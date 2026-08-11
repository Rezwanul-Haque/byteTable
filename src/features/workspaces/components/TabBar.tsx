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
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { Icon } from "../../../shared/ui/Icon";
import { useTabMenu } from "../../../shared/ui/useTabMenu";
import { OBJ_SECTIONS } from "../../db_objects/kinds";
import type { Tab } from "../types";
import "./TabBar.css";

// Kind → Material Symbol, matching the prototype's TAB_ICONS plus the
// structure-mode swap (a table tab in structure mode shows account_tree).
const TAB_ICONS: Record<Tab["kind"], string> = {
  table: "table",
  sql: "terminal",
  map: "schema",
  processes: "monitor_heart",
  diff: "difference",
  object: "visibility",
  objexplorer: "category",
};

function tabIcon(tab: Tab): string {
  if (tab.kind === "table" && tab.mode === "structure") return "account_tree";
  if (tab.kind === "object") return OBJ_SECTIONS[tab.objectKind].icon;
  return TAB_ICONS[tab.kind];
}

/** The visible label: just the table/object name while its schema is the one the
 *  workspace is on (the caller passes `currentSchema` — what the sidebar's schema
 *  switcher shows), `schema.name` for anything from another schema, the SQL
 *  "Query N" title, "schema · map", or a fixed name. */
function tabTitle(tab: Tab, currentSchema: string): string {
  switch (tab.kind) {
    case "table":
      return tab.schema === currentSchema ? tab.table : tab.schema + "." + tab.table;
    case "sql":
      return tab.title;
    case "map":
      return tab.schema + " · map";
    case "processes":
      return "Processes";
    case "diff":
      return "Schema diff";
    case "object":
      return tab.schema === currentSchema ? tab.name : tab.schema + "." + tab.name;
    case "objexplorer":
      return "Objects";
  }
}

/** Hover/`aria` text — always fully qualified for a schema-scoped tab, so the
 *  schema the shortened label drops is still one hover away. */
function tabTooltip(tab: Tab, currentSchema: string): string {
  switch (tab.kind) {
    case "table":
      return tab.schema + "." + tab.table;
    case "object":
      return tab.schema + "." + tab.name;
    default:
      return tabTitle(tab, currentSchema);
  }
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  /** The schema the workspace is currently on — tabs in it show a bare name. */
  currentSchema: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewSql: () => void;
  /** True when the docked console panel is open (M14) — lights the toggle. */
  consoleOpen: boolean;
  /** Toggle the docked console panel (M14). */
  onToggleConsole: () => void;
  /** Open the Processes tab (M26). Omitted for engines with no server process
   *  list, which hides the button. */
  onOpenProcesses?: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  currentSchema,
  onSelect,
  onClose,
  onNewSql,
  consoleOpen,
  onToggleConsole,
  onOpenProcesses,
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
  // "Open in new tab" puts the same table on the strip twice, which would render
  // two identical labels; number the repeats (`benefits`, `benefits (2)`) in tab
  // order so they can be told apart. Untouched when nothing repeats.
  const labels = useMemo(() => {
    const seen = new Map<string, number>();
    return tabs.map((tab) => {
      const base = tabTitle(tab, currentSchema);
      const nth = (seen.get(base) ?? 0) + 1;
      seen.set(base, nth);
      const ordinal = nth > 1 ? " (" + nth + ")" : "";
      return { title: base + ordinal, tooltip: tabTooltip(tab, currentSchema) + ordinal };
    });
  }, [tabs, currentSchema]);
  return (
    <div className="tabbar" role="tablist" aria-label="Open tabs">
      <div className="tabbar-tabs">
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const { title, tooltip } = labels[index] ?? {
            title: tabTitle(tab, currentSchema),
            tooltip: tabTooltip(tab, currentSchema),
          };
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
              title={tooltip}
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
                aria-label={"Close " + tooltip}
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
        {onOpenProcesses ? (
          <button
            type="button"
            className="tabbar-tool tabbar-tool-icon"
            title="Running processes (Ctrl+Shift+P)"
            aria-label="Running processes (Ctrl+Shift+P)"
            onClick={onOpenProcesses}
          >
            <Icon name="monitor_heart" size={15} />
          </button>
        ) : null}
      </div>
      {menu.element}
    </div>
  );
}
