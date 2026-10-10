// The DDL sheet (M37 Task 7): the generated script, a per-table summary of what
// changed, and the two ways out — copy it, or open it in a SQL tab.
//
// The footnote is not decoration: the board can CREATE and DROP in the text it
// produces, and the user has to know that nothing here has run. The board never
// touches the database.

import { Icon } from "../../../shared/ui/Icon";
import { useT } from "../../../shared/i18n/useT";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalTitle } from "../../../shared/ui/Modal";
import type { ToastFn } from "../../../shared/ui/toastContext";
import type { BoardDiff } from "../diff";

/** Keywords lifted out for highlighting. One capture group, so `split` returns
 *  the keywords at odd indices and the surrounding text at even ones. */
const KEYWORDS =
  /(\b(?:CREATE TABLE|ALTER TABLE|ADD COLUMN|ALTER COLUMN|DROP COLUMN|PRIMARY KEY|NOT NULL|REFERENCES|TYPE)\b|--.*)/g;

export interface BoardDdlSheetProps {
  sql: string;
  diff: BoardDiff;
  onClose: () => void;
  /** Hand the script to a new SQL tab, where the user can run it. */
  onOpenInSql: (sql: string) => void;
  toast: ToastFn;
}

export function BoardDdlSheet({ sql, diff, onClose, onOpenInSql, toast }: BoardDdlSheetProps) {
  const t = useT();
  const parts = sql.split(KEYWORDS);
  return (
    <Modal onClose={onClose} className="bb-ddl" label={t("board.ddl.title")}>
      <ModalTitle>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="code" size={18} style={{ color: "var(--accent)" }} />
          {t("board.ddl.title")}
        </span>
        <IconBtn icon="close" title={t("common.close")} onClick={onClose} />
      </ModalTitle>
      <div className="bb-ddl-sum">
        {diff.creates.map((table) => (
          <span key={table.id} className="add">
            <Icon name="add_box" size={13} />
            {table.name}
          </span>
        ))}
        {diff.alters.map((alter) => (
          <span key={alter.table.id} className="mod">
            <Icon name="edit" size={13} />
            {alter.table.name}
            {" · " +
              [
                alter.adds.length ? "+" + alter.adds.length : "",
                alter.types.length ? "~" + alter.types.length : "",
                alter.drops.length ? "−" + alter.drops.length : "",
              ]
                .filter(Boolean)
                .join(" ")}
          </span>
        ))}
      </div>
      <pre className="bb-ddl-sql">
        {parts.map((part, i) =>
          /^--/.test(part) ? (
            <span key={i} className="c">
              {part}
            </span>
          ) : i % 2 ? (
            <span key={i} className="k">
              {part}
            </span>
          ) : (
            part
          ),
        )}
      </pre>
      <div className="bb-ddl-foot">
        <span className="bb-hint" style={{ margin: 0 }}>
          {t("board.ddl.footnote")}
        </span>
        <button
          type="button"
          className="bb-btn"
          onClick={() => {
            void navigator.clipboard?.writeText(sql);
            toast(t("board.ddl.copied"), "ok");
          }}
        >
          <Icon name="content_copy" size={14} />
          {t("board.ddl.copy")}
        </button>
        <button
          type="button"
          className="bb-btn pri"
          onClick={() => {
            onOpenInSql(sql);
            toast(t("board.ddl.openedInSql"), "ok");
            onClose();
          }}
        >
          <Icon name="open_in_new" size={14} />
          {t("board.ddl.openInSql")}
        </button>
      </div>
    </Modal>
  );
}
