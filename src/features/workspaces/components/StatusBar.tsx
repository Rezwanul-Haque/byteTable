// Status bar — ported from the prototype's workspace.jsx `StatusBar`
// (spec §3.10). 28px strip across the bottom of the workspace grid:
// workspace color chip · name · env tag · server version · tunnel lock (when
// tunneled) · "schema: x" · spacer · context info (active tab rows/timing) ·
// "UTF-8".
//
// The prototype's "mock engine" tag is intentionally dropped (README
// fidelity note / spec §3.10). Tunnel lock is omitted for SQLite (never
// tunneled) and until ConnectionParams carries tunnel fields (M12) — the
// same deferral the sidebar documents.
//
// Context info reads the active tab's result meta from the Task-3 seam
// (tabMeta store): the grid reports totalRows + elapsedMs per fetch; until
// then it shows "— rows".

import { connectionIsTunneled, tunnelTitle } from "../../connections/api";
import { EnvTag } from "../../../shared/ui/EnvTag";
import { Icon } from "../../../shared/ui/Icon";
import { rowCountLabel, useTabMetaStore } from "../tabMeta";
import type { Workspace } from "../types";
import "./StatusBar.css";

export function StatusBar({ workspace }: { workspace: Workspace }) {
  const tabs = workspace.ui.tabs ?? [];
  const activeTabId = workspace.ui.activeTabId ?? null;
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // Narrow selector: only the active tab's meta.
  const activeMeta = useTabMetaStore((state) =>
    activeTabId ? state.meta[activeTabId] : undefined,
  );

  const schemaName =
    activeTab?.kind === "table" || activeTab?.kind === "map"
      ? activeTab.schema
      : (workspace.ui.schemaName ?? workspace.schemas[0]?.name ?? "main");

  // Context info: a table tab shows "N rows" (+ timing once the grid
  // reports it). Other tab kinds (sql/map placeholders this milestone) show
  // nothing.
  let context: string | null = null;
  if (activeTab?.kind === "table") {
    context = rowCountLabel(activeMeta);
    if (activeMeta?.elapsedMs !== undefined) {
      context += " · " + activeMeta.elapsedMs + " ms";
    }
  }

  return (
    <div className="statusbar" role="status">
      <span className="ws-chip" style={{ background: workspace.color }} />
      <span className="status-strong">{workspace.name}</span>
      <EnvTag env={workspace.saved.env} />
      <span className="status-dim">{workspace.info.serverVersion}</span>
      {/* Tunnel lock (M12 Task 3): shown when the connection routes through an
          SSH bastion. SQLite never tunnels. */}
      {connectionIsTunneled(workspace.saved.params) ? (
        <span className="status-dim status-tunnel" title={tunnelTitle(workspace.saved.params)}>
          <Icon name="vpn_lock" size={13} style={{ color: "var(--accent)" }} />
        </span>
      ) : null}
      <span className="status-dim">schema: {schemaName}</span>
      <div style={{ flex: 1 }} />
      {context ? <span className="status-dim">{context}</span> : null}
      <span className="status-dim">UTF-8</span>
    </div>
  );
}
