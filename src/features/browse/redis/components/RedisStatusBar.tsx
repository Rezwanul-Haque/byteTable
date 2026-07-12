// Redis status bar (REDIS_SPEC §9) — workspace color chip · name · env tag ·
// "Redis {version}" · tunnel lock (when tunneled) · "db{N}" ·
// spacer · active-key `type · memory` (when a key tab is active — humanBytes) ·
// "RESP{N}". The active-key info is reported up by the active KeyTab and passed
// in here. (The prototype's "mock engine" tag is dropped in production.)

import { openUrl } from "@tauri-apps/plugin-opener";

import { EnvTag } from "../../../../shared/ui/EnvTag";
import { Icon } from "../../../../shared/ui/Icon";
import type { Env } from "../../../../shared/types";
import type { KeyType } from "../api";
import { humanBytes, REDIS_TYPES } from "../helpers";
import "./RedisStatusBar.css";

/** The project's source repository (opened from the "Built by" credit). */
const REPO_URL = "https://github.com/rezwanul-Haque/byteTable";

/** Open a URL in the OS default browser; falls back to window.open in plain
 *  browser dev (no Tauri IPC). Mirrors StatusBar/DonateModal. */
function openExternal(url: string): void {
  if ("__TAURI_INTERNALS__" in window) {
    void openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

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
        className="status-dim status-credit"
        title="View ByteTable source on GitHub"
        onClick={() => openExternal(REPO_URL)}
      >
        Built by <b>Rezwanul-Haque</b>
      </button>
      <span className="status-dim">RESP{respVersion}</span>
    </div>
  );
}
