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

import { useEffect, useMemo } from "react";

import { PROC_SOURCES } from "../../processes/api";
import { ProcessesTab } from "../../processes/ProcessesTab";
import { SchemaDiff } from "../../schema_diff/components/SchemaDiff";
import { SchemaMap } from "../../schema_map/components/SchemaMap";
import { selectPanel, shellLabel, usePanelStore } from "../../console/state";
import { BTLogo } from "../../../shared/ui/BTLogo";
import { Kbd } from "../../../shared/ui/Kbd";
import { ObjectViewer } from "../../db_objects/components/ObjectViewer";
import { ObjectExplorer } from "../../db_objects/components/ObjectExplorer";
import { useWorkspacesStore } from "../state";
import { useTabMetaStore } from "../tabMeta";
import type { Tab, Workspace } from "../types";
import { selectedSchema, unsavedSummary, unsavedTabIds } from "../types";
import { tabLabels } from "../tabLabels";
import { CloseTabsModal, type UnsavedTab } from "./CloseTabsModal";
import { SqlEditorTab } from "./SqlEditorTab";
import { TabBar } from "./TabBar";
import { TableTab } from "./TableTab";
import "./WorkspaceContent.css";

/** No-tabs state (prototype workspace.jsx empty-state copy). */
function NoTabs() {
  return (
    <div className="empty-state">
      <BTLogo size={40} accent="var(--text-faint)" fg="var(--text-faint)" />
      <p>No open tabs</p>
      <span>
        Pick a table from the sidebar, press <Kbd>⌘K</Kbd> / <Kbd>Ctrl+K</Kbd> to jump, or{" "}
        <Kbd>⌘T</Kbd> / <Kbd>Ctrl+T</Kbd> for a SQL query.
      </span>
    </div>
  );
}

function TabBody({
  tab,
  workspace,
  currentSchema,
}: {
  tab: Tab;
  workspace: Workspace;
  currentSchema: string;
}) {
  switch (tab.kind) {
    case "table":
      return <TableTab tab={tab} handleId={workspace.handleId} currentSchema={currentSchema} />;
    case "sql":
      return <SqlEditorTab workspace={workspace} tab={tab} />;
    case "map":
      return <SchemaMap workspace={workspace} schema={tab.schema} />;
    case "processes":
      return (
        <ProcessesTab
          handleId={workspace.handleId}
          engine={workspace.saved.engine}
          env={workspace.saved.env}
          schemaName={tab.schema}
        />
      );
    case "diff":
      // Compare-only from the workspace: the diff tab compares this schema
      // against another connection's; applying a migration is the sync mode,
      // which no entry point mounts yet.
      return <SchemaDiff currentConn={workspace.saved} compareOnly />;
    case "object":
      return (
        <ObjectViewer
          workspace={workspace}
          tabId={tab.id}
          schema={tab.schema}
          objectKind={tab.objectKind}
          name={tab.name}
          detail={tab.detail}
        />
      );
    case "objexplorer":
      return (
        <ObjectExplorer workspace={workspace} schema={tab.schema} focusClass={tab.focusClass} />
      );
  }
}

export function WorkspaceContent({ workspace }: { workspace: Workspace }) {
  const setActiveTab = useWorkspacesStore((state) => state.setActiveTab);
  const closeTab = useWorkspacesStore((state) => state.closeTab);
  const openSqlTab = useWorkspacesStore((state) => state.openSqlTab);
  const openProcessesTab = useWorkspacesStore((state) => state.openProcessesTab);
  const consoleOpen = usePanelStore((state) => selectPanel(state, workspace.id).open);
  const togglePanel = usePanelStore((state) => state.togglePanel);
  // The close-confirm seam: any entry point parks its set here, this owns the
  // one dialog that answers for all of them.
  const closeRequest = useTabMetaStore((state) => state.closeRequest);
  const requestTabClose = useTabMetaStore((state) => state.requestTabClose);
  const clearTabClose = useTabMetaStore((state) => state.clearTabClose);

  // Memoised so the label/dirty derivations below have a stable dependency.
  const tabs = useMemo(() => workspace.ui.tabs ?? [], [workspace.ui.tabs]);
  const activeTabId = workspace.ui.activeTabId ?? null;
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // The schema this workspace is currently on — the same `selectedSchema` the
  // sidebar's switcher displays. Tab titles and the Structure heading shorten
  // against THIS, not the connection's first schema: a workspace parked on
  // `forestmw` would otherwise prefix every tab with `forestmw.` just because
  // another database happens to be listed first.
  const currentSchema = selectedSchema(workspace) ?? "main";

  // Schema the Processes tab opens against — the active tab's schema when it
  // has one, else the one the workspace is on. Mirrors StatusBar's "processes" btn.
  const procSchema =
    activeTab?.kind === "table" || activeTab?.kind === "map" ? activeTab.schema : currentSchema;

  // Tabs holding work that is not in the database yet — staged grid rows/cells
  // and pending structure ops, both on `ui` keyed by tab id. Drives the strip's
  // unsaved dot AND the confirm below, from one definition.
  const unsaved = useMemo(
    () => unsavedTabIds(workspace.ui),
    [workspace.ui.gridEdits, workspace.ui.structureEdits], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // A close is destructive for a dirty tab (`closeTab` prunes its batch), so it
  // routes through the confirm. Clean closes stay instant. The whole set is
  // parked on the seam, not just the dirty ids: confirming has to close the
  // clean tabs of a "Close others" too, and cancelling has to close none.
  const requestClose = (ids: string[]) => {
    if (ids.some((id) => unsaved.has(id))) requestTabClose(ids);
    else ids.forEach(closeTab);
  };
  // Tabs still open + still dirty when the prompt renders, with the label the
  // strip shows them under (ordinal included, so "trees (2)" is unambiguous).
  const labels = useMemo(() => tabLabels(tabs, currentSchema), [tabs, currentSchema]);
  const pendingClose = (closeRequest ?? []).filter((id) => tabs.some((t) => t.id === id));
  const pendingUnsaved: UnsavedTab[] = pendingClose
    .filter((id) => unsaved.has(id))
    .map((id) => ({
      id,
      label: labels[tabs.findIndex((t) => t.id === id)]?.title ?? id,
      summary: unsavedSummary(workspace.ui, id),
    }));

  // A parked request with nothing dirty left in it needs no prompt — honour the
  // close rather than dropping the user's gesture. (Reachable when the tabs went
  // away, or a batch was cleared, between the request and this render.)
  useEffect(() => {
    if (!closeRequest || pendingUnsaved.length > 0) return;
    pendingClose.forEach(closeTab);
    clearTabClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeRequest]);

  // The request is transient UI: drop it when this strip goes away (a workspace
  // switch — App keys the shell by workspace id), so a prompt raised in one
  // workspace cannot resurface later in another.
  useEffect(() => clearTabClose, [clearTabClose]);

  // Only engines with a server process list (PROC_SOURCES) get the toggle.
  const hasProcesses = workspace.saved.engine in PROC_SOURCES;

  if (tabs.length === 0) return <NoTabs />;

  return (
    <>
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        currentSchema={currentSchema}
        unsavedTabIds={unsaved}
        onSelect={setActiveTab}
        onClose={requestClose}
        onNewSql={openSqlTab}
        consoleOpen={consoleOpen}
        onToggleConsole={() => togglePanel(workspace.id, shellLabel(workspace.saved.engine))}
        onOpenProcesses={hasProcesses ? () => openProcessesTab(procSchema) : undefined}
      />
      <div className="tab-content">
        {activeTab ? (
          // Keyed by tab id: only the ACTIVE tab is mounted, so without a key
          // React reuses one TableTab/DataGrid instance across tab switches and
          // everything that body keeps in local state (staged edits, the row
          // cache, column widths, scroll, the row inspector) rides along to the
          // next tab. That was papered over by resetting on schema/table change,
          // which cannot tell two tabs on the SAME table apart — exactly what
          // "Open in new tab" creates. One instance per tab, no bleed.
          <TabBody
            key={activeTab.id}
            tab={activeTab}
            workspace={workspace}
            currentSchema={currentSchema}
          />
        ) : null}
      </div>
      {/* Every close entry point funnels here (see `CloseTabsModal`). Rendered
          when the parked set still contains a dirty tab — if the last one was
          saved while the prompt was open there is nothing left to warn about. */}
      {pendingUnsaved.length > 0 ? (
        <CloseTabsModal
          unsaved={pendingUnsaved}
          total={pendingClose.length}
          onConfirm={() => {
            pendingClose.forEach(closeTab);
            clearTabClose();
          }}
          onCancel={clearTabClose}
        />
      ) : null}
    </>
  );
}
