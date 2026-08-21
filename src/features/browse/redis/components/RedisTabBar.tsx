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

import { Icon } from "../../../../shared/ui/Icon";
import { useTabMenu } from "../../../../shared/ui/useTabMenu";
import type { RedisTab } from "../state";
import { RedisTypeBadge } from "./RedisTypeBadge";
// `.tabbar-tools` / `.tabbar-tool` / `.tabbar-tool-icon` for the right-hand
// tools, borrowed rather than re-declared — the same import the Mongo,
// Cassandra and Typesense tab bars make.
import "../../../workspaces/components/TabBar.css";
import "./RedisTabBar.css";

/** The visible label: the key name, or the dashboard's name for this mode. */
function tabTitle(tab: RedisTab, cluster: boolean): string {
  switch (tab.kind) {
    case "dashboard":
      // A cluster workspace's first tab is the Cluster dashboard, not a
      // keyspace one — the tab name says which view it actually is.
      return cluster ? "Cluster" : "Dashboard";
    case "key":
      return tab.key;
    case "processes":
      return "Clients";
  }
}

interface RedisTabBarProps {
  tabs: RedisTab[];
  /** True when the connection is a cluster node — retitles the dashboard tab. */
  cluster: boolean;
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** True when the docked console panel is open (M14) — lights the toggle. */
  consoleOpen: boolean;
  /** Toggle the docked console panel (M14). */
  onToggleConsole: () => void;
  /** Open (or focus) the Clients tab — the tab-bar tool the other engines
   *  put beside Terminal (M36). */
  onOpenClients: () => void;
}

export function RedisTabBar({
  tabs,
  cluster,
  activeTabId,
  onSelect,
  onClose,
  consoleOpen,
  onToggleConsole,
  onOpenClients,
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
          const title = tabTitle(tab, cluster);
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
                  name={tab.kind === "processes" ? "monitor_heart" : cluster ? "lan" : "monitoring"}
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
        {/* Icon-only, immediately after Terminal — the same slot the SQL,
            Mongo and Cassandra tab bars put their processes toggle in, so the
            shortcut and the muscle memory carry across engines. */}
        <button
          type="button"
          className="tabbar-tool tabbar-tool-icon"
          title="Connected clients (Ctrl+Shift+P)"
          aria-label="Connected clients (Ctrl+Shift+P)"
          onClick={onOpenClients}
        >
          <Icon name="monitor_heart" size={15} />
        </button>
      </div>
      {menu.element}
    </div>
  );
}
