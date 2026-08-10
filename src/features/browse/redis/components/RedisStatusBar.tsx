// Redis status bar (REDIS_SPEC §9) — workspace color chip · name · env tag ·
// "Redis {version}" · tunnel lock (when tunneled) · "db{N}" ·
// spacer · active-key `type · memory` (when a key tab is active — humanBytes) ·
// "RESP{N}". The active-key info is reported up by the active KeyTab and passed
// in here. (The prototype's "mock engine" tag is dropped in production.)

import { EnvTag } from "../../../../shared/ui/EnvTag";
import { BuiltByCredit } from "../../../../shared/ui/BuiltByCredit";
import { ResourceMeter } from "../../../app_metrics/ResourceMeter";
import { Icon } from "../../../../shared/ui/Icon";
import type { Env } from "../../../../shared/types";
import type { KeyType } from "../api";
import { humanBytes, REDIS_TYPES } from "../helpers";
import "../../../processes/ProcessList.css";
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
  /** The active key tab's type (null when no key tab is active). */
  activeKeyType: KeyType | null;
  /** The active key's `MEMORY USAGE` bytes (null when unknown / no key tab). */
  activeKeyMemory: number | null;
  /** Open (or focus) the connected-clients (processes) tab (M26). */
  onOpenProcesses: () => void;
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
    activeKeyType,
    activeKeyMemory,
    onOpenProcesses,
  } = props;

  const keyMeta = activeKeyType
    ? activeKeyType + (activeKeyMemory !== null ? " · " + humanBytes(activeKeyMemory) : "")
    : null;

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
      <span className="status-dim">db{dbIndex}</span>
      <div style={{ flex: 1 }} />
      {keyMeta ? (
        <span
          className="status-dim"
          style={{ color: activeKeyType ? REDIS_TYPES[activeKeyType].color : undefined }}
        >
          {keyMeta}
        </span>
      ) : null}
      <button
        type="button"
        className="status-btn"
        title="Connected clients"
        onClick={onOpenProcesses}
      >
        <Icon name="monitor_heart" size={13} /> clients
      </button>
      <ResourceMeter />
      <BuiltByCredit className="status-dim" />
      <span className="status-dim">RESP{respVersion}</span>
    </div>
  );
}
