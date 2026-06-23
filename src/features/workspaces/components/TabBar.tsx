// Tab bar — ported from the prototype's workspace.jsx `TabBar` (spec §3.4).
// 37px strip of tabs above the content area: kind icon + mono title + close
// ×; active tab gets a 2px accent top bar; "+" opens a new SQL tab.
// Middle-click closes a tab.
//
// State comes from the active workspace's `ui` (tabs + activeTabId) via the
// store; actions are store methods. Tabs are plain divs in the prototype —
// we keep that but make them keyboard-operable (Enter/Space select, Delete
// closes) and label the strip for a11y.

import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { Icon } from "../../../shared/ui/Icon";
import { useTabMenu } from "../../../shared/ui/useTabMenu";
import type { Tab } from "../types";
import "./TabBar.css";

// Kind → Material Symbol, matching the prototype's TAB_ICONS plus the
// structure-mode swap (a table tab in structure mode shows account_tree).
const TAB_ICONS: Record<Tab["kind"], string> = {
  table: "table",
  sql: "terminal",
  map: "schema",
};

function tabIcon(tab: Tab): string {
  if (tab.kind === "table" && tab.mode === "structure") return "account_tree";
  return TAB_ICONS[tab.kind];
}

/** The visible label: `schema.table` for non-default schemas (the caller
 *  passes `defaultSchema` so we know when to drop it), the SQL "Query N"
 *  title, or "schema · map". */
function tabTitle(tab: Tab, defaultSchema: string): string {
  switch (tab.kind) {
    case "table":
      return tab.schema === defaultSchema ? tab.table : tab.schema + "." + tab.table;
    case "sql":
      return tab.title;
    case "map":
      return tab.schema + " · map";
  }
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  defaultSchema: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewSql: () => void;
  /** True when the docked console panel is open (M14) — lights the toggle. */
  consoleOpen: boolean;
  /** Toggle the docked console panel (M14). */
  onToggleConsole: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  defaultSchema,
  onSelect,
  onClose,
  onNewSql,
  consoleOpen,
  onToggleConsole,
}: TabBarProps) {
  const menu = useTabMenu({
    ids: tabs.map((t) => t.id),
    close: (ids) => ids.forEach(onClose),
  });
  // Scroll the active tab into view when it changes — so a tab opened (and made
  // active) while the bar is scrolled past the edge isn't left hidden.
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabId]);
  return (
    <div className="tabbar" role="tablist" aria-label="Open tabs">
      <div className="tabbar-tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const title = tabTitle(tab, defaultSchema);
          const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(tab.id);
            } else if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              onClose(tab.id);
            }
          };
          const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
            // Middle-click closes (spec §3.4 / §3.12).
            if (event.button === 1) {
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
              <Icon
                name={tabIcon(tab)}
                size={14}
                style={{ color: active ? "var(--accent)" : "var(--text-faint)" }}
              />
              <span className="tab-title">{title}</span>
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
            </div>
          );
        })}
      </div>
      <button type="button" className="tab-new" onClick={onNewSql} title="New SQL query (⌘T)">
        <Icon name="add" size={16} />
      </button>
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
