// Schema-level import modal (M15 SQL enhancements) — ported from the
// prototype's `bytetable/schema-import.jsx` `SchemaImportModal` (minus the
// destructive DropSchemaModal, intentionally out of scope for this task).
//
// Imports a multi-table `.sql` dump into one schema. Flow: pick a `.sql` file
// via the native open dialog → `readTextFile` → preview client-side
// (`previewSchema` lists the tables it would touch + each table's INSERT row
// count + the total) → on Import, run the WHOLE dump server-side via
// `importSql(handle, schema, path)` (it re-reads + executes the file; atomic on
// SQLite/Postgres, non-atomic on MySQL). Running the original file (not the
// parsed text) preserves DDL and ordering exactly — the preview is purely
// informational, so a dump that CREATEs new tables imports fine.
//
// Success → toast + refresh the sidebar (invalidate + force-reload the table
// list) so any new tables appear; the dialog stays open on error with the §5
// message inline.

import { useState } from "react";

import { importSql, readTextFile } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { useTabMetaStore } from "../../workspaces/tabMeta";
import { isSchemaPreviewError, previewSchema, type SchemaPreviewResult } from "../parse";
import "./ImportModal.css";

async function openSqlDialog(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    multiple: false,
    filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
  });
  return typeof chosen === "string" ? chosen : null;
}

export function SchemaImportModal({
  handleId,
  schemaName,
  onClose,
  onDone,
}: {
  handleId: string;
  schemaName: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const toast = useToast();
  // The chosen file's path (run as-is by import_sql) + its preview.
  const [path, setPath] = useState<string | null>(null);
  const [prev, setPrev] = useState<SchemaPreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onChooseFile = () => {
    void (async () => {
      let chosen: string | null;
      try {
        chosen = await openSqlDialog();
      } catch {
        toast("Import requires the desktop app", "info");
        return;
      }
      if (!chosen) return; // cancelled
      try {
        const contents = await readTextFile(chosen);
        setPath(chosen);
        setPrev(previewSchema(contents));
        setError(null);
      } catch (err) {
        setError(appErrorMessage(err, "Could not read the file."));
      }
    })();
  };

  const ok = prev !== null && !isSchemaPreviewError(prev);
  const canImport = ok && path !== null && prev.totalStatements > 0 && !busy;

  const doImport = () => {
    if (!canImport || path === null) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const { statements } = await importSql(handleId, schemaName, path);
        // Refresh the sidebar so newly created tables appear.
        const introspection = useIntrospectionStore.getState();
        introspection.invalidate(handleId, schemaName);
        void introspection.loadTables(handleId, schemaName, { force: true });
        // Bump any open data grid in this schema (existing tables may have grown).
        const { workspaces } = useWorkspacesStore.getState();
        const { requestRefetch } = useTabMetaStore.getState();
        for (const ws of workspaces) {
          if (ws.handleId !== handleId) continue;
          for (const tab of ws.ui.tabs ?? []) {
            if (tab.kind === "table" && tab.schema === schemaName) requestRefetch(tab.id);
          }
        }
        const file = path.split(/[\\/]/).pop() ?? path;
        toast("Imported " + file + " — " + statements.toLocaleString() + " statements", "ok");
        onDone?.();
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not import the dump."));
        setBusy(false);
      }
    })();
  };

  const fileName = path ? (path.split(/[\\/]/).pop() ?? path) : null;

  return (
    <Modal
      onClose={onClose}
      label={"Import SQL dump into " + schemaName}
      width={620}
      className="import-modal"
    >
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="upload" size={17} style={{ color: "var(--accent)" }} /> Import SQL dump →{" "}
          {schemaName}
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </ModalTitle>

      <div className="import-format">
        <span className="import-note" style={{ flex: 1 }}>
          Choose a multi-table <code>.sql</code> dump. The whole file (DDL + INSERTs) runs into{" "}
          <code>{schemaName}</code>. {fileName ? <b>{fileName}</b> : null}
        </span>
        <Btn icon="folder_open" variant="tonal" small onClick={onChooseFile}>
          Choose .sql file…
        </Btn>
      </div>

      {prev !== null ? (
        isSchemaPreviewError(prev) ? (
          <div className="import-err">
            <Icon name="error" size={14} /> {prev.error}
          </div>
        ) : (
          <div className="import-preview">
            <div className="import-preview-bar">
              <span className="import-ready">
                <Icon name="check_circle" size={14} style={{ color: "var(--accent)" }} />{" "}
                {prev.totalStatements.toLocaleString()} rows · {prev.groups.length} table
                {prev.groups.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="schema-import-list">
              {prev.groups.map((g) => (
                <div key={g.table} className="schema-import-row">
                  <Icon name="table" size={14} style={{ color: "var(--accent)" }} />
                  <span className="schema-import-name">{g.table}</span>
                  <span className="schema-import-rows">{g.rowCount.toLocaleString()} rows</span>
                </div>
              ))}
            </div>
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
          The dump runs as written. On SQLite/Postgres the whole import rolls back on any error; on
          MySQL it does not (DDL auto-commits).
        </div>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="filled" icon="upload" onClick={doImport} disabled={!canImport}>
          {busy ? "Importing…" : "Import all"}
        </Btn>
      </ModalActions>
    </Modal>
  );
}
