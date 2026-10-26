// SQL editor tab (M6, spec §3.7) — ported from the prototype's editor.jsx
// SqlEditorTab: a toolbar (Run + ⌘↩ hint + snippet chips + save popover),
// a syntax-highlighted editor (CodeMirror 6, see
// SqlCodeEditor), and a results area (status row + virtualized grid, the §5
// error card, and the empty state).
//
// STATE: the editor buffer and the run results (one tab per executed
// statement) live on the tab object in the workspace's `ui` (store actions
// setSqlText / setSqlRuns / setActiveRun) so they survive workspace switches
// per the WorkspaceUiState rule. The run HISTORY is not a tab's: every run is
// pushed to the workspace's list (`pushSqlHistory`, keyed by workspace id) and
// browsed from a drawer WorkspaceContent hosts. A multi-statement
// run produces one result tab per statement; the first is focused. `running`
// is transient local state
// (an in-flight query cannot outlive a switch — the tab unmounts). Editor text
// is committed to the store on every change; that is low-frequency enough at
// editor scale and is the simplest way to guarantee text survives a switch.
//
// SAVED QUERIES are a GLOBAL store (features/saved_queries): save in workspace
// A, load from workspace B. This tab owns the SAVE half — the popover's
// attachment toggle scopes a query to THIS workspace's saved connection
// (connectionId = workspace.saved.id) when checked, global when unchecked. The
// browse half (SavedQueriesDrawer) is hosted by WorkspaceContent, because its
// opener sits on the tab strip and must work with no query tab open — as does
// the history drawer beside it.
//
// QUERY PARAMETERS: a buffer holding `:name` / `${name}` / `?` placeholders
// grows a ParamBar under the toolbar, and every run RESOLVES the buffer through
// `applyParams` before anything else touches it — so the statement splitter,
// the result tabs, the history and the backend's read-only guard all see the
// SQL that actually ran. A run with a value missing opens the prompt dialog
// instead of running; ⇧⌘↩ opens it on demand. See `../sqlParams` for the model.

import { useEffect, useMemo, useRef, useState } from "react";

import type { QueryResult } from "../../../shared/api/engine";
import { queryRun, queryRunBatch, readTextFile } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import type { StringKey } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import type { Engine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useTabMenu } from "../../../shared/hooks/useTabMenu";
import { useToast } from "../../../shared/ui/toastContext";
import { columnsKey, tablesKey, useIntrospectionStore } from "../../introspection/state";
import { useSavedQueriesStore } from "../../saved_queries/state";
import { libraryForEngine } from "../../snippets/builtins";
import { selectSnippetsForEngine, useSnippetsStore } from "../../snippets/state";
import { useWorkspacesStore } from "../state";
import { useBtCmd } from "../../../shared/ui/btCmd";
import type { SqlRun, Tab, Workspace } from "../types";
import { homeSchema } from "../types";
import { ExecutionMinimap, ExplainPanel } from "./explain";
import { detectedTable } from "../explainClauses";
import { formatSql } from "../formatSql";
import { previewHtml } from "../sqlPreview";
import { splitStatements, statementRanges } from "../sqlStatement";
import {
  applyParams,
  defsToStore,
  detectParams,
  missingParams,
  valuesToStore,
  type DetectedParam,
} from "../sqlParams";
import { type EditorSchema } from "../sqlCompletion";
import { ParamBar, ParamPrompt } from "./QueryParams";
import { SqlCodeEditor, type SqlCodeEditorHandle } from "./SqlCodeEditor";
import { SqlResultGrid } from "./SqlResultGrid";
import "./SqlEditorTab.css";

type SqlTab = Extract<Tab, { kind: "sql" }>;

// Resizable editor/results split floor: below this the editor is too small to
// use. The dragged height lives on the SQL tab in the workspace store
// (setSqlEditorHeight), so it survives workspace switches like the rest of the
// tab's state; null = fall back to the CSS default (38%).
const EDITOR_H_MIN = 110;

/**
 * Starter snippet chips. These are REAL, runnable introspection queries — but
 * each engine speaks a different dialect, so the chips are engine-specific
 * (a SQLite `pragma_table_info(...)` is a syntax error on MySQL/Postgres, etc.).
 * The placeholder `table_name` is meant to be replaced with a real table.
 * `schema_name` resolves the introspection chips to the tab's active schema.
 */
// Module-level (engine dialects select outside React): the label is a KEY, and
// the chip renders it through t() so a language switch relabels in place.
type Snippet = { labelKey: StringKey; sql: string };

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

/**
 * Did this statement fail? Normally that is just "it carries an error", but a
 * run with neither a result nor an error is treated as a failure too: nothing
 * came back, so it must never be badged as a success.
 */
function runFailed(run: SqlRun): boolean {
  return run.error != null || run.result == null;
}

function snippetsFor(engine: Engine, schemaName: string): Snippet[] {
  switch (engine) {
    case "mysql":
      return [
        {
          labelKey: "ws.sql.snipListTables",
          sql: `SELECT table_name, table_type\nFROM information_schema.tables\nWHERE table_schema = '${schemaName}'\nORDER BY table_name;`,
        },
        {
          labelKey: "ws.sql.snipTableColumns",
          sql: `SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_schema = '${schemaName}' AND table_name = 'table_name'\nORDER BY ordinal_position;`,
        },
        {
          labelKey: "ws.sql.snipRowCounts",
          sql: "SELECT COUNT(*) AS row_count\nFROM table_name;",
        },
        { labelKey: "ws.sql.snipRecentRows", sql: "SELECT *\nFROM table_name\nLIMIT 50;" },
      ];
    case "postgres":
      return [
        {
          labelKey: "ws.sql.snipListTables",
          sql: `SELECT table_name, table_type\nFROM information_schema.tables\nWHERE table_schema = '${schemaName}'\nORDER BY table_name;`,
        },
        {
          labelKey: "ws.sql.snipTableColumns",
          sql: `SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_schema = '${schemaName}' AND table_name = 'table_name'\nORDER BY ordinal_position;`,
        },
        {
          labelKey: "ws.sql.snipRowCounts",
          sql: "SELECT COUNT(*) AS row_count\nFROM table_name;",
        },
        { labelKey: "ws.sql.snipRecentRows", sql: "SELECT *\nFROM table_name\nLIMIT 50;" },
      ];
    case "sqlite":
    default:
      return [
        {
          labelKey: "ws.sql.snipListTables",
          sql: "SELECT name, type\nFROM sqlite_master\nWHERE type = 'table'\nORDER BY name;",
        },
        {
          labelKey: "ws.sql.snipTableColumns",
          sql: "SELECT name, type, \"notnull\", dflt_value\nFROM pragma_table_info('table_name');",
        },
        {
          labelKey: "ws.sql.snipRowCounts",
          sql: "SELECT COUNT(*) AS row_count\nFROM table_name;",
        },
        {
          labelKey: "ws.sql.snipRecentRows",
          sql: "SELECT *\nFROM table_name\nORDER BY rowid DESC\nLIMIT 50;",
        },
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
  const t = useT();
  const setSqlText = useWorkspacesStore((s) => s.setSqlText);
  const setSqlRuns = useWorkspacesStore((s) => s.setSqlRuns);
  const setActiveRun = useWorkspacesStore((s) => s.setActiveRun);
  const closeRun = useWorkspacesStore((s) => s.closeRun);
  const closeRuns = useWorkspacesStore((s) => s.closeRuns);
  const pushSqlHistory = useWorkspacesStore((s) => s.pushSqlHistory);

  const clearSqlRuns = useWorkspacesStore((s) => s.clearSqlRuns);
  const setSqlEditorHeight = useWorkspacesStore((s) => s.setSqlEditorHeight);

  const setSqlSavedLink = useWorkspacesStore((s) => s.setSqlSavedLink);
  const setSqlParams = useWorkspacesStore((s) => s.setSqlParams);
  const setSqlParamDefs = useWorkspacesStore((s) => s.setSqlParamDefs);
  const clearPendingSnippet = useWorkspacesStore((s) => s.clearPendingSnippet);

  const saveQuery = useSavedQueriesStore((s) => s.save);
  // Resolved live rather than cached on the tab: a rename or a delete from the
  // drawer is picked up without bookkeeping, and a deleted entry simply drops
  // the popover back to saving a new query.
  const savedQueries = useSavedQueriesStore((s) => s.savedQueries);
  const linked = savedQueries.find((q) => q.id === tab.savedQueryId) ?? null;

  const [running, setRunning] = useState(false);
  const [pop, setPop] = useState<Popover>(null);
  const [saveName, setSaveName] = useState("");
  const [attach, setAttach] = useState(false);
  // Results minimize toggle (Prompt 5). The history drawer is NOT here any
  // more: the list is workspace-scoped, so WorkspaceContent hosts it and the
  // tab strip carries its button beside Terminal and Saved queries.
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
  // The parameter prompt, when open: the run it is gathering values for.
  // `source` is the SQL that run will use (the caret statement, a selection, or
  // the whole buffer), captured when the prompt opened so the dialog cannot
  // drift from what Run was about to do. Local — an open dialog is not state
  // worth surviving a tab switch.
  const [prompt, setPrompt] = useState<{ source: string; forceBatch: boolean } | null>(null);

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
      : homeSchema(workspace)) ?? "main";

  // Engine-specific starter chips, resolved to the active schema.
  const snippets = snippetsFor(workspace.info.engine, schemaName);

  // A snippet clicked with no live editor opened THIS tab to receive it: expand
  // the template the store parked on the tab, then clear it so a later re-mount
  // (tab switch, workspace switch) does not insert it again.
  //
  // The ref is populated by the time effects run — the child's
  // useImperativeHandle commits first — so the insert lands on the first pass.
  useEffect(() => {
    const template = tab.pendingSnippet;
    if (template === undefined) return;
    if (editorRef.current?.insertSnippet(template)) clearPendingSnippet(tab.id);
  }, [tab.pendingSnippet, tab.id, clearPendingSnippet]);

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

  // Seed the save popover from the saved query this tab is linked to, every
  // time it opens — so re-saving a loaded query shows its own name and
  // attachment, and "Save" means UPDATE rather than a second copy. Keyed off
  // the open transition (not `linked`), so typing a new name while the popover
  // is open is never clobbered. Unlinked tabs open blank, as before.
  useEffect(() => {
    if (pop !== "save") return;
    setSaveName(linked?.name ?? "");
    setAttach(linked?.connectionId != null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop]);

  const text = tab.text;

  // --- Query parameters -----------------------------------------------------
  // The parameter LIST is derived from the buffer on every change and never
  // stored, so it cannot go stale: delete a `:placeholder` and its row is gone.
  // The VALUES and DECLARATIONS do live on the tab (so they survive a switch)
  // and are copied to the saved query on save.
  const engine = workspace.info.engine;
  const detectedParams = useMemo(() => detectParams(text, engine), [text, engine]);
  const paramValues = tab.params ?? {};
  const paramDefs = tab.paramDefs ?? [];
  const hasParams = detectedParams.length > 0;

  // --- Snippets -------------------------------------------------------------
  // The library for this engine — the user's snippets plus the built-in
  // starters — fed to the editor's completion source. Loaded once (the store
  // guards re-calls) so typing `sel` works without ever opening the drawer.
  // `t` is a dependency because the built-ins' names are localized.
  const allSnippets = useSnippetsStore((s) => s.snippets);
  const loadSnippets = useSnippetsStore((s) => s.load);
  useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);
  const editorSnippets = useMemo(
    () => libraryForEngine(selectSnippetsForEngine(allSnippets, engine), engine),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSnippets, engine, t],
  );

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

  // Cached row estimates for the Explain panel's joined relations — read from
  // the same introspection entry, so no fetch is issued. Stable identity: the
  // panel keys its (single) measuring run off this callback.
  const approxRows = useMemo(() => {
    const byName = new Map((tableEntries ?? []).map((t) => [t.name, t.approxRowCount]));
    return (table: string) => byName.get(table) ?? null;
  }, [tableEntries]);

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

  /**
   * Write the values a run just used back to the saved query this tab came
   * from, so reopening it comes back ready to run ("remembers what it last ran
   * with"). A no-op for an unlinked buffer — a scratch query has nowhere to
   * remember into, and its values still live on the tab.
   *
   * Only writes when something actually changed, so re-running the same query
   * does not touch the store file on every ⌘↵. Failures are swallowed on
   * purpose: this is bookkeeping that follows a successful run, and a toast
   * about it would be noise over the result the user asked for.
   */
  const rememberParamValues = (present: DetectedParam[], values: Record<string, string>) => {
    if (!linked) return;
    const toStore = valuesToStore(present, paramDefs, values);
    const stored = linked.paramValues ?? {};
    const unchanged =
      Object.keys(toStore).length === Object.keys(stored).length &&
      Object.entries(toStore).every(([k, v]) => stored[k] === v);
    if (unchanged) return;
    void saveQuery({
      id: linked.id,
      savedAt: linked.savedAt,
      name: linked.name,
      sql: linked.sql,
      connectionId: linked.connectionId,
      params: linked.params,
      paramValues: toStore,
    }).catch(() => {});
  };

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
  const run = (
    override?: string,
    opts?: { forceBatch?: boolean; values?: Record<string, string> },
  ) => {
    const raw = (override ?? text).trim();
    if (running || raw === "") return;

    // Resolve `:placeholders` FIRST, so everything downstream — the statement
    // split, the result tabs, the history entries and the backend's read-only
    // classifier — works on the SQL that actually runs. `opts.values` is the
    // prompt dialog handing back what the user just typed, which has not
    // reached the store yet.
    const values = opts?.values ?? paramValues;
    const present = detectParams(raw, engine);
    if (present.length > 0) {
      // Something still unfilled: ask instead of running. The prompt resumes
      // this exact run (same source, same batch choice) once values are in.
      if (missingParams(present, paramDefs, values).length > 0) {
        setPrompt({ source: raw, forceBatch: opts?.forceBatch === true });
        return;
      }
      // The values this run used become the remembered ones.
      if (opts?.values) setSqlParams(tab.id, values);
      rememberParamValues(present, values);
    }
    const source = applyParams(raw, values, paramDefs, engine);
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
          pushSqlHistory(workspace.id, {
            sql: stmt,
            ok: true,
            rowCount: result?.rowCount,
            ranAt: Date.now(),
          });
        } else {
          pushSqlHistory(workspace.id, { sql: stmt, ok: false, error, ranAt: Date.now() });
        }
      };

      // The whole run is wrapped so the `running` flag is ALWAYS cleared. The
      // inner try/catch blocks already turn a rejected invoke into an error
      // tab, so reaching this outer catch means the run path itself threw — a
      // bug, not a query error. Without the `finally` that left the Run button
      // stuck in "Running…" with no way back except switching tabs (which
      // remounts the component and resets the local flag).
      try {
        if (!useBatch) {
          // One statement, not forced: nothing to carry across, so the plain
          // single-statement path (unchanged from before).
          const stmt = statements[0]!;
          try {
            const result = await queryRun(workspace.handleId, stmt, { schema: schemaName });
            record(0, stmt, result, null);
          } catch (err: unknown) {
            record(0, stmt, null, appErrorMessage(err, t("ws.sql.queryFailed")));
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
            record(0, source, null, appErrorMessage(err, t("ws.sql.queryFailed")));
          }
        }
      } catch (err: unknown) {
        // Pushed directly rather than through `record`: if `record` is what
        // threw, calling it again here would throw again and escape as an
        // unhandled rejection.
        runs.push({
          id: `r${runs.length}`,
          sql: source,
          result: null,
          error: appErrorMessage(err, t("ws.sql.queryFailed")),
        });
      } finally {
        setSqlRuns(tab.id, runs); // focuses the first tab
        setRunning(false);
      }

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

  // Put the caret on the statement behind a result tab: select it in the
  // editor, scroll it to the middle and focus — so a failed result walks the
  // user straight to the SQL that produced it instead of leaving them to find
  // it in a long buffer.
  //
  // The buffer is re-split and matched by statement TEXT rather than by stored
  // offsets, because the text may have been edited since the run. When the same
  // statement appears more than once, the occurrence at (or after) the run's own
  // position wins; a run whose SQL is no longer a whole statement — an edited
  // buffer, or the whole-selection error tab a failed batch produces — falls
  // back to a plain substring search before giving up.
  const goToStatement = (runId: string) => {
    const idx = tab.runs.findIndex((r) => r.id === runId);
    const target = tab.runs[idx];
    if (!target) return;
    const ranges = statementRanges(text);
    const isTarget = (r: { from: number; to: number }) => text.slice(r.from, r.to) === target.sql;
    const hit = ranges.slice(idx).find(isTarget) ?? ranges.find(isTarget);
    if (hit) {
      editorRef.current?.revealRange(hit.from, hit.to);
      return;
    }
    const at = text.indexOf(target.sql);
    if (at === -1) {
      toast("That statement is no longer in the editor.", "info");
      return;
    }
    editorRef.current?.revealRange(at, at + target.sql.length);
  };

  // Replace the buffer from a snippet chip, a history entry or an opened file.
  // None of those is a saved query, so the tab stops being linked to one — the
  // next save must not overwrite the entry the previous text came from. (A
  // saved query is loaded by WorkspaceContent, which links instead.)
  //
  // Parameter values and declarations go with it: they described the OLD
  // buffer, and carrying a `:status` default into unrelated SQL that happens to
  // use the same name would quietly change what that query runs.
  const load = (sql: string) => {
    setSqlText(tab.id, sql);
    setSqlSavedLink(tab.id, null);
    setSqlParams(tab.id, {});
    setSqlParamDefs(tab.id, []);
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
        toast(t("ws.sql.openNeedsApp"), "info");
        return;
      }
      if (!chosen) return; // cancelled
      try {
        const contents = await readTextFile(chosen);
        editorRef.current?.dismissCompletion();
        load(contents);
        const fileName = chosen.split(/[\\/]/).pop() ?? chosen;
        toast(t("ws.sql.opened", { name: fileName }), "ok");
      } catch (err) {
        toast(appErrorMessage(err, t("ws.sql.readFail")), "err");
      }
    })();
  };

  // Beautify the whole buffer in place (wand FAB / Shift+Alt+F).
  const format = () => setSqlText(tab.id, formatSql(text));

  /**
   * Save the buffer. When this tab was loaded FROM a saved query, the default
   * is to UPDATE that entry in place (same id, so a tweak-and-save does not
   * leave a near-duplicate behind) — the entry's `savedAt` rides along because
   * the backend keeps whatever it is handed on an update. `asNew` forks the
   * buffer into a fresh entry instead; the tab then follows the copy, so the
   * next save updates that one.
   */
  const doSave = (asNew = false) => {
    const updating = !asNew && linked !== null;
    const name = saveName.trim() || linked?.name || t("ws.sql.untitled");
    const connectionId = attach ? workspace.saved.id : null;
    void saveQuery({
      id: updating ? linked.id : undefined,
      savedAt: updating ? linked.savedAt : undefined,
      name,
      sql: text,
      connectionId,
      // Pruned to the parameters this buffer actually has, and to declarations
      // that say something beyond the default — so an unparameterized query
      // saves exactly as it did before the feature existed.
      params: defsToStore(detectedParams, paramDefs),
      paramValues: valuesToStore(detectedParams, paramDefs, paramValues),
    })
      .then((stored) => {
        setSqlSavedLink(tab.id, stored.id);
        toast(
          updating
            ? t("ws.sql.updated", { name })
            : attach
              ? t("ws.sql.savedAttached", { name })
              : t("ws.sql.savedGlobal", { name }),
          "ok",
        );
        setSaveName("");
        setAttach(false);
        setPop(null);
      })
      .catch((err: unknown) => {
        toast(appErrorMessage(err, t("ws.sql.saveFail")), "err");
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

  /**
   * Open the parameter prompt for the run ⌘↵ would have done, without running.
   * The way to CHANGE values that are already filled in — a plain run would
   * just use them, which is the point of not nagging on every run.
   */
  const promptForRun = () => {
    if (!hasParams) return;
    const raw = (editorRef.current?.pickStatement() ?? text).trim();
    if (raw === "") return;
    setPrompt({ source: raw, forceBatch: false });
  };

  // ⇧⌘↩ / ⇧Ctrl+↵ — "run, but ask me about the parameters first". Scoped like
  // the ⌘S handler below: only the active SQL tab is mounted, so only it hears
  // this. Inert for a buffer with no parameters, so the chord never swallows a
  // keystroke it has nothing to do with.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key !== "Enter") return;
      if (!hasParams) return;
      e.preventDefault();
      promptForRun();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `promptForRun` reads the latest text/editor ref on each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasParams, text]);

  const { runs, activeRunId } = tab;
  const runDisabled = running || text.trim() === "";

  // The focused result tab; its result/error drive the body below (falls back
  // to the first run if the active id is stale).
  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null;
  // Right-click menu on the result tabs — the same one the workspace tab strip
  // and the NoSQL shells use, plus "Close all": a result tab is disposable
  // output, so sweeping the lot is a normal thing to want after a batch run.
  // "Go to statement" leads it, so the SQL behind a result tab can be found in
  // the editor straight from its tab.
  const resultMenu = useTabMenu({
    ids: runs.map((r) => r.id),
    close: (ids) => closeRuns(tab.id, ids),
    closeAll: true,
    actions: [{ label: t("ws.sql.goToStmt"), icon: "my_location", onSelect: goToStatement }],
  });
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
      title={resultsMin ? t("ws.sql.expand") : t("ws.sql.minimize")}
      aria-label={resultsMin ? t("ws.sql.expandResults") : t("ws.sql.minimizeResults")}
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
          {running ? t("ws.sql.running") : allSelected ? t("ws.sql.runAll") : t("menu.query.run")}
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
          title={t("ws.sql.explainTitle")}
        >
          {allSelected ? t("ws.sql.explainAll") : t("ws.sql.explain")}
        </Btn>
        {/* Only for a parameterized buffer: the way to revisit values that are
            already filled in, since a plain run just uses them. */}
        {hasParams ? (
          <IconBtn
            icon="tune"
            title={t("ws.params.runWith")}
            active={prompt !== null}
            onClick={promptForRun}
          />
        ) : null}
        <span className="sql-hint">⌘↩ / Ctrl+Enter</span>
        <div className="sql-snippets">
          {snippets.map((s) => (
            <button
              key={s.labelKey}
              type="button"
              className="snippet-chip"
              onClick={() => load(s.sql)}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />

        {/* open a .sql/.txt file into the editor */}
        <IconBtn icon="folder_open" title={t("menu.file.openSqlFile")} onClick={openFile} />

        {/* save-query popover */}
        <div className="editor-pop-anchor" style={{ position: "relative" }}>
          <IconBtn
            icon="bookmark_add"
            title={t("ws.sql.saveTitle")}
            active={pop === "save"}
            onClick={() => setPop(pop === "save" ? null : "save")}
          />
          {pop === "save" ? (
            <div
              className="editor-pop save-pop"
              role="dialog"
              aria-label={linked ? t("ws.sql.updateSavedQuery") : t("ws.sql.saveQuery")}
            >
              <div className="history-pop-title">
                {linked ? t("ws.sql.updateQuery") : t("ws.sql.saveQuery")}
              </div>
              <input
                className="save-pop-input"
                placeholder={t("ws.sql.queryName")}
                value={saveName}
                autoFocus
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") doSave();
                }}
                spellCheck={false}
              />
              <label className="save-pop-attach">
                <Checkbox checked={attach} onChange={(e) => setAttach(e.target.checked)} />
                <span>{t("ws.sql.attach")}</span>
              </label>
              <div className="save-pop-note">
                {attach
                  ? t("ws.sql.noteAttached", { name: workspace.name })
                  : t("ws.sql.noteGlobal")}
              </div>
              {/* Loaded from the saved list: the primary action overwrites that
                  entry (renaming it if the field was edited), with the old
                  behaviour one click away as "Save as new". */}
              <div className="save-pop-actions">
                {linked ? (
                  <Btn variant="text" small onClick={() => doSave(true)}>
                    {t("ws.sql.saveAsNew")}
                  </Btn>
                ) : null}
                <Btn variant="filled" small onClick={() => doSave()}>
                  {linked ? t("ws.sql.update") : t("common.save")}
                </Btn>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Between the toolbar and the editor: close to the Run button that will
          consume the values, and above the SQL the placeholders are written in. */}
      {hasParams ? (
        <ParamBar
          params={detectedParams}
          defs={paramDefs}
          values={paramValues}
          engine={engine}
          sql={text}
          onChange={(values) => setSqlParams(tab.id, values)}
          onDefsChange={(defs) => setSqlParamDefs(tab.id, defs)}
        />
      ) : null}

      {prompt ? (
        <ParamPrompt
          params={detectParams(prompt.source, engine)}
          defs={paramDefs}
          values={paramValues}
          engine={engine}
          sql={prompt.source}
          onRun={(values) => {
            const pending = prompt;
            setPrompt(null);
            run(pending.source, { forceBatch: pending.forceBatch, values });
          }}
          onClose={() => setPrompt(null)}
        />
      ) : null}

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
            title={t("ws.sql.formatTitle")}
            aria-label={t("ws.sql.formatAria")}
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
            engine={workspace.info.engine}
            snippets={editorSnippets}
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
          aria-label={t("ws.sql.resizeResults")}
          title={t("ws.sql.dragResize")}
          onPointerDown={startResize}
        />
      ) : null}

      {resultsShown ? (
        <div className={"sql-results" + (resultsMin ? " minimized" : "")}>
          {/* One result tab per executed statement (only worth showing for a
              multi-statement run). Same design as the terminal's session tabs:
              click focuses that statement's outcome, the × closes it. The first
              is focused after each run. A failed statement is badged with a red
              cross (and a red title) so it stands out in a strip of ticks. */}
          {view !== "explain" && runs.length > 1 && !resultsMin ? (
            <div className="sqlres-tabs">
              {runs.map((r, i) => {
                const active = r.id === activeRun?.id;
                const failed = runFailed(r);
                return (
                  <div
                    key={r.id}
                    className={"sqlres-tab" + (active ? " active" : "") + (failed ? " failed" : "")}
                    onClick={() => setActiveRun(tab.id, r.id)}
                    onContextMenu={(e) => resultMenu.onContextMenu(e, r.id)}
                    title={r.sql}
                  >
                    <Icon
                      name={failed ? "cancel" : "check_circle"}
                      size={13}
                      style={{ color: failed ? "var(--error)" : "var(--accent)" }}
                    />
                    <span className="sqlres-tab-title">
                      {failed
                        ? t("ws.sql.resultFailedN", { n: i + 1 })
                        : t("ws.sql.resultN", { n: i + 1 })}
                    </span>
                    <button
                      type="button"
                      className="sqlres-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeRun(tab.id, r.id);
                      }}
                      title={t("ws.sql.closeResult")}
                      aria-label={t("ws.sql.closeResultN", { n: i + 1 })}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                );
              })}
              {resultMenu.element}
            </div>
          ) : null}
          {view === "explain" ? (
            <>
              <div className="sql-result-bar explain-bar">
                {minBtn}
                <button type="button" className="result-tab" onClick={() => setView("result")}>
                  <Icon name="arrow_back" size={13} /> {t("ws.sql.results")}
                </button>
                <span className="result-tab active">
                  <Icon name="account_tree" size={13} /> {t("ws.sql.explainTab")}
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
                      <span className="sqlres-tab-title">{t("ws.sql.queryN", { n: i + 1 })}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {resultsMin ? null : (
                <ExplainPanel
                  sql={activeExplainSql}
                  handleId={workspace.handleId}
                  schemaName={schemaName}
                  env={workspace.saved.env}
                  engine={workspace.info.engine}
                  approxRows={approxRows}
                  columnCount={columnCount}
                />
              )}
            </>
          ) : activeRun && runFailed(activeRun) ? (
            <>
              <div className="sql-result-bar error-bar" role="alert">
                {minBtn}
                <Icon name="cancel" size={14} style={{ color: "var(--error)" }} />
                <span style={{ color: "var(--error)" }}>{t("ws.sql.queryFailedTitle")}</span>
                <div style={{ flex: 1 }} />
                {/* Jump the caret to the SQL that failed, so it can be fixed
                    and re-run from the editor (⌘↩ on the caret's statement). */}
                <Btn
                  icon="my_location"
                  variant="text"
                  small
                  onClick={() => goToStatement(activeRun.id)}
                  title={t("ws.sql.selectStmtHint")}
                >
                  {t("ws.sql.goToStmt")}
                </Btn>
                <IconBtn
                  icon="close"
                  size={14}
                  title={t("ws.sql.dismissResults")}
                  onClick={() => clearSqlRuns(tab.id)}
                />
              </div>
              {resultsMin ? null : (
                <div className="sql-error">
                  <Icon name="cancel" size={18} />
                  <div>
                    <div className="sql-error-title">{t("ws.sql.queryFailedTitle")}</div>
                    <div className="sql-error-msg">{error ?? t("ws.sql.noResult")}</div>
                    {/* Which statement failed — in a multi-statement run the
                        tab number alone doesn't say, and the tooltip is easy
                        to miss. Clicking it is the same jump as the bar's "Go
                        to statement": the SQL is what a user reaches for. */}
                    <button
                      type="button"
                      className="sql-error-stmt"
                      title={t("ws.sql.goToStmtHint")}
                      onClick={() => goToStatement(activeRun.id)}
                      dangerouslySetInnerHTML={{ __html: previewHtml(activeRun.sql) }}
                    />
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
                    <span>{t("ws.sql.queryOk")}</span>
                    <span className="dim">·</span>
                    <span className="dim">{result.elapsedMs} ms</span>
                    <span className="dim">·</span>
                    <span className="dim">{schemaName}</span>
                  </>
                ) : (
                  <>
                    <Icon name="check_circle" size={14} style={{ color: "var(--accent)" }} />
                    <span>{t("ws.rows.count", { count: result.rowCount })}</span>
                    {result.truncated ? <span className="dim">{t("ws.sql.truncated")}</span> : null}
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
                  title={t("ws.sql.closeResults")}
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
    </div>
  );
}
