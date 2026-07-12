// Confirm modal for the grid's bulk "delete selected" (M17). Mirrors the SQL
// TruncateModal's env-aware rigor: a non-production connection gets a plain
// confirm; a `production` connection requires the user to TYPE the table name to
// arm the destructive button. On confirm it runs the chunked
// BatchWriteItem-delete and reports the count; errors stay inside the modal.

import { useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../../shared/ui/Modal";
import { useToast } from "../../../../shared/ui/toastContext";
import { dynamoBatchDelete, type DynamoItem } from "../api";
// Reuse the SQL truncate modal's destructive styling (.truncate-*, .btn-danger).
import "../../../export/components/TruncateModal.css";

const DANGER = "#e06c75";

export function DynamoDeleteModal({
  handleId,
  table,
  isProduction,
  keys,
  onClose,
  onDone,
}: {
  handleId: string;
  table: string;
  isProduction: boolean;
  /** Primary keys (PK + optional SK) of the selected items to delete. */
  keys: DynamoItem[];
  onClose: () => void;
  /** Called after a successful delete (clear selection + refetch). */
  onDone: () => void;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = keys.length;
  // Production gate: the typed name must match the table exactly.
  const armed = !isProduction || typed.trim() === table;

  const confirm = () => {
    if (!armed || busy || n === 0) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const res = await dynamoBatchDelete(handleId, table, keys);
        toast(
          `Deleted ${res.written} item${res.written === 1 ? "" : "s"} from ${table}` +
            (res.unprocessed ? ` · ${res.unprocessed} unprocessed` : ""),
          "ok",
        );
        onDone();
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not delete the selected items."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal onClose={onClose} label="Delete selected items" width={460} className="truncate-modal">
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> Delete selected items
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This permanently deletes{" "}
          <b>
            {n} item{n === 1 ? "" : "s"}
          </b>{" "}
          from <code>{table}</code>. This cannot be undone.
        </p>
        {isProduction ? (
          <div className="truncate-prod">
            <div
              className="truncate-prod-tag"
              style={{ color: DANGER, borderColor: DANGER + "66", background: DANGER + "14" }}
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
          <span>{busy ? "Deleting…" : `Delete ${n} item${n === 1 ? "" : "s"}`}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
