// Column header: shows that a column is masked, and shows / hides that one
// column (M49 C2). Clicking does not sort.

import type { CellValue } from "../../../shared/api/engine";
import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { maskColumn, useMaskStore } from "../state";
import "./Masking.css";

export function MaskHeadBtn({ col, sample }: { col: string; sample?: CellValue[] }) {
  const t = useT();
  const reveal = useMaskStore((s) => s.reveal);
  const m = maskColumn(col, sample);
  if (!m) return null;
  return (
    <button
      type="button"
      className={"mask-head" + (m.revealed ? " shown" : "")}
      title={
        m.revealed
          ? t("mask.head.shownHint")
          : t("mask.head.maskedHint", { kind: t(`mask.kind.${m.kind}`) })
      }
      aria-label={m.revealed ? t("mask.head.hide", { col }) : t("mask.head.show", { col })}
      aria-pressed={m.revealed}
      onClick={(e) => {
        e.stopPropagation();
        reveal(col, !m.revealed);
      }}
      // Keep the header's drag / resize handlers off this button.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Icon name={m.revealed ? "visibility" : "visibility_off"} size={13} />
    </button>
  );
}
