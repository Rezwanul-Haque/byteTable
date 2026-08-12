// Discard-unsaved confirm for closing tabs. A tab's staged grid batch and its
// pending structure ops live on `workspace.ui` keyed by tab id, and `closeTab`
// prunes both — so closing is destructive in a way the × does not advertise.
// This is the last stop: it names each tab at stake and what it holds.
//
// One dialog serves every close entry point (the tab's ×, Delete on a focused
// tab, middle-click, the strip's context menu, ⌘W) because they all park their
// request on `tabMeta.closeRequest` rather than each prompting for themselves.
// A batch close (Close others / to the right) confirms ONCE for the whole set:
// confirming closes all of it, cancelling closes none — the alternative, a
// prompt per dirty tab, turns one gesture into a quiz.

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
// Reuse the destructive styling the truncate/drop confirms already ship
// (.truncate-body / .btn-danger) so this reads as the same class of prompt.
import "../../export/components/TruncateModal.css";
import "./CloseTabsModal.css";

/** One tab the close would discard: its strip label + what it would lose. */
export interface UnsavedTab {
  id: string;
  label: string;
  /** e.g. "2 edited rows, 1 new row" (from `unsavedSummary`). */
  summary: string;
}

export function CloseTabsModal({
  unsaved,
  total,
  onConfirm,
  onCancel,
}: {
  /** The dirty tabs in the close set — never empty (the caller closes silently
   *  when nothing is dirty). */
  unsaved: UnsavedTab[];
  /** Tabs the action closes in total; larger than `unsaved` for a batch close
   *  that also sweeps up clean tabs. */
  total: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const one = unsaved.length === 1;
  const heading = one
    ? "Discard unsaved changes?"
    : "Discard unsaved changes in " + unsaved.length + " tabs?";
  const alsoClean = total - unsaved.length;

  return (
    <Modal onClose={onCancel} label={heading} width={460} className="truncate-modal">
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: "var(--error)" }} /> {heading}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {one ? "This tab has" : "These tabs have"} changes that are not in the database yet.
          Closing {one ? "it" : "them"} throws {one ? "that" : "those"} away — there is no undo.
        </p>
        <ul className="close-tabs-list">
          {unsaved.map((tab) => (
            <li key={tab.id}>
              <code>{tab.label}</code>
              <span className="close-tabs-summary">{tab.summary}</span>
            </li>
          ))}
        </ul>
        {alsoClean > 0 ? (
          <p className="close-tabs-note">
            {alsoClean} other {alsoClean === 1 ? "tab" : "tabs"} in this action{" "}
            {alsoClean === 1 ? "has" : "have"} nothing unsaved.
          </p>
        ) : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onCancel}>
          Keep editing
        </Btn>
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          <Icon name="close" size={16} />
          <span>{total === 1 ? "Discard & close" : "Discard & close " + total + " tabs"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
