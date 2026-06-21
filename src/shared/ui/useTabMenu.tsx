// Shared right-click menu for tab strips (SQL / DynamoDB / MongoDB / Redis
// workspaces + the docked terminal). Given the ordered tab ids, a close-many
// callback, and an optional "can this id be closed" predicate, it renders a
// portaled context menu with Close / Close others / Close to the right / Close
// to the left — each disabled when it would close nothing.
//
// Usage: `const menu = useTabMenu({ ids, close, canClose });` then put
// `onContextMenu={(e) => menu.onContextMenu(e, tab.id)}` on each tab element and
// render `{menu.element}` once inside the component.

import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./Icon";
import "./TabMenu.css";

export interface TabMenuOptions {
  /** Tab ids in display order. */
  ids: string[];
  /** Close the given set of tabs. */
  close: (ids: string[]) => void;
  /** Whether a tab may be closed (e.g. a pinned Dashboard cannot). Default: yes. */
  canClose?: (id: string) => boolean;
}

interface MenuState {
  x: number;
  y: number;
  id: string;
}

export function useTabMenu({ ids, close, canClose }: TabMenuOptions) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const onContextMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, id });
  };
  const closeMenu = () => setMenu(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  let element: ReactNode = null;
  if (menu) {
    const ok = (id: string) => (canClose ? canClose(id) : true);
    const idx = ids.indexOf(menu.id);
    const items = [
      { label: "Close", icon: "close", targets: ok(menu.id) ? [menu.id] : [] },
      {
        label: "Close others",
        icon: "clear_all",
        targets: ids.filter((id) => id !== menu.id && ok(id)),
      },
      { label: "Close to the right", icon: "last_page", targets: ids.slice(idx + 1).filter(ok) },
      { label: "Close to the left", icon: "first_page", targets: ids.slice(0, idx).filter(ok) },
    ];
    const run = (targets: string[]) => {
      if (targets.length) close(targets);
      closeMenu();
    };
    // Clamp so the menu stays on-screen.
    const left = Math.min(menu.x, window.innerWidth - 210);
    const top = Math.min(menu.y, window.innerHeight - 170);
    element = createPortal(
      <>
        <div
          className="tabmenu-overlay"
          onMouseDown={closeMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            closeMenu();
          }}
        />
        <div className="tabmenu" style={{ left, top }} role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              className="tabmenu-item"
              role="menuitem"
              disabled={it.targets.length === 0}
              onClick={() => run(it.targets)}
            >
              <Icon name={it.icon} size={15} />
              <span>{it.label}</span>
              {it.targets.length ? (
                <span className="tabmenu-count">{it.targets.length}</span>
              ) : null}
            </button>
          ))}
        </div>
      </>,
      document.body,
    );
  }

  return { onContextMenu, element, closeMenu };
}
