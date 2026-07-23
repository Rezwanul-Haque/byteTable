// SQL editor tab (M6, spec §3.7) — ported from the prototype's editor.jsx
// SqlEditorTab: a toolbar (Run + ⌘↩ hint + snippet chips + save/bookmarks/
// history popovers), a syntax-highlighted editor (CodeMirror 6, see
// SqlCodeEditor), and a results area (status row + virtualized grid, the §5
// error card, and the empty state).
//
// STATE: the editor buffer, the run results (one tab per executed statement),
// and per-tab history live on the tab object in the workspace's `ui` (store
// actions setSqlText / setSqlRuns / setActiveRun / pushSqlHistory) so they
// survive workspace switches per the WorkspaceUiState rule. A multi-statement
// run produces one result tab per statement; the first is focused. `running`
// is transient local state
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

import { useEffect, useMemo, useRef, useState } from "react";

import { highlightSql } from "../../browse/shared/highlightSql";
import type { QueryResult } from "../../../shared/api/engine";
import { queryRun, queryRunBatch, readTextFile } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import type { Engine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { columnsKey, tablesKey, useIntrospectionStore } from "../../introspection/state";
import { type SavedQuery } from "../../saved_queries/api";
import { selectQueriesForConnection, useSavedQueriesStore } from "../../saved_queries/state";
import { useWorkspacesStore } from "../state";
import { useBtCmd } from "../../../shared/ui/btCmd";
import type { SqlHistoryEntry, SqlRun, Tab, Workspace } from "../types";
import { ExecutionMinimap, ExplainPanel } from "./explain";
import { detectedTable } from "./explainClauses";
import { formatSql } from "./formatSql";
import { splitStatements } from "./sqlStatement";
import { type EditorSchema } from "./sqlCompletion";
import { SqlCodeEditor, type SqlCodeEditorHandle } from "./SqlCodeEditor";
import { SqlResultGrid } from "./SqlResultGrid";
import "./SqlEditorTab.css";

type SqlTab = Extract<Tab, { kind: "sql" }>;

/** Cap on the SQL shown in a drawer preview (full multi-line, but bounded). */
const PREVIEW_MAX = 240;

// Resizable editor/results split floor: below this the editor is too small to
// use. The dragged height lives on the SQL tab in the workspace store
// (setSqlEditorHeight), so it survives workspace switches like the rest of the
// tab's state; null = fall back to the CSS default (38%).
const EDITOR_H_MIN = 110;

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

/** A statement that creates/drops/alters/refreshes a schema OBJECT (not a
 *  table) — used to invalidate the object caches after an editor run so the
 *  sidebar + viewer update immediately. Matches at the statement start so a
 *  `view`/`function`/etc. word inside a table query never trips it. */
const OBJECT_DDL_RE =
  /^\s*(create(\s+or\s+replace)?|drop|alter|refresh)\s+(materialized\s+view|view|function|procedure|trigger)\b/i;

/** A statement that creates/drops/alters/renames a TABLE (or its indexes) —
 *  used to force-refetch the schema's table list after an editor run so the
 *  sidebar accordion + Structure view pick up new/dropped/renamed columns and
 *  tables immediately, instead of showing stale cache until a manual refresh.
 *  A forced `loadTables` drops the schema's column + tableMeta caches, so the
 *  sidebar's column effect and an open Structure view refetch reactively —
 *  the same path the manual refresh button takes. Matches at the statement
 *  start so a `table`/`index` word inside a query body never trips it. */
const TABLE_DDL_RE =
  /^\s*(?:create(?:\s+(?:global|local))?(?:\s+temp(?:orary)?)?\s+table|(?:drop|alter|rename)\s+table|(?:create(?:\s+unique)?|drop)\s+index)\b/i;

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
        { label: "row counts", sql: "SELECT COUNT(*) AS row_count\nFROM table_name;" },
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

/**
 * Native file-open dialog for a `.sql` / `.txt` file (the real Tauri build).
 * Lazily imports the dialog plugin so plain-browser dev doesn't crash at load
 * (mirrors the import modals' `openSqlDialog`). Returns the chosen path, or
 * null when the user cancels. Throws (no Tauri) when not running in the desktop
 * shell — the caller turns that into a toast.
 */
async function openSqlFileDialog(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    multiple: false,
    filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
  });
  return typeof chosen === "string" ? chosen : null;
}

/** Only the save popover remains a popover; browse/manage moved to drawers. */
type Popover = "save" | null;

export function SqlEditorTab({ workspace, tab }: { workspace: Workspace; tab: SqlTab }) {
  const toast = useToast();
  const setSqlText = useWorkspacesStore((s) => s.setSqlText);
  const setSqlRuns = useWorkspacesStore((s) => s.setSqlRuns);
  const setActiveRun = useWorkspacesStore((s) => s.setActiveRun);
  const closeRun = useWorkspacesStore((s) => s.closeRun);
  const pushSqlHistory = useWorkspacesStore((s) => s.pushSqlHistory);

  const clearSqlRuns = useWorkspacesStore((s) => s.clearSqlRuns);
  const setSqlEditorHeight = useWorkspacesStore((s) => s.setSqlEditorHeight);

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
  // Which statement of a multi-statement Explain selection is focused (one
  // explain tab per statement, mirroring the result tabs). Reset to 0 on open.
  const [explainActiveIdx, setExplainActiveIdx] = useState(0);
  // Caret offset, reported by the editor; drives the cursor-aware clause minimap.
  const [caret, setCaret] = useState(0);
  // True when the editor's whole buffer is selected (Mod-A) — flips Run to
  // "Run All" so it's clear the entire buffer (every statement) will run.
  const [allSelected, setAllSelected] = useState(false);
  // Transient view toggle: the results area shows either the query result
  // ('result') or the execution-order teaching panel ('explain'). Local —
  // it's a view flip, not buffer/result state, so it need not survive a switch.
  const [view, setView] = useState<"result" | "explain">("result");

  // Resizable editor/results split. `tab.editorHeight` (px, in the store)
  // overrides the CSS default height of the editor pane; the results pane
  // (flex:1) reclaims the rest. Updated live during the drag.
  const tabRef = useRef<HTMLDivElement>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  // Pointer-drag the splitter: grow/shrink the editor pane between a usable
  // floor and a ceiling that always leaves room for the results pane. Writes
  // the height to the store live on each move (like TerminalPanel's setHeight),
  // so it's already persisted on release. Pointer capture on the handle keeps
  // the drag tracking even when the cursor outruns the 6px bar.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const wrap = editorWrapRef.current;
    const tabEl = tabRef.current;
    if (!wrap || !tabEl) return;
    const startY = e.clientY;
    const startH = wrap.getBoundingClientRect().height;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      const maxH = Math.max(EDITOR_H_MIN, tabEl.getBoundingClientRect().height - 140);
      const next = Math.max(EDITOR_H_MIN, Math.min(maxH, startH + (ev.clientY - startY)));
      setSqlEditorHeight(tab.id, next);
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setDragging(false);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

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
  // Explain runs per statement, same as a multi-statement Run: split the
  // captured SQL and explain the focused one (each statement is a tab).
  const explainStatements = useMemo(
    () => (view === "explain" ? splitStatements(explainSql) : []),
    [view, explainSql],
  );
  const activeExplainSql =
    explainStatements[explainActiveIdx] ?? explainStatements[0] ?? explainSql;
  const explainTable = view === "explain" ? detectedTable(activeExplainSql) : null;
  const columnCount =
    explainTable != null
      ? (columnsCache[columnsKey(workspace.handleId, schemaName, explainTable)]?.columns.length ??
        null)
      : null;

  // --- Autocomplete schema (PROMPT_autocomplete) -----------------------------
  // The suggestion source is the active connection's introspected schema: the
  // schema's table list plus whatever column lists are cached. Columns load
  // lazily (sidebar expansion / the warm below), so the editor reads this live
  // and re-renders as more columns arrive — never a per-keystroke backend call.
  const tablesCache = useIntrospectionStore((s) => s.tables);
  const loadTables = useIntrospectionStore((s) => s.loadTables);
  const loadColumns = useIntrospectionStore((s) => s.loadColumns);
  const invalidateObjects = useIntrospectionStore((s) => s.invalidateObjects);
  const tableEntries = tablesCache[tablesKey(workspace.handleId, schemaName)]?.tables;

  // Ensure the table list exists even if the sidebar hasn't fetched it yet
  // (cache-first — a no-op once warmed).
  useEffect(() => {
    void loadTables(workspace.handleId, schemaName);
  }, [loadTables, workspace.handleId, schemaName]);

  // Tables named after FROM/JOIN/INTO/UPDATE in the buffer — warm their columns
  // so column suggestions for referenced tables are available. Cache-first, so
  // re-runs are free; this is what keeps "no per-keystroke backend call" true.
  const referencedNames = useMemo(() => {
    const set = new Set<string>();
    const re = /\b(?:from|join|into|update)\s+([a-z_][\w$]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) set.add(m[1]!.toLowerCase());
    return set;
  }, [text]);

  useEffect(() => {
    for (const t of tableEntries ?? []) {
      if (referencedNames.has(t.name.toLowerCase())) {
        void loadColumns(workspace.handleId, schemaName, t.name);
      }
    }
  }, [referencedNames, tableEntries, loadColumns, workspace.handleId, schemaName]);

  const editorSchema = useMemo<EditorSchema>(
    () => ({
      tables: (tableEntries ?? []).map((t) => ({
        name: t.name,
        columns: (
          columnsCache[columnsKey(workspace.handleId, schemaName, t.name)]?.columns ?? []
        ).map((c) => ({ name: c.name, pk: c.pk })),
      })),
    }),
    [tableEntries, columnsCache, workspace.handleId, schemaName],
  );

  // Run SQL. With no override the whole buffer runs; the toolbar Run button and
  // ⌘/Ctrl+Enter pass the statement at the caret, OR — when the user has
  // selected text spanning several statements — that whole selection. The
  // source is split into top-level statements and run IN ORDER. A SINGLE
  // statement goes through `queryRun`; TWO OR MORE run as one session-pinned
  // batch (`queryRunBatch`) so they share ONE connection — a per-statement loop
  // hands each statement a different pooled connection, which breaks
  // transactions / savepoints / `SET SESSION` that must span statements. EVERY
  // statement's outcome becomes a result tab (success or its §5 error), so a
  // failing statement doesn't hide the others; the run continues through all of
  // them and the first tab is focused. Latest `running` is read off state so
  // double-fires are ignored; runs / history go to the store (survive switches).
  const run = (override?: string, opts?: { forceBatch?: boolean }) => {
    const source = (override ?? text).trim();
    if (running || source === "") return;
    const statements = splitStatements(source);
    if (statements.length === 0) return;
    // Batch when there is more than one statement (they must share a session),
    // or when the caller forces it via the "Run as Batch" context-menu action
    // (pins even a lone statement onto one connection).
    const useBatch = opts?.forceBatch === true || statements.length > 1;
    setRunning(true);
    setPop(null);
    // A new run always re-expands the results pane (Prompt 5).
    setResultsMin(false);
    void (async () => {
      const runs: SqlRun[] = [];
      let touchedObjects = false;
      let touchedTables = false;
      // Record one statement's outcome as a result tab + a history entry, and
      // flag object/table DDL so the sidebar caches refresh after a success.
      const record = (
        i: number,
        stmt: string,
        result: QueryResult | null,
        error: string | null,
      ) => {
        runs.push({ id: `r${i}`, sql: stmt, result, error });
        if (error === null) {
          if (OBJECT_DDL_RE.test(stmt)) touchedObjects = true;
          if (TABLE_DDL_RE.test(stmt)) touchedTables = true;
          pushSqlHistory(tab.id, {
            sql: stmt,
            ok: true,
            rowCount: result?.rowCount,
            ranAt: Date.now(),
          });
        } else {
          pushSqlHistory(tab.id, { sql: stmt, ok: false, error, ranAt: Date.now() });
        }
      };

      if (!useBatch) {
        // One statement, not forced: nothing to carry across, so the plain
        // single-statement path (unchanged from before).
        const stmt = statements[0]!;
        try {
          const result = await queryRun(workspace.handleId, stmt, { schema: schemaName });
          record(0, stmt, result, null);
        } catch (err: unknown) {
          record(0, stmt, null, appErrorMessage(err, "Query failed."));
        }
      } else {
        // Multiple statements: one session-pinned batch. Per-statement errors
        // arrive INSIDE the outcomes (continue-on-error); the promise itself
        // only rejects on a whole-run failure (e.g. the connection was lost
        // before anything ran), surfaced as a single error tab.
        try {
          const outcomes = await queryRunBatch(workspace.handleId, statements, {
            schema: schemaName,
          });
          outcomes.forEach((o, i) => record(i, o.sql, o.result, o.error));
        } catch (err: unknown) {
          record(0, source, null, appErrorMessage(err, "Query failed."));
        }
      }

      setSqlRuns(tab.id, runs); // focuses the first tab
      setRunning(false);
      // A successful CREATE/DROP/ALTER/REFRESH of a schema object invalidates
      // the introspection object caches so the sidebar + any open viewer pick up
      // the change immediately (matches running the same DDL via the object UI).
      if (touchedObjects) invalidateObjects(workspace.handleId, schemaName);
      // A successful CREATE/ALTER/DROP/RENAME TABLE (or index DDL) force-refetches
      // the schema's table list; that eviction of the column + tableMeta caches
      // makes the sidebar accordion and any open Structure view refetch reactively
      // — same path as the manual refresh button, so new columns show at once.
      if (touchedTables) void loadTables(workspace.handleId, schemaName, { force: true });
    })();
  };

  const load = (sql: string) => {
    setSqlText(tab.id, sql);
    setPop(null);
  };

  // Open a .sql/.txt file via the native dialog and load its text into the
  // editor (replacing the buffer). Reads from disk through the read_text_file
  // command — the user's pick in the OS dialog is the consent. The open
  // autocomplete popup is dismissed so it doesn't linger over the new text.
  const openFile = () => {
    void (async () => {
      let chosen: string | null;
      try {
        chosen = await openSqlFileDialog();
      } catch {
        toast("Opening a file requires the desktop app", "info");
        return;
      }
      if (!chosen) return; // cancelled
      try {
        const contents = await readTextFile(chosen);
        editorRef.current?.dismissCompletion();
        load(contents);
        const fileName = chosen.split(/[\\/]/).pop() ?? chosen;
        toast(`Opened “${fileName}”`, "ok");
      } catch (err) {
        toast(appErrorMessage(err, "Could not read the file."), "err");
      }
    })();
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

  // Toggle the execution-plan view — mirrors the Explain button (capture the
  // statement at the caret, one explain tab per statement).
  const runExplain = () => {
    if (view === "explain") {
      setView("result");
      return;
    }
    setExplainSql(editorRef.current?.pickStatement() ?? text);
    setExplainActiveIdx(0);
    setView("explain");
  };

  // Title-bar Query/File/View menu commands (bt:cmd bus). Only the ACTIVE SQL
  // tab is mounted (WorkspaceContent renders just the active tab), so exactly
  // one editor claims these at a time.
  useBtCmd("run", () => run());
  useBtCmd("format", format);
  useBtCmd("explain", runExplain);
  useBtCmd("save-query", () => setPop("save"));
  useBtCmd("open-sql-file", openFile);
  useBtCmd("query-history", () => setHistoryOpen(true));

  const visibleSaved = selectQueriesForConnection(savedQueries, workspace.saved.id);
  const { runs, activeRunId, history } = tab;
  const runDisabled = running || text.trim() === "";

  // The focused result tab; its result/error drive the body below (falls back
  // to the first run if the active id is stale).
  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null;
  const result = activeRun?.result ?? null;
  const error = activeRun?.error ?? null;

  // Prompt 4: the results pane only exists once there's something to show —
  // at least one run, or the Explain view. Otherwise the editor grows to fill
  // the tab (no placeholder pane). Prompt 5: a minimized pane also lets the
  // editor reclaim the space.
  const resultsShown = view === "explain" || runs.length > 0;
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
    <div className="sql-tab" ref={tabRef}>
      <div className="sql-toolbar">
        <Btn
          icon="play_arrow"
          variant="filled"
          onClick={() => run(editorRef.current?.pickStatement())}
          disabled={runDisabled}
          small
        >
          {running ? "Running…" : allSelected ? "Run All" : "Run"}
        </Btn>
        <Btn
          icon="account_tree"
          variant={view === "explain" ? "filled" : "tonal"}
          small
          onClick={() => {
            if (view === "explain") {
              setView("result");
            } else {
              // Capture the statement at the caret — or, when text spanning
              // several statements is selected, that whole selection (matching
              // Run / ⌘↩). A multi-statement capture becomes one explain tab per
              // statement; focus the first.
              setExplainSql(editorRef.current?.pickStatement() ?? text);
              setExplainActiveIdx(0);
              setView("explain");
            }
          }}
          title="Explain & analyze the execution plan"
        >
          {allSelected ? "Explain All" : "Explain"}
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

        {/* open a .sql/.txt file into the editor */}
        <IconBtn icon="folder_open" title="Open .sql file" onClick={openFile} />

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

      <div
        className={"sql-editor-wrap" + (editorGrows ? " grow" : "")}
        ref={editorWrapRef}
        // Inline height only when the editor is NOT in grow mode (no results /
        // minimized), so it never overrides the `.grow` rule's flex fill.
        style={!editorGrows && tab.editorHeight != null ? { height: tab.editorHeight } : undefined}
      >
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
            onRunBatch={(sql) => run(sql, { forceBatch: true })}
            onFormat={format}
            onCaret={setCaret}
            onAllSelected={setAllSelected}
            schema={editorSchema}
          />
        </div>
        <ExecutionMinimap sql={text} caret={caret} />
      </div>

      {/* Drag handle between editor and results. Only meaningful when the
          results pane is actually shown (and not minimized); otherwise the
          editor is in grow mode and there's nothing to resize against. */}
      {resultsShown && !resultsMin ? (
        <div
          className={"sql-vsplit" + (dragging ? " dragging" : "")}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize results"
          title="Drag to resize"
          onPointerDown={startResize}
        />
      ) : null}

      {resultsShown ? (
        <div className={"sql-results" + (resultsMin ? " minimized" : "")}>
          {/* One result tab per executed statement (only worth showing for a
              multi-statement run). Same design as the terminal's session tabs:
              click focuses that statement's outcome, the × closes it. The first
              is focused after each run. */}
          {view !== "explain" && runs.length > 1 && !resultsMin ? (
            <div className="sqlres-tabs">
              {runs.map((r, i) => {
                const active = r.id === activeRun?.id;
                return (
                  <div
                    key={r.id}
                    className={"sqlres-tab" + (active ? " active" : "")}
                    onClick={() => setActiveRun(tab.id, r.id)}
                    title={r.sql}
                  >
                    <Icon
                      name={r.error ? "error" : "check_circle"}
                      size={13}
                      style={{ color: r.error ? "#e06c75" : "var(--accent)" }}
                    />
                    <span className="sqlres-tab-title">Result {i + 1}</span>
                    <button
                      type="button"
                      className="sqlres-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeRun(tab.id, r.id);
                      }}
                      title="Close result"
                      aria-label={`Close result ${i + 1}`}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
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
              {/* One explain tab per statement (only for a multi-statement
                  selection), mirroring the result tabs. No close — they're a
                  view of the captured selection, not independent runs. */}
              {explainStatements.length > 1 && !resultsMin ? (
                <div className="sqlres-tabs">
                  {explainStatements.map((stmt, i) => (
                    <div
                      key={i}
                      className={"sqlres-tab" + (i === explainActiveIdx ? " active" : "")}
                      onClick={() => setExplainActiveIdx(i)}
                      title={stmt}
                    >
                      <Icon
                        name="account_tree"
                        size={13}
                        style={{
                          color: i === explainActiveIdx ? "var(--accent)" : "var(--text-faint)",
                        }}
                      />
                      <span className="sqlres-tab-title">Query {i + 1}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {resultsMin ? null : (
                <ExplainPanel
                  sql={activeExplainSql}
                  schemaName={schemaName}
                  columnCount={columnCount}
                />
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
                  onClick={() => clearSqlRuns(tab.id)}
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
                  onClick={() => clearSqlRuns(tab.id)}
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
    ? queries.filter((x) => x.name.toLowerCase().includes(ql) || x.sql.toLowerCase().includes(ql))
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
                    <span className="saved-scope" title={scoped ? "This workspace" : "Global"}>
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
