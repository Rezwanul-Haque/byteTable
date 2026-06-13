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
} from "../../connections/api";
import { useWorkspacesStore } from "../../workspaces/state";
import type { Workspace } from "../../workspaces/types";
import type { KeyType } from "../api";
import { useRedisBrowseStore } from "../state";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { RedisCommandPalette } from "./RedisCommandPalette";
import { RedisSidebar } from "./RedisSidebar";
import { RedisStatusBar } from "./RedisStatusBar";
import { RedisTabBar } from "./RedisTabBar";
import { RedisTabContent } from "./RedisTabContent";
import "./RedisTabContent.css";

/** Empty per-db overview when a workspace somehow opened without a keyspace. */
const NO_DATABASES: KvDbInfo[] = [];

export function RedisWorkspace({ workspace }: { workspace: Workspace }) {
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);

  // Per-db key counts + server identity from the open-result overview.
  const databases = workspace.keyspace?.databases ?? NO_DATABASES;
  const serverInfo = workspace.keyspace?.serverInfo;

  // Initial db = the connection's configured dbIndex (params), else 0.
  const params = workspace.saved.params;
  const initialDb = params.engine === "redis" ? params.dbIndex : 0;

  // Redis per-workspace UI (tabs + selected db + version), keyed by ws id.
  const wsId = workspace.id;
  const ensure = useRedisBrowseStore((state) => state.ensure);
  const setDbIndex = useRedisBrowseStore((state) => state.setDbIndex);
  const bumpVersion = useRedisBrowseStore((state) => state.bumpVersion);
  const openKeyTab = useRedisBrowseStore((state) => state.openKeyTab);
  const openCliTab = useRedisBrowseStore((state) => state.openCliTab);
  const openDashboardTab = useRedisBrowseStore((state) => state.openDashboardTab);
  const setActiveTab = useRedisBrowseStore((state) => state.setActiveTab);
  const closeTab = useRedisBrowseStore((state) => state.closeTab);
  const setCliState = useRedisBrowseStore((state) => state.setCliState);
  // Subscribe to this workspace's slice so tab/db/version changes re-render.
  const slice = useRedisBrowseStore((state) => state.byWorkspace[wsId]);
  const rs = slice ?? ensure(wsId, initialDb);

  const [paletteOpen, setPaletteOpen] = useState(false);

  // ⌘K palette toggle, ⌘T new CLI (REDIS_SPEC §5: ⌘T opens a CLI).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === "t") {
        event.preventDefault();
        openCliTab(wsId, initialDb);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openCliTab, wsId, initialDb]);

  const activeTab = rs.tabs.find((t) => t.id === rs.activeTabId) ?? rs.tabs[0];
  const activeKey =
    activeTab?.kind === "key" && activeTab.db === rs.dbIndex ? activeTab.key : null;

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

  // Stable callbacks for the tab content (so the CLI persist effect + dashboard
  // fetch effect don't see a fresh identity every render).
  const onMutated = useCallback(() => bumpVersion(wsId, initialDb), [bumpVersion, wsId, initialDb]);
  const onSelectDb = useCallback(
    (db: number) => setDbIndex(wsId, initialDb, db),
    [setDbIndex, wsId, initialDb],
  );
  const onPersistCli = useCallback(
    (tabId: string, state: Parameters<typeof setCliState>[3]) =>
      setCliState(wsId, initialDb, tabId, state),
    [setCliState, wsId, initialDb],
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
  const keyCount = databases.find((d) => d.index === rs.dbIndex)?.keyCount ?? 0;

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
        onOpenCli={() => openCliTab(wsId, initialDb)}
        onOpenDashboard={() => openDashboardTab(wsId, initialDb)}
        onCloseWorkspace={() => closeWorkspace(wsId)}
      />
      <main className="main-col redis-main">
        <RedisTabBar
          tabs={rs.tabs}
          activeTabId={rs.activeTabId}
          onSelect={(id) => setActiveTab(wsId, initialDb, id)}
          onClose={(id) => closeTab(wsId, initialDb, id)}
          onNewCli={() => openCliTab(wsId, initialDb)}
        />
        <div className="redis-tab-content">
          {activeTab ? (
            <RedisTabContent
              tab={activeTab}
              handleId={workspace.handleId}
              connName={workspace.name}
              serverInfo={serverInfo}
              serverVersion={
                serverInfo ? "Redis " + serverInfo.serverVersion : workspace.info.serverVersion
              }
              dbIndex={rs.dbIndex}
              databases={databases}
              version={rs.version}
              isProduction={env === "production"}
              cli={rs.cli}
              onPersistCli={onPersistCli}
              onKeyMeta={onKeyMeta}
              onMutated={onMutated}
              onSelectDb={onSelectDb}
              onCloseTab={(id) => closeTab(wsId, initialDb, id)}
            />
          ) : null}
        </div>
      </main>
      <RedisStatusBar
        workspaceColor={workspace.color}
        workspaceName={workspace.name}
        env={env}
        serverVersion={serverInfo ? "Redis " + serverInfo.serverVersion : workspace.info.serverVersion}
        respVersion={serverInfo?.respVersion ?? 3}
        isTunneled={isTunneled}
        tunnelHint={tunnelHint}
        dbIndex={rs.dbIndex}
        keyCount={keyCount}
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
