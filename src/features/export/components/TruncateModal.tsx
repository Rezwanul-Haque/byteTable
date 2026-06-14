// Truncate confirm modal (M15 Task 2) — ported from the prototype's
// export.jsx `TruncateModal`, on the shared Modal (focus trap + Esc + scrim).
//
// Destructive + env-aware: a non-production connection gets a simple confirm;
// a `production` connection requires the user to TYPE the table name to arm the
// destructive button (the M11 production-confirm rigor, stronger gate). On
// confirm it calls the Task-1 `truncateTable` wrapper, then on success toasts
// "Truncated {table} — N rows removed" (using the returned affected count),
// force-refreshes the schema's table list (sidebar counts) and calls `onDone`
// so the open data grid re-fetches; the modal then closes. A backend error
// (e.g. MySQL TRUNCATE on an FK-parent table) is surfaced inside the modal and
// the dialog stays open.

import { useState } from "react";

import { truncateTable } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { useIntrospectionStore } from "../../introspection/state";
import "./TruncateModal.css";

const DANGER = "#e06c75";

export function TruncateModal({
  handleId,
  schemaName,
  table,
  env,
  onClose,
  onDone,
}: {
  handleId: string;
  schemaName: string;
  table: string;
  /** Connection deployment env; `production` triggers the type-to-confirm gate. */
  env: string;
  onClose: () => void;
  /** Called after a successful truncate so callers can refresh the open grid. */
  onDone?: () => void;
}) {
  const toast = useToast();
  const loadTables = useIntrospectionStore((s) => s.loadTables);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isProd = env === "production";
  // Production gate: the typed name must match exactly. Else always armed.
  const armed = !isProd || typed.trim() === table;

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const { affected } = await truncateTable(handleId, schemaName, table);
        // Refresh sidebar counts (force drops the schema's cached lists/metas)
        // and let the caller re-fetch the open grid for this table.
        void loadTables(handleId, schemaName, { force: true });
        onDone?.();
        toast("Truncated " + table + " — " + affected.toLocaleString() + " rows removed", "ok");
        onClose();
      } catch (err) {
        // Keep the modal open and show the §5 message where the action was.
        setError(appErrorMessage(err, "Could not truncate the table."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal onClose={onClose} label="Truncate table" width={460} className="truncate-modal">
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> Truncate table
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This permanently deletes <b>all rows</b> from{" "}
          <code>
            {schemaName}.{table}
          </code>
          . The table structure is kept. This cannot be undone.
        </p>
        <pre className="truncate-sql">TRUNCATE TABLE {table};</pre>
        {isProd ? (
          <div className="truncate-prod">
            <div
              className="truncate-prod-tag"
              style={{
                color: DANGER,
                borderColor: DANGER + "66",
                background: DANGER + "14",
              }}
            >
              <Icon name="public" size={13} /> production
            </div>
            <label>
              Type <b>{table}</b> to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={table}
                spellCheck="false"
                autoFocus
                aria-label={"Type " + table + " to confirm"}
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
          <span>{busy ? "Truncating…" : "Truncate"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
