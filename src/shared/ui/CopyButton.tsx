// A small hover-revealed "copy to clipboard" icon button, shared by the grids
// (browse DataGrid, SQL result grid, terminal results). Every one of those had
// the same button: write the given text to the clipboard, toast success/failure,
// and stop the click from bubbling to the cell/row. The only thing that legitimately
// differs per site is the POSITIONING CSS (cell sizes + the hover-reveal selector
// is parent-scoped, e.g. `.dg-td:hover .dg-copy` vs `.term-grid td:hover .term-copy`),
// so the caller passes `className` and keeps its own CSS; the behaviour lives here.

import { useT } from "../i18n/useT";
import { Icon } from "./Icon";
import { useToast } from "./toastContext";

export function CopyButton({
  text,
  label,
  className,
  size = 12,
  icon = "content_copy",
}: {
  /** The exact text to copy. The caller stringifies its value (objects → JSON,
   *  etc.) so this component stays agnostic to the source data shape. */
  text: string;
  /** Accessible label — used for both `aria-label` and the tooltip, so a
   *  button that copies something other than a single cell can say so.
   *  Defaults to the translated "Copy value". */
  label?: string;
  /** Positioning class for the button at the call site (e.g. `dg-copy`). */
  className?: string;
  /** Icon size in px. */
  size?: number;
  /** Glyph, when one copy button sits beside another and the two need telling
   *  apart — the FK peek offers a binary key as both a UUID (`content_copy`)
   *  and its stored bytes (`tag`, the app's binary/hex glyph). */
  icon?: string;
}) {
  const toast = useToast();
  const t = useT();
  const resolvedLabel = label ?? t("uix.copy.value");
  return (
    <button
      type="button"
      className={className}
      title={resolvedLabel}
      aria-label={resolvedLabel}
      onClick={(e) => {
        // Never let the copy click select the row / focus the terminal input.
        e.stopPropagation();
        if (!text) return;
        void navigator.clipboard.writeText(text).then(
          () => toast(t("uix.copy.done"), "ok"),
          () => toast(t("uix.copy.fail"), "err"),
        );
      }}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
