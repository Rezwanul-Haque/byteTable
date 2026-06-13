// Table-level import modal (M15 SQL enhancements) — ported from the prototype's
// `bytetable/import.jsx` `ImportModal`. Imports CSV or SQL-INSERT data into one
// target table `{schema, table}`.
//
// Flow: pick a file via the native open dialog (CSV/SQL/TXT filters) →
// `readTextFile` → detect format by extension (`.sql` → sql, else csv) →
// preview client-side against the target's columns (matched/unknown chips +
// row count + a sample) → on Import, build `INSERT INTO "schema"."table"
// (matchedCols) VALUES (...)` statements (escaping per the export side's
// sql-value rules) and run them via `executeScriptText`. The user can also
// paste text directly and pick the format with the segmented control.
//
// Success → toast "Imported N rows into {table}" + refresh: drop the schema's
// introspection cache, force-reload its table list (sidebar counts), and bump
// any open data grid for this table so the new rows appear. The dialog stays
// open on error and shows the §5 message inline.

import { useEffect, useMemo, useState } from "react";

import { executeScriptText, readTextFile, type ColumnInfo } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { columnsKey, useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { useTabMetaStore } from "../../workspaces/tabMeta";
import {
  buildInsertScript,
  isPreviewError,
  previewTable,
  type ImportFormat,
  type TablePreviewResult,
} from "../parse";
import "./ImportModal.css";

/** Lazily import the dialog plugin so plain-browser dev does not crash at load. */
async function openFileDialog(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    multiple: false,
    filters: [
      { name: "CSV or SQL", extensions: ["csv", "sql", "txt"] },
      { name: "CSV file", extensions: ["csv"] },
      { name: "SQL file", extensions: ["sql"] },
    ],
  });
  return typeof chosen === "string" ? chosen : null;
}

export function ImportModal({
  handleId,
  schemaName,
  table,
  onClose,
  onDone,
}: {
  handleId: string;
  schemaName: string;
  table: string;
  onClose: () => void;
  /** Called after a successful import (caller re-fetches the open grid). */
  onDone?: () => void;
}) {
  const toast = useToast();
  const loadColumns = useIntrospectionStore((s) => s.loadColumns);
  const columnsEntry = useIntrospectionStore(
    (s) => s.columns[columnsKey(handleId, schemaName, table)],
  );

  const [format, setFormat] = useState<ImportFormat>("csv");
  const [text, setText] = useState("");
  const [prev, setPrev] = useState<TablePreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The target columns come from the introspection cache (warm them on open).
  const columns: ColumnInfo[] = useMemo(() => columnsEntry?.columns ?? [], [columnsEntry]);
  useEffect(() => {
    void loadColumns(handleId, schemaName, table);
  }, [loadColumns, handleId, schemaName, table]);

  // Keep a stable ref to columns so the preview recomputes when they arrive.
  const runPreview = (fmt: ImportFormat, txt: string) => {
    if (!txt.trim()) {
      setPrev(null);
      return;
    }
    setPrev(previewTable(fmt, txt, columns));
  };

  // Re-run the preview when the target columns finish loading (so matched/
  // unknown reflects the real schema, not an empty column list).
  useEffect(() => {
    if (text.trim()) setPrev(previewTable(format, text, columns));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  const onChooseFile = () => {
    void (async () => {
      let path: string | null;
      try {
        path = await openFileDialog();
      } catch {
        toast("Import requires the desktop app", "info");
        return;
      }
      if (!path) return; // cancelled
      try {
        const contents = await readTextFile(path);
        const fmt: ImportFormat = /\.sql$/i.test(path) ? "sql" : "csv";
        setFormat(fmt);
        setText(contents);
        runPreview(fmt, contents);
        setError(null);
      } catch (err) {
        setError(appErrorMessage(err, "Could not read the file."));
      }
    })();
  };

  const canImport = prev !== null && !isPreviewError(prev) && prev.count > 0 && !busy;

  const doImport = () => {
    if (prev === null || isPreviewError(prev) || prev.count === 0 || busy) return;
    const { matched, objects } = prev;
    if (!matched.length) {
      setError("No columns match this table — nothing to import.");
      return;
    }
    // Build the INSERT script in the target table's column order (matched only).
    const ordered = columns.map((c) => c.name).filter((name) => matched.includes(name));
    const script = buildInsertScript(schemaName, table, ordered, objects);
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await executeScriptText(handleId, schemaName, script);
        const n = objects.length;
        // Refresh: sidebar counts + any open data grid for this table.
        const introspection = useIntrospectionStore.getState();
        introspection.invalidate(handleId, schemaName);
        void introspection.loadTables(handleId, schemaName, { force: true });
        const { workspaces } = useWorkspacesStore.getState();
        const { requestRefetch } = useTabMetaStore.getState();
        for (const ws of workspaces) {
          if (ws.handleId !== handleId) continue;
          for (const tab of ws.ui.tabs ?? []) {
            if (tab.kind === "table" && tab.schema === schemaName && tab.table === table) {
              requestRefetch(tab.id);
            }
          }
        }
        toast(
          "Imported " + n.toLocaleString() + " row" + (n === 1 ? "" : "s") + " into " + table,
          "ok",
        );
        onDone?.();
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not import the data."));
        setBusy(false);
      }
    })();
  };

  const placeholder =
    format === "csv"
      ? "Paste CSV — first row is the header:\n" + columns.map((c) => c.name).join(",") + "\n…"
      : "Paste INSERT statements:\nINSERT INTO " +
        table +
        " (" +
        columns.map((c) => c.name).join(", ") +
        ") VALUES (…);";

  // The sample rows for the preview: the matched columns, first 5 rows.
  const sampleColumns =
    prev !== null && !isPreviewError(prev)
      ? columns.filter((c) => prev.matched.includes(c.name))
      : [];
  const sampleRows = prev !== null && !isPreviewError(prev) ? prev.objects.slice(0, 5) : [];

  return (
    <Modal
      onClose={onClose}
      label={"Import into " + schemaName + "." + table}
      width={620}
      className="import-modal"
    >
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="upload" size={17} style={{ color: "var(--accent)" }} /> Import into{" "}
          {schemaName}.{table}
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </ModalTitle>

      <div className="import-format">
        <div className="seg" role="tablist" aria-label="Import format">
          <button
            type="button"
            role="tab"
            aria-selected={format === "csv"}
            className={"seg-btn" + (format === "csv" ? " active" : "")}
            onClick={() => {
              setFormat("csv");
              runPreview("csv", text);
            }}
          >
            <Icon name="table_view" size={14} /> CSV
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={format === "sql"}
            className={"seg-btn" + (format === "sql" ? " active" : "")}
            onClick={() => {
              setFormat("sql");
              runPreview("sql", text);
            }}
          >
            <Icon name="code" size={14} /> SQL inserts
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <Btn icon="folder_open" variant="tonal" small onClick={onChooseFile}>
          Choose file…
        </Btn>
      </div>

      <textarea
        className="import-textarea"
        spellCheck="false"
        aria-label="Import data"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          runPreview(format, e.target.value);
          setError(null);
        }}
      />

      {prev !== null ? (
        isPreviewError(prev) ? (
          <div className="import-err">
            <Icon name="error" size={14} /> {prev.error}
          </div>
        ) : (
          <div className="import-preview">
            <div className="import-preview-bar">
              <span className="import-ready">
                <Icon name="check_circle" size={14} style={{ color: "var(--accent)" }} />{" "}
                {prev.count.toLocaleString()} rows ready
              </span>
              <span className="import-match">
                {prev.matched.length} matched column{prev.matched.length === 1 ? "" : "s"}
              </span>
              {prev.unknown.length ? (
                <span className="import-unknown">ignoring: {prev.unknown.join(", ")}</span>
              ) : null}
            </div>
            {sampleColumns.length ? (
              <div className="import-preview-grid">
                <table className="import-sample">
                  <thead>
                    <tr>
                      {sampleColumns.map((c) => (
                        <th key={c.name}>{c.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sampleRows.map((row, ri) => (
                      <tr key={ri}>
                        {sampleColumns.map((c) => {
                          const v = row[c.name];
                          return (
                            <td
                              key={c.name}
                              className={v === null || v === undefined ? "is-null" : undefined}
                            >
                              {v === null || v === undefined ? "NULL" : String(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        )
      ) : null}

      {error ? (
        <div className="import-err">
          <Icon name="error" size={14} /> {error}
        </div>
      ) : null}

      <ModalActions>
        <div className="import-note">
          Rows are appended (one INSERT per row). Unknown columns are ignored; missing columns use
          the table&apos;s defaults.
        </div>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="filled" icon="upload" onClick={doImport} disabled={!canImport}>
          {busy ? "Importing…" : "Import"}
        </Btn>
      </ModalActions>
    </Modal>
  );
}
