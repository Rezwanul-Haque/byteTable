// Confirm for the two ways staged work gets thrown away, sharing one dialog
// because they show the same thing: which tabs are at stake and what each one
// holds. A tab's staged grid batch + pending structure ops live on
// `workspace.ui` keyed by tab id, and neither is recoverable once dropped.
//
//   intent="close"    the tab's ×, Delete on a focused tab, middle-click, the
//                     strip's context menu, ⌘W — all parked on
//                     `tabMeta.closeRequest` so one dialog answers for every
//                     entry point. A batch close (Close others / to the right)
//                     confirms ONCE: confirming closes all of it, cancelling
//                     closes none — a prompt per dirty tab turns one gesture
//                     into a quiz.
//   intent="discard"  the tab bar's reload button, which drops every tab's
//                     staged batch and leaves the tabs open.

import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
// Reuse the destructive styling the truncate/drop confirms already ship
// (.truncate-body / .btn-danger) so this reads as the same class of prompt.
import "../../export/components/TruncateModal.css";
import "./UnsavedTabsModal.css";

/** One tab at stake: its strip label + what it would lose. */
export interface UnsavedTab {
  id: string;
  label: string;
  /** e.g. "2 edited rows, 1 new row" (from `unsavedSummary`). */
  summary: string;
}

export function UnsavedTabsModal({
  intent,
  unsaved,
  total,
  onConfirm,
  onCancel,
}: {
  intent: "close" | "discard";
  /** The dirty tabs — never empty (a clean action does not prompt at all). */
  unsaved: UnsavedTab[];
  /** Tabs the action touches in total. Exceeds `unsaved.length` only for a batch
   *  close that also sweeps up clean tabs; equal to it when discarding. */
  total: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const closing = intent === "close";
  const one = unsaved.length === 1;
  const t = useT();
  const heading = one
    ? closing
      ? t("ws.unsaved.headingCloseOne")
      : t("ws.unsaved.headingDiscardOne")
    : t("ws.unsaved.headingMany", { count: unsaved.length });
  const alsoClean = total - unsaved.length;

  return (
    <Modal onClose={onCancel} label={heading} width={460} className="truncate-modal">
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: "var(--error)" }} /> {heading}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {closing
            ? one
              ? t("ws.unsaved.bodyCloseOne")
              : t("ws.unsaved.bodyCloseMany")
            : one
              ? t("ws.unsaved.bodyDiscardOne")
              : t("ws.unsaved.bodyDiscardMany")}
        </p>
        <ul className="unsaved-tabs-list">
          {unsaved.map((tab) => (
            <li key={tab.id}>
              <code>{tab.label}</code>
              <span className="unsaved-tabs-summary">{tab.summary}</span>
            </li>
          ))}
        </ul>
        {alsoClean > 0 ? (
          <p className="unsaved-tabs-note">{t("ws.unsaved.cleanNote", { count: alsoClean })}</p>
        ) : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onCancel}>
          {t("ws.unsaved.keepEditing")}
        </Btn>
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          <Icon name={closing ? "close" : "refresh"} size={16} />
          <span>
            {closing
              ? total === 1
                ? t("ws.unsaved.btnDiscardClose")
                : t("ws.unsaved.btnDiscardCloseMany", { count: total })
              : t("ws.unsaved.btnDiscardTabs", { count: total })}
          </span>
        </button>
      </ModalActions>
    </Modal>
  );
}
