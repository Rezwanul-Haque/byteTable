// Redis workspace shell (REDIS_SPEC §3) — the sibling of the relational
// WorkspaceShell the App routes to when a connection's kind is "kv". Same
// frame (sidebar 248px | tab bar + content | 28px status bar) and shared
// chrome (rail, palette, toasts, tokens), but every inner piece is keyspace-
// shaped. Owns ⌘K (palette) / ⌘T (new CLI). All per-workspace Redis UI lives
// in the redis_browse store (keyed by workspace id, survives switches); the
// shared workspaces store carries no Redis state.

import { useCallback, useEffect, useState } from "react";

import {
  connectionDetail,
  connectionIsTunneled,
  connectionOpen,
  tunnelTitle,
  type KvDbInfo,
} from "../../../connections/api";
import { TerminalPanel } from "../../../console/TerminalPanel";
import { shellLabel, usePanelStore } from "../../../console/state";
import { useWorkspacesStore } from "../../../workspaces/state";
import { useScopeWorkspaces } from "../../../workspaces/scopes";
import type { Workspace } from "../../../workspaces/types";
import {
  dbScopeIndex,
  kvClusterTopology,
  kvCommand,
  kvKeyspace,
  type ClusterNode,
  type ClusterTopology,
  type KeyType,
} from "../api";
import { useRedisBrowseStore } from "../state";
import { appErrorMessage } from "../../../../shared/api/error";
import { ENV_COLOR } from "../../../../shared/ui/envColors";
import { useToast } from "../../../../shared/ui/toastContext";
import { useBtCmd } from "../../../../shared/ui/btCmd";
import { RedisCommandPalette } from "./RedisCommandPalette";
import { RedisSidebar } from "./RedisSidebar";
import { SidebarResizer } from "../../../../shared/ui/SidebarResizer";
import { useAutoRefresh } from "../../../settings/useAutoRefresh";
import { RedisStatusBar } from "./RedisStatusBar";
import { RedisTabBar } from "./RedisTabBar";
import { RedisTabContent } from "./RedisTabContent";
import "./RedisTabContent.css";

/** Empty per-db overview when a workspace somehow opened without a keyspace. */
const NO_DATABASES: KvDbInfo[] = [];

export function RedisWorkspace({ workspace }: { workspace: Workspace }) {
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);
  const toast = useToast();

  // Per-db key counts: seeded from the open-result overview, then kept live by
  // re-fetching on every `version` bump (manual refresh, a write, or the
  // auto-refresh timer below) so counts + the dashboard reflect expired keys.
  const [databases, setDatabases] = useState<KvDbInfo[]>(
    workspace.keyspace?.databases ?? NO_DATABASES,
  );
  const serverInfo = workspace.keyspace?.serverInfo;
  const handleId = workspace.handleId;

  // M36 §B3: the CONNECTION decides whether this is a cluster workspace, never
  // a UI toggle — `kvClusterTopology` returns null unless the server itself
  // reports `redis_mode:cluster`. Everything cluster-shaped (the dashboard, the
  // node picker replacing the db switcher, the status-bar segment) hangs off
  // this one value, so a standalone connection is untouched. Re-read whenever
  // the handle changes, which is also how a node switch refreshes `myself`.
  const [cluster, setCluster] = useState<ClusterTopology | null>(null);
  useEffect(() => {
    let alive = true;
    void kvClusterTopology(handleId).then(
      (topology) => {
        if (alive) setCluster(topology);
      },
      () => {
        // A server that refuses CLUSTER commands is a standalone server.
        if (alive) setCluster(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [handleId]);

  // Initial db = the connection's configured dbIndex (params), else 0.
  // M33: a db sub-workspace overrides both and opens ON its own db. Only the
  // INITIAL placement — the db switcher stays enabled inside a sub-workspace
  // and `ensure` keeps whatever the user switches to afterwards, matching
  // `homeSchema` for SQL.
  const params = workspace.saved.params;
  const ownDb = dbScopeIndex(workspace.schema);
  const initialDb = ownDb ?? (params.engine === "redis" ? params.dbIndex : 0);

  // Redis per-workspace UI (tabs + selected db + version), keyed by ws id.
  const wsId = workspace.id;
  const ensure = useRedisBrowseStore((state) => state.ensure);
  const setDbIndex = useRedisBrowseStore((state) => state.setDbIndex);
  const bumpVersion = useRedisBrowseStore((state) => state.bumpVersion);
  const openKeyTab = useRedisBrowseStore((state) => state.openKeyTab);
  const openDashboardTab = useRedisBrowseStore((state) => state.openDashboardTab);
  const openProcessesTab = useRedisBrowseStore((state) => state.openProcessesTab);
  const setActiveTab = useRedisBrowseStore((state) => state.setActiveTab);
  const closeTab = useRedisBrowseStore((state) => state.closeTab);
  // M14: the docked console panel REPLACES the M13 cli tab. ⌘T / the tab-bar +
  // / the sidebar "New CLI console" / the palette entry all open it now.
  const togglePanel = usePanelStore((state) => state.togglePanel);
  const openPanel = usePanelStore((state) => state.openPanel);
  const consoleOpen = usePanelStore((state) => state.byWorkspace[wsId]?.open ?? false);
  const termLabel = shellLabel(workspace.saved.engine);
  // Subscribe to this workspace's slice so tab/db/version changes re-render.
  const slice = useRedisBrowseStore((state) => state.byWorkspace[wsId]);
  const rs = slice ?? ensure(wsId, initialDb);

  // M33: db sub-workspaces, the Redis counterpart of the SQL schema split.
  const { openedScopes, openScope } = useScopeWorkspaces(workspace);

  const [paletteOpen, setPaletteOpen] = useState(false);

  // Title-bar View menu → "Running Processes" opens the Clients tab (M26).
  useBtCmd("processes", () => openProcessesTab(wsId, initialDb));

  // ⌘K palette toggle; ⌘T opens the console panel (M14: was "new CLI tab", now
  // the docked panel); ⌃` (Ctrl+backtick, the VS Code convention) toggles it —
  // mirrors WorkspaceShell.
  // ⌘W on macOS: close the active tab; if no tabs, let the OS handle it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌃` (and ⌘` on macOS) toggles the console — handle it first.
      if ((event.ctrlKey || event.metaKey) && event.key === "`") {
        event.preventDefault();
        togglePanel(wsId, termLabel);
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      // ⌃⇧P (⌘⇧P on macOS) opens the Clients tab, matching the tab-bar tool
      // and the other engines' Processes shortcut.
      if (event.shiftKey && key === "p") {
        event.preventDefault();
        openProcessesTab(wsId, initialDb);
        return;
      }
      if (key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === "t") {
        event.preventDefault();
        openPanel(wsId, termLabel);
      } else if (key === "w") {
        const st = useRedisBrowseStore.getState().byWorkspace[wsId];
        if (st?.tabs.length && st.activeTabId) {
          event.preventDefault();
          closeTab(wsId, initialDb, st.activeTabId);
        }
        // No tabs → let the OS handle it (hide app on macOS).
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPanel, togglePanel, wsId, termLabel, closeTab, openProcessesTab, initialDb]);

  const activeTab = rs.tabs.find((t) => t.id === rs.activeTabId) ?? rs.tabs[0];
  const activeKey = activeTab?.kind === "key" && activeTab.db === rs.dbIndex ? activeTab.key : null;

  // Active-key meta for the status bar's right side (§9: `type · memory`). The
  // active KeyTab reports its loaded type + memory here; cleared when no key
  // tab is active. Keyed by tab id so a stale report from a just-closed tab is
  // ignored on the next render.
  const [keyMeta, setKeyMeta] = useState<{
    tabId: string;
    keyType: KeyType;
    memory: number | null;
  } | null>(null);
  const activeKeyMeta =
    activeTab?.kind === "key" && keyMeta?.tabId === activeTab.id ? keyMeta : null;

  // Keep the per-db counts live: re-fetch the keyspace overview whenever the
  // version nonce bumps (manual refresh / a write / the auto-refresh timer).
  useEffect(() => {
    let alive = true;
    void kvKeyspace(handleId).then(
      (dbs) => {
        if (alive) setDatabases(dbs);
      },
      () => {
        /* transient scan/INFO error — keep the last good counts */
      },
    );
    return () => {
      alive = false;
    };
  }, [handleId, rs.version]);

  // Settings-driven auto-refresh of the keyspace (TTL-expired keys leave the
  // tree; counts + dashboard update) — controlled by the shared toggle/interval.
  useAutoRefresh(() => bumpVersion(wsId, initialDb));

  // -- cluster node switching ------------------------------------------------
  //
  // Attaching to a different node means a different SERVER: `SCAN`,
  // `INFO keyspace` and `CLIENT LIST` all answer per node, and a master only
  // holds the slots it owns. So this opens a real connection to the chosen
  // endpoint and repoints the workspace at it, rather than adding a "node"
  // argument to twenty commands.
  //
  // Credentials come from the saved entry (`connectionOpen({ params, id })`),
  // so the keychain secret never has to reach the renderer — a cluster peer is
  // the same configured server at another endpoint.
  const [nodeSwitching, setNodeSwitching] = useState(false);
  const setWorkspaceHandle = useWorkspacesStore((state) => state.setWorkspaceHandle);
  const dropKeyTabs = useRedisBrowseStore((state) => state.dropKeyTabs);

  const onPickNode = useCallback(
    (node: ClusterNode) => {
      if (params.engine !== "redis" || nodeSwitching) return;
      setNodeSwitching(true);
      void (async () => {
        try {
          const opened = await connectionOpen({
            params: { ...params, host: node.host, port: node.port },
            id: workspace.saved.id,
          });
          // A replica answers `MOVED` for a keyed read until the connection
          // opts into replica reads — verified against the rig: `GET` on a
          // replica is `MOVED 697 …` cold and serves the value after
          // `READONLY`. Without this the key list would load and every key in
          // it would fail to open.
          //
          // `READONLY` is connection state, and the adapter reuses one
          // multiplexed connection per db, so it holds for every later read.
          // A transparent driver reconnect would drop it; the symptom is a
          // `MOVED` on a key that worked a moment ago, and re-picking the node
          // restores it. (Keys on OTHER shards are `MOVED` regardless — they
          // are not on this node at all, which is what the picker is for.)
          if (node.role === "replica") {
            await kvCommand(opened.handleId, 0, ["READONLY"]).catch(() => {
              /* older server without READONLY — reads will redirect, and the
                 picker already says a replica behaves differently */
            });
          }
          // Key tabs are bound to keys this node may not serve; drop them
          // (this also bumps the version, so everything else re-reads).
          dropKeyTabs(wsId, initialDb);
          // The topology effect re-runs on the new handle and brings back a
          // fresh `myself`. Deliberately NOT cleared first: a null cluster
          // would flash the standalone chrome (db switcher, "Dashboard" tab)
          // for one frame.
          setWorkspaceHandle(wsId, opened.handleId, opened.engineInfo);
          toast("Browsing " + node.host + ":" + node.port, "ok");
        } catch (err) {
          toast(appErrorMessage(err, "Could not connect to that node."), "err");
        } finally {
          setNodeSwitching(false);
        }
      })();
    },
    [
      params,
      nodeSwitching,
      workspace.saved.id,
      dropKeyTabs,
      setWorkspaceHandle,
      wsId,
      initialDb,
      toast,
    ],
  );

  // Stable callbacks for the tab content (so the CLI persist effect + dashboard
  // fetch effect don't see a fresh identity every render).
  const onMutated = useCallback(() => bumpVersion(wsId, initialDb), [bumpVersion, wsId, initialDb]);
  const onSelectDb = useCallback(
    (db: number) => setDbIndex(wsId, initialDb, db),
    [setDbIndex, wsId, initialDb],
  );
  // The one Clients tab every entry point opens (dashboard stat, dashboard
  // panel button, palette, status bar, View menu) — `openProcessesTab` focuses
  // the existing tab rather than opening a second copy.
  const onOpenClients = useCallback(
    () => openProcessesTab(wsId, initialDb),
    [openProcessesTab, wsId, initialDb],
  );
  const onKeyMeta = useCallback(
    (tabId: string, meta: { keyType: KeyType; memory: number | null }) =>
      setKeyMeta({ tabId, ...meta }),
    [],
  );

  const env = workspace.saved.env;
  const envColor = ENV_COLOR[env];
  const isTunneled = connectionIsTunneled(params);
  const tunnelHint = tunnelTitle(params);
  const detail = connectionDetail(params);

  return (
    <div className="workspace" data-screen-label={"Redis workspace: " + workspace.name}>
      <RedisSidebar
        workspaceColor={workspace.color}
        workspaceName={workspace.name}
        envColor={envColor}
        envLabel={env}
        detail={detail}
        isTunneled={isTunneled}
        tunnelHint={tunnelHint}
        handleId={workspace.handleId}
        cluster={cluster}
        onPickNode={cluster ? onPickNode : undefined}
        nodeSwitching={nodeSwitching}
        databases={databases}
        dbIndex={rs.dbIndex}
        activeKey={activeKey}
        version={rs.version}
        onDbChange={(db) => setDbIndex(wsId, initialDb, db)}
        openedScopes={openedScopes}
        onOpenScopeWorkspace={openScope}
        onRefresh={() => bumpVersion(wsId, initialDb)}
        onOpenKey={(db, key, keyType) => openKeyTab(wsId, initialDb, db, key, keyType)}
        onOpenCli={() => openPanel(wsId, termLabel)}
        onOpenDashboard={() => openDashboardTab(wsId, initialDb)}
        onCloseWorkspace={() => closeWorkspace(wsId)}
      />
      <SidebarResizer />
      <main className="main-col redis-main">
        <RedisTabBar
          tabs={rs.tabs}
          cluster={cluster !== null}
          activeTabId={rs.activeTabId}
          onSelect={(id) => setActiveTab(wsId, initialDb, id)}
          onClose={(id) => closeTab(wsId, initialDb, id)}
          consoleOpen={consoleOpen}
          onToggleConsole={() => togglePanel(wsId, termLabel)}
          onOpenClients={onOpenClients}
        />
        <div className="redis-tab-content">
          {activeTab ? (
            <RedisTabContent
              tab={activeTab}
              handleId={workspace.handleId}
              serverInfo={serverInfo}
              cluster={cluster}
              dbIndex={rs.dbIndex}
              env={env}
              databases={databases}
              version={rs.version}
              isProduction={env === "production"}
              onKeyMeta={onKeyMeta}
              onMutated={onMutated}
              onSelectDb={onSelectDb}
              onCloseTab={(id) => closeTab(wsId, initialDb, id)}
              onOpenClients={onOpenClients}
            />
          ) : null}
        </div>
        {/* Docks at the bottom of the content column, above the status bar
            (M14) — the Redis console; only renders when the panel is open. */}
        <TerminalPanel workspace={workspace} />
      </main>
      <RedisStatusBar
        workspaceColor={workspace.color}
        workspaceName={workspace.name}
        env={env}
        serverVersion={
          serverInfo ? "Redis " + serverInfo.serverVersion : workspace.info.serverVersion
        }
        respVersion={serverInfo?.respVersion ?? 3}
        isTunneled={isTunneled}
        tunnelHint={tunnelHint}
        dbIndex={rs.dbIndex}
        cluster={cluster}
        activeKeyType={activeKeyMeta?.keyType ?? null}
        activeKeyMemory={activeKeyMeta?.memory ?? null}
        onOpenProcesses={() => openProcessesTab(wsId, initialDb)}
      />
      {paletteOpen ? (
        <RedisCommandPalette
          workspaceId={wsId}
          workspaceName={workspace.name}
          initialDb={initialDb}
          dbIndex={rs.dbIndex}
          cluster={cluster !== null}
          databases={databases}
          handleId={workspace.handleId}
          onOpenKey={(db, key, keyType) => openKeyTab(wsId, initialDb, db, key, keyType)}
          onCloseWorkspace={() => closeWorkspace(wsId)}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
    </div>
  );
}
