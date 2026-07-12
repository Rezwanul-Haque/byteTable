// MongoDB workspace shell (M18) — the fourth sibling of WorkspaceShell /
// RedisWorkspace / DynamoWorkspace the App routes to when a connection's kind is
// "mongo". Same frame (sidebar | tab bar + content | status bar). Opens on the
// Dashboard tab (§18.1). Tab kinds: dashboard / collection / pipeline / map /
// shell (mongosh). The `+` opens a new aggregation pipeline; the mongosh button
// and Ctrl/⌘+` toggle the shell tab. Ported from the prototype's MongoWorkspace,
// with all data fetched from the backend.

import { useCallback, useEffect, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { ENV_COLOR } from "../../../../shared/ui/envColors";
import { Icon } from "../../../../shared/ui/Icon";
import { useTabMenu } from "../../../../shared/ui/useTabMenu";
import { connectionDetail } from "../../../connections/api";
import { TerminalPanel } from "../../../console/TerminalPanel";
import { shellLabel, usePanelStore } from "../../../console/state";
import { useWorkspacesStore } from "../../../workspaces/state";
import type { Workspace } from "../../../workspaces/types";
import { mongoListCollections, mongoListDatabases, type CollectionDescriptor } from "../api";
import { MongoCollectionTab, type MongoTab } from "./MongoCollectionTab";
import { MongoDashboard } from "./MongoDashboard";
import { MongoExportModal, MongoImportModal } from "./MongoIoModals";
import { MongoPipelineTab, type MongoPipelineTabState } from "./MongoPipelineTab";
import { MongoSchemaMap } from "./MongoSchemaMap";
import { MongoSidebar } from "./MongoSidebar";
import { SidebarResizer } from "../../../../shared/ui/SidebarResizer";
import { useAutoRefresh } from "../../../settings/useAutoRefresh";
import { useMongoActiveDbStore, useMongoShellStore } from "../shellState";
import { useMongoTabsStore, type MongoWorkspaceTab as Tab } from "../workspaceTabs";
// Shared chrome the Mongo slice REUSES (per MILESTONE_18: "do not re-style it").
// These classes live in other slices' CSS files; in a production build they're
// all bundled into one stylesheet, but `vite dev` only injects a file's CSS when
// its owning component mounts — so a Mongo-first session would be missing them
// (e.g. the Find tree's flex container collapses). Importing them here makes the
// Mongo workspace self-contained, like the Dynamo slice, in dev and prod alike.
import "../../../workspaces/components/WorkspaceContent.css"; // .tab-content, .empty-state
import "../../../workspaces/components/Sidebar.css"; // .sidebar, .schema-row/-btn/-pop, .table-item
import "../../../workspaces/components/TabBar.css"; // .tabbar, .tab, .tab-new
import "../../../workspaces/components/StatusBar.css"; // .statusbar, .ws-chip, .env-tag, .status-*
import "../../../workspaces/components/TableTab.css"; // .table-tab, .table-toolbar, .seg/.seg-btn
import "../../../workspaces/components/SqlEditorTab.css"; // .sql-error, .sql-hint, .sql-snippets, .snippet-chip
import "../../shared/DataGrid.css"; // .datagrid, .dg-*, .cell-*
import "../../shared/StructureView.css"; // .structure-table, .structure-card, .ddl-block, .tag
import "../../redis/components/DashboardTab.css"; // .rdash-*
import "../../../console/SqlTerminalTab.css"; // .rcli-* terminal chrome
import "../../../export/components/ExportProgressModal.css"; // .export-*
import "../../../import/components/ImportModal.css"; // .import-*
import "../../dynamo/components/Dynamo.css"; // .ddb-* (toolbar/row/dash-num/io-label/seg/item-actions/edit-dot)
import "../../../console/TerminalPanel.css"; // docked mongosh panel chrome
// Mongo-specific (mg-*) styles load LAST so they win on any conflict.
import "./Mongo.css";

const TAB_ICON: Record<string, string> = {
  dashboard: "monitoring",
  collection: "folder_special",
  pipeline: "account_tree",
  map: "schema",
};

let seq = 0;
const nextId = (p: string) => "mg-" + p + "-" + ++seq;

export function MongoWorkspace({ workspace }: { workspace: Workspace }) {
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);
  const handleId = workspace.handleId;
  const params = workspace.saved.params;
  const env = workspace.saved.env;
  const envColor = ENV_COLOR[env];
  const isProduction = env === "production";
  const detail = connectionDetail(params);
  const serverVersion = workspace.info.serverVersion;

  // mongosh docks as the shared bottom TerminalPanel (keyed by workspace id),
  // exactly like the SQL/Redis/Dynamo consoles — not a tab.
  const termLabel = shellLabel(workspace.saved.engine);
  const openPanel = usePanelStore((s) => s.openPanel);
  const togglePanel = usePanelStore((s) => s.togglePanel);
  const setActiveDb = useMongoActiveDbStore((s) => s.setDb);

  // Tabs / active tab / selected db persist per-workspace (survive switching
  // away and back); collections/loading/version are transient and refetched on
  // mount.
  const ensureTabs = useMongoTabsStore((s) => s.ensure);
  const patchTabs = useMongoTabsStore((s) => s.patch);
  const tabState = useMongoTabsStore((s) => s.byWorkspace[workspace.id]);
  const tabs: Tab[] = tabState?.tabs ?? [{ id: "mg-dash", kind: "dashboard", title: "Dashboard" }];
  const activeId = tabState?.activeId ?? "mg-dash";
  const db = tabState?.db ?? "";

  const peekTabs = () => useMongoTabsStore.getState().byWorkspace[workspace.id]?.tabs ?? tabs;
  const setTabs = (next: Tab[] | ((ts: Tab[]) => Tab[])) =>
    patchTabs(workspace.id, { tabs: typeof next === "function" ? next(peekTabs()) : next });
  const setActiveId = (id: string) => patchTabs(workspace.id, { activeId: id });
  const setDb = (d: string) => patchTabs(workspace.id, { db: d });

  const [dbNames, setDbNames] = useState<string[]>([]);
  const [collections, setCollections] = useState<CollectionDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const [exportJob, setExportJob] = useState<{ scope: "collection" | "all"; coll?: string } | null>(
    null,
  );
  const [importTarget, setImportTarget] = useState<{ coll: string | null } | null>(null);

  const loadCollections = useCallback(
    async (database: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await mongoListCollections(handleId, database);
        setCollections(list);
      } catch (e) {
        setError(
          isAppErrorPayload(e) ? e.message : "Could not list collections (desktop app required)",
        );
        setCollections([]);
      } finally {
        setLoading(false);
      }
    },
    [handleId],
  );

  // Initial load: databases → (persisted or default) db → its collections.
  // Reuses the persisted db when returning to a workspace so tabs + selection
  // are restored rather than reset.
  useEffect(() => {
    ensureTabs(workspace.id);
    let live = true;
    (async () => {
      try {
        const names = await mongoListDatabases(handleId);
        if (!live) return;
        setDbNames(names);
        const stored = useMongoTabsStore.getState().byWorkspace[workspace.id]?.db ?? "";
        const target = stored || names[0] || "";
        if (!stored && target) setDb(target);
        if (target) void loadCollections(target);
        else setLoading(false);
      } catch (e) {
        if (!live) return;
        setError(
          isAppErrorPayload(e) ? e.message : "Could not list databases (desktop app required)",
        );
        setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, loadCollections, workspace.id]);

  // Publish the selected database so the docked mongosh session seeds its prompt
  // with the db the user actually picked (not a re-derived first-listed one).
  useEffect(() => {
    if (db) setActiveDb(workspace.id, db);
  }, [db, workspace.id, setActiveDb]);

  // Drop this workspace's persisted state when it is CLOSED (not on a mere
  // switch): on unmount, prune only if the workspace is gone from the store.
  useEffect(() => {
    const wsId = workspace.id;
    return () => {
      const stillOpen = useWorkspacesStore.getState().workspaces.some((w) => w.id === wsId);
      if (stillOpen) return;
      useMongoTabsStore.getState().prune(wsId);
      useMongoActiveDbStore.getState().prune(wsId);
      const sessions = usePanelStore.getState().byWorkspace[wsId]?.sessions ?? [];
      useMongoShellStore.getState().pruneSessions(sessions.map((s) => s.id));
    };
  }, [workspace.id]);

  const collNames = collections.map((c) => c.name);
  const descOf = (name?: string) => collections.find((c) => c.name === name);
  const activeTab = tabs.find((t) => t.id === activeId);

  const openColl = (name: string) => {
    const ex = tabs.find((t) => t.kind === "collection" && (t as MongoTab).coll === name);
    if (ex) {
      setActiveId(ex.id);
      return;
    }
    const tab: MongoTab = {
      id: nextId(name),
      kind: "collection",
      coll: name,
      title: name,
      mode: "find",
      view: "tree",
    };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };
  const openSingleton = (kind: "dashboard" | "map", title: string) => {
    const ex = tabs.find((t) => t.kind === kind);
    if (ex) {
      setActiveId(ex.id);
      return ex.id;
    }
    const tab = { id: nextId(kind), kind, title } as Tab;
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
    return tab.id;
  };
  const openPipeline = () => {
    const cur = tabs.find((t) => t.id === activeId);
    const coll =
      cur && (cur.kind === "collection" || cur.kind === "pipeline")
        ? (cur as MongoTab | MongoPipelineTabState).coll
        : collNames[0];
    const tab: MongoPipelineTabState = {
      id: nextId("pipeline"),
      kind: "pipeline",
      title: "Aggregation" + (coll ? " · " + coll : ""),
      coll,
    };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };
  const openShell = () => openPanel(workspace.id, termLabel);
  const toggleShell = () => togglePanel(workspace.id, termLabel);
  const updateTab = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)));
  const closeTab = (id: string) =>
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      const fallback = next[Math.max(0, idx - 1)];
      if (id === activeId && fallback) setActiveId(fallback.id);
      return next;
    });

  const tabMenu = useTabMenu({
    ids: tabs.map((t) => t.id),
    close: (ids) => ids.forEach(closeTab),
    canClose: (id) => tabs.find((t) => t.id === id)?.kind !== "dashboard",
  });

  const switchDb = (d: string) => {
    setDb(d);
    setTabs([{ id: "mg-dash", kind: "dashboard", title: "Dashboard" }]);
    setActiveId("mg-dash");
    void loadCollections(d);
  };
  const refresh = () => {
    setVersion((v) => v + 1);
    void loadCollections(db);
  };

  // Settings-driven auto-refresh: reload only the sidebar collection list (not
  // the version bump — that would re-run the active query/grid). The returned
  // flag spins the sidebar's refresh icon once per tick.
  const refreshSpinning = useAutoRefresh(() => void loadCollections(db));

  // Ctrl/⌘+` toggles the docked mongosh panel (VS Code convention, like the
  // other engines' consoles).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        togglePanel(workspace.id, termLabel);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel, workspace.id, termLabel]);

  // Scroll the active tab into view when it changes (newly-opened tabs past the
  // scrolled edge stay hidden otherwise).
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  return (
    <div className="workspace" data-screen-label={"MongoDB workspace: " + workspace.name}>
      <MongoSidebar
        workspaceName={workspace.name}
        workspaceColor={workspace.color}
        env={env}
        detail={detail}
        db={db}
        dbNames={dbNames}
        collections={collections}
        loading={loading}
        activeColl={activeTab?.kind === "collection" ? (activeTab as MongoTab).coll : null}
        onDbChange={switchDb}
        onOpenColl={openColl}
        onOpenShell={openShell}
        onOpenDashboard={() => openSingleton("dashboard", "Dashboard")}
        onOpenMap={() => openSingleton("map", "Schema map")}
        onNewPipeline={openPipeline}
        onExportColl={(c) => setExportJob({ scope: "collection", coll: c })}
        onImportColl={(c) => setImportTarget({ coll: c })}
        onExportAll={() => setExportJob({ scope: "all" })}
        onRefresh={refresh}
        refreshing={refreshSpinning}
        onCloseWorkspace={() => closeWorkspace(workspace.id)}
      />
      <SidebarResizer />
      <div className="main-col">
        <div className="tabbar" data-screen-label="MongoDB tab bar">
          <div className="tabbar-tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                ref={t.id === activeId ? activeTabRef : undefined}
                className={"tab" + (t.id === activeId ? " active" : "")}
                onClick={() => setActiveId(t.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(t.id);
                  }
                }}
                onContextMenu={(e) => tabMenu.onContextMenu(e, t.id)}
                title={t.title}
              >
                <Icon
                  name={TAB_ICON[t.kind] ?? "circle"}
                  size={14}
                  style={{ color: t.id === activeId ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="tab-title">{t.title}</span>
                {t.kind !== "dashboard" ? (
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <button className="tab-new" onClick={openPipeline} title="New aggregation pipeline">
            <Icon name="add" size={16} />
          </button>
          <div className="tabbar-tools">
            <button className="tabbar-tool" onClick={toggleShell} title="mongosh (⌘` / Ctrl+`)">
              <Icon name="terminal" size={15} />
              <span>mongosh</span>
            </button>
          </div>
          {tabMenu.element}
        </div>

        <div className="tab-content">
          {tabs.map((t) => (
            <div key={t.id} style={{ display: t.id === activeId ? "contents" : "none" }}>
              {t.kind === "dashboard" ? (
                <MongoDashboard
                  db={db}
                  collections={collections}
                  serverVersion={serverVersion}
                  loading={loading}
                  error={error}
                />
              ) : t.kind === "map" ? (
                <MongoSchemaMap
                  handleId={handleId}
                  db={db}
                  collections={collections}
                  onOpenColl={openColl}
                />
              ) : t.kind === "pipeline" ? (
                <MongoPipelineTab
                  tab={t as MongoPipelineTabState}
                  db={db}
                  handleId={handleId}
                  collNames={collNames}
                  isProduction={isProduction}
                  onUpdateTab={(p) => updateTab(t.id, p as Partial<Tab>)}
                />
              ) : (
                <MongoCollectionTab
                  tab={t as MongoTab}
                  db={db}
                  handleId={handleId}
                  descriptor={descOf((t as MongoTab).coll)}
                  isProduction={isProduction}
                  version={version}
                  onUpdateTab={(p) => updateTab(t.id, p as Partial<Tab>)}
                  onExport={(c) => setExportJob({ scope: "collection", coll: c })}
                  onImport={(c) => setImportTarget({ coll: c })}
                  onDataChanged={() => void loadCollections(db)}
                />
              )}
            </div>
          ))}
        </div>
        {/* mongosh docks here (above the status bar), like the SQL/Redis/Dynamo
            consoles — only when open. */}
        <TerminalPanel workspace={workspace} />
      </div>

      <div className="statusbar" data-screen-label="MongoDB status bar">
        <span className="ws-chip" style={{ background: workspace.color }} />
        <span className="status-strong">{workspace.name}</span>
        <span
          className="env-tag"
          style={{ color: envColor, borderColor: envColor + "66", background: envColor + "14" }}
        >
          {env}
        </span>
        <span className="status-dim">{serverVersion}</span>
        <span className="status-dim">
          <Icon name="database" size={11} /> {db}
        </span>
        <div style={{ flex: 1 }} />
        {activeTab?.kind === "collection" && descOf((activeTab as MongoTab).coll) ? (
          <span className="status-dim">
            {descOf((activeTab as MongoTab).coll)?.count.toLocaleString()} docs
          </span>
        ) : null}
      </div>

      {exportJob ? (
        <MongoExportModal
          scope={exportJob.scope}
          db={db}
          coll={exportJob.coll}
          handleId={handleId}
          collections={collections}
          onClose={() => setExportJob(null)}
        />
      ) : null}
      {importTarget ? (
        <MongoImportModal
          db={db}
          coll={importTarget.coll}
          handleId={handleId}
          collNames={collNames}
          onClose={() => setImportTarget(null)}
          onDone={() => {
            setImportTarget(null);
            void loadCollections(db);
          }}
        />
      ) : null}
    </div>
  );
}
