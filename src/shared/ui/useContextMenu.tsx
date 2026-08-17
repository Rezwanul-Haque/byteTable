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
// An item can carry `children` instead of doing something itself, which opens a
// flyout to its right (M34 grid row menu: four copy formats and two export
// formats would otherwise flatten into a nine-item wall). One level only — a
// context menu that needs deeper nesting wants a different control. A `separate`
// item draws a rule above itself, to group clipboard actions apart from the ones
// that write a file or touch the database.
//
// Styling is shared with the tab-strip menus (TabMenu.css) so both look the
// same. `useTabMenu` is deliberately NOT rebuilt on top of this: it hard-codes
// close-tab semantics across five tab strips, and rewriting it is not this
// feature's business — but it is the obvious candidate if that ever needs
// touching.

import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { dropWordSelection } from "./dropWordSelection";
import { Icon } from "./Icon";
import "./TabMenu.css";

/** A leaf entry, or a parent that opens a one-level flyout. */
export interface ContextMenuItem {
  label: string;
  /** Material Symbols icon name. */
  icon: string;
  /** Tint the row with the danger colour (destructive actions). */
  danger?: boolean;
  disabled?: boolean;
  /** Draw a separator rule above this item. */
  separate?: boolean;
  /** Leaf action. Ignored when `children` is present. */
  onSelect?: () => void;
  /** Submenu entries; makes this item a parent rather than an action. */
  children?: ContextMenuItem[];
}

interface MenuState<T> {
  x: number;
  y: number;
  subject: T;
}

/** Menu width in px, mirrored from `.tabmenu`'s `min-width`. */
const MENU_WIDTH = 196;

export function useContextMenu<T>(itemsFor: (subject: T) => ContextMenuItem[]) {
  const [menu, setMenu] = useState<MenuState<T> | null>(null);
  // Which parent's flyout is open, by label (labels are unique within a menu —
  // they are already the React key).
  const [openSub, setOpenSub] = useState<string | null>(null);

  const open = (e: ReactMouseEvent, subject: T) => {
    e.preventDefault();
    e.stopPropagation();
    dropWordSelection(e.currentTarget);
    setOpenSub(null);
    setMenu({ x: e.clientX, y: e.clientY, subject });
  };
  const close = () => {
    setOpenSub(null);
    setMenu(null);
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const renderItem = (item: ContextMenuItem): ReactNode => {
    const rule = item.separate ? <div className="tabmenu-sep" key={item.label + "-sep"} /> : null;
    const hasChildren = !!item.children?.length;

    if (!hasChildren) {
      return (
        <div key={item.label} className="tabmenu-entry">
          {rule}
          <button
            type="button"
            className={"tabmenu-item" + (item.danger ? " danger" : "")}
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onSelect?.();
            }}
          >
            <Icon name={item.icon} size={14} />
            {item.label}
          </button>
        </div>
      );
    }

    const showing = openSub === item.label;
    return (
      <div
        key={item.label}
        className="tabmenu-entry tabmenu-parent"
        // Hover opens it; the click handler keeps it reachable from the
        // keyboard and from touch, where there is no hover.
        onMouseEnter={() => setOpenSub(item.label)}
      >
        {rule}
        <button
          type="button"
          className={"tabmenu-item" + (item.danger ? " danger" : "")}
          disabled={item.disabled}
          aria-haspopup="menu"
          aria-expanded={showing}
          onClick={() => setOpenSub(showing ? null : item.label)}
        >
          <Icon name={item.icon} size={14} />
          {item.label}
          <Icon name="chevron_right" size={14} className="tabmenu-chevron" />
        </button>
        {showing ? (
          <div className="tabmenu tabmenu-sub" role="menu">
            {item.children?.map((child) => (
              <button
                key={child.label}
                type="button"
                className={"tabmenu-item" + (child.danger ? " danger" : "")}
                disabled={child.disabled}
                onClick={() => {
                  close();
                  child.onSelect?.();
                }}
              >
                <Icon name={child.icon} size={14} />
                {child.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  // Keep the panel on screen: a right-click near the right or bottom edge would
  // otherwise open a menu that runs off it. Flipping is enough — the menu is
  // small relative to any window this app runs in.
  const items = menu ? itemsFor(menu.subject) : [];
  const estHeight = items.length * 34 + 8;
  const left = menu ? Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8) : 0;
  const top = menu ? Math.min(menu.y, Math.max(8, window.innerHeight - estHeight - 8)) : 0;

  const element: ReactNode = menu
    ? createPortal(
        // The overlay catches the click (or right-click) that dismisses the
        // menu, so no document-level listener is needed.
        <div className="tabmenu-overlay" onClick={close} onContextMenu={close}>
          <div
            className="tabmenu"
            style={{ left, top }}
            // Clicks inside must not reach the overlay's dismiss handler before
            // the item's own onSelect runs.
            onClick={(e) => e.stopPropagation()}
            onMouseLeave={() => setOpenSub(null)}
          >
            {items.map(renderItem)}
          </div>
        </div>,
        document.body,
      )
    : null;

  return { open, close, element };
}
