// Delete-schema confirm modal (M34) — the destructive sibling of
// {@link EmptySchemaModal}, on the same shared Modal + `.truncate-modal`
// family.
//
// The distinction the two modals exist to make: "Empty schema" removes the
// tables and leaves the schema standing; this removes the schema itself. Until
// M34 only the first existed, which meant a schema created from the UI could
// never be removed from it.
//
// Because the schema is gone afterward — not merely empty — this one always
// requires the name to be typed, not just on production connections: there is
// nothing to re-import into if it was the wrong schema. The env tag still
// escalates the visual weight on a production connection.
//
// On confirm it calls `deleteSchema`, then hands control back to the caller via
// `onDeleted` (the sidebar re-introspects and switches to a surviving schema —
// this modal cannot leave the workspace pointing at something that no longer
// exists). A backend error is surfaced inside the modal and the dialog stays
// open; the engine refuses system schemas and, on MySQL/ClickHouse, the
// database the connection is currently using.

import { useState } from "react";

import { deleteSchema, type TableInfo } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { useToast } from "../../../shared/ui/toastContext";
import { normalizeEnv } from "../../../shared/types";
import { useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { useTabMetaStore } from "../../workspaces/tabMeta";
import "../../import/components/ImportModal.css";
import "./TruncateModal.css";

const DANGER = "#e06c75";

export function DeleteSchemaModal({
  handleId,
  schemaName,
  tables,
  env,
  onClose,
  onDeleted,
}: {
  handleId: string;
  schemaName: string;
  /** The schema's current tables (for the list + total-row summary). */
  tables: TableInfo[];
  /** Connection deployment env; `production` escalates the visual weight. */
  env: string;
  onClose: () => void;
  /** Called after a successful delete so the caller can move off this schema. */
  onDeleted: (deleted: string) => void;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normEnv = normalizeEnv(env);
  const isProd = normEnv === "production";
  const envColor = ENV_COLOR[normEnv];
  // Always type-to-confirm: unlike emptying, this cannot be re-imported into.
  const armed = typed.trim() === schemaName;

  const tableCount = tables.length;
  const totalRows = tables.reduce((n, t) => n + (t.approxRowCount ?? 0), 0);

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await deleteSchema(handleId, schemaName);
        // Drop this schema's cached lists/metas. Nothing re-loads them: the
        // schema is gone, and the caller is about to switch away from it.
        useIntrospectionStore.getState().invalidate(handleId, schemaName);
        // Any open grid for a table in this schema now points at nothing.
        const { workspaces } = useWorkspacesStore.getState();
        const { requestRefetch } = useTabMetaStore.getState();
        for (const ws of workspaces) {
          if (ws.handleId !== handleId) continue;
          for (const tab of ws.ui.tabs ?? []) {
            if (tab.kind === "table" && tab.schema === schemaName) requestRefetch(tab.id);
          }
        }
        toast("Deleted schema " + schemaName, "ok");
        onDeleted(schemaName);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not delete the schema."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal onClose={onClose} label="Delete schema" width={480} className="truncate-modal">
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> Delete schema
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This removes the schema <code>{schemaName}</code> itself
          {tableCount > 0 ? (
            <>
              , along with{" "}
              <b>
                all {tableCount} table{tableCount === 1 ? "" : "s"}
              </b>{" "}
              in it and their <b>{totalRows.toLocaleString()} rows</b>
            </>
          ) : null}
          . Nothing is left to re-import into. This cannot be undone.
        </p>
        <pre className="truncate-sql">DROP SCHEMA {schemaName} CASCADE;</pre>
        {tableCount > 0 ? (
          <div className="schema-import-list">
            {tables.map((t) => (
              <div key={t.name} className="schema-import-row">
                <Icon name="table" size={14} style={{ color: "var(--text-faint)" }} />
                <span className="schema-import-name">{t.name}</span>
                <span className="schema-import-rows">
                  {t.approxRowCount === null ? "—" : t.approxRowCount.toLocaleString() + " rows"}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="truncate-prod">
          {isProd ? (
            <div
              className="truncate-prod-tag"
              style={{
                color: envColor,
                borderColor: envColor + "66",
                background: envColor + "14",
              }}
            >
              <Icon name="public" size={13} /> production
            </div>
          ) : null}
          <label>
            Type <b>{schemaName}</b> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={schemaName}
              spellCheck="false"
              autoFocus
              aria-label={"Type " + schemaName + " to confirm"}
            />
          </label>
        </div>
        {error ? <div className="truncate-error">{error}</div> : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy ? "" : " disabled")}
          disabled={!armed || busy}
          onClick={confirm}
        >
          <Icon name="delete_forever" size={16} />
          <span>{busy ? "Deleting…" : "Delete schema"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
