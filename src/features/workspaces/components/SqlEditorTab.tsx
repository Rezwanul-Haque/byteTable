// SQL editor tab (M6, spec §3.7) — ported from the prototype's editor.jsx
// SqlEditorTab: a toolbar (Run + ⌘↩ hint + snippet chips + save/bookmarks/
// history popovers), a syntax-highlighted editor (CodeMirror 6, see
// SqlCodeEditor), and a results area (status row + virtualized grid, the §5
// error card, and the empty state).
//
// STATE: the editor buffer, last result, last error, and per-tab history live
// on the tab object in the workspace's `ui` (store actions setSqlText /
// setSqlResult / setSqlError / pushSqlHistory) so they survive workspace
// switches per the WorkspaceUiState rule. `running` is transient local state
// (an in-flight query cannot outlive a switch — the tab unmounts). Editor text
// is committed to the store on every change; that is low-frequency enough at
// editor scale and is the simplest way to guarantee text survives a switch.
//
// SAVED QUERIES are a GLOBAL store (features/saved_queries): save in workspace
// A, load from workspace B. The save popover offers an attachment toggle — when
// checked the query is scoped to THIS workspace's saved connection
// (connectionId = workspace.saved.id); unchecked it is global. The list popover
// shows global + this-workspace-attached entries (selectQueriesForConnection)
// with a per-row indicator.

import { useEffect, useState } from "react";

import { queryRun } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { selectQueriesForConnection, useSavedQueriesStore } from "../../saved_queries/state";
import { useWorkspacesStore } from "../state";
import type { Tab, Workspace } from "../types";
import { SqlCodeEditor } from "./SqlCodeEditor";
import { SqlResultGrid } from "./SqlResultGrid";
import "./SqlEditorTab.css";

type SqlTab = Extract<Tab, { kind: "sql" }>;

/** SQLite-appropriate starter snippets (prototype chips, adapted to SQLite). */
const SQL_SNIPPETS: { label: string; sql: string }[] = [
  {
    label: "list tables",
    sql: "SELECT name, type\nFROM sqlite_master\nWHERE type = 'table'\nORDER BY name;",
  },
  {
    label: "table columns",
    sql: "SELECT name, type, \"notnull\", dflt_value\nFROM pragma_table_info('table_name');",
  },
  { label: "row counts", sql: "SELECT COUNT(*) AS rows\nFROM table_name;" },
  { label: "recent rows", sql: "SELECT *\nFROM table_name\nORDER BY rowid DESC\nLIMIT 50;" },
];

type Popover = "save" | "saved" | "history" | null;

/** Collapse whitespace + truncate a SQL string for popover previews. */
function preview(sql: string, max: number): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, max);
}

export function SqlEditorTab({ workspace, tab }: { workspace: Workspace; tab: SqlTab }) {
  const toast = useToast();
  const setSqlText = useWorkspacesStore((s) => s.setSqlText);
  const setSqlResult = useWorkspacesStore((s) => s.setSqlResult);
  const setSqlError = useWorkspacesStore((s) => s.setSqlError);
  const pushSqlHistory = useWorkspacesStore((s) => s.pushSqlHistory);

  const savedQueries = useSavedQueriesStore((s) => s.savedQueries);
  const loadSaved = useSavedQueriesStore((s) => s.load);
  const saveQuery = useSavedQueriesStore((s) => s.save);
  const removeQuery = useSavedQueriesStore((s) => s.remove);

  const [running, setRunning] = useState(false);
  const [pop, setPop] = useState<Popover>(null);
  const [saveName, setSaveName] = useState("");
  const [attach, setAttach] = useState(false);

  // The active schema this tab runs against (sidebar switcher; falls back to
  // the connection's first schema — SQLite: "main").
  const schemaName =
    (workspace.ui.schemaName !== undefined &&
    workspace.schemas.some((s) => s.name === workspace.ui.schemaName)
      ? workspace.ui.schemaName
      : workspace.schemas[0]?.name) ?? "main";

  // Load the global saved-query store once on first mount (guarded inside the
  // store: a settled load short-circuits, and re-calling is cheap).
  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  // Outside-click / Esc closes the open popover (Rail/Sidebar pattern).
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest?.(".editor-pop, .editor-pop-anchor")) return;
      setPop(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPop(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pop]);

  const text = tab.text;

  // Run the current buffer. Latest `running` is read off state so double-fires
  // are ignored. Result/error/history all go to the store (survive switches).
  const run = () => {
    const sql = text.trim();
    if (running || sql === "") return;
    setRunning(true);
    setPop(null);
    queryRun(workspace.handleId, sql, { schema: schemaName })
      .then((result) => {
        setSqlResult(tab.id, result);
        pushSqlHistory(tab.id, {
          sql,
          ok: true,
          rowCount: result.rowCount,
          ranAt: Date.now(),
        });
      })
      .catch((err: unknown) => {
        const message = appErrorMessage(err, "Query failed.");
        setSqlError(tab.id, message);
        pushSqlHistory(tab.id, { sql, ok: false, error: message, ranAt: Date.now() });
      })
      .finally(() => setRunning(false));
  };

  const load = (sql: string) => {
    setSqlText(tab.id, sql);
    setPop(null);
  };

  const doSave = () => {
    const name = saveName.trim() || "Untitled query";
    const connectionId = attach ? workspace.saved.id : null;
    void saveQuery({ name, sql: text, connectionId })
      .then(() => {
        toast(
          attach
            ? `Saved “${name}” — attached to this workspace`
            : `Saved “${name}” — shared across all workspaces`,
          "ok",
        );
        setSaveName("");
        setAttach(false);
        setPop(null);
      })
      .catch((err: unknown) => {
        toast(appErrorMessage(err, "Could not save query."), "err");
      });
  };

  const visibleSaved = selectQueriesForConnection(savedQueries, workspace.saved.id);
  const { result, error, history } = tab;
  const runDisabled = running || text.trim() === "";

  return (
    <div className="sql-tab">
      <div className="sql-toolbar">
        <Btn icon="play_arrow" variant="filled" onClick={run} disabled={runDisabled} small>
          {running ? "Running…" : "Run"}
        </Btn>
        <span className="sql-hint">⌘↩ / Ctrl+Enter</span>
        <div className="sql-snippets">
          {SQL_SNIPPETS.map((s) => (
            <button
              key={s.label}
              type="button"
              className="snippet-chip"
              onClick={() => load(s.sql)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />

        {/* save-query popover */}
        <div className="editor-pop-anchor" style={{ position: "relative" }}>
          <IconBtn
            icon="bookmark_add"
            title="Save this query"
            active={pop === "save"}
            onClick={() => setPop(pop === "save" ? null : "save")}
          />
          {pop === "save" ? (
            <div className="editor-pop save-pop" role="dialog" aria-label="Save query">
              <div className="history-pop-title">Save query</div>
              <input
                className="save-pop-input"
                placeholder="Query name…"
                value={saveName}
                autoFocus
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") doSave();
                }}
                spellCheck={false}
              />
              <label className="save-pop-attach">
                <input
                  type="checkbox"
                  checked={attach}
                  onChange={(e) => setAttach(e.target.checked)}
                />
                <span>Attach to this workspace</span>
              </label>
              <div className="save-pop-note">
                {attach ? `Only visible in ${workspace.name}` : "Shared across all workspaces"}
              </div>
              <Btn variant="filled" small onClick={doSave} style={{ alignSelf: "flex-end" }}>
                Save
              </Btn>
            </div>
          ) : null}
        </div>

        {/* saved-queries list popover */}
        <div className="editor-pop-anchor" style={{ position: "relative" }}>
          <IconBtn
            icon="bookmarks"
            title="Saved queries"
            active={pop === "saved"}
            onClick={() => setPop(pop === "saved" ? null : "saved")}
          />
          {pop === "saved" ? (
            <div className="editor-pop history-pop" role="menu" aria-label="Saved queries">
              <div className="history-pop-title">Saved queries</div>
              {visibleSaved.length === 0 ? (
                <div className="history-empty">
                  Nothing saved yet — write a query and hit <Icon name="bookmark_add" size={12} />
                </div>
              ) : (
                visibleSaved.map((q) => {
                  const scoped = q.connectionId != null;
                  return (
                    <div
                      key={q.id}
                      className="history-item"
                      role="menuitem"
                      tabIndex={0}
                      onClick={() => load(q.sql)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") load(q.sql);
                      }}
                    >
                      <Icon name="bookmark" size={13} style={{ color: "var(--accent)" }} />
                      <span className="saved-name">{q.name}</span>
                      <span className="history-sql">{preview(q.sql, 30)}</span>
                      <span className="saved-scope" title={scoped ? "This workspace" : "Global"}>
                        {scoped ? "this workspace" : "global"}
                      </span>
                      <button
                        type="button"
                        className="saved-del"
                        title="Delete"
                        aria-label={"Delete " + q.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeQuery(q.id).catch((err: unknown) =>
                            toast(appErrorMessage(err, "Could not delete query."), "err"),
                          );
                        }}
                      >
                        <Icon name="delete" size={13} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
        </div>

        {/* this-tab history popover */}
        <div className="editor-pop-anchor" style={{ position: "relative" }}>
          <IconBtn
            icon="history"
            title="Query history"
            active={pop === "history"}
            onClick={() => setPop(pop === "history" ? null : "history")}
          />
          {pop === "history" ? (
            <div className="editor-pop history-pop" role="menu" aria-label="Query history">
              <div className="history-pop-title">Recent queries · this tab</div>
              {history.length === 0 ? (
                <div className="history-empty">Nothing yet — run a query</div>
              ) : (
                history.map((h, i) => (
                  <div
                    key={i}
                    className="history-item"
                    role="menuitem"
                    tabIndex={0}
                    onClick={() => load(h.sql)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") load(h.sql);
                    }}
                  >
                    <Icon
                      name={h.ok ? "check" : "close"}
                      size={13}
                      style={{ color: h.ok ? "var(--accent)" : "#e06c75" }}
                    />
                    <span className="history-sql">{preview(h.sql, 64)}</span>
                    {h.ok && h.rowCount !== undefined ? (
                      <span className="history-meta">{h.rowCount} rows</span>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="sql-editor-wrap">
        <SqlCodeEditor value={text} onChange={(v) => setSqlText(tab.id, v)} onRun={run} />
      </div>

      <div className="sql-results">
        {error ? (
          <div className="sql-error" role="alert">
            <Icon name="error" size={18} />
            <div>
              <div className="sql-error-title">Query failed</div>
              <div className="sql-error-msg">{error}</div>
            </div>
          </div>
        ) : result ? (
          <>
            <div className="sql-result-bar">
              {result.columns.length === 0 ? (
                <>
                  <Icon name="check_circle" size={14} style={{ color: "var(--accent)" }} />
                  <span>Query OK</span>
                  <span className="dim">·</span>
                  <span className="dim">{result.elapsedMs} ms</span>
                  <span className="dim">·</span>
                  <span className="dim">{schemaName}</span>
                </>
              ) : (
                <>
                  <Icon name="check_circle" size={14} style={{ color: "var(--accent)" }} />
                  <span>
                    {result.rowCount} row{result.rowCount === 1 ? "" : "s"}
                  </span>
                  {result.truncated ? <span className="dim">(truncated)</span> : null}
                  <span className="dim">·</span>
                  <span className="dim">{result.elapsedMs} ms</span>
                  <span className="dim">·</span>
                  <span className="dim">{schemaName}</span>
                </>
              )}
            </div>
            {result.columns.length === 0 ? null : result.rows.length === 0 ? (
              <div className="sql-placeholder">
                <Icon name="table_rows" size={28} style={{ color: "var(--text-faint)" }} />
                <span>Query returned no rows</span>
              </div>
            ) : (
              <SqlResultGrid result={result} />
            )}
          </>
        ) : (
          <div className="sql-placeholder">
            <Icon name="terminal" size={28} style={{ color: "var(--text-faint)" }} />
            <span>Run a query to see results — try a snippet above</span>
          </div>
        )}
      </div>
    </div>
  );
}
