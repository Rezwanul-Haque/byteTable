// Redis tab content router — renders the active Redis tab's body. For M13
// Task 2 the three kinds are placeholders: the Dashboard (default), key
// viewers (Task 3), and the CLI console (Task 4) fill in later. The tab model
// + the open/close/focus actions (redis_browse/state.ts) are complete now, so
// Tasks 3–4 only swap these placeholder bodies for real content.

import { BTLogo } from "../../../shared/ui/BTLogo";
import { Icon } from "../../../shared/ui/Icon";
import type { RedisTab } from "../state";
import { RedisTypeBadge } from "./RedisTypeBadge";
import "./RedisTabContent.css";

interface RedisTabContentProps {
  tab: RedisTab;
}

export function RedisTabContent({ tab }: RedisTabContentProps) {
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
        <div className="redis-placeholder" data-screen-label={"Redis key: " + tab.key}>
          <RedisTypeBadge type={tab.keyType} size={26} />
          <p className="redis-placeholder-key">{tab.key}</p>
          <span>Key viewer arrives in M13 Task 3.</span>
        </div>
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
