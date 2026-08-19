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

const EXPORT_CONTENTS: { id: ExportMode; label: string; icon: string; desc: string }[] = [
  {
    id: "both",
    label: "Structure + items",
    icon: "database",
    desc: "Table definition and every item",
  },
  {
    id: "schema",
    label: "Structure only",
    icon: "account_tree",
    desc: "CreateTable definition — no items",
  },
  {
    id: "data",
    label: "Items only",
    icon: "table_rows",
    desc: "Items array — no table definition",
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
        toast("Exporting requires the ByteTable desktop app.", "info");
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
      toast("Exported " + (path.split(/[\\/]/).pop() ?? fname), "ok");
      setTimeout(() => {
        if (!cancelled.current) onClose();
      }, 700);
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Export requires the desktop app", "err");
      onClose();
    }
  };

  return (
    <Modal
      label={isAll ? "Export all tables" : "Export " + table}
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
            ? "Export complete"
            : stage === "choose"
              ? isAll
                ? "Export all tables"
                : "Export " + table
              : "Exporting…"}
        </span>
        {stage !== "building" ? <IconBtn icon="close" onClick={onClose} title="Close" /> : null}
      </ModalTitle>

      {stage === "choose" ? (
        <>
          <div className="ddb-io-label">Format</div>
          <div className="seg ddb-io-seg">
            {EXPORT_FORMATS.map((f) => {
              const disabled = isAll && f.id === "csv";
              return (
                <button
                  key={f.id}
                  type="button"
                  className={"seg-btn" + (format === f.id ? " active" : "")}
                  disabled={disabled}
                  title={disabled ? "CSV is per-table only" : ""}
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
              <Icon name="info" size={13} /> CSV exports one table at a time — use a table's own
              Export for it.
            </div>
          ) : null}

          <div className="ddb-io-label">Contents</div>
          {isCsv ? (
            <div className="ddb-export-file" style={{ marginTop: 0 }}>
              <Icon name="table_rows" size={15} style={{ color: "var(--text-dim)" }} />
              <span className="ddb-export-file-name">
                CSV carries items only — nested maps/lists become JSON strings.
              </span>
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
                    <b>{c.label}</b>
                    <span>{c.desc}</span>
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
            {isAll ? <span className="ddb-export-cur">{tables.length} tables</span> : null}
          </div>
          <ModalActions>
            <div style={{ flex: 1 }} />
            <Btn variant="text" onClick={onClose}>
              Cancel
            </Btn>
            <Btn variant="filled" icon="download" onClick={() => void build()}>
              Export
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
            <span>{stage === "done" ? "Done" : pct + "%"}</span>
            <span>
              {effMode === "schema"
                ? "structure only"
                : done
                  ? done.toLocaleString() + " items"
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
                Cancel
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
  const t = tableDescriptor;
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [text, setText] = useState("");
  const [prev, setPrev] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<{ pct: number; rows: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();

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
        error:
          "No items found. Paste " +
          (fmt === "csv" ? "CSV with a header row" : "a JSON array of items") +
          ".",
      });
      return;
    }
    const columns = attributeUnion(items);
    const pk = t.keySchema.pk;
    const sk = t.keySchema.sk;
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
      toast(isAppErrorPayload(e) ? e.message : "Import requires the desktop app", "err");
      setBusy(null);
      return;
    }
    toast(
      "BatchWriteItem · imported " +
        written.toLocaleString() +
        " item" +
        (written === 1 ? "" : "s") +
        " into " +
        table,
      "ok",
    );
    onDone();
  };

  const placeholder =
    format === "csv"
      ? "Paste CSV — first row is the header:\n" +
        [t.keySchema.pk, t.keySchema.sk].filter(Boolean).join(",") +
        ",…"
      : 'Paste a JSON array of items (plain or DynamoDB-typed):\n[\n  { "' +
        t.keySchema.pk +
        '": "…"' +
        (t.keySchema.sk ? ', "' + t.keySchema.sk + '": "…"' : "") +
        " }\n]";

  return (
    <Modal label={"Import items into " + table} onClose={onClose} className="ddb-import-modal">
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="upload" size={17} style={{ color: "var(--accent)" }} /> Import items into{" "}
          {table}
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
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
          {format === "json"
            ? "plain or DynamoDB-typed — auto-detected"
            : "numbers / booleans / JSON auto-typed"}
        </span>
        <div style={{ flex: 1 }} />
        <Btn icon="folder_open" variant="tonal" small onClick={() => fileRef.current?.click()}>
          Choose file…
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
                {(prev.count ?? 0).toLocaleString()} item{prev.count === 1 ? "" : "s"} ready
              </span>
              <span className="ddb-import-match">
                {prev.columns?.length ?? 0} attribute{prev.columns?.length === 1 ? "" : "s"}
              </span>
              {prev.missingKey ? (
                <span className="ddb-import-unknown">
                  <Icon name="warning" size={12} /> {prev.missingKey} missing{" "}
                  {t.keySchema.sk ? "PK/SK" : "PK"}
                </span>
              ) : null}
            </div>
            <div className="ddb-import-preview-grid">
              <DynamoItemGrid items={(prev.items ?? []).slice(0, 5)} keySchema={t.keySchema} />
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
              {busy.rows.toLocaleString()} / {busy.total.toLocaleString()} items
            </span>
          </div>
        </div>
      ) : (
        <ModalActions>
          <div className="ddb-import-note">
            Items are written with PutItem (BatchWriteItem). DynamoDB is schemaless — extra
            attributes are kept; items missing a key are rejected by the API.
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
        </ModalActions>
      )}
    </Modal>
  );
}
