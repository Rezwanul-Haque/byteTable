// "Add a cell" (M47 E7): a thin row with + Query and + Note between every two
// cells, shown on hover or focus; the same row, always visible and larger, at
// the end of the document.

import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";

export function NbAdd({
  onAdd,
  always = false,
}: {
  onAdd: (type: "query" | "note") => void;
  always?: boolean;
}) {
  const t = useT();
  return (
    <div className={"nb-add" + (always ? " always" : "")}>
      <span className="nb-add-line" aria-hidden="true" />
      <button type="button" onClick={() => onAdd("query")} aria-label={t("notebook.add.queryAria")}>
        <Icon name="add" size={14} /> {t("notebook.add.query")}
      </button>
      <button type="button" onClick={() => onAdd("note")} aria-label={t("notebook.add.noteAria")}>
        <Icon name="add" size={14} /> {t("notebook.add.note")}
      </button>
      <span className="nb-add-line" aria-hidden="true" />
    </div>
  );
}
