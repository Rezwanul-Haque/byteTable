// A small hover-revealed "copy to clipboard" icon button, shared by the grids
// (browse DataGrid, SQL result grid, terminal results). Every one of those had
// the same button: write the given text to the clipboard, toast success/failure,
// and stop the click from bubbling to the cell/row. The only thing that legitimately
// differs per site is the POSITIONING CSS (cell sizes + the hover-reveal selector
// is parent-scoped, e.g. `.dg-td:hover .dg-copy` vs `.term-grid td:hover .term-copy`),
// so the caller passes `className` and keeps its own CSS; the behaviour lives here.

import { Icon } from "./Icon";
import { useToast } from "./toastContext";

export function CopyButton({
  text,
  label = "Copy value",
  className,
  size = 12,
}: {
  /** The exact text to copy. The caller stringifies its value (objects → JSON,
   *  etc.) so this component stays agnostic to the source data shape. */
  text: string;
  /** Accessible label (`aria-label`). */
  label?: string;
  /** Positioning class for the button at the call site (e.g. `dg-copy`). */
  className?: string;
  /** Icon size in px. */
  size?: number;
}) {
  const toast = useToast();
  return (
    <button
      type="button"
      className={className}
      title="Copy value"
      aria-label={label}
      onClick={(e) => {
        // Never let the copy click select the row / focus the terminal input.
        e.stopPropagation();
        if (!text) return;
        void navigator.clipboard.writeText(text).then(
          () => toast("Copied", "ok"),
          () => toast("Couldn't copy to clipboard", "err"),
        );
      }}
    >
      <Icon name="content_copy" size={size} />
    </button>
  );
}
