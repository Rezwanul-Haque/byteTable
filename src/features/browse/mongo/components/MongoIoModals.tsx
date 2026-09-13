// MongoDB export & import modals (M18 §18.8). Export: per-collection or whole
// database (mongodump-style), formats JSON array / mongosh script / CSV,
// contents documents-only vs documents+indexes/validator. Import: JSON (plain
// array or a runnable mongosh script) / CSV → chunked insertMany with a preview
// grid. Ported from the prototype's mongo-io.jsx / mongo-export.js /
// mongo-import.js; documents come from / go to the backend.

import { useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Modal } from "../../../../shared/ui/Modal";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import { exportStamp } from "../../../export/exportFlow";
import { mongoFind, mongoInsertMany, type CollectionDescriptor, type MongoDoc } from "../api";
import { previewImport, toCSV, toShell, withIds, type ImportPreview } from "../helpers";
import { MongoDocGrid } from "./MongoValue";

type ExportFormat = "extended" | "shell" | "csv";

function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

/** Fetch all documents of a collection via the bounded find cursor (All). */
async function fetchAll(handleId: string, db: string, coll: string): Promise<MongoDoc[]> {
  const r = await mongoFind(handleId, db, coll, { filter: {}, limit: null });
  return r.docs;
}

function serializeCollection(
  desc: CollectionDescriptor | undefined,
  collName: string,
  db: string,
  docs: MongoDoc[],
  format: ExportFormat,
  withStructure: boolean,
): { content: string; mime: string } {
  if (format === "csv") {
    return { content: toCSV(docs), mime: "text/csv" };
  }
  if (format === "shell") {
    const lines = [
      "// ByteTable export · " + db + "." + collName,
      'db = db.getSiblingDB("' + db + '");',
    ];
    if (withStructure && desc?.validator) {
      lines.push(
        'db.createCollection("' +
          collName +
          '", { validator: ' +
          JSON.stringify(desc.validator) +
          " });",
      );
    }
    lines.push("db." + collName + ".insertMany([\n  " + docs.map(toShell).join(",\n  ") + "\n]);");
    if (withStructure && desc) {
      desc.indexes
        .filter((i) => i.name !== "_id_")
        .forEach((idx) =>
          lines.push(
            "db." +
              collName +
              ".createIndex(" +
              JSON.stringify(idx.keys) +
              (idx.unique ? ", { unique: true }" : "") +
              ");",
          ),
        );
    }
    return { content: lines.join("\n"), mime: "application/javascript" };
  }
  // Extended JSON
  const payload = withStructure
    ? {
        db,
        collection: collName,
        options: desc?.validator ? { validator: desc.validator } : {},
        indexes: desc?.indexes ?? [],
        documents: docs,
      }
    : docs;
  return { content: JSON.stringify(payload, null, 2), mime: "application/json" };
}

export function MongoExportModal({
  scope,
  db,
  coll,
  handleId,
  collections,
  /** Connection's deployment env — goes into the filename (`exportStamp`). */
  env,
  onClose,
}: {
  scope: "collection" | "all";
  db: string;
  coll?: string;
  handleId: string;
  collections: CollectionDescriptor[];
  env?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [stage, setStage] = useState<"choose" | "building" | "done">("choose");
  const [format, setFormat] = useState<ExportFormat>("extended");
  const [mode, setMode] = useState<"both" | "data">("both");
  const [pct, setPct] = useState(0);

  const isAll = scope === "all";
  const isCsv = format === "csv";
  const effMode = isCsv ? "data" : mode;
  const ext = isCsv ? "csv" : format === "shell" ? "js" : "json";
  const base = isAll ? db + "_dump" : db + "." + coll;
  // One stamp per modal (not per render) so the name shown while choosing is the
  // name the file is downloaded under.
  const stamp = useMemo(() => exportStamp(env), [env]);
  const fname = base + (effMode === "data" && !isCsv ? "_docs" : "") + stamp + "." + ext;

  const descOf = (name: string) => collections.find((c) => c.name === name);

  const build = async () => {
    setStage("building");
    setPct(10);
    try {
      let content: string;
      let mime: string;
      if (isAll) {
        const names = collections.map((c) => c.name);
        const out: Record<string, unknown>[] = [];
        for (let i = 0; i < names.length; i++) {
          const name = names[i]!;
          const docs = await fetchAll(handleId, db, name);
          const entry: Record<string, unknown> = { collection: name, documents: docs };
          if (effMode === "both") {
            const d = descOf(name);
            entry.indexes = d?.indexes ?? [];
            if (d?.validator) entry.options = { validator: d.validator };
          }
          out.push(entry);
          setPct(Math.round(((i + 1) / names.length) * 100));
        }
        content = JSON.stringify(
          {
            db,
            dumpedAt: new Date().toISOString(),
            collectionCount: out.length,
            collections: out,
          },
          null,
          2,
        );
        mime = "application/json";
      } else {
        const docs = await fetchAll(handleId, db, coll!);
        setPct(70);
        const r = serializeCollection(descOf(coll!), coll!, db, docs, format, effMode === "both");
        content = r.content;
        mime = r.mime;
      }
      setPct(100);
      setStage("done");
      download(fname, content, mime);
      toast(t("mongo.exportedFile", { name: fname }), "ok");
      setTimeout(onClose, 700);
    } catch (e) {
      toast(appErrorMessage(e, t("mongo.exportFail")), "err");
      setStage("choose");
    }
  };

  const FORMATS: { id: ExportFormat; label: string; icon: string }[] = [
    { id: "extended", label: "JSON", icon: "data_object" },
    { id: "shell", label: t("mongo.fmtShell"), icon: "code" },
    { id: "csv", label: "CSV", icon: "table_view" },
  ];

  return (
    <Modal onClose={onClose} width={460} className="export-progress-modal">
      <div className="modal-title">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon
            name={stage === "done" ? "download_done" : "download"}
            size={17}
            style={{ color: "var(--accent)" }}
          />
          {stage === "done"
            ? t("mongo.exportDone")
            : stage === "choose"
              ? isAll
                ? t("mongo.exportDbTitle", { db })
                : t("mongo.exportCollTitle", { coll: coll ?? "" })
              : t("mongo.exporting")}
        </span>
        {stage !== "building" ? (
          <IconBtn icon="close" onClick={onClose} title={t("common.close")} />
        ) : null}
      </div>

      {stage === "choose" ? (
        <>
          <div className="ddb-io-label">{t("mongo.format")}</div>
          <div className="seg ddb-io-seg">
            {FORMATS.map((f) => {
              const disabled = isAll && f.id === "csv";
              return (
                <button
                  key={f.id}
                  className={"seg-btn" + (format === f.id ? " active" : "")}
                  disabled={disabled}
                  title={disabled ? t("mongo.csvOnly") : ""}
                  onClick={() => setFormat(f.id)}
                >
                  <Icon name={f.icon} size={14} /> {f.label}
                </button>
              );
            })}
          </div>

          <div className="ddb-io-label">{t("mongo.contents")}</div>
          {isCsv ? (
            <div className="export-file" style={{ marginTop: 0 }}>
              <Icon name="table_view" size={15} style={{ color: "var(--text-dim)" }} />
              <span className="export-file-name">{t("mongo.csvNote")}</span>
            </div>
          ) : (
            <div className="export-choose">
              <button
                className={"export-opt" + (mode === "both" ? " on" : "")}
                onClick={() => setMode("both")}
              >
                <span className="export-opt-radio">
                  <Icon
                    name={mode === "both" ? "radio_button_checked" : "radio_button_unchecked"}
                    size={16}
                  />
                </span>
                <Icon
                  name="account_tree"
                  size={16}
                  style={{ color: mode === "both" ? "var(--accent)" : "var(--text-dim)" }}
                />
                <span className="export-opt-text">
                  <b>{t("mongo.modeBoth")}</b>
                  <span>
                    {t("mongo.modeBothSub")}
                    {format === "shell" ? t("mongo.modeBothSubShell") : ""}
                  </span>
                </span>
              </button>
              <button
                className={"export-opt" + (mode === "data" ? " on" : "")}
                onClick={() => setMode("data")}
              >
                <span className="export-opt-radio">
                  <Icon
                    name={mode === "data" ? "radio_button_checked" : "radio_button_unchecked"}
                    size={16}
                  />
                </span>
                <Icon
                  name="data_array"
                  size={16}
                  style={{ color: mode === "data" ? "var(--accent)" : "var(--text-dim)" }}
                />
                <span className="export-opt-text">
                  <b>{t("mongo.modeData")}</b>
                  <span>{t("mongo.modeDataSub")}</span>
                </span>
              </button>
            </div>
          )}

          <div className="export-file">
            <Icon
              name={isCsv ? "table_view" : format === "shell" ? "code" : "data_object"}
              size={15}
              style={{ color: "var(--text-dim)" }}
            />
            <span className="export-file-name">{fname}</span>
            {isAll ? (
              <span className="export-cur">
                {t("mongo.nCollections", { count: collections.length })}
              </span>
            ) : null}
          </div>
          <div className="modal-actions">
            <div style={{ flex: 1 }} />
            <Btn variant="text" onClick={onClose}>
              {t("common.cancel")}
            </Btn>
            <Btn variant="filled" icon="download" onClick={() => void build()}>
              {t("mongo.exportBtn")}
            </Btn>
          </div>
        </>
      ) : (
        <>
          <div className="export-file">
            <Icon
              name={isCsv ? "table_view" : "data_object"}
              size={15}
              style={{ color: "var(--text-dim)" }}
            />
            <span className="export-file-name">{fname}</span>
          </div>
          <div className="export-bar">
            <div className="export-bar-fill" style={{ width: pct + "%" }} />
          </div>
          <div className="export-meta">
            <span>{stage === "done" ? t("mongo.done") : pct + "%"}</span>
          </div>
        </>
      )}
    </Modal>
  );
}

export function MongoImportModal({
  db,
  coll,
  handleId,
  collNames,
  onClose,
  onDone,
}: {
  db: string;
  coll: string | null;
  handleId: string;
  collNames: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [target, setTarget] = useState(coll ?? collNames[0] ?? "");
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [text, setText] = useState("");
  const [prev, setPrev] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<{ pct: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const runPreview = (fmt: "json" | "csv", txt: string) => {
    if (!txt.trim()) {
      setPrev(null);
      return;
    }
    setPrev(previewImport(fmt, txt));
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fmt: "json" | "csv" = /\.csv$/i.test(file.name) ? "csv" : "json";
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result);
      setFormat(fmt);
      setText(txt);
      runPreview(fmt, txt);
    };
    reader.readAsText(file);
  };

  const doImport = async () => {
    if (!prev || prev.error || !prev.count || !prev.docs) return;
    setBusy({ pct: 30 });
    try {
      const docs = withIds(prev.docs);
      const r = await mongoInsertMany(handleId, db, target, docs);
      setBusy({ pct: 100 });
      toast(t("mongo.importOk", { count: r.inserted, ns: db + "." + target }), "ok");
      onDone();
    } catch (e) {
      toast(appErrorMessage(e, t("mongo.importFail")), "err");
      setBusy(null);
    }
  };

  const placeholder = format === "csv" ? t("mongo.phCsv") : t("mongo.phJson");

  return (
    <Modal onClose={onClose} className="import-modal">
      <div className="modal-title">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="upload" size={17} style={{ color: "var(--accent)" }} />{" "}
          {t("mongo.importTitle")}
        </span>
        <IconBtn icon="close" onClick={onClose} title={t("common.close")} />
      </div>

      <div className="import-format">
        <div className="mg-import-target">
          <span>{t("mongo.into")}</span>
          <Select
            className="mg-import-sel"
            value={target}
            options={collNames.map((c) => ({ value: c, label: db + "." + c }))}
            onChange={setTarget}
            aria-label={t("mongo.menu.importIntoAria")}
          />
        </div>
        <div className="seg">
          <button
            className={"seg-btn" + (format === "json" ? " active" : "")}
            onClick={() => {
              setFormat("json");
              runPreview("json", text);
            }}
          >
            <Icon name="data_object" size={14} /> JSON
          </button>
          <button
            className={"seg-btn" + (format === "csv" ? " active" : "")}
            onClick={() => {
              setFormat("csv");
              runPreview("csv", text);
            }}
          >
            <Icon name="table_view" size={14} /> CSV
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <Btn icon="folder_open" variant="tonal" small onClick={() => fileRef.current?.click()}>
          {t("mongo.chooseFile")}
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.csv,.js,.txt"
          style={{ display: "none" }}
          onChange={onFile}
        />
      </div>

      <textarea
        className="import-textarea mg-mono"
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          runPreview(format, e.target.value);
        }}
      />

      {prev ? (
        prev.error ? (
          <div className="import-err">
            <Icon name="error" size={14} /> {prev.error}
          </div>
        ) : (
          <div className="import-preview">
            <div className="import-preview-bar">
              <span className="import-ready">
                <Icon name="check_circle" size={14} style={{ color: "var(--accent)" }} />{" "}
                {t("mongo.nReady", { count: prev.count ?? 0 })}
              </span>
              <span className="import-match">
                {t("mongo.nTopFields", { count: prev.columns?.length ?? 0 })}
              </span>
              {prev.noId ? (
                <span className="import-unknown">
                  <Icon name="info" size={12} /> {t("mongo.noIdNote", { count: prev.noId })}
                </span>
              ) : null}
            </div>
            <div className="import-preview-grid">
              <MongoDocGrid docs={(prev.docs ?? []).slice(0, 5)} onOpenDoc={() => {}} />
            </div>
          </div>
        )
      ) : null}

      {busy ? (
        <div className="import-busy">
          <div className="export-bar">
            <div className="export-bar-fill" style={{ width: busy.pct + "%" }} />
          </div>
          <div className="export-meta">
            <span>{t("mongo.importing", { pct: busy.pct })}</span>
          </div>
        </div>
      ) : (
        <div className="modal-actions">
          <div className="import-note">{t("mongo.importNote")}</div>
          <Btn variant="text" onClick={onClose}>
            {t("common.cancel")}
          </Btn>
          <Btn
            variant="filled"
            icon="upload"
            onClick={() => void doImport()}
            disabled={!prev || !!prev.error || !prev.count}
          >
            {t("mongo.importBtn")}
          </Btn>
        </div>
      )}
    </Modal>
  );
}
