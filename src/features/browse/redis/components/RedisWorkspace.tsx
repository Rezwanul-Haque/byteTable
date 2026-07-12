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
  tunnelTitle,
  type KvDbInfo,
} from "../../../connections/api";
import { TerminalPanel } from "../../../console/TerminalPanel";
import { shellLabel, usePanelStore } from "../../../console/state";
import { useWorkspacesStore } from "../../../workspaces/state";
import type { Workspace } from "../../../workspaces/types";
import { kvKeyspace, type KeyType } from "../api";
import { useRedisBrowseStore } from "../state";
import { ENV_COLOR } from "../../../../shared/ui/envColors";
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

  // Per-db key counts: seeded from the open-result overview, then kept live by
  // re-fetching on every `version` bump (manual refresh, a write, or the
  // auto-refresh timer below) so counts + the dashboard reflect expired keys.
  const [databases, setDatabases] = useState<KvDbInfo[]>(
    workspace.keyspace?.databases ?? NO_DATABASES,
  );
  const serverInfo = workspace.keyspace?.serverInfo;
  const handleId = workspace.handleId;

  // Initial db = the connection's configured dbIndex (params), else 0.
  const params = workspace.saved.params;
  const initialDb = params.engine === "redis" ? params.dbIndex : 0;

  // Redis per-workspace UI (tabs + selected db + version), keyed by ws id.
  const wsId = workspace.id;
  const ensure = useRedisBrowseStore((state) => state.ensure);
  const setDbIndex = useRedisBrowseStore((state) => state.setDbIndex);
  const bumpVersion = useRedisBrowseStore((state) => state.bumpVersion);
  const openKeyTab = useRedisBrowseStore((state) => state.openKeyTab);
  const openDashboardTab = useRedisBrowseStore((state) => state.openDashboardTab);
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

  const [paletteOpen, setPaletteOpen] = useState(false);

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
  }, [openPanel, togglePanel, wsId, termLabel, closeTab, initialDb]);

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

  // Stable callbacks for the tab content (so the CLI persist effect + dashboard
  // fetch effect don't see a fresh identity every render).
  const onMutated = useCallback(() => bumpVersion(wsId, initialDb), [bumpVersion, wsId, initialDb]);
  const onSelectDb = useCallback(
    (db: number) => setDbIndex(wsId, initialDb, db),
    [setDbIndex, wsId, initialDb],
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
        databases={databases}
        dbIndex={rs.dbIndex}
        activeKey={activeKey}
        version={rs.version}
        onDbChange={(db) => setDbIndex(wsId, initialDb, db)}
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
          activeTabId={rs.activeTabId}
          onSelect={(id) => setActiveTab(wsId, initialDb, id)}
          onClose={(id) => closeTab(wsId, initialDb, id)}
          consoleOpen={consoleOpen}
          onToggleConsole={() => togglePanel(wsId, termLabel)}
        />
        <div className="redis-tab-content">
          {activeTab ? (
            <RedisTabContent
              tab={activeTab}
              handleId={workspace.handleId}
              serverInfo={serverInfo}
              dbIndex={rs.dbIndex}
              databases={databases}
              version={rs.version}
              isProduction={env === "production"}
              onKeyMeta={onKeyMeta}
              onMutated={onMutated}
              onSelectDb={onSelectDb}
              onCloseTab={(id) => closeTab(wsId, initialDb, id)}
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
        activeKeyType={activeKeyMeta?.keyType ?? null}
        activeKeyMemory={activeKeyMeta?.memory ?? null}
      />
      {paletteOpen ? (
        <RedisCommandPalette
          workspaceId={wsId}
          workspaceName={workspace.name}
          initialDb={initialDb}
          dbIndex={rs.dbIndex}
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
