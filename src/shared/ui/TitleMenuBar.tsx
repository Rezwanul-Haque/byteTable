// TitleMenuBar — the in-window app menu bar (spec §2).
//
// Classic desktop menu-bar behavior: clicking a top button toggles its
// popover; once any menu is open, hovering a sibling switches to it; a click
// anywhere outside closes it. Disabled items expose their hint as a tooltip;
// enabled items render it as a right-aligned mono keycap.

import { useState } from "react";

import { Icon } from "./Icon";
import type { Menu, MenuItem } from "./titlebarMenus";

export function TitleMenuBar({ menus }: { menus: Menu[] }) {
  // Index of the open menu, or null. `null` also means "not in menu-tracking
  // mode", so hover only switches menus once one has been opened by a click.
  const [open, setOpen] = useState<number | null>(null);
  // The open submenu's parent id (M35): at most one, and it closes whenever the
  // top-level menu changes or the pointer moves onto a leaf item.
  const [sub, setSub] = useState<string | null>(null);

  return (
    <div className="tb-menubar">
      {/* Full-viewport backdrop that captures the dismiss click. A plain
          `window` mousedown listener misses clicks on the title bar itself,
          because that area is a Tauri drag region and the OS swallows the
          mousedown as a native window drag before JS sees it. An actual
          element (above the drag region, below the menu buttons/popover) is
          what reliably catches the outside click. */}
      {open !== null ? (
        <div
          className="tb-menu-backdrop"
          onMouseDown={() => {
            setOpen(null);
            setSub(null);
          }}
        />
      ) : null}
      {menus.map((menu, i) => (
        <div className="tb-menu" key={menu.label}>
          <button
            type="button"
            className={"tb-menu-btn" + (open === i ? " on" : "")}
            onClick={() => {
              setSub(null);
              setOpen((cur) => (cur === i ? null : i));
            }}
            onMouseEnter={() =>
              setOpen((cur) => {
                if (cur === null || cur === i) return cur;
                setSub(null);
                return i;
              })
            }
          >
            {menu.label}
          </button>
          {open === i ? (
            <div className="tb-menu-pop">
              {menu.items.map((item, j) =>
                item === "—" ? (
                  <div className="tb-menu-sep" key={`sep-${j}`} />
                ) : item.sub ? (
                  <div
                    key={item.id}
                    className={"tb-menu-item tb-menu-parent" + (sub === item.id ? " hot" : "")}
                    onMouseEnter={() => setSub(item.id)}
                    onClick={(e) => {
                      // Clicking the parent toggles its submenu; it never runs.
                      e.stopPropagation();
                      setSub((cur) => (cur === item.id ? null : item.id));
                    }}
                  >
                    <span className="tb-menu-label">{item.label}</span>
                    <Icon name="chevron_right" size={15} className="tb-menu-caret" />
                    {sub === item.id ? (
                      <div className="tb-menu-pop tb-menu-sub">
                        {item.sub.map((child) =>
                          child === "—" ? null : (
                            <MenuLeaf
                              key={child.id}
                              item={child}
                              onRun={() => {
                                setOpen(null);
                                setSub(null);
                              }}
                            />
                          ),
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <MenuLeaf
                    key={item.id}
                    item={item}
                    onHover={() => setSub(null)}
                    onRun={() => {
                      setOpen(null);
                      setSub(null);
                    }}
                  />
                ),
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * One runnable menu row (top level or inside a submenu).
 *
 * Disabled rows are marked with `aria-disabled` + a class rather than the native
 * `disabled` attribute, because a disabled control receives NO mouse events —
 * and this row has two jobs that depend on them:
 *
 *   - `onHover` closes a sibling's open submenu. With a native `disabled`, the
 *     pointer could land on a greyed row while File ▸ Open's submenu stayed open
 *     and its parent row stayed lit, leaving two highlighted rows touching.
 *   - `title` explains *why* an item is unavailable, and a browser shows no
 *     tooltip for a disabled control.
 *
 * The click is guarded here instead; `aria-disabled` is what assistive tech
 * reads, and it keeps the row reachable, which is the behaviour ARIA's menu
 * pattern asks for anyway.
 */
function MenuLeaf({
  item,
  onHover,
  onRun,
}: {
  item: Exclude<MenuItem, "—">;
  onHover?: () => void;
  onRun: () => void;
}) {
  const disabled = !item.enabled;
  return (
    <button
      type="button"
      className={"tb-menu-item" + (disabled ? " disabled" : "")}
      aria-disabled={disabled || undefined}
      // A disabled item with a hint explains *why* on hover.
      title={disabled && item.hint ? item.hint : undefined}
      onMouseEnter={onHover}
      onClick={() => {
        if (disabled) return;
        item.run?.();
        onRun();
      }}
    >
      <span className="tb-menu-label">{item.label}</span>
      {item.enabled && item.hint ? <span className="tb-menu-hint-key">{item.hint}</span> : null}
    </button>
  );
}
