// Save / Discard / Cancel for notebooks with unsaved changes (M47 B4) — on
// closing their tabs, and on quitting the app. Styled as the workspace's own
// unsaved-tabs confirm, with Save added: a notebook, unlike a staged grid
// batch, has somewhere to go.
//
// Save writes each notebook in turn (asking where for one never saved); if a
// save dialog is cancelled the prompt stays, so no path loses edits silently.

import { useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { saveNotebook } from "../files";
import { useNotebooksStore } from "../state";
import "../../export/components/TruncateModal.css";
import "../../workspaces/components/UnsavedTabsModal.css";

export function UnsavedNotebooksModal({
  tabIds,
  intent,
  onDone,
  onCancel,
}: {
  /** The notebook tabs with unsaved changes. */
  tabIds: string[];
  intent: "close" | "quit";
  /** Saved or discarded: go ahead with the close / quit. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const docs = useNotebooksStore((s) => s.docs);
  const [busy, setBusy] = useState(false);
  const one = tabIds.length === 1;
  const heading = one
    ? t("notebook.unsavedModal.one")
    : t("notebook.unsavedModal.many", { count: tabIds.length });

  const saveAll = async () => {
    setBusy(true);
    try {
      for (const id of tabIds) {
        const out = await saveNotebook(id);
        if (out !== "saved") {
          if (out === "refused") toast(t("notebook.newer.cannotSave"), "info");
          return; // a cancelled dialog keeps the prompt
        }
      }
      onDone();
    } catch (err) {
      toast(appErrorMessage(err, t("notebook.saveFailed")), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onCancel} label={heading} width={460} className="truncate-modal">
      <ModalTitle>
        <Icon name="edit_note" size={18} style={{ color: "var(--warn)" }} /> {heading}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {intent === "quit"
            ? t("notebook.unsavedModal.bodyQuit")
            : t("notebook.unsavedModal.bodyClose")}
        </p>
        <ul className="unsaved-tabs-list">
          {tabIds.map((id) => {
            const doc = docs[id];
            return (
              <li key={id}>
                <code>{doc?.nb.title ?? id}</code>
                <span className="unsaved-tabs-summary">
                  {doc?.path ? doc.path.split(/[\\/]/).pop() : t("notebook.notSavedYet")}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Btn>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-danger" onClick={onDone} disabled={busy}>
          <Icon name="delete" size={16} />
          <span>{t("notebook.unsavedModal.discard")}</span>
        </button>
        <Btn variant="filled" icon="save" onClick={() => void saveAll()} disabled={busy} autoFocus>
          {one ? t("common.save") : t("notebook.unsavedModal.saveAll")}
        </Btn>
      </ModalActions>
    </Modal>
  );
}
