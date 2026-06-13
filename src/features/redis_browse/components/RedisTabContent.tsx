// Redis tab content router — renders the active Redis tab's body (REDIS_SPEC
// §5). The three kinds: the keyspace dashboard (default, non-closable — Task
// 4), the type-aware key viewers (Task 3), and the CLI console (Task 4). The
// tab model + open/close/focus actions live in redis_browse/state.ts; this just
// switches on the active tab's kind and hands each its props.

import type { KvDbInfo, KvServerInfo } from "../../connections/api";
import type { KeyType } from "../api";
import type { CliTabState, RedisTab } from "../state";
import { CliTab } from "./CliTab";
import { DashboardTab } from "./DashboardTab";
import { KeyTab } from "./KeyTab";
import "./RedisTabContent.css";

interface RedisTabContentProps {
  tab: RedisTab;
  /** The connection handle the active workspace's commands run against. */
  handleId: string;
  /** Conn name shown in the CLI prompt (`{conn}:db{N}>`). */
  connName: string;
  /** Server identity (dashboard header + CLI banner). */
  serverInfo: KvServerInfo | undefined;
  /** "Redis {version}" string for the CLI connected banner. */
  serverVersion: string;
  /** The workspace's selected db (dashboard sample + CLI run target). */
  dbIndex: number;
  /** Per-db key counts (dashboard per-db panel). */
  databases: KvDbInfo[];
  /** Invalidation nonce — bumped after writes / manual refresh (REDIS_SPEC §7). */
  version: number;
  /** True when the connection's env is `production` (gate destructive ops). */
  isProduction: boolean;
  /** Persisted CLI log + history per cli tab id. */
  cli: Record<string, CliTabState>;
  /** Persist a cli tab's log + history. */
  onPersistCli: (tabId: string, state: CliTabState) => void;
  /** Report the active key tab's type + memory to the status bar (§9). */
  onKeyMeta: (tabId: string, meta: { keyType: KeyType; memory: number | null }) => void;
  /** Bump the workspace version after a write (sidebar + tabs re-fetch). */
  onMutated: () => void;
  /** Switch the workspace db (CLI `SELECT n`, dashboard per-db cell). */
  onSelectDb: (db: number) => void;
  /** Close a tab by id (key tab DEL closes itself). */
  onCloseTab: (tabId: string) => void;
}

export function RedisTabContent({
  tab,
  handleId,
  connName,
  serverInfo,
  serverVersion,
  dbIndex,
  databases,
  version,
  isProduction,
  cli,
  onPersistCli,
  onKeyMeta,
  onMutated,
  onSelectDb,
  onCloseTab,
}: RedisTabContentProps) {
  switch (tab.kind) {
    case "dashboard":
      return (
        <DashboardTab
          handleId={handleId}
          dbIndex={dbIndex}
          databases={databases}
          serverInfo={serverInfo}
          version={version}
          onSelectDb={onSelectDb}
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
    case "cli":
      return (
        <CliTab
          // Re-mount per cli tab so each keeps its own input/history cursor.
          key={tab.id}
          handleId={handleId}
          connName={connName}
          serverVersion={serverVersion}
          dbIndex={dbIndex}
          isProduction={isProduction}
          state={cli[tab.id]}
          onPersist={(state) => onPersistCli(tab.id, state)}
          onMutated={onMutated}
          onSelectDb={onSelectDb}
        />
      );
  }
}
