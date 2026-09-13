// Cassandra export & import modals (M19 §19.8, ported from cassandra-io.jsx):
// format + contents pickers, target-table select, progress bars, preview grid.
// Reuses the shared .export-* / .import-* / .ddb-io-* chrome.

import { useMemo, useRef, useState } from "react";

import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { useToast } from "../../../../shared/ui/toastContext";
import { exportStamp } from "../../../export/exportFlow";
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

const EXPORT_FORMATS: {
  id: ExportFormat;
  labelKey: "cass.io.fmtCql" | "cass.io.fmtJson" | "cass.io.fmtCsv";
  icon: string;
}[] = [
  { id: "cql", labelKey: "cass.io.fmtCql", icon: "code" },
  { id: "json", labelKey: "cass.io.fmtJson", icon: "data_object" },
  { id: "csv", labelKey: "cass.io.fmtCsv", icon: "table_view" },
];

export function CassExportModal({
  scope,
  ks,
  keyspaceInfo,
  table,
  tables,
  handleId,
  /** Connection's deployment env — goes into the filename (`exportStamp`). */
  env,
  onClose,
}: {
  scope: "table" | "all";
  ks: string;
  keyspaceInfo: KeyspaceInfo | null;
  table?: string;
  tables: TableDescriptor[];
  handleId: string;
  env?: string;
  onClose: () => void;
}) {
  const t = useT();
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
  // One stamp per modal (not per render) so the name shown while choosing is the
  // name the file is downloaded under.
  const stamp = useMemo(() => exportStamp(env), [env]);
  const fname =
    base +
    (effMode === "schema" ? "_schema" : effMode === "data" && !isCsv ? "_data" : "") +
    stamp +
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
        toast(t("cass.io.exportedFile", { file: fname }), "ok");
        setTimeout(() => !cancelled.current && onClose(), 700);
      } catch (e) {
        toast((e as Error).message ?? t("cass.io.exportFailed"), "err");
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
              ? t("cass.io.exportComplete")
              : stage === "choose"
                ? isAll
                  ? t("cass.io.exportKeyspace", { ks })
                  : t("cass.io.exportTable", { table: table ?? "" })
                : t("cass.io.exporting")}
          </span>
          {stage !== "building" ? (
            <IconBtn icon="close" onClick={onClose} title={t("cass.io.close")} />
          ) : null}
        </div>

        {stage === "choose" ? (
          <>
            <div className="ddb-io-label">{t("cass.io.format")}</div>
            <div className="seg ddb-io-seg">
              {EXPORT_FORMATS.map((f) => {
                const disabled = isAll && f.id === "csv";
                return (
                  <button
                    key={f.id}
                    className={"seg-btn" + (format === f.id ? " active" : "")}
                    disabled={disabled}
                    title={disabled ? t("cass.io.csvPerTable") : ""}
                    onClick={() => setFormat(f.id)}
                  >
                    <Icon name={f.icon} size={14} /> {t(f.labelKey)}
                  </button>
                );
              })}
            </div>

            <div className="ddb-io-label">{t("cass.io.contents")}</div>
            {isCsv ? (
              <div className="export-file" style={{ marginTop: 0 }}>
                <Icon name="table_view" size={15} style={{ color: "var(--text-dim)" }} />
                <span className="export-file-name">{t("cass.io.csvNote")}</span>
              </div>
            ) : (
              <div className="export-choose">
                {(
                  [
                    [
                      "both",
                      "schema",
                      t("cass.io.schemaPlusData"),
                      format === "cql" ? t("cass.io.schemaPlusDataHint") : t("cass.io.bothHint"),
                    ],
                    [
                      "schema",
                      "account_tree",
                      t("cass.io.schemaOnly"),
                      format === "cql" ? t("cass.io.schemaOnlyHint") : t("cass.io.justRows"),
                    ],
                    [
                      "data",
                      "table_rows",
                      t("cass.io.dataOnly"),
                      format === "cql" ? t("cass.io.dataOnlyHint") : t("cass.io.justRows"),
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
              {isAll ? (
                <span className="export-cur">
                  {t("cass.io.tableCount", { count: tables.length })}
                </span>
              ) : null}
            </div>
            <div className="modal-actions">
              <div style={{ flex: 1 }} />
              <Btn variant="text" onClick={onClose}>
                {t("cass.io.cancel")}
              </Btn>
              <Btn variant="filled" icon="download" onClick={build}>
                {t("cass.io.exportBtn")}
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
              <span>{stage === "done" ? t("cass.io.done") : pct + "%"}</span>
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
                  {t("cass.io.cancel")}
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
  const t = useT();
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
        t("cass.io.imported", {
          count: n.toLocaleString(),
          target: ks + "." + target,
        }),
        "ok",
      );
      onDone(n);
    } catch (err) {
      toast((err as Error).message ?? t("cass.io.importFailed"), "err");
      setBusy(null);
    }
  };

  const placeholder =
    format === "csv"
      ? t("cass.io.pasteCsv")
      : format === "json"
        ? t("cass.io.pasteJson")
        : t("cass.io.pasteCql") +
          "\nINSERT INTO " +
          ks +
          "." +
          target +
          " (user_id, name) VALUES (…, 'Ada');";

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal import-modal">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="upload" size={17} style={{ color: "var(--accent)" }} />{" "}
            {t("cass.io.importRows")}
          </span>
          <IconBtn icon="close" onClick={onClose} title={t("cass.io.close")} />
        </div>

        <div className="import-format">
          <label className="mg-import-target">
            <span>{t("cass.io.into")}</span>
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
            {t("cass.io.chooseFile")}
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
                  {t("cass.io.rowsReady", { count: prev.count.toLocaleString() })}
                </span>
                <span className="import-match">
                  {t("cass.io.columnsCount", { count: prev.columns.length })}
                </span>
                {prev.missingKey ? (
                  <span className="import-unknown">
                    <Icon name="warning" size={12} />{" "}
                    {t("cass.io.missingKey", { count: prev.missingKey })}
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
              <span>{t("cass.io.writing", { pct: busy.pct })}</span>
              <span>
                {t("cass.io.rowsProgress", {
                  done: busy.rows.toLocaleString(),
                  total: busy.total.toLocaleString(),
                })}
              </span>
            </div>
          </div>
        ) : (
          <div className="modal-actions">
            <div className="import-note">{t("cass.io.importNote")}</div>
            <Btn variant="text" onClick={onClose}>
              {t("cass.io.cancel")}
            </Btn>
            <Btn
              variant="filled"
              icon="upload"
              onClick={() => void doImport()}
              disabled={!prev || !!prev.error || !prev.count}
            >
              {t("cass.io.importBtn")}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}
