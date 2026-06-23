// Redis tab bar (REDIS_SPEC §5) — ported from `redis.jsx` RedisTabBar. Same
// 37px `.tabbar`/`.tab` chrome as the SQL workspace, but the leading glyph is
// a type badge for key tabs (not a generic icon). The Redis tab kinds are
// `{dashboard, key}` — the M13 cli tab is gone (M14: command work lives in the
// docked console panel). The right-aligned terminal IconBtn toggles that panel
// (mirrors the SQL TabBar). The dashboard tab is non-closable.

import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { Icon } from "../../../shared/ui/Icon";
import { useTabMenu } from "../../../shared/ui/useTabMenu";
import type { RedisTab } from "../state";
import { RedisTypeBadge } from "./RedisTypeBadge";
import "./RedisTabBar.css";

/** The visible label: the key name, or "Dashboard". */
function tabTitle(tab: RedisTab): string {
  switch (tab.kind) {
    case "dashboard":
      return "Dashboard";
    case "key":
      return tab.key;
  }
}

interface RedisTabBarProps {
  tabs: RedisTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** True when the docked console panel is open (M14) — lights the toggle. */
  consoleOpen: boolean;
  /** Toggle the docked console panel (M14). */
  onToggleConsole: () => void;
}

export function RedisTabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  consoleOpen,
  onToggleConsole,
}: RedisTabBarProps) {
  const menu = useTabMenu({
    ids: tabs.map((t) => t.id),
    close: (ids) => ids.forEach(onClose),
    canClose: (id) => tabs.find((t) => t.id === id)?.kind !== "dashboard",
  });
  // Bring the active tab into view when it changes (a newly-opened tab that
  // landed past the scrolled edge would otherwise stay hidden).
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabId]);
  return (
    <div className="tabbar" role="tablist" aria-label="Redis tabs">
      <div className="tabbar-tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const title = tabTitle(tab);
          const closable = tab.kind !== "dashboard";
          const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(tab.id);
            } else if (closable && (event.key === "Delete" || event.key === "Backspace")) {
              event.preventDefault();
              onClose(tab.id);
            }
          };
          const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
            if (event.button === 1 && closable) {
              event.preventDefault();
              onClose(tab.id);
            }
          };
          return (
            <div
              key={tab.id}
              ref={active ? activeTabRef : undefined}
              className={"tab" + (active ? " active" : "")}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              onKeyDown={onKeyDown}
              onMouseDown={onMouseDown}
              onContextMenu={(e) => menu.onContextMenu(e, tab.id)}
              title={title}
            >
              {tab.kind === "key" ? (
                <RedisTypeBadge type={tab.keyType} size={13} />
              ) : (
                <Icon
                  name="monitoring"
                  size={14}
                  style={{ color: active ? "var(--accent)" : "var(--text-faint)" }}
                />
              )}
              <span className="tab-title">{title}</span>
              {closable ? (
                <button
                  type="button"
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.id);
                  }}
                  title="Close tab"
                  aria-label={"Close " + title}
                >
                  <Icon name="close" size={12} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="tabbar-tools">
        <button
          type="button"
          className={"tabbar-tool" + (consoleOpen ? " active" : "")}
          title="Toggle terminal (Ctrl+`)"
          aria-label="Toggle terminal (Ctrl+`)"
          aria-pressed={consoleOpen}
          onClick={onToggleConsole}
        >
          <Icon name="terminal" size={15} />
          <span>Terminal</span>
        </button>
      </div>
      {menu.element}
    </div>
  );
}
