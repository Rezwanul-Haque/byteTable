// Drop-table confirm modal — the destructive sibling of {@link TruncateModal},
// on the same shared Modal + `.truncate-*` family (the same relationship
// DeleteSchemaModal has to EmptySchemaModal, one level down: truncate empties
// the table, this removes it).
//
// Because the table is gone afterward — not merely empty — this one always
// requires the name to be typed, not just on production connections, matching
// DeleteSchemaModal's reasoning: there is nothing left to re-import into. The
// env tag still escalates the visual weight on a production connection.
//
// Foreign keys: a referencing FK is the usual reason the engine refuses, so the
// modal offers the engine's own way through (Postgres CASCADE, MySQL/SQLite FK
// checks off, SQL Server drops the referencing constraints) as an opt-in
// checkbox — see `fkOverride.ts` for the per-engine copy and previewed SQL.
//
// On success it force-refreshes the schema's table list (the sidebar drops the
// row) and hands control back via `onDropped` so the caller can close whatever
// still points at the table. A backend error is surfaced inside the modal and
// the dialog stays open.

import { useState } from "react";

import { dropTable } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { useToast } from "../../../shared/ui/toastContext";
import { normalizeEnv, type Engine } from "../../../shared/types";
import { useIntrospectionStore } from "../../introspection/state";
import { dropFkOverride, dropSql } from "../fkOverride";
import "./TruncateModal.css";

const DANGER = "#e06c75";

export function DropTableModal({
  handleId,
  schemaName,
  table,
  engine,
  env,
  rowCount,
  onClose,
  onDropped,
}: {
  handleId: string;
  schemaName: string;
  table: string;
  /** Connection engine — shapes the FK-override copy and the previewed SQL. */
  engine?: Engine;
  /** Connection deployment env; `production` escalates the visual weight. */
  env: string;
  /** The table's (approximate) row count for the summary line, when known. */
  rowCount?: number | null;
  onClose: () => void;
  /** Called after a successful drop so the caller can close what pointed at it. */
  onDropped?: () => void;
}) {
  const toast = useToast();
  const loadTables = useIntrospectionStore((s) => s.loadTables);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normEnv = normalizeEnv(env);
  const isProd = normEnv === "production";
  const envColor = ENV_COLOR[normEnv];
  // Always type-to-confirm: unlike emptying, this cannot be re-imported into.
  const armed = typed.trim() === table;
  const fk = dropFkOverride(engine);

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await dropTable(handleId, schemaName, table, force && !!fk);
        // Force-refresh so the sidebar loses the row (and its column caches).
        void loadTables(handleId, schemaName, { force: true });
        onDropped?.();
        toast("Dropped " + table, "ok");
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not drop the table."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal onClose={onClose} label="Drop table" width={460} className="truncate-modal">
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> Drop table
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This removes the table{" "}
          <code>
            {schemaName}.{table}
          </code>{" "}
          itself — its structure, its indexes and{" "}
          {rowCount === null || rowCount === undefined ? (
            <b>all its rows</b>
          ) : (
            <b>all {rowCount.toLocaleString()} rows</b>
          )}
          . Nothing is left to re-import into. This cannot be undone.
        </p>
        <pre className="truncate-sql">{dropSql(engine, table, force && !!fk)}</pre>
        {fk ? (
          <label className={"truncate-fk" + (force ? " on" : "")}>
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              disabled={busy}
            />
            <span className="truncate-fk-text">
              <span className="truncate-fk-label">{fk.label}</span>
              <span className="truncate-fk-hint">{fk.hint}</span>
            </span>
          </label>
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
          <span>{busy ? "Dropping…" : "Drop table"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
