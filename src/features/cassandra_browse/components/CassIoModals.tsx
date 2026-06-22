// Cassandra export & import modals (M19 §19.8, ported from cassandra-io.jsx):
// format + contents pickers, target-table select, progress bars, preview grid.
// Reuses the shared .export-* / .import-* / .ddb-io-* chrome.

import { useRef, useState } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import type { KeyspaceInfo, TableDescriptor } from "../api";
import {
  applyImport,
  buildKeyspaceExport,
  buildTableExport,
  download,
  previewImport,
  type ExportFormat,
  type ExportMode,
  type ImportFormat,
  type ImportPreview,
} from "../cassIo";
import { CassRowGrid } from "./CassRowGrid";

const EXPORT_FORMATS: { id: ExportFormat; label: string; icon: string }[] = [
  { id: "cql", label: "CQL script", icon: "code" },
  { id: "json", label: "JSON", icon: "data_object" },
  { id: "csv", label: "CSV", icon: "table_view" },
];

export function CassExportModal({
  scope,
  ks,
  keyspaceInfo,
  table,
  tables,
  handleId,
  onClose,
}: {
  scope: "table" | "all";
  ks: string;
  keyspaceInfo: KeyspaceInfo | null;
  table?: string;
  tables: TableDescriptor[];
  handleId: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [stage, setStage] = useState<"choose" | "building" | "done">("choose");
  const [format, setFormat] = useState<ExportFormat>("cql");
  const [mode, setMode] = useState<ExportMode>("both");
  const [pct, setPct] = useState(0);
  const [curTable, setCurTable] = useState<string | null>(
    scope === "table" ? (table ?? null) : null,
  );
  const cancelled = useRef(false);

  const isAll = scope === "all";
  const isCsv = format === "csv";
  const effMode: ExportMode = isCsv ? "data" : mode;
  const ext = isCsv ? "csv" : format === "json" ? "json" : "cql";
  const base = isAll ? ks + "_dump" : ks + "." + table;
  const fname =
    base +
    (effMode === "schema" ? "_schema" : effMode === "data" && !isCsv ? "_data" : "") +
    "." +
    ext;

  const build = () => {
    setStage("building");
    cancelled.current = false;
    void (async () => {
      const onProg = (p: number, _d: number, _t: number, tname?: string) => {
        if (cancelled.current) return;
        setPct(Math.round(p * 100));
        if (tname) setCurTable(tname);
      };
      try {
        const res = isAll
          ? await buildKeyspaceExport(
              handleId,
              keyspaceInfo ?? { name: ks, replication: {}, durableWrites: true },
              tables,
              format,
              effMode,
              onProg,
            )
          : await buildTableExport(
              handleId,
              ks,
              tables.find((t) => t.name === table)!,
              format,
              effMode,
              onProg,
            );
        if (cancelled.current) return;
        setStage("done");
        setPct(100);
        download(fname, res.content, res.mime);
        toast("Exported " + fname, "ok");
        setTimeout(() => !cancelled.current && onClose(), 700);
      } catch (e) {
        toast((e as Error).message ?? "Export failed", "err");
        onClose();
      }
    })();
  };

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && stage !== "building" && onClose()}
    >
      <div className="modal export-progress-modal">
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
                  ? "Export keyspace " + ks
                  : "Export " + table
                : "Exporting…"}
          </span>
          {stage !== "building" ? <IconBtn icon="close" onClick={onClose} title="Close" /> : null}
        </div>

        {stage === "choose" ? (
          <>
            <div className="ddb-io-label">Format</div>
            <div className="seg ddb-io-seg">
              {EXPORT_FORMATS.map((f) => {
                const disabled = isAll && f.id === "csv";
                return (
                  <button
                    key={f.id}
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

            <div className="ddb-io-label">Contents</div>
            {isCsv ? (
              <div className="export-file" style={{ marginTop: 0 }}>
                <Icon name="table_view" size={15} style={{ color: "var(--text-dim)" }} />
                <span className="export-file-name">
                  CSV exports rows only; collections (set/list/map) become JSON strings.
                </span>
              </div>
            ) : (
              <div className="export-choose">
                {(
                  [
                    [
                      "both",
                      "schema",
                      "Schema + data",
                      format === "cql"
                        ? "CREATE TABLE + INSERT statements"
                        : "Table definition and rows",
                    ],
                    [
                      "schema",
                      "account_tree",
                      "Schema only",
                      format === "cql"
                        ? "CREATE TABLE / INDEX / MV"
                        : "Column definitions, no rows",
                    ],
                    [
                      "data",
                      "table_rows",
                      "Data only",
                      format === "cql" ? "INSERT statements only" : "Just the rows",
                    ],
                  ] as const
                ).map(([m, icon, title, sub]) => (
                  <button
                    key={m}
                    className={"export-opt" + (mode === m ? " on" : "")}
                    onClick={() => setMode(m)}
                  >
                    <span className="export-opt-radio">
                      <Icon
                        name={mode === m ? "radio_button_checked" : "radio_button_unchecked"}
                        size={16}
                      />
                    </span>
                    <Icon
                      name={icon}
                      size={16}
                      style={{ color: mode === m ? "var(--accent)" : "var(--text-dim)" }}
                    />
                    <span className="export-opt-text">
                      <b>{title}</b>
                      <span>{sub}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="export-file">
              <Icon
                name={isCsv ? "table_view" : format === "json" ? "data_object" : "code"}
                size={15}
                style={{ color: "var(--text-dim)" }}
              />
              <span className="export-file-name">{fname}</span>
              {isAll ? <span className="export-cur">{tables.length} tables</span> : null}
            </div>
            <div className="modal-actions">
              <div style={{ flex: 1 }} />
              <Btn variant="text" onClick={onClose}>
                Cancel
              </Btn>
              <Btn variant="filled" icon="download" onClick={build}>
                Export
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="export-file">
              <Icon
                name={isCsv ? "table_view" : format === "json" ? "data_object" : "code"}
                size={15}
                style={{ color: "var(--text-dim)" }}
              />
              <span className="export-file-name">{fname}</span>
              {curTable && isAll && stage !== "done" ? (
                <span className="export-cur">{curTable}</span>
              ) : null}
            </div>
            <div className="export-bar">
              <div className="export-bar-fill" style={{ width: pct + "%" }} />
            </div>
            <div className="export-meta">
              <span>{stage === "done" ? "Done" : pct + "%"}</span>
            </div>
            {stage !== "done" ? (
              <div className="modal-actions">
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
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function CassImportModal({
  ks,
  table,
  tables,
  handleId,
  onClose,
  onDone,
}: {
  ks: string;
  table: string | null;
  tables: TableDescriptor[];
  handleId: string;
  onClose: () => void;
  onDone: (n: number) => void;
}) {
  const toast = useToast();
  const names = tables.map((t) => t.name);
  const [target, setTarget] = useState(table ?? names[0] ?? "");
  const [format, setFormat] = useState<ImportFormat>("cql");
  const [text, setText] = useState("");
  const [prev, setPrev] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<{ pct: number; rows: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const descriptorOf = (name: string) => tables.find((t) => t.name === name);

  const runPreview = (fmt: ImportFormat, txt: string, tgt: string) => {
    if (!txt.trim()) {
      setPrev(null);
      return;
    }
    const d = descriptorOf(tgt);
    if (!d) return;
    setPrev(previewImport(fmt, txt, d));
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fmt: ImportFormat = /\.csv$/i.test(file.name)
      ? "csv"
      : /\.json$/i.test(file.name)
        ? "json"
        : "cql";
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result);
      setFormat(fmt);
      setText(content);
      runPreview(fmt, content, target);
    };
    reader.readAsText(file);
  };

  const doImport = async () => {
    if (!prev || prev.error || !prev.count) return;
    setBusy({ pct: 0, rows: 0, total: prev.count });
    try {
      const n = await applyImport(handleId, ks, target, prev.rows, (p, d, t) =>
        setBusy({ pct: Math.round(p * 100), rows: d, total: t }),
      );
      toast(
        "Imported " +
          n.toLocaleString() +
          " row" +
          (n === 1 ? "" : "s") +
          " into " +
          ks +
          "." +
          target,
        "ok",
      );
      onDone(n);
    } catch (err) {
      toast((err as Error).message ?? "Import failed", "err");
      setBusy(null);
    }
  };

  const placeholder =
    format === "csv"
      ? "Paste CSV — first row is the header matching column names:\nuser_id,name,country"
      : format === "json"
        ? 'Paste a JSON array of rows, or { "rows": [ … ] }'
        : "Paste CQL INSERT statements:\nINSERT INTO " +
          ks +
          "." +
          target +
          " (user_id, name) VALUES (…, 'Ada');";

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal import-modal">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="upload" size={17} style={{ color: "var(--accent)" }} /> Import rows
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>

        <div className="import-format">
          <label className="mg-import-target">
            <span>Into</span>
            <select
              className="filter-select"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                runPreview(format, text, e.target.value);
              }}
            >
              {names.map((c) => (
                <option key={c} value={c}>
                  {ks}.{c}
                </option>
              ))}
            </select>
          </label>
          <div className="seg">
            {(["cql", "json", "csv"] as const).map((f) => (
              <button
                key={f}
                className={"seg-btn" + (format === f ? " active" : "")}
                onClick={() => {
                  setFormat(f);
                  runPreview(f, text, target);
                }}
              >
                <Icon
                  name={f === "cql" ? "code" : f === "json" ? "data_object" : "table_view"}
                  size={14}
                />{" "}
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <Btn icon="folder_open" variant="tonal" small onClick={() => fileRef.current?.click()}>
            Choose file…
          </Btn>
          <input
            ref={fileRef}
            type="file"
            accept=".cql,.json,.csv,.txt"
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
            runPreview(format, e.target.value, target);
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
                  {prev.count.toLocaleString()} row{prev.count === 1 ? "" : "s"} ready
                </span>
                <span className="import-match">{prev.columns.length} columns</span>
                {prev.missingKey ? (
                  <span className="import-unknown">
                    <Icon name="warning" size={12} /> {prev.missingKey} missing a primary-key value
                  </span>
                ) : null}
              </div>
              <div className="import-preview-grid">
                <CassRowGrid table={{ columns: prev.columns }} rows={prev.rows.slice(0, 5)} />
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
              <span>writing… {busy.pct}%</span>
              <span>
                {busy.rows.toLocaleString()} / {busy.total.toLocaleString()} rows
              </span>
            </div>
          </div>
        ) : (
          <div className="modal-actions">
            <div className="import-note">
              Rows are written by primary key — an existing key upserts (Cassandra has no separate
              INSERT vs UPDATE).
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
      </div>
    </div>
  );
}
