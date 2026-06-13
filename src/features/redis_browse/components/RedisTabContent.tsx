// Redis tab content router — renders the active Redis tab's body. For M13
// Task 2 the three kinds are placeholders: the Dashboard (default), key
// viewers (Task 3), and the CLI console (Task 4) fill in later. The tab model
// + the open/close/focus actions (redis_browse/state.ts) are complete now, so
// Tasks 3–4 only swap these placeholder bodies for real content.

import { BTLogo } from "../../../shared/ui/BTLogo";
import { Icon } from "../../../shared/ui/Icon";
import type { RedisTab } from "../state";
import { KeyTab } from "./KeyTab";
import "./RedisTabContent.css";

interface RedisTabContentProps {
  tab: RedisTab;
  /** The connection handle the active workspace's commands run against. */
  handleId: string;
  /** Invalidation nonce — bumped after writes / manual refresh (REDIS_SPEC §7). */
  version: number;
  /** True when the connection's env is `production` (gate destructive ops). */
  isProduction: boolean;
  /** Bump the workspace version after a write (sidebar + tabs re-fetch). */
  onMutated: () => void;
  /** Close a tab by id (key tab DEL closes itself). */
  onCloseTab: (tabId: string) => void;
}

export function RedisTabContent({
  tab,
  handleId,
  version,
  isProduction,
  onMutated,
  onCloseTab,
}: RedisTabContentProps) {
  switch (tab.kind) {
    case "dashboard":
      return (
        <div className="redis-placeholder" data-screen-label="Redis dashboard">
          <BTLogo size={40} accent="var(--engine-redis, #e8533d)" fg="var(--text-faint)" />
          <p>Keyspace dashboard</p>
          <span>Dashboard arrives in M13 Task 4.</span>
        </div>
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
        />
      );
    case "cli":
      return (
        <div className="redis-placeholder" data-screen-label={"Redis CLI: " + tab.title}>
          <Icon name="terminal" size={36} style={{ color: "var(--text-faint)" }} />
          <p>{tab.title}</p>
          <span>CLI console arrives in M13 Task 4.</span>
        </div>
      );
  }
}
