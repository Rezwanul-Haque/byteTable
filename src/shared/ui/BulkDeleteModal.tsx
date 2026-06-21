// Generic confirm modal for a grid's bulk "delete selected". Env-aware rigor
// (mirrors the SQL TruncateModal / Dynamo delete modal): a non-production
// connection gets a plain confirm; a production connection requires typing the
// target name (table / collection / db) to arm the destructive button. The
// engine supplies `onConfirm` (the actual delete) and the row noun; errors stay
// inside the modal.

import { useState } from "react";

import { appErrorMessage } from "../api/error";
import { Btn } from "./Btn";
import { Icon } from "./Icon";
import { Modal, ModalActions, ModalTitle } from "./Modal";
// Reuse the SQL truncate modal's destructive styling (.truncate-*, .btn-danger).
import "../../features/export/components/TruncateModal.css";

const DANGER = "#e06c75";

export function BulkDeleteModal({
  count,
  target,
  noun = "row",
  isProduction,
  onConfirm,
  onClose,
  onDone,
}: {
  /** Number of selected rows being deleted. */
  count: number;
  /** Name typed to confirm on production (table / collection / db). */
  target: string;
  /** Singular noun for the rows ("row", "document", "key", "item"). */
  noun?: string;
  isProduction: boolean;
  /** Perform the delete; resolve with the deleted count (or void). Throws on error. */
  onConfirm: () => Promise<number | void>;
  onClose: () => void;
  /** Called after a successful delete (clear selection + refetch). */
  onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plural = (n: number) => `${noun}${n === 1 ? "" : "s"}`;
  const armed = !isProduction || typed.trim() === target;

  const confirm = () => {
    if (!armed || busy || count === 0) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await onConfirm();
        onDone();
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, `Could not delete the selected ${plural(count)}.`));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={"Delete selected " + plural(count)}
      width={460}
      className="truncate-modal"
    >
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> Delete selected {plural(count)}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This permanently deletes{" "}
          <b>
            {count} {plural(count)}
          </b>{" "}
          from <code>{target}</code>. This cannot be undone.
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
              Type <b>{target}</b> to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={target}
                spellCheck="false"
                autoFocus
                aria-label={"Type " + target + " to confirm"}
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
          <span>{busy ? "Deleting…" : `Delete ${count} ${plural(count)}`}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
