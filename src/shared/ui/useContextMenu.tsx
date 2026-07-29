// Generic right-click menu: give it a list of items, get back an
// `onContextMenu` handler and a portaled element to render once.
//
// Usage:
//   const menu = useContextMenu<SavedConnection>((c) => [
//     { label: "Edit", icon: "edit", onSelect: () => setEditConn(c) },
//     { label: "Delete", icon: "delete", danger: true, onSelect: () => remove(c) },
//   ]);
//   <div onContextMenu={(e) => menu.open(e, connection)} />
//   {menu.element}
//
// The items are built from the right-clicked subject when the menu opens, so
// each entry closes over exactly the row it belongs to.
//
// Styling is shared with the tab-strip menus (TabMenu.css) so both look the
// same. `useTabMenu` is deliberately NOT rebuilt on top of this: it hard-codes
// close-tab semantics across five tab strips, and rewriting it is not this
// feature's business — but it is the obvious candidate if that ever needs
// touching.

import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./Icon";
import "./TabMenu.css";

export interface ContextMenuItem {
  label: string;
  /** Material Symbols icon name. */
  icon: string;
  /** Tint the row with the danger colour (destructive actions). */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuState<T> {
  x: number;
  y: number;
  subject: T;
}

export function useContextMenu<T>(itemsFor: (subject: T) => ContextMenuItem[]) {
  const [menu, setMenu] = useState<MenuState<T> | null>(null);

  const open = (e: ReactMouseEvent, subject: T) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, subject });
  };
  const close = () => setMenu(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const element: ReactNode = menu
    ? createPortal(
        // The overlay catches the click (or right-click) that dismisses the
        // menu, so no document-level listener is needed.
        <div className="tabmenu-overlay" onClick={close} onContextMenu={close}>
          <div
            className="tabmenu"
            style={{ left: menu.x, top: menu.y }}
            // Clicks inside must not reach the overlay's dismiss handler before
            // the item's own onSelect runs.
            onClick={(e) => e.stopPropagation()}
          >
            {itemsFor(menu.subject).map((item) => (
              <button
                key={item.label}
                type="button"
                className={"tabmenu-item" + (item.danger ? " danger" : "")}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                <Icon name={item.icon} size={14} />
                {item.label}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )
    : null;

  return { open, close, element };
}
