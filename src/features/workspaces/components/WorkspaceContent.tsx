// Workspace content router (spec §3.4): the tab bar (when ≥1 tab) above the
// active tab's body. With zero tabs the EmptyState fills the content area and
// no tab bar shows — matching the prototype. The content area itself is always
// rendered: it also hosts the saved-queries drawer, which the title bar's
// Query menu can open with nothing else on screen.
//
// Tabs + the active tab id live on the active workspace's `ui`; this reads
// them with a narrow selector and renders the active tab only (the
// prototype keeps inactive tabs mounted with display:none to preserve their
// state, but our per-tab state lives in the store / tabMeta seam, so we can
// mount just the active one — simpler, and grid scroll persistence is the
// grid's concern via the documented seam, Task 3).

import { useEffect, useMemo, useState } from "react";

import { PROC_SOURCES } from "../../processes/api";
import { ProcessesTab } from "../../processes/components/ProcessesTab";
import { SchemaDiff } from "../../schema_diff/components/SchemaDiff";
import { SchemaMap } from "../../schema_map/components/SchemaMap";
import { selectPanel, shellLabel, usePanelStore } from "../../console/state";
import { BTLogo } from "../../../shared/ui/BTLogo";
import { Kbd } from "../../../shared/ui/Kbd";
import { useToast } from "../../../shared/ui/toastContext";
import { useBtCmd } from "../../../shared/ui/btCmd";
import { type SavedQuery } from "../../saved_queries/api";
import { ObjectViewer } from "../../db_objects/components/ObjectViewer";
import { ObjectExplorer } from "../../db_objects/components/ObjectExplorer";
import { TableOverview } from "../../browse/sql/components/TableOverview";
import { useWorkspacesStore } from "../state";
import { useTabMetaStore } from "../tabMeta";
import type { Tab, Workspace } from "../types";
import { selectedSchema, unsavedSummary, unsavedTabIds } from "../types";
import { tabLabels } from "../tabLabels";
import { SavedQueriesDrawer } from "./QueryDrawers";
import { UnsavedTabsModal, type UnsavedTab } from "./UnsavedTabsModal";
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
  onOpenSavedQueries,
}: {
  tab: Tab;
  workspace: Workspace;
  currentSchema: string;
  /** Open the saved-queries drawer this component hosts (the query tab offers
   *  it from its history drawer). */
  onOpenSavedQueries: () => void;
}) {
  switch (tab.kind) {
    case "table":
      return <TableTab tab={tab} handleId={workspace.handleId} currentSchema={currentSchema} />;
    case "sql":
      return (
        <SqlEditorTab workspace={workspace} tab={tab} onOpenSavedQueries={onOpenSavedQueries} />
      );
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
    case "tableoverview":
      return (
        <TableOverview
          workspace={workspace}
          schema={tab.schema}
          view={tab.view}
          onViewChange={(v) => useWorkspacesStore.getState().setTableOverviewView(tab.id, v)}
        />
      );
  }
}

export function WorkspaceContent({ workspace }: { workspace: Workspace }) {
  const toast = useToast();
  const setActiveTab = useWorkspacesStore((state) => state.setActiveTab);
  const closeTab = useWorkspacesStore((state) => state.closeTab);
  const openSqlTab = useWorkspacesStore((state) => state.openSqlTab);
  const openSqlTabWith = useWorkspacesStore((state) => state.openSqlTabWith);
  const setSqlText = useWorkspacesStore((state) => state.setSqlText);
  const openProcessesTab = useWorkspacesStore((state) => state.openProcessesTab);
  const consoleOpen = usePanelStore((state) => selectPanel(state, workspace.id).open);
  const togglePanel = usePanelStore((state) => state.togglePanel);
  // The close-confirm seam: any entry point parks its set here, this owns the
  // one dialog that answers for all of them.
  const closeRequest = useTabMetaStore((state) => state.closeRequest);
  const requestTabClose = useTabMetaStore((state) => state.requestTabClose);
  const clearTabClose = useTabMetaStore((state) => state.clearTabClose);
  const requestDiscard = useTabMetaStore((state) => state.requestDiscard);
  const requestRefetch = useTabMetaStore((state) => state.requestRefetch);
  const discardTabEdits = useWorkspacesStore((state) => state.discardTabEdits);
  // The bar's discard prompt. Local (not on the seam like the close request):
  // it has exactly one entry point, the button this component renders.
  const [discardOpen, setDiscardOpen] = useState(false);
  // The saved-queries drawer. Hosted here rather than in the SQL tab because
  // its openers are the tab strip (always there), the title bar's Query menu
  // and the query tab's history drawer — a saved query is workspace-wide, so
  // browsing the list must not depend on a query tab being open.
  const [savedOpen, setSavedOpen] = useState(false);

  // Query ▸ Saved Queries (bt:cmd bus). Claimed here, not by the SQL tab: the
  // menu item is enabled for the whole SQL workspace, tabs or not.
  useBtCmd("saved-queries", () => setSavedOpen(true));

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
  const describe = (ids: string[]): UnsavedTab[] =>
    ids
      .filter((id) => unsaved.has(id))
      .map((id) => ({
        id,
        label: labels[tabs.findIndex((t) => t.id === id)]?.title ?? id,
        summary: unsavedSummary(workspace.ui, id),
      }));
  const pendingClose = (closeRequest ?? []).filter((id) => tabs.some((t) => t.id === id));
  const pendingUnsaved = describe(pendingClose);
  // Dirty tabs in strip order — what the bar's reload button would sweep.
  const dirtyTabs = describe(tabs.map((t) => t.id));

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

  // Load a saved query where the user can see it: into the active query tab
  // (replacing its buffer — what the drawer did when it lived in that tab), or
  // into a fresh one when the drawer was opened from the tab strip over
  // something else. Same destination rule as the command palette's saved-query
  // entries, which only ever have the second case.
  const loadSavedQuery = (q: SavedQuery) => {
    if (activeTab?.kind === "sql") setSqlText(activeTab.id, q.sql);
    else openSqlTabWith(q.sql);
    setSavedOpen(false);
    toast(`Loaded “${q.name}”`, "ok");
  };

  // Only engines with a server process list (PROC_SOURCES) get the toggle.
  const hasProcesses = workspace.saved.engine in PROC_SOURCES;

  // With no tabs the strip is gone, so the Query ▸ Saved Queries menu item is
  // the only opener left — the drawer is rendered below in that state too.
  const noTabs = tabs.length === 0;

  return (
    <>
      {noTabs ? null : (
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
          savedQueriesOpen={savedOpen}
          onOpenSavedQueries={() => setSavedOpen((open) => !open)}
          onOpenProcesses={hasProcesses ? () => openProcessesTab(procSchema) : undefined}
          onDiscardAll={dirtyTabs.length > 1 ? () => setDiscardOpen(true) : undefined}
        />
      )}
      <div className="tab-content">
        {noTabs ? <NoTabs /> : null}
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
            onOpenSavedQueries={() => setSavedOpen(true)}
          />
        ) : null}
        {/* Slides in over the tab body (`.tab-content` is its positioning
            context), so the strip it was opened from stays visible. */}
        <SavedQueriesDrawer
          open={savedOpen}
          connectionId={workspace.saved.id}
          onClose={() => setSavedOpen(false)}
          onLoad={loadSavedQuery}
        />
      </div>
      {/* Every close entry point funnels here (see `UnsavedTabsModal`). Rendered
          when the parked set still contains a dirty tab — if the last one was
          saved while the prompt was open there is nothing left to warn about. */}
      {pendingUnsaved.length > 0 ? (
        <UnsavedTabsModal
          intent="close"
          unsaved={pendingUnsaved}
          total={pendingClose.length}
          onConfirm={() => {
            pendingClose.forEach(closeTab);
            clearTabClose();
          }}
          onCancel={clearTabClose}
        />
      ) : null}
      {/* Discard-everything, from the bar's reload button. Clears the stored
          batches AND nudges the mounted grid, which holds its own copy. */}
      {discardOpen && dirtyTabs.length > 0 ? (
        <UnsavedTabsModal
          intent="discard"
          unsaved={dirtyTabs}
          total={dirtyTabs.length}
          onConfirm={() => {
            const ids = dirtyTabs.map((t) => t.id);
            // Drop the mounted grid's local batch, drop every stored batch, then
            // re-read from the database — "reload", not just "forget".
            requestDiscard(ids);
            discardTabEdits(ids);
            ids.forEach(requestRefetch);
            setDiscardOpen(false);
          }}
          onCancel={() => setDiscardOpen(false)}
        />
      ) : null}
    </>
  );
}
