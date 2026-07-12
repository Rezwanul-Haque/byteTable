// Cassandra workspace shell (M19) — the fifth sibling of WorkspaceShell /
// RedisWorkspace / DynamoWorkspace / MongoWorkspace the App routes to when a
// connection's kind is "cassandra". Same frame (sidebar | tab bar + content |
// status bar). Opens on the Dashboard tab (§19.1). Tab kinds: dashboard / table
// / cql / map; the cqlsh terminal docks as the shared bottom panel (§19.5).
//
// Schema (keyspaces, table descriptors) + cluster status are fetched from the
// backend on mount and on keyspace switch / refresh. No COUNT(*) is ever issued.

import { useCallback, useEffect, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { useTabMenu } from "../../../shared/ui/useTabMenu";
import { connectionDetail } from "../../connections/api";
import { TerminalPanel } from "../../console/TerminalPanel";
import { shellLabel, usePanelStore } from "../../console/state";
import { useWorkspacesStore } from "../../workspaces/state";
import type { Workspace } from "../../workspaces/types";
import {
  cassClusterStatus,
  cassListKeyspaces,
  cassListTables,
  type ClusterStatus,
  type KeyspaceInfo,
  type TableDescriptor,
} from "../api";
import {
  CassAddIndexModal,
  CassCreateKeyspaceModal,
  CassCreateTableModal,
} from "./CassCreateModals";
import { CassandraDashboard } from "./CassandraDashboard";
import { CassExportModal, CassImportModal } from "./CassIoModals";
import { CassandraQueryTab } from "./CassandraQueryTab";
import { CassandraSchemaMap } from "./CassandraSchemaMap";
import { CassandraSidebar } from "./CassandraSidebar";
import { SidebarResizer } from "../../../shared/ui/SidebarResizer";
import { useAutoRefresh } from "../../settings/useAutoRefresh";
import { CassandraTableTab } from "./CassandraTableTab";
import { useCassTabsStore } from "../workspaceTabs";
// Shared chrome the Cassandra slice REUSES (importing the owning components' CSS
// keeps the workspace self-contained in `vite dev` and prod alike).
import "../../workspaces/components/WorkspaceContent.css";
import "../../workspaces/components/Sidebar.css";
import "../../workspaces/components/TabBar.css";
import "../../workspaces/components/StatusBar.css";
import "../../workspaces/components/TableTab.css";
import "../../workspaces/components/SqlEditorTab.css";
import "../../browse/shared/DataGrid.css";
import "../../browse/shared/StructureView.css";
import "../../redis_browse/components/DashboardTab.css";
import "../../console/SqlTerminalTab.css"; // .rcli-* terminal chrome
import "../../console/TerminalPanel.css"; // docked terminal panel chrome
import "../../export/components/ExportProgressModal.css"; // .export-progress-modal
import "../../import/components/ImportModal.css"; // import modal chrome
import "../../dynamo_browse/components/Dynamo.css"; // export-*/import-*/ddb-io-* IO modal classes
import "../../mongo_browse/components/Mongo.css"; // mg-mono / mg-idx-line reuse
import "./Cassandra.css";

const TAB_ICON: Record<string, string> = {
  dashboard: "monitoring",
  table: "table_chart",
  cql: "code",
  map: "schema",
};

export interface CassTab {
  id: string;
  kind: "dashboard" | "table" | "cql" | "map";
  title: string;
  table?: string;
  mode?: "query" | "structure";
}

let seq = 0;
const nextId = (p: string) => "cs-" + p + "-" + ++seq;

export function CassandraWorkspace({ workspace }: { workspace: Workspace }) {
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);
  const toast = useToast();
  const openPanel = usePanelStore((s) => s.openPanel);
  const togglePanel = usePanelStore((s) => s.togglePanel);
  const termLabel = shellLabel("cassandra");
  const handleId = workspace.handleId;
  const env = workspace.saved.env;
  const envColor = ENV_COLOR[env];
  const detail = connectionDetail(workspace.saved.params);
  const serverVersion = workspace.info.serverVersion;

  // Tabs / active tab / selected keyspace persist per-workspace (survive
  // switching away and back); only dropped when the workspace is closed.
  // Keyspaces / tables / cluster are transient and refetched on mount.
  const ensureTabs = useCassTabsStore((s) => s.ensure);
  const patchTabs = useCassTabsStore((s) => s.patch);
  const tabState = useCassTabsStore((s) => s.byWorkspace[workspace.id]);
  const tabs: CassTab[] = tabState?.tabs ?? [
    { id: "cs-dash", kind: "dashboard", title: "Dashboard" },
  ];
  const activeId = tabState?.activeId ?? "cs-dash";
  const ks = tabState?.ks ?? "";

  const peekTabs = () => useCassTabsStore.getState().byWorkspace[workspace.id]?.tabs ?? tabs;
  const setTabs = (next: CassTab[] | ((ts: CassTab[]) => CassTab[])) =>
    patchTabs(workspace.id, { tabs: typeof next === "function" ? next(peekTabs()) : next });
  const setActiveId = (id: string) => patchTabs(workspace.id, { activeId: id });
  const setKs = (k: string) => patchTabs(workspace.id, { ks: k });

  const [keyspaces, setKeyspaces] = useState<KeyspaceInfo[]>([]);
  const [tables, setTables] = useState<TableDescriptor[]>([]);
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createKs, setCreateKs] = useState(false);
  const [createTbl, setCreateTbl] = useState(false);
  const [addIdxTable, setAddIdxTable] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<{ scope: "table" | "all"; table?: string } | null>(
    null,
  );
  const [importTarget, setImportTarget] = useState<{ table: string | null } | null>(null);

  const loadTables = useCallback(
    async (keyspace: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await cassListTables(handleId, keyspace);
        setTables(list);
      } catch (e) {
        setError(isAppErrorPayload(e) ? e.message : "Could not list tables (desktop app required)");
        setTables([]);
      } finally {
        setLoading(false);
      }
    },
    [handleId],
  );

  // Initial load: keyspaces → (persisted or default) keyspace → its tables +
  // cluster status. Reuses the persisted keyspace when returning to a workspace
  // so the selected keyspace + tabs are restored rather than reset.
  useEffect(() => {
    ensureTabs(workspace.id);
    let live = true;
    (async () => {
      try {
        const [kss, ring] = await Promise.all([
          cassListKeyspaces(handleId),
          cassClusterStatus(handleId).catch(() => null),
        ]);
        if (!live) return;
        setKeyspaces(kss);
        setCluster(ring);
        const stored = useCassTabsStore.getState().byWorkspace[workspace.id]?.ks ?? "";
        const fromConn =
          workspace.saved.params.engine === "cassandra"
            ? workspace.saved.params.keyspace
            : undefined;
        const target =
          stored ||
          (fromConn && kss.some((k) => k.name === fromConn) ? fromConn : kss[0]?.name) ||
          "";
        if (!stored && target) setKs(target);
        if (target) void loadTables(target);
        else setLoading(false);
      } catch (e) {
        if (!live) return;
        setError(
          isAppErrorPayload(e) ? e.message : "Could not list keyspaces (desktop app required)",
        );
        setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, loadTables, workspace.id]);

  // Drop this workspace's persisted tab state when it is CLOSED (not on a mere
  // switch): on unmount, prune only if the workspace is gone from the store.
  useEffect(() => {
    const wsId = workspace.id;
    return () => {
      const stillOpen = useWorkspacesStore.getState().workspaces.some((w) => w.id === wsId);
      if (!stillOpen) useCassTabsStore.getState().prune(wsId);
    };
  }, [workspace.id]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const keyspaceInfo = keyspaces.find((k) => k.name === ks) ?? null;

  const openTable = (name: string) => {
    const ex = tabs.find((t) => t.kind === "table" && t.table === name);
    if (ex) {
      setActiveId(ex.id);
      return;
    }
    const tab: CassTab = {
      id: nextId(name),
      kind: "table",
      table: name,
      title: name,
      mode: "query",
    };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };
  const openKind = (kind: "dashboard" | "map", title: string) => {
    const ex = tabs.find((t) => t.kind === kind);
    if (ex) {
      setActiveId(ex.id);
      return;
    }
    const tab: CassTab = { id: nextId(kind), kind, title };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };
  const openQuery = () => {
    const n = tabs.filter((t) => t.kind === "cql").length + 1;
    const tab: CassTab = { id: nextId("cql"), kind: "cql", title: "Query " + n };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };
  const updateTab = (id: string, patch: Partial<CassTab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const closeTab = (id: string) =>
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      const fallback = next[Math.max(0, idx - 1)];
      if (id === activeId && fallback) setActiveId(fallback.id);
      return next;
    });

  const switchKs = (d: string) => {
    setKs(d);
    setTabs([{ id: "cs-dash", kind: "dashboard", title: "Dashboard" }]);
    setActiveId("cs-dash");
    void loadTables(d);
  };
  const refresh = () => {
    void Promise.all([
      cassListKeyspaces(handleId)
        .then(setKeyspaces)
        .catch(() => {}),
      ks ? loadTables(ks) : Promise.resolve(),
    ]);
    toast("Schema refreshed", "ok");
  };

  // Settings-driven auto-refresh of the sidebar table list (silent — no toast).
  // The returned flag spins the sidebar's refresh icon once per tick.
  const refreshSpinning = useAutoRefresh(() => {
    if (ks) void loadTables(ks);
  });

  const openShell = () => openPanel(workspace.id, termLabel);
  const toggleShell = () => togglePanel(workspace.id, termLabel);

  const tabMenu = useTabMenu({
    ids: tabs.map((t) => t.id),
    close: (ids) => ids.forEach(closeTab),
    canClose: (id) => tabs.find((t) => t.id === id)?.kind !== "dashboard",
  });

  // ⌘T opens a new CQL query tab; Ctrl/⌘+` toggles the docked cqlsh terminal.
  // ⌘W on macOS: close the active tab; if no tabs, let the OS handle it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "t" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        openQuery();
      }
      if (e.key === "`" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleShell();
      }
      if (e.metaKey && e.key.toLowerCase() === "w") {
        const st = useCassTabsStore.getState().byWorkspace[workspace.id];
        if (st?.tabs.length && st.activeId) {
          e.preventDefault();
          const idx = st.tabs.findIndex((t) => t.id === st.activeId);
          const next = st.tabs.filter((t) => t.id !== st.activeId);
          const fallback = next[Math.max(0, idx - 1)];
          const activeId = fallback?.id ?? next[0]?.id ?? "";
          useCassTabsStore.getState().patch(workspace.id, { tabs: next, activeId });
        }
        // No tabs → let the OS handle it (hide app on macOS).
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  // Scroll the active tab into view when it changes so a newly-opened tab past
  // the scrolled edge isn't left hidden.
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  return (
    <div className="workspace" data-screen-label={"Cassandra workspace: " + workspace.name}>
      <CassandraSidebar
        workspaceName={workspace.name}
        workspaceColor={workspace.color}
        env={env}
        envColor={envColor}
        detail={detail}
        ks={ks}
        keyspaces={keyspaces.map((k) => k.name)}
        tables={tables}
        activeTable={activeTab?.kind === "table" ? (activeTab.table ?? null) : null}
        onKsChange={switchKs}
        onOpenTable={openTable}
        onOpenShell={openShell}
        onOpenDashboard={() => openKind("dashboard", "Dashboard")}
        onOpenMap={() => openKind("map", "Schema map")}
        onExportTable={(t) => setExportJob({ scope: "table", table: t })}
        onImportTable={(t) => setImportTarget({ table: t })}
        onExportAll={() => setExportJob({ scope: "all" })}
        onCreateKeyspace={() => setCreateKs(true)}
        onCreateTable={() => setCreateTbl(true)}
        onAddIndex={(table) => setAddIdxTable(table)}
        onRefresh={refresh}
        refreshing={refreshSpinning}
        onCloseWorkspace={() => closeWorkspace(workspace.id)}
      />
      <SidebarResizer />
      <div className="main-col">
        <div className="tabbar" data-screen-label="Cassandra tab bar">
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
          <button className="tab-new" onClick={openQuery} title="New CQL query (⌘T)">
            <Icon name="add" size={16} />
          </button>
          <div className="tabbar-tools">
            <button className="tabbar-tool" onClick={toggleShell} title="cqlsh (⌘` / Ctrl+`)">
              <Icon name="terminal" size={15} />
              <span>cqlsh</span>
            </button>
          </div>
          {tabMenu.element}
        </div>

        <div className="tab-content">
          {tabs.map((t) => (
            <div key={t.id} style={{ display: t.id === activeId ? "contents" : "none" }}>
              {t.kind === "dashboard" ? (
                <CassandraDashboard
                  ks={ks}
                  keyspace={keyspaceInfo}
                  tables={tables}
                  cluster={cluster}
                  loading={loading}
                  error={error}
                />
              ) : t.kind === "table" ? (
                (() => {
                  const descriptor = tables.find((d) => d.name === t.table);
                  return descriptor ? (
                    <CassandraTableTab
                      handleId={handleId}
                      ks={ks}
                      descriptor={descriptor}
                      mode={t.mode ?? "query"}
                      isProduction={env === "production"}
                      onModeChange={(m) => updateTab(t.id, { mode: m })}
                      onExport={(tb) => setExportJob({ scope: "table", table: tb })}
                      onImport={(tb) => setImportTarget({ table: tb })}
                      onSchemaChanged={() => ks && void loadTables(ks)}
                    />
                  ) : (
                    <div className="empty-state">
                      <Icon name="table_chart" size={28} />
                      <p>{t.title}</p>
                      <span>Loading table…</span>
                    </div>
                  );
                })()
              ) : t.kind === "cql" ? (
                <CassandraQueryTab handleId={handleId} ks={ks} tables={tables} />
              ) : (
                <CassandraSchemaMap ks={ks} tables={tables} onOpenTable={openTable} />
              )}
            </div>
          ))}
        </div>
        {/* cqlsh docks here (above the status bar), like the other engines. */}
        <TerminalPanel workspace={workspace} />
      </div>

      <div className="statusbar" data-screen-label="Cassandra status bar">
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
          <Icon name="hub" size={11} /> {ks}
        </span>
        <div style={{ flex: 1 }} />
        {activeTab?.kind === "table" ? <span className="status-dim">{activeTab.table}</span> : null}
      </div>

      {createKs ? (
        <CassCreateKeyspaceModal
          handleId={handleId}
          existing={keyspaces.map((k) => k.name)}
          onClose={() => setCreateKs(false)}
          onCreated={(nm) => {
            setCreateKs(false);
            void cassListKeyspaces(handleId)
              .then(setKeyspaces)
              .catch(() => {});
            switchKs(nm);
          }}
        />
      ) : null}
      {createTbl ? (
        <CassCreateTableModal
          handleId={handleId}
          ks={ks}
          existing={tables.map((d) => d.name)}
          onClose={() => setCreateTbl(false)}
          onCreated={(nm) => {
            setCreateTbl(false);
            if (ks) void loadTables(ks);
            openTable(nm);
          }}
        />
      ) : null}
      {addIdxTable
        ? (() => {
            const descriptor = tables.find((d) => d.name === addIdxTable);
            return descriptor ? (
              <CassAddIndexModal
                handleId={handleId}
                ks={ks}
                table={descriptor}
                onClose={() => setAddIdxTable(null)}
                onDone={() => {
                  setAddIdxTable(null);
                  if (ks) void loadTables(ks);
                }}
              />
            ) : null;
          })()
        : null}
      {exportJob ? (
        <CassExportModal
          scope={exportJob.scope}
          ks={ks}
          keyspaceInfo={keyspaceInfo}
          table={exportJob.table}
          tables={tables}
          handleId={handleId}
          onClose={() => setExportJob(null)}
        />
      ) : null}
      {importTarget ? (
        <CassImportModal
          ks={ks}
          table={importTarget.table}
          tables={tables}
          handleId={handleId}
          onClose={() => setImportTarget(null)}
          onDone={() => {
            setImportTarget(null);
            if (ks) void loadTables(ks);
          }}
        />
      ) : null}
    </div>
  );
}
