// The split action inside a scope switcher (M32 for SQL, M33 engine-wide).
//
// Sits on a `.schema-pop-item` row — the popover markup the SQL, Cassandra,
// MongoDB and Redis sidebars all already share — and turns "switch to this
// scope in place" into "…or open it as its own workspace". The row keeps its
// own click; this only ever handles its own.
//
// Once that workspace exists the icon becomes a focus target and stops being
// hover-only (see `.schema-pop-split.opened`), so an already-open scope is
// visible at a glance without opening anything.

import { Icon } from "../../../shared/ui/Icon";

interface ScopeSplitActionProps {
  /** The scope's id, as passed to `openScope` — also what the tooltip names. */
  scope: string;
  /** Whether a workspace for this scope is already open. */
  opened: boolean;
  /** Display label, when it differs from the id (Redis: `db3` for `3`). */
  label?: string;
  /** Create-or-focus. The caller closes its popover here too. */
  onOpen: (scope: string) => void;
}

export function ScopeSplitAction({ scope, opened, label, onOpen }: ScopeSplitActionProps) {
  const shown = label ?? scope;
  const open = (event: { stopPropagation: () => void }) => {
    // Never let this also switch scope in place — the row underneath is a
    // button and its onClick would otherwise fire too.
    event.stopPropagation();
    onOpen(scope);
  };

  return (
    <span
      role="button"
      tabIndex={0}
      className={"schema-pop-split" + (opened ? " opened" : "")}
      title={
        opened ? "Focus the “" + shown + "” workspace" : "Open “" + shown + "” as its own workspace"
      }
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open(event);
      }}
    >
      <Icon name={opened ? "my_location" : "open_in_new"} size={13} />
    </span>
  );
}

/** The popover footer explaining the icon. Two words on purpose: the popover is
 *  ~218px wide and prose wraps to several lines here. */
export function ScopeSplitHint() {
  return (
    <div className="schema-pop-hint">
      <Icon name="open_in_new" size={12} />
      <span>own workspace</span>
    </div>
  );
}
