// Redis status bar (REDIS_SPEC §9) — workspace color chip · name · env tag ·
// "Redis {version}" · tunnel lock (when tunneled) · "db{N} · {count} keys".
// The right side (active-key type · memory, RESP3) is enriched in Task 4 once
// the key tabs report their type/memory; for now it shows the protocol marker.

import { EnvTag } from "../../../shared/ui/EnvTag";
import { Icon } from "../../../shared/ui/Icon";
import type { Env } from "../../../shared/types";
import "./RedisStatusBar.css";

interface RedisStatusBarProps {
  workspaceColor: string;
  workspaceName: string;
  env: Env;
  serverVersion: string;
  respVersion: number;
  isTunneled: boolean;
  tunnelHint: string;
  dbIndex: number;
  keyCount: number;
}

export function RedisStatusBar(props: RedisStatusBarProps) {
  const {
    workspaceColor,
    workspaceName,
    env,
    serverVersion,
    respVersion,
    isTunneled,
    tunnelHint,
    dbIndex,
    keyCount,
  } = props;

  return (
    <div className="redis-statusbar" role="status">
      <span className="ws-chip" style={{ background: workspaceColor }} />
      <span className="status-strong">{workspaceName}</span>
      <EnvTag env={env} />
      <span className="status-dim">{serverVersion}</span>
      {isTunneled ? (
        <span className="status-dim status-tunnel" title={tunnelHint}>
          <Icon name="vpn_lock" size={13} style={{ color: "var(--accent)" }} />
        </span>
      ) : null}
      <span className="status-dim">
        db{dbIndex} · {keyCount} keys
      </span>
      <div style={{ flex: 1 }} />
      <span className="status-dim">RESP{respVersion}</span>
    </div>
  );
}
