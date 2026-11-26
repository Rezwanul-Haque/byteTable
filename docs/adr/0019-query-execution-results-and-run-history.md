# ADR-0019 — Query execution: per-statement result tabs and workspace run history

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature: `6ff5e6c` "SQL editor tab with CodeMirror, results, saved queries (M6 T2)")
- **Area:** SQL
- **Related:** ADR-0003, ADR-0006, ADR-0010, ADR-0016, ADR-0018, ADR-0020, ADR-0021, ADR-0022, `docs/M6-sql-editor.md`

## Context

A SQL tab buffer often holds several `;`-separated statements. Users run the one
under the caret, a selection, or a whole script. Four constraints shaped the run
path:

- a `;` inside strings, quoted identifiers, comments, `$$` bodies or
  `BEGIN … END` blocks must not split a statement;
- pooled engines (sqlx) give each call a different connection, so a naive loop
  breaks `BEGIN`/`SET SESSION`/temp tables across statements (`bbc6bf5`,
  2026-07-23);
- one failing statement must not hide the results of the others;
- read-only workspaces (ADR-0006) must refuse writes on the backend.

The original M6 history was per-tab, capped at 20, and was lost when the tab
closed. It was moved to workspace scope on 2026-10-15 (`7357460`).

## Decision

- **Statement splitting (renderer):** `src/features/workspaces/sqlLex.ts`
  (`skipNonCode`) is the single place that encodes SQL quoting: `'…'`, `"…"`,
  backticks, narrowly-gated `[…]`, comments, and Postgres dollar quotes.
  `sqlStatement.ts` builds on it (`statementRanges`, `statementRangeAt`,
  `splitStatements`) and tracks `BEGIN`/`CASE … END` depth, so trigger bodies
  stay whole.
- **Run flow** (`run` in `src/features/workspaces/components/SqlEditorTab.tsx`):
  1. resolve `:params` first (ADR-0022);
  2. split into statements;
  3. run one statement through `queryRun` → Tauri `query_run`, or two or more (or
     the "Run as Batch" context-menu action) through `queryRunBatch` →
     `query_run_batch`.

  When change recording is on, write statements go through the change-history
  recorder instead (ADR-0016). A `finally` always clears `running`.
- **Backend:** both commands live in
  `src-tauri/src/features/connections/commands.rs`. They call
  `refuse_writes_in_read_only` (`shared::readonly::sql_is_read_only`) before
  executing and clamp `row_limit` to `MAX_ROW_LIMIT = 10_000`.
  `EngineConnection::run_batch` (`src-tauri/src/shared/ports/sql/conn.rs`) has a
  default impl that loops `run_query` and records a `StatementOutcome` for each
  statement, continuing past errors. MySQL overrides it to pin one connection
  (`src-tauri/src/engines/mysql/`). `Err` is reserved for whole-batch failure.
- **Result tabs:** each statement becomes a `SqlRun { id, sql, result, error }`
  (`types.ts`) in `SqlTabState.runs`, with exactly one of `result`/`error` set.
  The first tab gets focus. Successful object/table DDL invalidates the
  introspection caches, so the sidebar refreshes.
- **Failed tab → statement** (`28f98c6`, 2026-09-13): `goToStatement` re-splits
  the current buffer and matches by statement **text**, not stored offsets,
  because the buffer may have been edited since the run. It prefers the
  occurrence at or after the run's index, then falls back to a substring search,
  then shows a toast. It calls `SqlCodeEditorHandle.revealRange` (ADR-0018).
- **Sort by header** (`d9a4822`, 2026-08-02):
  `src/features/workspaces/resultSort.ts` sorts **client-side** because "a query
  result is one materialized batch already in memory". Clicks cycle asc → desc →
  none, nulls always sink, and text uses a numeric `Intl.Collator`. The browse
  grid instead pushes `ORDER BY` to the backend (ADR-0010).
- **Run history:** `WorkspaceUiState.history: SqlHistoryEntry[]` (`sql`, `ok`,
  `rowCount?`, `error?`, `ranAt`), pushed via `withHistoryEntry` in
  `src/features/workspaces/state.ts`. Entries are newest first and deduped by SQL
  (a re-run moves the entry to the top). The cap is setting `sqlHistoryMax`
  (default `SQL_HISTORY_DEFAULT = 30`), clamped to `[1, SQL_HISTORY_HARD_MAX =
  100]` and read on every push. The list is persisted with the session. The
  source comment explains the ceiling: entries keep full SQL, so pasted scripts
  bloat the file. Legacy per-tab `SqlTab.history` is folded into the workspace
  list on restore.
- **Backend lexer:** `src-tauri/src/shared/sql_lex.rs` is a separate Rust
  clause-finding lexer that tracks paren depth. Execution does not use it. Its
  users are explain (ADR-0020), query debug (ADR-0021) and change-history capture
  (ADR-0016).

## Alternatives considered

- **Send the whole buffer to the driver as one string:** not done. Each statement
  needs its own result tab and error, and multi-statement support varies by
  driver (inferred).
- **Per-statement loop on the renderer:** this was the original path. It was
  replaced by `run_batch` because pooled connections break session state
  (recorded in `SqlEditorTab.tsx` and the `run_batch` doc comment).
- **Stop at first error:** rejected. The doc comment says "a failing statement
  never hides the ones after it".
- **Re-query with `ORDER BY` for result sorting:** rejected in
  `resultSort.ts`, which says sorting a materialized batch "is a reorder, not a
  re-run".
- **Per-tab history:** shipped first, then replaced. The `state.ts` comment says
  history "answers 'what have I been running against this database', so it
  outlives any one tab".

## Consequences

- **Positive:** splitting rules live in one lexer module. Partial failures are
  visible. Read-only enforcement happens in Rust. History survives tab closes and
  restarts.
- **Negative / trade-offs:** only MySQL pins a session for batches. Other engines
  use the default per-statement loop, so cross-statement session state is not
  guaranteed there. Sorting covers only the returned rows (at most 10,000), not
  the full result. The renderer and Rust each have their own SQL lexer, so the
  quoting rules are written twice.
- **Follow-ups:** no history search or filter is visible in this path. History
  persists inside the workspace UI session (`src/features/workspaces/session.ts`,
  keyed by saved-connection id, with per-schema sub-sessions), not in a dedicated
  store.
