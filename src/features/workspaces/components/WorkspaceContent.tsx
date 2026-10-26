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

import { BrainstormBoard } from "../../brainstorm_board/components/BrainstormBoard";
import { PROC_SOURCES } from "../../processes/api";
import { ProcessesTab } from "../../processes/components/ProcessesTab";
import { PrivilegesTab } from "../../privileges/components/PrivilegesTab";
import { SchemaDiff } from "../../schema_diff/components/SchemaDiff";
import { SchemaMap } from "../../schema_map/components/SchemaMap";
import { selectPanel, shellLabel, usePanelStore } from "../../console/state";
import { BTLogo } from "../../../shared/ui/BTLogo";
import { Kbd } from "../../../shared/ui/Kbd";
import { useT } from "../../../shared/i18n/useT";
import { useToast } from "../../../shared/ui/toastContext";
import { useBtCmd } from "../../../shared/ui/btCmd";
import { type SavedQuery } from "../../saved_queries/api";
import { ObjectViewer } from "../../db_objects/components/ObjectViewer";
import { ObjectExplorer } from "../../db_objects/components/ObjectExplorer";
import { TableOverview } from "../../browse/sql/components/TableOverview";
import { useWorkspacesStore } from "../state";
import { useTabMetaStore } from "../tabMeta";
import type { SqlHistoryEntry, Tab, Workspace } from "../types";
import { selectedSchema, unsavedSummary, unsavedTabIds } from "../types";
import { tabLabels } from "../tabLabels";
import type { Snippet } from "../../snippets/api";
import { SnippetsDrawer } from "../../snippets/components/SnippetsDrawer";
import { insertSnippetIntoActiveEditor } from "../../../shared/ui/activeCodeEditor";
import { HistoryDrawer, SavedQueriesDrawer } from "./QueryDrawers";
import { UnsavedTabsModal, type UnsavedTab } from "./UnsavedTabsModal";
import { SqlEditorTab } from "./SqlEditorTab";
import { TabBar } from "./TabBar";
import { TableTab } from "./TableTab";
import "./WorkspaceContent.css";

/** No-tabs state (prototype workspace.jsx empty-state copy). */
function NoTabs() {
  const t = useT();
  return (
    <div className="empty-state">
      <BTLogo size={40} accent="var(--text-faint)" fg="var(--text-faint)" />
      <p>{t("ws.empty.title")}</p>
      <span>
        {t("ws.empty.pre")} <Kbd>⌘K</Kbd> / <Kbd>Ctrl+K</Kbd> / <Kbd>⇧⇧</Kbd> {t("ws.empty.mid")}{" "}
        <Kbd>⌘T</Kbd> / <Kbd>Ctrl+T</Kbd> {t("ws.empty.post")}
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
    case "board":
      return (
        <BrainstormBoard
          tabId={tab.id}
          schemaName={tab.schema}
          connectionId={workspace.saved.id}
          connectionName={workspace.saved.name}
          handleId={workspace.handleId}
          // Only the active tab is mounted, so being here IS being active.
          isActive
          onNameChange={(name) => useWorkspacesStore.getState().setBoardTabName(tab.id, name)}
          onOpenInSql={(sql) => useWorkspacesStore.getState().openSqlTabWith(sql)}
        />
      );
    case "processes":
      return (
        <ProcessesTab
          handleId={workspace.handleId}
          engine={workspace.saved.engine}
          env={workspace.saved.env}
          schemaName={tab.schema}
        />
      );
    case "privileges":
      return (
        <PrivilegesTab
          handleId={workspace.handleId}
          engine={workspace.saved.engine}
          env={workspace.saved.env}
          // The workspace's LIVE schema, not `tab.schema`: the latter is frozen
          // at open time, so switching schema in the sidebar left the matrix
          // scoped to wherever the tab started. The tab can still scope itself
          // elsewhere from its own switcher.
          schemaName={selectedSchema(workspace) ?? tab.schema}
          schemas={workspace.schemas.map((s) => s.name)}
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
  const openSqlTabWithSnippet = useWorkspacesStore((state) => state.openSqlTabWithSnippet);
  const setSqlText = useWorkspacesStore((state) => state.setSqlText);
  const setSqlSavedLink = useWorkspacesStore((state) => state.setSqlSavedLink);
  const setSqlParams = useWorkspacesStore((state) => state.setSqlParams);
  const setSqlParamDefs = useWorkspacesStore((state) => state.setSqlParamDefs);
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
  // The run-history drawer. Hosted here, exactly like the saved queries and
  // for the same reason: the history is the WORKSPACE's (every statement run
  // against this connection), so browsing it must not depend on which tab — or
  // whether any query tab — happens to be open.
  const [historyOpen, setHistoryOpen] = useState(false);
  // The snippet-library drawer. Hosted here for the same reason again: the
  // library is global, so managing it must not depend on a query tab. Inserting
  // from it does need an editor, which the insert handler below checks.
  const [snippetsOpen, setSnippetsOpen] = useState(false);

  // Query ▸ Saved Queries (bt:cmd bus). Claimed here, not by the SQL tab: the
  // menu item is enabled for the whole SQL workspace, tabs or not.
  useBtCmd("saved-queries", () => {
    setHistoryOpen(false);
    setSnippetsOpen(false);
    setSavedOpen(true);
  });
  // Claimed here too, not by the SQL tab: the history is the workspace's, so
  // Query ▸ History works with no query tab open — the menu item is enabled
  // for the whole SQL workspace.
  useBtCmd("query-history", () => {
    setSavedOpen(false);
    setSnippetsOpen(false);
    setHistoryOpen(true);
  });
  // Query ▸ Snippet Library. Claimed here as well — the library is global, so
  // the menu item is enabled for the whole SQL workspace and needs no query
  // tab to browse (inserting does, which `insertSnippet` below reports).
  useBtCmd("snippets", () => {
    setSavedOpen(false);
    setHistoryOpen(false);
    setSnippetsOpen(true);
  });

  // Insert a snippet into the editor the user was last in. The drawer took
  // focus when they clicked, so this goes through the last-focused-view
  // registry (the same one the title bar's Undo uses) rather than a ref the
  // drawer does not have. Inserting into an editor that was already there
  // leaves the drawer open: a snippet is often one of several being pasted in.
  //
  // With no live editor to insert into — no query tab open, or the active tab
  // is a grid, which unmounts the editor and clears the registry — opening one
  // is the obvious thing the user wanted, so the click does that instead of
  // refusing. A FRESH tab rather than an existing query tab, deliberately: the
  // registry cannot say which buffer they meant, and expanding a snippet into
  // half-written SQL they cannot see is worse than one more tab. That path DOES
  // close the drawer: it slides over the tab body, so leaving it up would hide
  // the editor it just opened, with the caret parked on a tab stop the user
  // cannot see.
  const insertSnippet = (snippet: Snippet) => {
    if (!insertSnippetIntoActiveEditor(snippet.body)) {
      openSqlTabWithSnippet(snippet.body);
      setSnippetsOpen(false);
    }
    toast(t("ws.snip.inserted", { name: snippet.name }), "ok");
  };

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
    activeTab?.kind === "table" || activeTab?.kind === "map" || activeTab?.kind === "board"
      ? activeTab.schema
      : currentSchema;

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
  const t = useT();
  const labels = useMemo(() => tabLabels(tabs, currentSchema, t), [tabs, currentSchema, t]);
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
  //
  // Either way the tab is linked to the entry, so editing and saving again
  // updates it rather than leaving a second copy behind.
  // A history entry loads exactly like a saved query — into the active query
  // tab, or a new one when the active tab is something else — except it links
  // to no saved entry: re-running something out of the history must not make
  // "Save" overwrite whatever query it happened to come from.
  // A history entry's SQL is already RESOLVED (parameters were substituted
  // before the run), so it carries no declarations and no values — any the
  // target tab had described a different buffer and are cleared with it.
  const loadHistoryEntry = (entry: SqlHistoryEntry) => {
    if (activeTab?.kind === "sql") {
      setSqlText(activeTab.id, entry.sql);
      setSqlSavedLink(activeTab.id, null);
      setSqlParams(activeTab.id, {});
      setSqlParamDefs(activeTab.id, []);
    } else openSqlTabWith(entry.sql);
    setHistoryOpen(false);
  };

  // A saved query brings its parameter declarations AND the values it last ran
  // with, so a report query reopens ready to run rather than ready to fill in.
  const loadSavedQuery = (q: SavedQuery) => {
    if (activeTab?.kind === "sql") {
      setSqlText(activeTab.id, q.sql);
      setSqlSavedLink(activeTab.id, q.id);
      setSqlParams(activeTab.id, q.paramValues ?? {});
      setSqlParamDefs(activeTab.id, q.params ?? []);
    } else openSqlTabWith(q.sql, q.id, undefined, q.paramValues ?? {}, q.params ?? []);
    setSavedOpen(false);
    toast(t("ws.sql.loaded", { name: q.name }), "ok");
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
          onOpenSavedQueries={() => {
            setHistoryOpen(false);
            setSnippetsOpen(false);
            setSavedOpen((open) => !open);
          }}
          snippetsOpen={snippetsOpen}
          onOpenSnippets={() => {
            setSavedOpen(false);
            setHistoryOpen(false);
            setSnippetsOpen((open) => !open);
          }}
          // Always offered, like Saved queries: the list belongs to the
          // workspace, not to a query tab. All three drawers slide into the same
          // right-hand slot, so each opener closes the others.
          historyOpen={historyOpen}
          onOpenHistory={() => {
            setSavedOpen(false);
            setSnippetsOpen(false);
            setHistoryOpen((open) => !open);
          }}
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
        <SnippetsDrawer
          open={snippetsOpen}
          engine={workspace.info.engine}
          onClose={() => setSnippetsOpen(false)}
          onInsert={insertSnippet}
        />
        <HistoryDrawer
          open={historyOpen}
          history={workspace.ui.history ?? []}
          onClose={() => setHistoryOpen(false)}
          onLoad={loadHistoryEntry}
          // The drawers share this slot, so handing over closes this one.
          onOpenSaved={() => {
            setHistoryOpen(false);
            setSavedOpen(true);
          }}
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
