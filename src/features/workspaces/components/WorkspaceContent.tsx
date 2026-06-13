// Workspace content router (spec §3.4): the tab bar (when ≥1 tab) above the
// active tab's body. With zero tabs the EmptyState fills the area and no tab
// bar shows — matching the prototype.
//
// Tabs + the active tab id live on the active workspace's `ui`; this reads
// them with a narrow selector and renders the active tab only (the
// prototype keeps inactive tabs mounted with display:none to preserve their
// state, but our per-tab state lives in the store / tabMeta seam, so we can
// mount just the active one — simpler, and grid scroll persistence is the
// grid's concern via the documented seam, Task 3).

import { BTLogo } from "../../../shared/ui/BTLogo";
import { Kbd } from "../../../shared/ui/Kbd";
import { useWorkspacesStore } from "../state";
import type { Tab, Workspace } from "../types";
import { SqlEditorTab } from "./SqlEditorTab";
import { TabBar } from "./TabBar";
import { TableTab } from "./TableTab";
import "./WorkspaceContent.css";

/** Schema-map placeholder — the real ER diagram is M9 (spec §3.8). */
function MapPlaceholder({ tab }: { tab: Extract<Tab, { kind: "map" }> }) {
  return (
    <div className="tab-placeholder">
      <BTLogo size={40} accent="currentColor" fg="currentColor" />
      <p>Schema map arrives in M9</p>
      <span>{tab.schema + " · map"}</span>
    </div>
  );
}

/** No-tabs state (prototype workspace.jsx empty-state copy). */
function NoTabs() {
  return (
    <div className="empty-state">
      <BTLogo size={40} accent="var(--text-faint)" fg="var(--text-faint)" />
      <p>No open tabs</p>
      <span>
        Pick a table from the sidebar, press <Kbd>⌘K</Kbd> to jump, or <Kbd>⌘T</Kbd> for a SQL
        query.
      </span>
    </div>
  );
}

function TabBody({
  tab,
  workspace,
  defaultSchema,
}: {
  tab: Tab;
  workspace: Workspace;
  defaultSchema: string;
}) {
  switch (tab.kind) {
    case "table":
      return <TableTab tab={tab} handleId={workspace.handleId} defaultSchema={defaultSchema} />;
    case "sql":
      return <SqlEditorTab workspace={workspace} tab={tab} />;
    case "map":
      return <MapPlaceholder tab={tab} />;
  }
}

export function WorkspaceContent({ workspace }: { workspace: Workspace }) {
  const setActiveTab = useWorkspacesStore((state) => state.setActiveTab);
  const closeTab = useWorkspacesStore((state) => state.closeTab);
  const openSqlTab = useWorkspacesStore((state) => state.openSqlTab);

  const tabs = workspace.ui.tabs ?? [];
  const activeTabId = workspace.ui.activeTabId ?? null;
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // Default schema for tab-title shortening (drop schema prefix on the
  // connection's first schema — SQLite: "main").
  const defaultSchema = workspace.schemas[0]?.name ?? "main";

  if (tabs.length === 0) return <NoTabs />;

  return (
    <>
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        defaultSchema={defaultSchema}
        onSelect={setActiveTab}
        onClose={closeTab}
        onNewSql={openSqlTab}
      />
      <div className="tab-content">
        {activeTab ? (
          <TabBody tab={activeTab} workspace={workspace} defaultSchema={defaultSchema} />
        ) : null}
      </div>
    </>
  );
}
