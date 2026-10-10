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

import { useT } from "../i18n/useT";
import { dropWordSelection } from "../ui/dropWordSelection";
import { Icon } from "../ui/Icon";
import "../ui/TabMenu.css";

/**
 * A non-closing entry for the menu (e.g. the SQL result tabs' "Re-run
 * statement"), shown above the close items and separated from them. Both
 * callbacks take the right-clicked tab id.
 */
export interface TabMenuAction {
  label: string;
  icon: string;
  onSelect: (id: string) => void;
  /** Greyed out when this returns false. Default: always enabled. */
  enabled?: (id: string) => boolean;
}

export interface TabMenuOptions {
  /** Tab ids in display order. */
  ids: string[];
  /** Close the given set of tabs. */
  close: (ids: string[]) => void;
  /** Whether a tab may be closed (e.g. a pinned Dashboard cannot). Default: yes. */
  canClose?: (id: string) => boolean;
  /** Add a "Close all" item. Off by default: on a strip of documents "Close
   *  others" is the safer sibling of Close, but a strip of disposable output
   *  (the SQL result tabs) wants to be swept in one go. */
  closeAll?: boolean;
  /** Tab-specific actions prepended above the close items. */
  actions?: TabMenuAction[];
}

interface MenuState {
  x: number;
  y: number;
  id: string;
}

export function useTabMenu({ ids, close, canClose, closeAll = false, actions }: TabMenuOptions) {
  const t = useT();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const onContextMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    dropWordSelection(e.currentTarget);
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
    const id = menu.id;
    const ok = (candidate: string) => (canClose ? canClose(candidate) : true);
    const idx = ids.indexOf(id);
    const runClose = (targets: string[]) => () => {
      if (targets.length) close(targets);
      closeMenu();
    };
    const closeItem = (label: string, icon: string, targets: string[]) => ({
      label,
      icon,
      disabled: targets.length === 0,
      count: targets.length,
      sep: false,
      onSelect: runClose(targets),
    });
    const items = [
      // The tab's own actions first, ruled off from the close block below.
      ...(actions ?? []).map((a, i) => ({
        label: a.label,
        icon: a.icon,
        disabled: a.enabled ? !a.enabled(id) : false,
        count: 0,
        sep: i === (actions?.length ?? 0) - 1,
        onSelect: () => {
          a.onSelect(id);
          closeMenu();
        },
      })),
      closeItem(t("common.close"), "close", ok(id) ? [id] : []),
      closeItem(
        t("tabs.closeOthers"),
        "clear_all",
        ids.filter((other) => other !== id && ok(other)),
      ),
      ...(closeAll ? [closeItem(t("tabs.closeAll"), "delete_sweep", ids.filter(ok))] : []),
      closeItem(t("tabs.closeRight"), "last_page", ids.slice(idx + 1).filter(ok)),
      closeItem(t("tabs.closeLeft"), "first_page", ids.slice(0, idx).filter(ok)),
    ];
    // Clamp so the menu stays on-screen — from the item count, since the menu
    // grows a row per action and with "Close all".
    const left = Math.min(menu.x, window.innerWidth - 210);
    const top = Math.min(menu.y, window.innerHeight - (items.length * 34 + 12));
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
            <div className="tabmenu-entry" key={it.label}>
              <button
                type="button"
                className="tabmenu-item"
                role="menuitem"
                disabled={it.disabled}
                onClick={it.onSelect}
              >
                <Icon name={it.icon} size={15} />
                <span>{it.label}</span>
                {it.count ? <span className="tabmenu-count">{it.count}</span> : null}
              </button>
              {it.sep ? <div className="tabmenu-sep" /> : null}
            </div>
          ))}
        </div>
      </>,
      document.body,
    );
  }

  return { onContextMenu, element, closeMenu };
}
