// MongoDB export & import modals (M18 §18.8). Export: per-collection or whole
// database (mongodump-style), formats JSON array / mongosh script / CSV,
// contents documents-only vs documents+indexes/validator. Import: JSON (plain
// array or a runnable mongosh script) / CSV → chunked insertMany with a preview
// grid. Ported from the prototype's mongo-io.jsx / mongo-export.js /
// mongo-import.js; documents come from / go to the backend.

import { useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
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
  onClose,
}: {
  scope: "collection" | "all";
  db: string;
  coll?: string;
  handleId: string;
  collections: CollectionDescriptor[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [stage, setStage] = useState<"choose" | "building" | "done">("choose");
  const [format, setFormat] = useState<ExportFormat>("extended");
  const [mode, setMode] = useState<"both" | "data">("both");
  const [pct, setPct] = useState(0);

  const isAll = scope === "all";
  const isCsv = format === "csv";
  const effMode = isCsv ? "data" : mode;
  const ext = isCsv ? "csv" : format === "shell" ? "js" : "json";
  const base = isAll ? db + "_dump" : db + "." + coll;
  const fname = base + (effMode === "data" && !isCsv ? "_docs" : "") + "." + ext;

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
      toast("Exported " + fname, "ok");
      setTimeout(onClose, 700);
    } catch (e) {
      toast(appErrorMessage(e, "Export failed"), "err");
      setStage("choose");
    }
  };

  const FORMATS: { id: ExportFormat; label: string; icon: string }[] = [
    { id: "extended", label: "JSON", icon: "data_object" },
    { id: "shell", label: "mongosh script", icon: "code" },
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
            ? "Export complete"
            : stage === "choose"
              ? isAll
                ? "Export database " + db
                : "Export " + coll
              : "Exporting…"}
        </span>
        {stage !== "building" ? <IconBtn icon="close" onClick={onClose} title="Close" /> : null}
      </div>

      {stage === "choose" ? (
        <>
          <div className="ddb-io-label">Format</div>
          <div className="seg ddb-io-seg">
            {FORMATS.map((f) => {
              const disabled = isAll && f.id === "csv";
              return (
                <button
                  key={f.id}
                  className={"seg-btn" + (format === f.id ? " active" : "")}
                  disabled={disabled}
                  title={disabled ? "CSV is per-collection only" : ""}
                  onClick={() => setFormat(f.id)}
                >
                  <Icon name={f.icon} size={14} /> {f.label}
                </button>
              );
            })}
          </div>

          <div className="ddb-io-label">Contents</div>
          {isCsv ? (
            <div className="export-file" style={{ marginTop: 0 }}>
              <Icon name="table_view" size={15} style={{ color: "var(--text-dim)" }} />
              <span className="export-file-name">
                CSV flattens nested fields to dotted columns; arrays become JSON strings.
              </span>
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
                  <b>Documents + indexes</b>
                  <span>
                    Indexes &amp; $jsonSchema validator
                    {format === "shell" ? " as createIndex/createCollection" : ""}
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
                  <b>Documents only</b>
                  <span>Just the documents, no indexes</span>
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
            {isAll ? <span className="export-cur">{collections.length} collections</span> : null}
          </div>
          <div className="modal-actions">
            <div style={{ flex: 1 }} />
            <Btn variant="text" onClick={onClose}>
              Cancel
            </Btn>
            <Btn variant="filled" icon="download" onClick={() => void build()}>
              Export
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
            <span>{stage === "done" ? "Done" : pct + "%"}</span>
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
      toast(
        "insertMany · imported " +
          r.inserted.toLocaleString() +
          " doc" +
          (r.inserted === 1 ? "" : "s") +
          " into " +
          db +
          "." +
          target,
        "ok",
      );
      onDone();
    } catch (e) {
      toast(appErrorMessage(e, "Import failed"), "err");
      setBusy(null);
    }
  };

  const placeholder =
    format === "csv"
      ? "Paste CSV — first row is the header (dotted keys allowed):\n_id,name,country,address.city"
      : 'Paste a JSON array of documents (Extended JSON or mongosh ObjectId()/ISODate() both work):\n[\n  { "name": "Ada", "country": "GB" }\n]';

  return (
    <Modal onClose={onClose} className="import-modal">
      <div className="modal-title">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="upload" size={17} style={{ color: "var(--accent)" }} /> Import documents
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </div>

      <div className="import-format">
        <label className="mg-import-target">
          <span>Into</span>
          <select
            className="filter-select"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {collNames.map((c) => (
              <option key={c} value={c}>
                {db}.{c}
              </option>
            ))}
          </select>
        </label>
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
          Choose file…
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
                {prev.count?.toLocaleString()} doc{prev.count === 1 ? "" : "s"} ready
              </span>
              <span className="import-match">
                {prev.columns?.length} top-level field{prev.columns?.length === 1 ? "" : "s"}
              </span>
              {prev.noId ? (
                <span className="import-unknown">
                  <Icon name="info" size={12} /> {prev.noId} without _id (auto-assigned)
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
            <span>insertMany… {busy.pct}%</span>
          </div>
        </div>
      ) : (
        <div className="modal-actions">
          <div className="import-note">
            Documents are appended (insertMany). MongoDB is schemaless — extra fields are kept; a
            $jsonSchema validator would reject invalid docs.
          </div>
          <Btn variant="text" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            variant="filled"
            icon="upload"
            onClick={() => void doImport()}
            disabled={!prev || !!prev.error || !prev.count}
          >
            Import
          </Btn>
        </div>
      )}
    </Modal>
  );
}
