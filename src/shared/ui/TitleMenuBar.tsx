// TitleMenuBar — the in-window app menu bar (spec §2).
//
// Classic desktop menu-bar behavior: clicking a top button toggles its
// popover; once any menu is open, hovering a sibling switches to it; a click
// anywhere outside closes it. Disabled items expose their hint as a tooltip;
// enabled items render it as a right-aligned mono keycap.

import { useState } from "react";

import type { Menu } from "./titlebarMenus";

export function TitleMenuBar({ menus }: { menus: Menu[] }) {
  // Index of the open menu, or null. `null` also means "not in menu-tracking
  // mode", so hover only switches menus once one has been opened by a click.
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="tb-menubar">
      {/* Full-viewport backdrop that captures the dismiss click. A plain
          `window` mousedown listener misses clicks on the title bar itself,
          because that area is a Tauri drag region and the OS swallows the
          mousedown as a native window drag before JS sees it. An actual
          element (above the drag region, below the menu buttons/popover) is
          what reliably catches the outside click. */}
      {open !== null ? (
        <div className="tb-menu-backdrop" onMouseDown={() => setOpen(null)} />
      ) : null}
      {menus.map((menu, i) => (
        <div className="tb-menu" key={menu.label}>
          <button
            type="button"
            className={"tb-menu-btn" + (open === i ? " on" : "")}
            onClick={() => setOpen((cur) => (cur === i ? null : i))}
            onMouseEnter={() => setOpen((cur) => (cur === null ? cur : i))}
          >
            {menu.label}
          </button>
          {open === i ? (
            <div className="tb-menu-pop">
              {menu.items.map((item, j) =>
                item === "—" ? (
                  <div className="tb-menu-sep" key={`sep-${j}`} />
                ) : (
                  <button
                    type="button"
                    key={item.id}
                    className="tb-menu-item"
                    disabled={!item.enabled}
                    // A disabled item with a hint explains *why* on hover.
                    title={!item.enabled && item.hint ? item.hint : undefined}
                    onClick={() => {
                      item.run?.();
                      setOpen(null);
                    }}
                  >
                    <span className="tb-menu-label">{item.label}</span>
                    {item.enabled && item.hint ? (
                      <span className="tb-menu-hint-key">{item.hint}</span>
                    ) : null}
                  </button>
                ),
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
