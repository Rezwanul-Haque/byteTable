// Drop-schema confirm modal (M15 SQL enhancements) — ported from the
// prototype's `schema-import.jsx` `DropSchemaModal`, on the shared Modal
// (focus trap + Esc + scrim) and the same `.truncate-modal` family the
// TruncateModal uses.
//
// Destructive + env-aware: it drops EVERY table in the schema and leaves an
// empty schema (Postgres DROP+CREATE SCHEMA atomic; MySQL DROP+CREATE DATABASE
// non-atomic; SQLite drops all user tables). A non-production connection gets a
// simple confirm; a `production` connection requires the user to TYPE the
// schema name to arm the destructive button (the M11 production-confirm rigor).
//
// It shows the table list (name + row count) and the DROP/CREATE SQL preview.
// On confirm it calls the `dropSchema` wrapper, then on success toasts,
// refreshes the sidebar (invalidate + force-reload the now-empty table list),
// and bumps any open data grid for a table in this schema (those tabs will
// error on refetch since the table is gone — acceptable; the schema is empty).
// A backend error is surfaced inside the modal and the dialog stays open.

import { useState } from "react";

import { dropSchema, type TableInfo } from "../../../shared/api/engine";
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

export function DropSchemaModal({
  handleId,
  schemaName,
  tables,
  env,
  onClose,
  onDone,
}: {
  handleId: string;
  schemaName: string;
  /** The schema's current tables (for the list + total-row summary). */
  tables: TableInfo[];
  /** Connection deployment env; `production` triggers the type-to-confirm gate. */
  env: string;
  onClose: () => void;
  /** Called after a successful drop so callers can react (e.g. close tabs). */
  onDone?: () => void;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normEnv = normalizeEnv(env);
  const isProd = normEnv === "production";
  const envColor = ENV_COLOR[normEnv];
  // Production gate: the typed name must match exactly. Else always armed.
  const armed = !isProd || typed.trim() === schemaName;

  const tableCount = tables.length;
  const totalRows = tables.reduce((n, t) => n + (t.approxRowCount ?? 0), 0);

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await dropSchema(handleId, schemaName);
        // Refresh the sidebar: drop this schema's cached lists/metas, then
        // force-reload (it is empty now).
        const introspection = useIntrospectionStore.getState();
        introspection.invalidate(handleId, schemaName);
        void introspection.loadTables(handleId, schemaName, { force: true });
        // Bump any open data grid for a table in this schema — the table is
        // gone, so the grid will surface a §5 on refetch (acceptable; the
        // schema is now empty).
        const { workspaces } = useWorkspacesStore.getState();
        const { requestRefetch } = useTabMetaStore.getState();
        for (const ws of workspaces) {
          if (ws.handleId !== handleId) continue;
          for (const tab of ws.ui.tabs ?? []) {
            if (tab.kind === "table" && tab.schema === schemaName) requestRefetch(tab.id);
          }
        }
        toast("Dropped schema " + schemaName + " — emptied", "ok");
        onDone?.();
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not drop the schema."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal onClose={onClose} label="Drop schema" width={480} className="truncate-modal">
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> Drop schema
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This drops{" "}
          <b>
            all {tableCount} table{tableCount === 1 ? "" : "s"}
          </b>{" "}
          in <code>{schemaName}</code> and their <b>{totalRows.toLocaleString()} rows</b>, then
          leaves an empty schema ready to recreate &amp; re-import. This cannot be undone.
        </p>
        <pre className="truncate-sql">
          DROP SCHEMA {schemaName} CASCADE;{"\n"}CREATE SCHEMA {schemaName};
        </pre>
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
        {isProd ? (
          <div className="truncate-prod">
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
        ) : null}
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
          <span>{busy ? "Dropping…" : "Drop schema"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
