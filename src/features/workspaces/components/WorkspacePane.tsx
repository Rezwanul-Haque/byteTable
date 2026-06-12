// Minimal workspace pane (replaces M1's WorkspacePlaceholder): proves the
// real connection works by listing the default schema's tables straight from
// the backend. Deliberately NOT the M3 sidebar — a quiet centered column
// that M3 replaces wholesale.
//
// Per-workspace fetch policy: tables are refetched whenever the active
// workspace (handle) changes — no caching; the M3 sidebar owns caching.

import { useEffect, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { EnvTag } from "../../../shared/ui/EnvTag";
import { connectionDetail, connectionTables, type TableInfo } from "../../connections/api";
import type { Workspace } from "../types";
import "./WorkspacePane.css";

/** Right-aligned count cell: exact counts the backend chose not to compute
 *  (null) render as an em dash. */
function rowCountLabel(count: number | null): string {
  return count === null ? "—" : count.toLocaleString();
}

/** One fetch's outcome, tagged with the request (handle + schema) it answers. */
interface FetchState {
  key: string;
  /** null while loading or on error. */
  tables: TableInfo[] | null;
  error: string | null;
}

export function WorkspacePane({ workspace }: { workspace: Workspace }) {
  // Default schema = the first one the backend listed ("main" is always
  // first for SQLite; the literal fallback only covers an empty list).
  const defaultSchema =
    workspace.schemas[0]?.name ?? (workspace.saved.engine === "sqlite" ? "main" : "");

  // Fetch state, tagged with the request it belongs to. When the active
  // workspace (handle/schema) changes, the tag mismatches and state resets
  // to "loading" during render — the render-time state adjustment React
  // recommends over a setState-in-effect (same pattern as Rail.tsx).
  const fetchKey = workspace.handleId + "::" + defaultSchema;
  const initial: FetchState = { key: fetchKey, tables: null, error: null };
  const [fetched, setFetched] = useState<FetchState>(initial);
  if (fetched.key !== fetchKey) {
    setFetched(initial);
  }

  useEffect(() => {
    let cancelled = false;
    connectionTables(workspace.handleId, defaultSchema)
      .then((tables) => {
        if (!cancelled) setFetched({ key: fetchKey, tables, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setFetched({
            key: fetchKey,
            tables: null,
            error: appErrorMessage(err, "Could not load tables."),
          });
      });
    return () => {
      // A stale response for a switched-away workspace must not clobber the
      // current one's state.
      cancelled = true;
    };
  }, [fetchKey, workspace.handleId, defaultSchema]);

  const { tables, error } = fetched.key === fetchKey ? fetched : initial;

  return (
    <div className="ws-pane">
      <div className="ws-pane-inner">
        <header className="ws-pane-header">
          <EngineBadge engine={workspace.saved.engine} size={34} />
          <div className="ws-pane-titles">
            <div className="ws-pane-name">
              {workspace.name}
              <EnvTag env={workspace.saved.env} />
            </div>
            <div className="ws-pane-meta">
              {workspace.info.serverVersion} · {connectionDetail(workspace.saved.params)}
            </div>
          </div>
        </header>

        <div className="ws-pane-label">Tables · {defaultSchema}</div>

        {error !== null ? (
          // §5: errors are human sentences, shown where the action happened.
          <div className="ws-pane-error">{error}</div>
        ) : tables === null ? (
          <div className="ws-pane-loading">
            <span className="spinner" /> Loading tables…
          </div>
        ) : tables.length === 0 ? (
          <div className="ws-pane-empty">No tables in this schema yet.</div>
        ) : (
          <ul className="ws-pane-tables">
            {tables.map((table) => (
              <li key={table.name} className="ws-pane-table">
                <span className="ws-pane-table-name">{table.name}</span>
                <span className="ws-pane-table-count">{rowCountLabel(table.approxRowCount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
