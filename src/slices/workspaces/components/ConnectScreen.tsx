// Connect screen — ported from the prototype's connect.jsx ConnectScreen
// (spec §3.2). The NewConnectionModal is intentionally NOT ported here: the
// connection manager is M2, so both actions render disabled with a
// "Coming in M2" title.

import { useEffect, useRef, useState } from "react";

import { BTLogo } from "../../../shared/ui/BTLogo";
import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { EnvTag } from "../../../shared/ui/EnvTag";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { MOCK_CONNECTIONS } from "../mockConnections";
import { useWorkspacesStore } from "../state";
import type { Connection } from "../types";
import "./ConnectScreen.css";

export function ConnectScreen() {
  const [connecting, setConnecting] = useState<string | null>(null);
  const openWorkspace = useWorkspacesStore((state) => state.openWorkspace);
  const toast = useToast();
  const timerRef = useRef<number | undefined>(undefined);

  // Clear a pending fake-connect timer if the screen unmounts mid-spin.
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const connect = (conn: Connection) => {
    setConnecting(conn.id);
    // Simulated 650ms connect delay, ported from the prototype — replaced by
    // a real backend connect (Tauri command) in M2.
    timerRef.current = window.setTimeout(() => {
      setConnecting(null);
      openWorkspace(conn);
      toast(
        "Workspace “" + conn.name + "” opened — right-click its tile to rename or recolor",
        "ok",
      );
    }, 650);
  };

  return (
    // Frameless window: data-tauri-drag-region on the screen container makes
    // the empty chrome around the panel (including the top padding zone) a
    // window-drag area — Tauri only starts a drag when the mousedown target
    // itself carries the attribute, so the panel and its controls stay
    // interactive. Window controls (min/max/close buttons) are intentionally
    // NOT in the design; macOS keyboard close (⌘W / ⌘Q) works, and
    // cross-platform window controls are tracked for a later milestone.
    <div className="connect-screen" data-tauri-drag-region>
      <div className="connect-panel">
        <div className="connect-brand">
          <div className="brand-mark">
            <BTLogo size={28} accent="var(--accent)" fg="var(--text)" blink />
          </div>
          <div>
            <h1>ByteTable</h1>
            <p>Local-first database client · free forever</p>
          </div>
        </div>

        <div className="connect-list-label">Open a workspace</div>
        <div className="connect-list">
          {MOCK_CONNECTIONS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="connect-card"
              onClick={() => connect(c)}
              disabled={connecting !== null}
            >
              <EngineBadge engine={c.engine} size={34} />
              <div className="connect-card-info">
                <div className="connect-card-name">
                  {c.name}
                  <EnvTag env={c.env} />
                  {c.tunnel ? (
                    <span className="tunnel-tag" title={c.tunnel}>
                      <Icon name="vpn_lock" size={11} /> ssh
                    </span>
                  ) : null}
                </div>
                <div className="connect-card-detail">{c.detail}</div>
              </div>
              {connecting === c.id ? (
                <span className="spinner" />
              ) : (
                <Icon name="arrow_forward" size={18} className="connect-arrow" />
              )}
            </button>
          ))}
        </div>

        <div className="connect-actions">
          <Btn icon="add" variant="tonal" disabled title="Coming in M2">
            New connection
          </Btn>
          <Btn icon="folder_open" variant="text" disabled title="Coming in M2">
            Open SQLite file…
          </Btn>
        </div>
      </div>

      <div className="connect-footnote">
        SQLite · MySQL · PostgreSQL — more engines coming. Your credentials never leave this
        machine.
      </div>
    </div>
  );
}
