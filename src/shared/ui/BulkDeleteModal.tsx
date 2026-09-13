// Generic confirm modal for a grid's bulk "delete selected". Env-aware rigor
// (mirrors the SQL TruncateModal / Dynamo delete modal): a non-production
// connection gets a plain confirm; a production connection requires typing the
// target name (table / collection / db) to arm the destructive button. The
// engine supplies `onConfirm` (the actual delete) and the row noun; errors stay
// inside the modal.

import { useState } from "react";

import { appErrorMessage } from "../api/error";
import type { StringKey } from "../i18n";
import { useT } from "../i18n/useT";
import { Btn } from "./Btn";
import { Icon } from "./Icon";
import { Modal, ModalActions, ModalTitle } from "./Modal";
// Reuse the SQL truncate modal's destructive styling (.truncate-*, .btn-danger).
import "../../features/export/components/TruncateModal.css";

const DANGER = "#e06c75";

// The engine caller passes the row noun as an English string; known nouns are
// translated through plural keys, unknown ones fall back to noun + "s".
const NOUN_KEYS: Record<string, { one: StringKey; other: StringKey }> = {
  row: { one: "uix.noun.row.one", other: "uix.noun.row.other" },
  document: { one: "uix.noun.document.one", other: "uix.noun.document.other" },
  key: { one: "uix.noun.key.one", other: "uix.noun.key.other" },
  item: { one: "uix.noun.item.one", other: "uix.noun.item.other" },
};

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
  const t = useT();

  const nounKeys = NOUN_KEYS[noun];
  const pluralNoun = nounKeys
    ? t(count === 1 ? nounKeys.one : nounKeys.other)
    : noun + (count === 1 ? "" : "s");
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
        setError(appErrorMessage(err, t("uix.bulkDelete.error", { count, noun: pluralNoun })));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("uix.bulkDelete.title", { count, noun: pluralNoun })}
      width={460}
      className="truncate-modal"
    >
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} />{" "}
        {t("uix.bulkDelete.title", { count, noun: pluralNoun })}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {t("uix.bulkDelete.bodyPre")}{" "}
          <b>
            {count} {pluralNoun}
          </b>{" "}
          {t("uix.bulkDelete.bodyMid")} <code>{target}</code>
          {t("uix.bulkDelete.bodyPost")}
        </p>
        {isProduction ? (
          <div className="truncate-prod">
            <div
              className="truncate-prod-tag"
              style={{ color: DANGER, borderColor: DANGER + "66", background: DANGER + "14" }}
            >
              <Icon name="public" size={13} /> {t("uix.bulkDelete.prodTag")}
            </div>
            <label>
              {t("uix.bulkDelete.typePre")} <b>{target}</b> {t("uix.bulkDelete.typePost")}
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={target}
                spellCheck="false"
                autoFocus
                aria-label={t("uix.bulkDelete.typeAria", { target })}
              />
            </label>
          </div>
        ) : null}
        {error ? <div className="truncate-error">{error}</div> : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy ? "" : " disabled")}
          disabled={!armed || busy}
          onClick={confirm}
        >
          <Icon name="delete_forever" size={16} />
          <span>
            {busy
              ? t("uix.bulkDelete.deleting")
              : t("uix.bulkDelete.delete", { count, noun: pluralNoun })}
          </span>
        </button>
      </ModalActions>
    </Modal>
  );
}
