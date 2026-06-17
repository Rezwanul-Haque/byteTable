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

import { useEffect, useRef, useState } from "react";

import { highlightSql } from "../../browse/highlightSql";
import { queryRun } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import type { Engine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { columnsKey, useIntrospectionStore } from "../../introspection/state";
import { type SavedQuery } from "../../saved_queries/api";
import { selectQueriesForConnection, useSavedQueriesStore } from "../../saved_queries/state";
import { useWorkspacesStore } from "../state";
import type { SqlHistoryEntry, Tab, Workspace } from "../types";
import { ExecutionMinimap, ExplainPanel } from "./explain";
import { detectedTable } from "./explainClauses";
import { formatSql } from "./formatSql";
import { SqlCodeEditor, type SqlCodeEditorHandle } from "./SqlCodeEditor";
import { SqlResultGrid } from "./SqlResultGrid";
import "./SqlEditorTab.css";

type SqlTab = Extract<Tab, { kind: "sql" }>;

/** Cap on the SQL shown in a drawer preview (full multi-line, but bounded). */
const PREVIEW_MAX = 240;

/** Truncate (with ellipsis) then syntax-highlight SQL for a drawer preview. */
function previewHtml(sql: string): string {
  const clipped = sql.length > PREVIEW_MAX ? sql.slice(0, PREVIEW_MAX) + "…" : sql;
  return highlightSql(clipped);
}

/**
 * Starter snippet chips. These are REAL, runnable introspection queries — but
 * each engine speaks a different dialect, so the chips are engine-specific
 * (a SQLite `pragma_table_info(...)` is a syntax error on MySQL/Postgres, etc.).
 * The placeholder `table_name` is meant to be replaced with a real table.
 * `schema_name` resolves the introspection chips to the tab's active schema.
 */
type Snippet = { label: string; sql: string };

function snippetsFor(engine: Engine, schemaName: string): Snippet[] {
  switch (engine) {
    case "mysql":
      return [
        {
          label: "list tables",
          sql: `SELECT table_name, table_type\nFROM information_schema.tables\nWHERE table_schema = '${schemaName}'\nORDER BY table_name;`,
        },
        {
          label: "table columns",
          sql: `SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_schema = '${schemaName}' AND table_name = 'table_name'\nORDER BY ordinal_position;`,
        },
        { label: "row counts", sql: "SELECT COUNT(*) AS row_count\nFROM table_name;" },
        { label: "recent rows", sql: "SELECT *\nFROM table_name\nLIMIT 50;" },
      ];
    case "postgres":
      return [
        {
          label: "list tables",
          sql: `SELECT table_name, table_type\nFROM information_schema.tables\nWHERE table_schema = '${schemaName}'\nORDER BY table_name;`,
        },
        {
          label: "table columns",
          sql: `SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_schema = '${schemaName}' AND table_name = 'table_name'\nORDER BY ordinal_position;`,
        },
        { label: "row counts", sql: 'SELECT COUNT(*) AS row_count\nFROM table_name;' },
        { label: "recent rows", sql: "SELECT *\nFROM table_name\nLIMIT 50;" },
      ];
    case "sqlite":
    default:
      return [
        {
          label: "list tables",
          sql: "SELECT name, type\nFROM sqlite_master\nWHERE type = 'table'\nORDER BY name;",
        },
        {
          label: "table columns",
          sql: "SELECT name, type, \"notnull\", dflt_value\nFROM pragma_table_info('table_name');",
        },
        { label: "row counts", sql: "SELECT COUNT(*) AS row_count\nFROM table_name;" },
        { label: "recent rows", sql: "SELECT *\nFROM table_name\nORDER BY rowid DESC\nLIMIT 50;" },
      ];
  }
}

/** Only the save popover remains a popover; browse/manage moved to drawers. */
type Popover = "save" | null;

export function SqlEditorTab({ workspace, tab }: { workspace: Workspace; tab: SqlTab }) {
  const toast = useToast();
  const setSqlText = useWorkspacesStore((s) => s.setSqlText);
  const setSqlResult = useWorkspacesStore((s) => s.setSqlResult);
  const setSqlError = useWorkspacesStore((s) => s.setSqlError);
  const pushSqlHistory = useWorkspacesStore((s) => s.pushSqlHistory);

  const clearSqlResults = useWorkspacesStore((s) => s.clearSqlResults);

  const savedQueries = useSavedQueriesStore((s) => s.savedQueries);
  const loadSaved = useSavedQueriesStore((s) => s.load);
  const saveQuery = useSavedQueriesStore((s) => s.save);
  const removeQuery = useSavedQueriesStore((s) => s.remove);

  const [running, setRunning] = useState(false);
  const [pop, setPop] = useState<Popover>(null);
  const [saveName, setSaveName] = useState("");
  const [attach, setAttach] = useState(false);
  // Right-side drawers (Prompts 1–2) and results minimize toggle (Prompt 5).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [resultsMin, setResultsMin] = useState(false);
  // The editor handle resolves the statement at the caret for the Run/Explain
  // buttons; `explainSql` is the statement captured when Explain was opened.
  const editorRef = useRef<SqlCodeEditorHandle>(null);
  const [explainSql, setExplainSql] = useState("");
  // Caret offset, reported by the editor; drives the cursor-aware clause minimap.
  const [caret, setCaret] = useState(0);
  // Transient view toggle: the results area shows either the query result
  // ('result') or the execution-order teaching panel ('explain'). Local —
  // it's a view flip, not buffer/result state, so it need not survive a switch.
  const [view, setView] = useState<"result" | "explain">("result");

  // The active schema this tab runs against (sidebar switcher; falls back to
  // the connection's first schema — SQLite: "main").
  const schemaName =
    (workspace.ui.schemaName !== undefined &&
    workspace.schemas.some((s) => s.name === workspace.ui.schemaName)
      ? workspace.ui.schemaName
      : workspace.schemas[0]?.name) ?? "main";

  // Engine-specific starter chips, resolved to the active schema.
  const snippets = snippetsFor(workspace.info.engine, schemaName);

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

  // Prompt 3: Ctrl/Cmd+S opens the save-query popover. The SQL tab is mounted
  // only while active (WorkspaceContent renders just the active tab), so this
  // window listener is correctly scoped to the active SQL tab — it never
  // collides with the data grid's own Ctrl+S (a different tab kind, never
  // mounted at the same time). preventDefault stops the browser save dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setPop("save");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const text = tab.text;

  // Optional, client-side enrichment for the Explain panel: if the detected
  // FROM table already has cached introspection columns (no fetch is issued),
  // surface its column count on the FROM step. Falls back to null otherwise —
  // the panel works from clause detection alone.
  const columnsCache = useIntrospectionStore((s) => s.columns);
  const explainTable = view === "explain" ? detectedTable(explainSql) : null;
  const columnCount =
    explainTable != null
      ? (columnsCache[columnsKey(workspace.handleId, schemaName, explainTable)]?.columns.length ??
        null)
      : null;

  // Run a statement. With no override the whole buffer runs; the toolbar Run
  // button and ⌘/Ctrl+Enter pass the statement at the caret (selection wins),
  // so a multi-statement buffer runs only the one under the cursor. Latest
  // `running` is read off state so double-fires are ignored; result / error /
  // history all go to the store (survive switches).
  const run = (override?: string) => {
    const sql = (override ?? text).trim();
    if (running || sql === "") return;
    setRunning(true);
    setPop(null);
    // A new run always re-expands the results pane (Prompt 5).
    setResultsMin(false);
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

  // Beautify the whole buffer in place (wand FAB / Shift+Alt+F).
  const format = () => setSqlText(tab.id, formatSql(text));

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

  // Prompt 4: the results pane only exists once there's something to show —
  // a result, an error, or the Explain view. Otherwise the editor grows to
  // fill the tab (no placeholder pane). Prompt 5: a minimized pane also lets
  // the editor reclaim the space.
  const resultsShown = view === "explain" || result != null || error != null;
  const editorGrows = !resultsShown || resultsMin;
  const minBtn = (
    <button
      type="button"
      className="results-min"
      title={resultsMin ? "Expand" : "Minimize"}
      aria-label={resultsMin ? "Expand results" : "Minimize results"}
      onClick={() => setResultsMin((m) => !m)}
    >
      <Icon name={resultsMin ? "expand_less" : "expand_more"} size={16} />
    </button>
  );

  return (
    <div className="sql-tab">
      <div className="sql-toolbar">
        <Btn
          icon="play_arrow"
          variant="filled"
          onClick={() => run(editorRef.current?.pickStatement())}
          disabled={runDisabled}
          small
        >
          {running ? "Running…" : "Run"}
        </Btn>
        <Btn
          icon="account_tree"
          variant={view === "explain" ? "filled" : "tonal"}
          small
          onClick={() => {
            if (view === "explain") {
              setView("result");
            } else {
              // Capture the statement at the caret so Explain analyzes only the
              // query under the cursor, matching Run / ⌘↩.
              setExplainSql(editorRef.current?.pickStatement() ?? text);
              setView("explain");
            }
          }}
          title="Explain & analyze the execution plan"
        >
          Explain
        </Btn>
        <span className="sql-hint">⌘↩ / Ctrl+Enter</span>
        <div className="sql-snippets">
          {snippets.map((s) => (
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

        {/* saved-queries drawer opener (Prompt 1) */}
        <IconBtn
          icon="bookmarks"
          title="Saved queries"
          active={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        />

        {/* this-tab history drawer opener (Prompt 2) */}
        <IconBtn
          icon="history"
          title="Query history"
          active={historyOpen}
          onClick={() => setHistoryOpen(true)}
        />
      </div>

      <div className={"sql-editor-wrap" + (editorGrows ? " grow" : "")}>
        <div className="sql-editor-main">
          <button
            type="button"
            className="sql-format-fab"
            title="Beautify / format SQL (⇧⌥F)"
            aria-label="Format SQL"
            onClick={format}
          >
            <Icon name="auto_fix_high" size={15} />
          </button>
          <SqlCodeEditor
            ref={editorRef}
            value={text}
            onChange={(v) => setSqlText(tab.id, v)}
            onRun={run}
            onFormat={format}
            onCaret={setCaret}
          />
        </div>
        <ExecutionMinimap sql={text} caret={caret} />
      </div>

      {resultsShown ? (
        <div className={"sql-results" + (resultsMin ? " minimized" : "")}>
          {view === "explain" ? (
            <>
              <div className="sql-result-bar explain-bar">
                {minBtn}
                <button type="button" className="result-tab" onClick={() => setView("result")}>
                  <Icon name="arrow_back" size={13} /> Results
                </button>
                <span className="result-tab active">
                  <Icon name="account_tree" size={13} /> Explain &amp; analyze
                </span>
                <div style={{ flex: 1 }} />
                <span className="dim">{schemaName}</span>
              </div>
              {resultsMin ? null : (
                <ExplainPanel sql={explainSql} schemaName={schemaName} columnCount={columnCount} />
              )}
            </>
          ) : error ? (
            <>
              <div className="sql-result-bar error-bar" role="alert">
                {minBtn}
                <Icon name="error" size={14} style={{ color: "#e06c75" }} />
                <span style={{ color: "#e06c75" }}>Query failed</span>
                <div style={{ flex: 1 }} />
                <IconBtn
                  icon="close"
                  size={14}
                  title="Dismiss results"
                  onClick={() => clearSqlResults(tab.id)}
                />
              </div>
              {resultsMin ? null : (
                <div className="sql-error">
                  <Icon name="error" size={18} />
                  <div>
                    <div className="sql-error-title">Query failed</div>
                    <div className="sql-error-msg">{error}</div>
                  </div>
                </div>
              )}
            </>
          ) : result ? (
            <>
              <div className="sql-result-bar">
                {minBtn}
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
                <div style={{ flex: 1 }} />
                <IconBtn
                  icon="close"
                  size={14}
                  title="Close results"
                  onClick={() => clearSqlResults(tab.id)}
                />
              </div>
              {resultsMin || result.columns.length === 0 ? null : (
                // A SELECT with columns renders the grid even with zero rows, so
                // the column headers stay visible (the status row above already
                // reports the row count). Only a column-less result (DML/DDL) has
                // no grid to show.
                <SqlResultGrid result={result} />
              )}
            </>
          ) : null}
        </div>
      ) : null}

      <SavedQueriesDrawer
        open={drawerOpen}
        queries={visibleSaved}
        onClose={() => setDrawerOpen(false)}
        onLoad={(q) => {
          load(q.sql);
          setDrawerOpen(false);
          toast(`Loaded “${q.name}”`, "ok");
        }}
        onDelete={(id) =>
          void removeQuery(id).catch((err: unknown) =>
            toast(appErrorMessage(err, "Could not delete query."), "err"),
          )
        }
      />

      <HistoryDrawer
        open={historyOpen}
        history={history}
        onClose={() => setHistoryOpen(false)}
        onLoad={(h) => {
          load(h.sql);
          setHistoryOpen(false);
        }}
      />
    </div>
  );
}

// ---- saved-queries side drawer (browse / search / load / delete) ----------
// Shared right-side drawer pattern (Prompt 1): a dimmed scrim + a sliding
// panel. Searches saved queries by name OR SQL content, shows each with a
// full, multi-line, syntax-highlighted SQL preview, loads on click, and
// deletes via a hover trash icon. The per-row scope chip (global /
// this-workspace) preserves this app's workspace-attachment feature.
function SavedQueriesDrawer({
  open,
  queries,
  onClose,
  onLoad,
  onDelete,
}: {
  open: boolean;
  queries: SavedQuery[];
  onClose: () => void;
  onLoad: (q: SavedQuery) => void;
  onDelete: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  // Esc closes the drawer (matches the popover dismissal it replaces).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const ql = q.trim().toLowerCase();
  const list = ql
    ? queries.filter(
        (x) => x.name.toLowerCase().includes(ql) || x.sql.toLowerCase().includes(ql),
      )
    : queries;

  return (
    <>
      <div className={"drawer-scrim" + (open ? " show" : "")} onClick={onClose} />
      <aside className={"sq-drawer" + (open ? " open" : "")} aria-hidden={!open}>
        <div className="sq-drawer-head">
          <span className="sq-drawer-title">
            <Icon name="bookmarks" size={16} style={{ color: "var(--accent)" }} /> Saved queries
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>
        <div className="sq-drawer-sub">Shared across all workspaces</div>
        <div className="sq-search">
          <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
          <input
            placeholder="Search name or SQL…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
          />
          {q ? <IconBtn icon="close" size={13} title="Clear" onClick={() => setQ("")} /> : null}
        </div>
        <div className="sq-list">
          {list.length === 0 ? (
            <div className="sq-empty">
              {queries.length === 0
                ? "Nothing saved yet — write a query and use the bookmark button."
                : `No saved queries match “${q}”.`}
            </div>
          ) : (
            list.map((item) => {
              const scoped = item.connectionId != null;
              return (
                <div key={item.id} className="sq-item" onClick={() => onLoad(item)}>
                  <div className="sq-item-head">
                    <Icon name="bookmark" size={14} style={{ color: "var(--accent)" }} />
                    <span className="sq-item-name">{item.name}</span>
                    <span
                      className="saved-scope"
                      title={scoped ? "This workspace" : "Global"}
                    >
                      {scoped ? "this workspace" : "global"}
                    </span>
                    <button
                      type="button"
                      className="sq-item-del"
                      title="Delete"
                      aria-label={"Delete " + item.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(item.id);
                      }}
                    >
                      <Icon name="delete" size={14} />
                    </button>
                  </div>
                  <pre
                    className="sq-item-sql"
                    dangerouslySetInnerHTML={{ __html: previewHtml(item.sql) }}
                  />
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}

// ---- query-history side drawer (this tab) ---------------------------------
// Reuses the saved-queries drawer/scrim styling (Prompt 2). Shows the recent
// runs for this tab with a status indicator (accent check / red error), a
// result badge (row count or "failed"), and a full highlighted SQL preview.
function HistoryDrawer({
  open,
  history,
  onClose,
  onLoad,
}: {
  open: boolean;
  history: SqlHistoryEntry[];
  onClose: () => void;
  onLoad: (h: SqlHistoryEntry) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={"drawer-scrim" + (open ? " show" : "")} onClick={onClose} />
      <aside className={"sq-drawer" + (open ? " open" : "")} aria-hidden={!open}>
        <div className="sq-drawer-head">
          <span className="sq-drawer-title">
            <Icon name="history" size={16} style={{ color: "var(--accent)" }} /> Query history
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>
        <div className="sq-drawer-sub">Recent queries · this tab</div>
        <div className="sq-list">
          {history.length === 0 ? (
            <div className="sq-empty">Nothing yet — run a query and it shows up here.</div>
          ) : (
            history.map((h, i) => (
              <div key={i} className="sq-item" onClick={() => onLoad(h)}>
                <div className="sq-item-head">
                  <Icon
                    name={h.ok ? "check_circle" : "error"}
                    size={14}
                    style={{ color: h.ok ? "var(--accent)" : "#e06c75" }}
                  />
                  <span className="sq-item-name">
                    {h.ok
                      ? h.rowCount !== undefined
                        ? `${h.rowCount} row${h.rowCount === 1 ? "" : "s"}`
                        : "Query OK"
                      : "failed"}
                  </span>
                </div>
                <pre
                  className="sq-item-sql"
                  dangerouslySetInnerHTML={{ __html: previewHtml(h.sql) }}
                />
              </div>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
