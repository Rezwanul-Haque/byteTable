// Redis tab content router — renders the active Redis tab's body (REDIS_SPEC
// §5). The two kinds: the keyspace dashboard (default, non-closable) and the
// type-aware key viewers. The M13 cli tab is gone (M14: command work lives in
// the docked console panel, mounted by RedisWorkspace). The tab model +
// open/close/focus actions live in redis_browse/state.ts; this just switches
// on the active tab's kind and hands each its props.

import type { KvDbInfo, KvServerInfo } from "../../../connections/api";
import type { ClusterTopology, KeyType } from "../api";
import type { RedisTab } from "../state";
import { ClusterDashboard } from "./ClusterDashboard";
import { DashboardTab } from "./DashboardTab";
import { RedisClientsTab } from "./RedisClientsTab";
import { KeyTab } from "./KeyTab";
import "./RedisTabContent.css";

interface RedisTabContentProps {
  tab: RedisTab;
  /** The connection handle the active workspace's commands run against. */
  handleId: string;
  /** Server identity (dashboard header). */
  serverInfo: KvServerInfo | undefined;
  /**
   * The cluster topology when the connection is a cluster node, else null
   * (M36 §B3). The dashboard branches on it once, at the top — cluster mode
   * changes the shape of the whole view, not a few rows of the standalone one.
   */
  cluster: ClusterTopology | null;
  /** The workspace's selected db (dashboard sample). */
  dbIndex: number;
  /** Connection deployment env (drives the kill modal's production gate). */
  env: string;
  /** Per-db key counts (dashboard per-db panel). */
  databases: KvDbInfo[];
  /** Invalidation nonce — bumped after writes / manual refresh (REDIS_SPEC §7). */
  version: number;
  /** True when the connection's env is `production` (gate destructive ops). */
  isProduction: boolean;
  /** Report the active key tab's type + memory to the status bar (§9). */
  onKeyMeta: (tabId: string, meta: { keyType: KeyType; memory: number | null }) => void;
  /** Bump the workspace version after a write (sidebar + tabs re-fetch). */
  onMutated: () => void;
  /** Switch the workspace db (dashboard per-db cell). */
  onSelectDb: (db: number) => void;
  /** Close a tab by id (key tab DEL closes itself). */
  onCloseTab: (tabId: string) => void;
  /** Open (or focus) the connected-clients tab (M36 §A4 dashboard entry points). */
  onOpenClients: () => void;
}

export function RedisTabContent({
  tab,
  handleId,
  serverInfo,
  cluster,
  dbIndex,
  env,
  databases,
  version,
  isProduction,
  onKeyMeta,
  onMutated,
  onSelectDb,
  onCloseTab,
  onOpenClients,
}: RedisTabContentProps) {
  switch (tab.kind) {
    case "dashboard":
      // One branch at the top, not conditional rows sprinkled through the
      // standalone view: Redis Cluster reshapes the whole workspace.
      return cluster ? (
        <ClusterDashboard
          handleId={handleId}
          topology={cluster}
          serverVersion={serverInfo?.serverVersion ?? "cluster"}
          version={version}
          onOpenClients={onOpenClients}
        />
      ) : (
        <DashboardTab
          handleId={handleId}
          dbIndex={dbIndex}
          databases={databases}
          serverInfo={serverInfo}
          version={version}
          onSelectDb={onSelectDb}
          onOpenClients={onOpenClients}
        />
      );
    case "key":
      return (
        <KeyTab
          // Re-mount on key/db identity change so per-key local edit state
          // (string draft, inline-edit cell) never leaks across keys.
          key={tab.id}
          handleId={handleId}
          db={tab.db}
          keyName={tab.key}
          keyType={tab.keyType}
          version={version}
          isProduction={isProduction}
          onMutated={onMutated}
          onClose={() => onCloseTab(tab.id)}
          onMeta={(meta) => onKeyMeta(tab.id, meta)}
        />
      );
    case "processes":
      // M36: Redis gets its own `CLIENT LIST` tab — the generic ProcessesTab
      // flattened Redis's fields into a SQL-shaped session row and offered no
      // kill route beyond one id at a time.
      return <RedisClientsTab handleId={handleId} env={env} />;
  }
}
