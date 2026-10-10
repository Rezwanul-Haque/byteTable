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

import { useLocale, useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { useTabMenu } from "../../../shared/hooks/useTabMenu";
import { OBJ_SECTIONS } from "../../db_objects/kinds";
import { tabLabels } from "../tabLabels";
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
  tableoverview: "monitoring",
};

function tabIcon(tab: Tab): string {
  if (tab.kind === "table" && tab.mode === "structure") return "account_tree";
  if (tab.kind === "object") return OBJ_SECTIONS[tab.objectKind].icon;
  return TAB_ICONS[tab.kind];
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  /** The schema the workspace is currently on — tabs in it show a bare name. */
  currentSchema: string;
  /** Tabs with work that is not in the database yet (staged grid edits, pending
   *  structure ops) — marked with an unsaved dot. */
  unsavedTabIds: Set<string>;
  onSelect: (id: string) => void;
  /** Close these tabs — a set, because the strip's context menu closes many at
   *  once and the caller confirms unsaved work for the whole batch. */
  onClose: (ids: string[]) => void;
  onNewSql: () => void;
  /** True when the docked console panel is open (M14) — lights the toggle. */
  consoleOpen: boolean;
  /** Toggle the docked console panel (M14). */
  onToggleConsole: () => void;
  /** True when the saved-queries drawer is open — lights its toggle. */
  savedQueriesOpen?: boolean;
  /** Open the saved-queries drawer. Lives here, not just in the SQL tab's
   *  toolbar, so the saved list is reachable without opening a query tab.
   *  Omitted for engines with no saved queries, which hides the button. */
  onOpenSavedQueries?: () => void;
  /** Open the Processes tab (M26). Omitted for engines with no server process
   *  list, which hides the button. */
  onOpenProcesses?: () => void;
  /**
   * Drop every tab's staged changes (after a confirm). Omitted — and the button
   * hidden — unless MORE THAN ONE tab is dirty: a single dirty tab is the one on
   * screen, and its own save bar already offers Discard. This button exists for
   * the batch you cannot see from here.
   */
  onDiscardAll?: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  currentSchema,
  unsavedTabIds,
  onSelect,
  onClose,
  onNewSql,
  consoleOpen,
  onToggleConsole,
  savedQueriesOpen = false,
  onOpenSavedQueries,
  onOpenProcesses,
  onDiscardAll,
}: TabBarProps) {
  const menu = useTabMenu({
    ids: tabs.map((t) => t.id),
    close: onClose,
  });
  // Scroll the active tab into view when it changes — so a tab opened (and made
  // active) while the bar is scrolled past the edge isn't left hidden.
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabId]);
  // Labels read t() at build time; `locale` in the deps rebuilds them on a
  // language switch.
  const t = useT();
  const locale = useLocale();
  const labels = useMemo(() => tabLabels(tabs, currentSchema), [tabs, currentSchema, locale]);
  return (
    <div className="tabbar" role="tablist" aria-label={t("ws.tabs.openAria")}>
      <div className="tabbar-tabs">
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const unsaved = unsavedTabIds.has(tab.id);
          // `labels` is built from the same array, so the index always hits.
          const { title, tooltip } = labels[index] ?? { title: tab.id, tooltip: tab.id };
          const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(tab.id);
            } else if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              onClose([tab.id]);
            }
          };
          const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
            // Middle-click closes (spec §3.4 / §3.12).
            if (event.button === 1) {
              event.preventDefault();
              onClose([tab.id]);
            }
          };
          return (
            <div
              key={tab.id}
              ref={active ? activeTabRef : undefined}
              className={"tab" + (active ? " active" : "") + (unsaved ? " unsaved" : "")}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              onKeyDown={onKeyDown}
              onMouseDown={onMouseDown}
              onContextMenu={(e) => menu.onContextMenu(e, tab.id)}
              title={unsaved ? tooltip + " " + t("ws.tabs.unsavedSuffix") : tooltip}
            >
              <Icon
                name={tabIcon(tab)}
                size={14}
                style={{ color: active ? "var(--accent)" : "var(--text-faint)" }}
              />
              <span className="tab-title">{title}</span>
              {/* Unsaved marker: staged rows/cells or pending structure ops that
                  closing the tab would throw away. Sits before the × so the
                  close target does not move as the dot appears. */}
              {unsaved ? <span className="tab-unsaved-dot" aria-hidden="true" /> : null}
              <button
                type="button"
                className="tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose([tab.id]);
                }}
                title={t("ws.tabs.close")}
                aria-label={t("ws.tabs.closeAria", { name: tooltip })}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="tab-new" onClick={onNewSql} title={t("ws.tabs.newSql")}>
        <Icon name="add" size={16} />
      </button>
      <div className="tabbar-tools">
        {/* Sits before Terminal so the tools read left-to-right as
            "undo the mess" → "open a shell". */}
        {onDiscardAll ? (
          <button
            type="button"
            className="tabbar-tool tabbar-tool-icon tabbar-tool-warn"
            title={t("ws.tabs.discardAll", { count: unsavedTabIds.size })}
            aria-label={t("ws.tabs.discardAll", { count: unsavedTabIds.size })}
            onClick={onDiscardAll}
          >
            <Icon name="refresh" size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className={"tabbar-tool" + (consoleOpen ? " active" : "")}
          title={t("ws.tabs.toggleTerminal")}
          aria-label={t("ws.tabs.toggleTerminal")}
          aria-pressed={consoleOpen}
          onClick={onToggleConsole}
        >
          <Icon name="terminal" size={15} />
          <span>{t("ws.tabs.terminal")}</span>
        </button>
        {/* Beside Terminal: the saved queries are workspace-wide, not a
            property of whichever tab happens to be open, so browsing them
            must not require a query tab. */}
        {onOpenSavedQueries ? (
          <button
            type="button"
            className={"tabbar-tool tabbar-tool-icon" + (savedQueriesOpen ? " active" : "")}
            title={t("ws.sql.savedQueries")}
            aria-label={t("ws.sql.savedQueries")}
            aria-pressed={savedQueriesOpen}
            onClick={onOpenSavedQueries}
          >
            <Icon name="bookmarks" size={15} />
          </button>
        ) : null}
        {onOpenProcesses ? (
          <button
            type="button"
            className="tabbar-tool tabbar-tool-icon"
            title={t("ws.tabs.processes")}
            aria-label={t("ws.tabs.processes")}
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
