// The composer's suggestion list for `@` (tables) and `/` (commands and
// models). Render-only: the composer owns the query, the active row and the
// keyboard (↑/↓, Enter/Tab picks, Esc closes); this draws the grouped rows
// above the message box and reports clicks. A listbox the textarea points at
// with aria-activedescendant, so screen readers follow the arrow keys.

import { useEffect, useRef } from "react";

import { Icon } from "../../../shared/ui/Icon";

export interface Suggestion {
  id: string;
  /** Rows are grouped under this heading, in the order they arrive. */
  group: string;
  icon: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

export function AiSuggest({
  id,
  items,
  active,
  empty,
  onPick,
  onHover,
}: {
  id: string;
  items: Suggestion[];
  active: number;
  /** Shown when nothing matches. */
  empty: string;
  onPick: (s: Suggestion) => void;
  onHover: (i: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the active row visible as the arrows move it — scrolling the list
  // itself, never the drawer.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [active]);

  return (
    <div className="ai-suggest" id={id} role="listbox" ref={listRef}>
      {items.length === 0 ? <div className="ai-suggest-empty">{empty}</div> : null}
      {items.map((s, i) => (
        <div key={s.id}>
          {i === 0 || items[i - 1]!.group !== s.group ? (
            <div className="ai-suggest-h" role="presentation">
              {s.group}
            </div>
          ) : null}
          <div
            id={`${id}-${i}`}
            data-idx={i}
            role="option"
            aria-selected={i === active}
            aria-disabled={s.disabled || undefined}
            className={
              "ai-suggest-row" + (i === active ? " active" : "") + (s.disabled ? " disabled" : "")
            }
            onMouseDown={(e) => {
              // Keep focus (and the caret) in the message box.
              e.preventDefault();
              if (!s.disabled) onPick(s);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <Icon name={s.icon} size={14} />
            <span className="ai-suggest-l">{s.label}</span>
            {s.hint ? <span className="ai-suggest-hint">{s.hint}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
