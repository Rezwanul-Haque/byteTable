// DynamoDB export & import modals (M17 §17.6) — counterparts to the SQL
// export/import. Export streams items via paginated `Scan` (bounded pages,
// never a whole-table load) and formats Plain JSON / DynamoDB-typed JSON / CSV,
// per-table or whole-account, structure-only / items-only / both. Import parses
// JSON (auto-detecting DynamoDB-typed) or CSV, previews with a missing-key
// warning, and writes via chunked `BatchWriteItem` with progress. Ported from
// `dynamo-io.jsx`.

import { useMemo, useRef, useState } from "react";

import { exportSave } from "../../../../shared/api/engine";
import { isAppErrorPayload } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../../shared/ui/Modal";
import { useToast } from "../../../../shared/ui/toastContext";
import { exportStamp } from "../../../export/exportFlow";
import { dynamoBatchWrite, dynamoScan, type DynamoItem, type TableDescriptor } from "../api";
import { attributeUnion, marshalItem, parseItems, tableDefinition, toCSV } from "../helpers";
import { DynamoItemGrid } from "./DynamoItemGrid";

const SCAN_PAGE = 100;
const IMPORT_CHUNK = 100;

type ExportFormat = "json" | "ddb-json" | "csv";
type ExportMode = "both" | "schema" | "data";

/** Scan a whole table page-by-page (bounded), accumulating items, with a
 *  cancellable progress callback. The per-REQUEST scan stays bounded — the file
 *  is assembled client-side exactly like the SQL export. */
async function scanAll(
  handleId: string,
  table: string,
  cancelled: { current: boolean },
  onProgress: (done: number) => void,
): Promise<DynamoItem[]> {
  const items: DynamoItem[] = [];
  let token: string | undefined;
  do {
    if (cancelled.current) break;
    const page = await dynamoScan(handleId, table, { limit: SCAN_PAGE, nextToken: token });
    items.push(...page.items);
    onProgress(items.length);
    token = page.nextToken;
  } while (token);
  return items;
}

interface ExportModalProps {
  scope: "table" | "all";
  table?: string;
  handleId: string;
  tables: TableDescriptor[];
  region: string;
  /** Connection's deployment env — goes into the filename (`exportStamp`). */
  env?: string;
  onClose: () => void;
}

const EXPORT_CONTENTS: { id: ExportMode; labelKey: string; icon: string; descKey: string }[] = [
  {
    id: "both",
    labelKey: "dyn.io.contentBoth",
    icon: "database",
    descKey: "dyn.io.descBoth",
  },
  {
    id: "schema",
    labelKey: "dyn.io.contentSchema",
    icon: "account_tree",
    descKey: "dyn.io.descSchema",
  },
  {
    id: "data",
    labelKey: "dyn.io.contentData",
    icon: "table_rows",
    descKey: "dyn.io.descData",
  },
];
const EXPORT_FORMATS: { id: ExportFormat; label: string; icon: string }[] = [
  { id: "json", label: "JSON", icon: "data_object" },
  { id: "ddb-json", label: "DynamoDB JSON", icon: "code" },
  { id: "csv", label: "CSV", icon: "table_view" },
];

export function DynamoExportModal({
  scope,
  table,
  handleId,
  tables,
  region,
  env,
  onClose,
}: ExportModalProps) {
  const [stage, setStage] = useState<"choose" | "building" | "done">("choose");
  const [format, setFormat] = useState<ExportFormat>("json");
  const [mode, setMode] = useState<ExportMode>("both");
  const [pct, setPct] = useState(0);
  const [done, setDone] = useState(0);
  const [curTable, setCurTable] = useState<string | null>(
    scope === "table" ? (table ?? null) : null,
  );
  const cancelled = useRef(false);
  const toast = useToast();
  const t = useT();

  const isAll = scope === "all";
  const isCsv = format === "csv";
  const effMode: ExportMode = isCsv ? "data" : mode;
  const ext = isCsv ? "csv" : "json";
  const suffix = effMode === "schema" ? "_schema" : effMode === "data" ? "_items" : "";
  const base = isAll ? region + "_export" : (table ?? "table");
  // One stamp per modal (not per render) so the name shown while choosing is the
  // name the file is downloaded under.
  const stamp = useMemo(() => exportStamp(env), [env]);
  const fname = base + suffix + stamp + (format === "ddb-json" ? ".ddb" : "") + "." + ext;

  const descOf = (name: string) => tables.find((t) => t.name === name);

  const marshalArr = (items: DynamoItem[]): unknown[] =>
    format === "ddb-json" ? items.map(marshalItem) : items;

  const build = async () => {
    setStage("building");
    cancelled.current = false;
    try {
      let content: string;
      if (isAll) {
        const tablesOut: Record<string, unknown>[] = [];
        for (const t of tables) {
          if (cancelled.current) return;
          setCurTable(t.name);
          const items =
            effMode === "schema"
              ? []
              : await scanAll(handleId, t.name, cancelled, (d) => setDone(d));
          const entry: Record<string, unknown> = { TableName: t.name };
          if (effMode !== "data") entry.TableDefinition = tableDefinition(t);
          if (effMode !== "schema") entry.Items = marshalArr(items);
          tablesOut.push(entry);
          setPct(Math.round(((tables.indexOf(t) + 1) / tables.length) * 100));
        }
        const payload = {
          region,
          exportedAt: new Date().toISOString(),
          tableCount: tablesOut.length,
          tables: tablesOut,
        };
        content = JSON.stringify(payload, null, 2);
      } else {
        const t = descOf(table ?? "");
        const items =
          effMode === "schema"
            ? []
            : await scanAll(handleId, table ?? "", cancelled, (d) => {
                setDone(d);
                setPct(Math.min(99, d));
              });
        if (cancelled.current) return;
        if (isCsv) {
          content = toCSV(items);
        } else {
          const def = t ? tableDefinition(t) : {};
          const payload =
            effMode === "schema"
              ? { TableDefinition: def }
              : effMode === "data"
                ? { Items: marshalArr(items) }
                : { TableDefinition: def, Items: marshalArr(items) };
          content = JSON.stringify(payload, null, 2);
        }
      }
      if (cancelled.current) return;
      setPct(100);

      // Ask where to put it, then write through the backend — the same path
      // every other export in the app takes. This used to hand the content to a
      // blob URL and an <a download>, which is a BROWSER idiom: inside the Tauri
      // webview it produced no dialog and no file the user could find, while the
      // toast still claimed success.
      let path: string | null;
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        path = await save({
          defaultPath: fname,
          filters: [
            isCsv ? { name: "CSV", extensions: ["csv"] } : { name: "JSON", extensions: ["json"] },
          ],
        });
      } catch {
        toast(t("dyn.exportNeedApp"), "info");
        onClose();
        return;
      }
      // Cancelled at the dialog: stay on the choices rather than closing, so the
      // scan that was just paid for is not thrown away.
      if (!path) {
        setStage("choose");
        setPct(0);
        return;
      }
      await exportSave(path, content);
      setStage("done");
      toast(t("dyn.io.exportedFile", { file: path.split(/[\\/]/).pop() ?? fname }), "ok");
      setTimeout(() => {
        if (!cancelled.current) onClose();
      }, 700);
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : t("dyn.io.exportFailApp"), "err");
      onClose();
    }
  };

  return (
    <Modal
      label={isAll ? t("dyn.io.exportAllLabel") : t("dyn.io.exportTable", { table: table ?? "" })}
      onClose={() => {
        if (stage !== "building") onClose();
      }}
      className="ddb-export-modal"
    >
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon
            name={stage === "done" ? "download_done" : "download"}
            size={17}
            style={{ color: "var(--accent)" }}
          />
          {stage === "done"
            ? t("dyn.io.exportDone")
            : stage === "choose"
              ? isAll
                ? t("dyn.io.exportAllLabel")
                : t("dyn.io.exportTable", { table: table ?? "" })
              : t("dyn.io.exporting")}
        </span>
        {stage !== "building" ? (
          <IconBtn icon="close" onClick={onClose} title={t("common.close")} />
        ) : null}
      </ModalTitle>

      {stage === "choose" ? (
        <>
          <div className="ddb-io-label">{t("dyn.io.formatLabel")}</div>
          <div className="seg ddb-io-seg">
            {EXPORT_FORMATS.map((f) => {
              const disabled = isAll && f.id === "csv";
              return (
                <button
                  key={f.id}
                  type="button"
                  className={"seg-btn" + (format === f.id ? " active" : "")}
                  disabled={disabled}
                  title={disabled ? t("dyn.io.csvPerTable") : ""}
                  onClick={() => setFormat(f.id)}
                >
                  <Icon name={f.icon} size={14} /> {f.label}
                </button>
              );
            })}
          </div>
          {/* A disabled segment with only a tooltip reads as broken — and a
              tooltip on a disabled button often never fires. Say why in the
              open: one CSV has one header row, so it cannot carry four tables
              with different attributes. */}
          {isAll ? (
            <div className="ddb-io-note">
              <Icon name="info" size={13} /> {t("dyn.io.csvNote")}
            </div>
          ) : null}

          <div className="ddb-io-label">{t("dyn.io.contentsLabel")}</div>
          {isCsv ? (
            <div className="ddb-export-file" style={{ marginTop: 0 }}>
              <Icon name="table_rows" size={15} style={{ color: "var(--text-dim)" }} />
              <span className="ddb-export-file-name">{t("dyn.io.csvCarries")}</span>
            </div>
          ) : (
            <div className="ddb-export-choose">
              {EXPORT_CONTENTS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={"ddb-export-opt" + (mode === c.id ? " on" : "")}
                  onClick={() => setMode(c.id)}
                >
                  <span className="ddb-export-opt-radio">
                    <Icon
                      name={mode === c.id ? "radio_button_checked" : "radio_button_unchecked"}
                      size={16}
                    />
                  </span>
                  <Icon
                    name={c.icon}
                    size={16}
                    style={{ color: mode === c.id ? "var(--accent)" : "var(--text-dim)" }}
                  />
                  <span className="ddb-export-opt-text">
                    <b>{t(c.labelKey as "dyn.io.contentBoth")}</b>
                    <span>{t(c.descKey as "dyn.io.descBoth")}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="ddb-export-file">
            <Icon
              name={isCsv ? "table_view" : "data_object"}
              size={15}
              style={{ color: "var(--text-dim)" }}
            />
            <span className="ddb-export-file-name">{fname}</span>
            {isAll ? (
              <span className="ddb-export-cur">
                {t("dyn.io.nTables", { count: tables.length })}
              </span>
            ) : null}
          </div>
          <ModalActions>
            <div style={{ flex: 1 }} />
            <Btn variant="text" onClick={onClose}>
              {t("common.cancel")}
            </Btn>
            <Btn variant="filled" icon="download" onClick={() => void build()}>
              {t("dyn.io.exportBtn")}
            </Btn>
          </ModalActions>
        </>
      ) : (
        <>
          <div className="ddb-export-file">
            <Icon
              name={isCsv ? "table_view" : "data_object"}
              size={15}
              style={{ color: "var(--text-dim)" }}
            />
            <span className="ddb-export-file-name">{fname}</span>
            {curTable && isAll && stage !== "done" ? (
              <span className="ddb-export-cur">{curTable}</span>
            ) : null}
          </div>
          <div className="ddb-export-bar">
            <div className="ddb-export-bar-fill" style={{ width: pct + "%" }} />
          </div>
          <div className="ddb-export-meta">
            <span>{stage === "done" ? t("dyn.io.done") : pct + "%"}</span>
            <span>
              {effMode === "schema"
                ? t("dyn.io.structureOnly")
                : done
                  ? t("dyn.statusItems", { count: done.toLocaleString() })
                  : ""}
            </span>
          </div>
          {stage !== "done" ? (
            <ModalActions>
              <div style={{ flex: 1 }} />
              <Btn
                variant="text"
                onClick={() => {
                  cancelled.current = true;
                  onClose();
                }}
              >
                {t("common.cancel")}
              </Btn>
            </ModalActions>
          ) : null}
        </>
      )}
    </Modal>
  );
}

interface ImportModalProps {
  table: string;
  tableDescriptor: TableDescriptor;
  handleId: string;
  onClose: () => void;
  onDone: () => void;
}

interface Preview {
  items?: DynamoItem[];
  count?: number;
  columns?: string[];
  missingKey?: number;
  error?: string;
}

export function DynamoImportModal({
  table,
  tableDescriptor,
  handleId,
  onClose,
  onDone,
}: ImportModalProps) {
  const td = tableDescriptor;
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [text, setText] = useState("");
  const [prev, setPrev] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<{ pct: number; rows: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();
  const t = useT();

  const runPreview = (fmt: "json" | "csv", txt: string) => {
    if (!txt.trim()) {
      setPrev(null);
      return;
    }
    let items: DynamoItem[];
    try {
      items = parseItems(fmt, txt);
    } catch (e) {
      setPrev({ error: (e as Error).message });
      return;
    }
    if (!items.length) {
      setPrev({
        error: t(
          "dyn.io.noItemsFound",
          fmt === "csv" ? { what: t("dyn.io.whatCsv") } : { what: t("dyn.io.whatJson") },
        ),
      });
      return;
    }
    const columns = attributeUnion(items);
    const pk = td.keySchema.pk;
    const sk = td.keySchema.sk;
    const missingKey = items.filter((it) => !(pk in it) || (sk && !(sk in it))).length;
    setPrev({ items, count: items.length, columns, missingKey });
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fmt = /\.csv$/i.test(file.name) ? "csv" : "json";
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result);
      setFormat(fmt);
      setText(content);
      runPreview(fmt, content);
    };
    reader.readAsText(file);
  };

  const doImport = async () => {
    if (!prev || prev.error || !prev.count || !prev.items) return;
    const items = prev.items;
    setBusy({ pct: 0, rows: 0, total: items.length });
    let written = 0;
    try {
      for (let i = 0; i < items.length; i += IMPORT_CHUNK) {
        const chunk = items.slice(i, i + IMPORT_CHUNK);
        const res = await dynamoBatchWrite(handleId, table, chunk);
        written += res.written;
        const rows = Math.min(i + IMPORT_CHUNK, items.length);
        setBusy({ pct: Math.round((rows / items.length) * 100), rows, total: items.length });
      }
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : t("dyn.io.importFailApp"), "err");
      setBusy(null);
      return;
    }
    toast(
      written === 1
        ? t("dyn.io.imported1", { count: written, table })
        : t("dyn.io.importedN", { count: written, table }),
      "ok",
    );
    onDone();
  };

  const placeholder =
    format === "csv"
      ? t("dyn.io.phCsvPre") + [td.keySchema.pk, td.keySchema.sk].filter(Boolean).join(",") + ",…"
      : t("dyn.io.phJsonPre") +
        '[\n  { "' +
        td.keySchema.pk +
        '": "…"' +
        (td.keySchema.sk ? ', "' + td.keySchema.sk + '": "…"' : "") +
        " }\n]";

  return (
    <Modal label={t("dyn.io.importInto", { table })} onClose={onClose} className="ddb-import-modal">
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="upload" size={17} style={{ color: "var(--accent)" }} />{" "}
          {t("dyn.io.importInto", { table })}
        </span>
        <IconBtn icon="close" onClick={onClose} title={t("common.close")} />
      </ModalTitle>

      <div className="ddb-import-format">
        <div className="seg">
          <button
            type="button"
            className={"seg-btn" + (format === "json" ? " active" : "")}
            onClick={() => {
              setFormat("json");
              runPreview("json", text);
            }}
          >
            <Icon name="data_object" size={14} /> JSON
          </button>
          <button
            type="button"
            className={"seg-btn" + (format === "csv" ? " active" : "")}
            onClick={() => {
              setFormat("csv");
              runPreview("csv", text);
            }}
          >
            <Icon name="table_view" size={14} /> CSV
          </button>
        </div>
        <span className="ddb-io-hint">
          {format === "json" ? t("dyn.io.hintJson") : t("dyn.io.hintCsv")}
        </span>
        <div style={{ flex: 1 }} />
        <Btn icon="folder_open" variant="tonal" small onClick={() => fileRef.current?.click()}>
          {t("dyn.io.chooseFile")}
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.csv,.txt"
          style={{ display: "none" }}
          onChange={onFile}
        />
      </div>

      <textarea
        className="ddb-import-textarea"
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
          <div className="ddb-import-err">
            <Icon name="error" size={14} /> {prev.error}
          </div>
        ) : (
          <div className="ddb-import-preview">
            <div className="ddb-import-preview-bar">
              <span className="ddb-import-ready">
                <Icon name="check_circle" size={14} style={{ color: "var(--accent)" }} />{" "}
                {prev.count === 1
                  ? t("dyn.io.ready1", { count: (prev.count ?? 0).toLocaleString() })
                  : t("dyn.io.readyN", { count: (prev.count ?? 0).toLocaleString() })}
              </span>
              <span className="ddb-import-match">
                {(prev.columns?.length ?? 0) === 1
                  ? t("dyn.io.attrs1", { count: prev.columns?.length ?? 0 })
                  : t("dyn.io.attrsN", { count: prev.columns?.length ?? 0 })}
              </span>
              {prev.missingKey ? (
                <span className="ddb-import-unknown">
                  <Icon name="warning" size={12} />{" "}
                  {t("dyn.io.missingKey", {
                    count: prev.missingKey,
                    which: td.keySchema.sk ? "PK/SK" : "PK",
                  })}
                </span>
              ) : null}
            </div>
            <div className="ddb-import-preview-grid">
              <DynamoItemGrid items={(prev.items ?? []).slice(0, 5)} keySchema={td.keySchema} />
            </div>
          </div>
        )
      ) : null}

      {busy ? (
        <div className="ddb-import-busy">
          <div className="ddb-export-bar">
            <div className="ddb-export-bar-fill" style={{ width: busy.pct + "%" }} />
          </div>
          <div className="ddb-export-meta">
            <span>BatchWriteItem… {busy.pct}%</span>
            <span>
              {busy.rows.toLocaleString()} /{" "}
              {t("dyn.statusItems", { count: busy.total.toLocaleString() })}
            </span>
          </div>
        </div>
      ) : (
        <ModalActions>
          <div className="ddb-import-note">{t("dyn.io.note")}</div>
          <Btn variant="text" onClick={onClose}>
            {t("common.cancel")}
          </Btn>
          <Btn
            variant="filled"
            icon="upload"
            onClick={() => void doImport()}
            disabled={!prev || !!prev.error || !prev.count}
          >
            {t("dyn.io.importBtn")}
          </Btn>
        </ModalActions>
      )}
    </Modal>
  );
}
