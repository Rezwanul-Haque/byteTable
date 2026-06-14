# M6 — SQL editor + global saved queries

> Provenance: this spec documents the **shipped code** in `bytetable/`, cross-checked against MILESTONES.md (M6) and DESIGN_SPEC.md §3.7 (SQL editor tab) and §5 (error style). It is the rebuild contract: an imperative sentence is a requirement, and every requirement is grounded in a real path. Where this doc and the handoff prototype disagree, the shipped code wins (e.g. the saved-query **workspace-attachment** toggle is a real-code extension beyond the prototype's pure-global store).

## Goal

A real SQL editor tab per §3.7: a CodeMirror-6 editor with SQL highlighting, **⌘↩ / Ctrl+Enter** to run, **Tab = 2 spaces**, per-engine **snippet chips**, a results area that **reuses the M4 grid**, §5 error rendering, and a **per-tab history** (newest-first, deduped by SQL, capped at 20). Plus a **global, persisted saved-query store** — save a query in workspace A, load it from workspace B — exposed through a save popover, a saved-list popover, and the command palette. Multiple SQL tabs coexist and their state (buffer, result, error, history) survives workspace switches.

## Dependencies — M4 grid, editor lib

- **M4 data grid kernel** — the results area reuses `SqlResultGrid` (`src/features/workspaces/components/SqlResultGrid.tsx`), which virtualizes rows with `@tanstack/react-virtual` and renders cells through the shared `CellContent` from `src/features/browse/components/GridCell.tsx`, so SQL-result cells match the browse grid exactly (NULL/number/boolean/pill rendering, `--grid-row-h` density 26/32). No header sort, no FK links in this grid (FK is M10).
- **Editor library — CodeMirror 6** (`src/features/workspaces/components/SqlCodeEditor.tsx`). Exact versions from `package.json`:
  - `@codemirror/commands` 6.10.3
  - `@codemirror/lang-sql` 6.10.0 (`sql({ dialect: SQLite })`)
  - `@codemirror/language` 6.12.3
  - `@codemirror/state` 6.6.0
  - `@codemirror/view` 6.43.1
  - `@lezer/highlight` 1.2.3
- **M2 query path** — execution rides the existing `query_run` Tauri command (`src-tauri/src/features/connections/commands.rs:195`), wrapped by `queryRun` in `src/shared/api/engine.ts:440`.
- **Workspaces store** — tab/history/result state lives on the SQL tab object in `src/features/workspaces/state.ts` + `types.ts`.

## Backend (Rust core)

The backend splits in two: a **new persisted slice** `src-tauri/src/features/saved_queries/` (global CRUD) and the **reused** `query_run` command for statement execution (no backend changes were needed there for M6).

### Domain — `SavedQuery` model

`src-tauri/src/features/saved_queries/domain/mod.rs`. A pure value object; only outward dep is `serde`. The serde derives double as the persisted/wire representation (camelCase) so the renderer's TS literals match byte-for-byte.

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,        // UUID assigned by the save use-case when empty (new entry)
    pub name: String,
    pub sql: String,
    pub saved_at: u64,     // Unix epoch ms; assigned on first save, kept on update
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>, // OPTIONAL workspace attachment (see below)
}
```

- `connection_id` is the durable workspace attachment: workspaces have ephemeral `ws-<uuid>` ids, but the underlying `SavedConnection.id` is persisted, so attachment is keyed on that. `None`/absent = **global** (visible in every workspace); `Some(id)` = scoped to that saved connection's workspace. It is omitted from the wire when `None`, so a global query keeps its original four-key shape (`id`/`name`/`sql`/`savedAt`).
- `SavedQuery::validation_error(&self) -> Option<&'static str>` returns, in field order, `"Query name is required."` then `"Query SQL is required."` — both checked after `trim()`, so spaces-only is rejected like empty. Messages follow §5 (human, specific).

### Ports / Application

**Persistence port** — `src-tauri/src/features/saved_queries/ports.rs`:

```rust
pub trait SavedQueryRepository: Send + Sync {
    fn list(&self) -> Result<Vec<SavedQuery>, AppError>;        // stored order
    fn save(&self, query: &SavedQuery) -> Result<(), AppError>; // upsert by id
    fn delete(&self, id: &str) -> Result<(), AppError>;         // NotFound on unknown id
}
```

Deliberately **sync** (the store is a tiny local JSON file; each call is effectively instant). Commands are still `async fn` for surface consistency; calling sync inline is fine. `Send + Sync` because a single instance is shared across Tauri's async invocations.

**Use-cases** — `src-tauri/src/features/saved_queries/application/mod.rs` (depend on domain + ports only; generic over `R: SavedQueryRepository + ?Sized` so `&dyn` trait objects and test fakes both work):

- `list_saved_queries(repo) -> Result<Vec<SavedQuery>, AppError>` — passthrough.
- `save_saved_query(repo, mut query) -> Result<SavedQuery, AppError>` — runs `validation_error()` first (blank → `AppError::Invalid`); if `id` is blank, mints `uuid::Uuid::new_v4()` and stamps `saved_at = now_epoch_ms()`; an existing id keeps both. Returns the stored value so the renderer learns the assigned id/timestamp. `connection_id` passes through untouched for both new and existing entries.
- `delete_saved_query(repo, id) -> Result<(), AppError>` — passthrough; unknown id → `NotFound`.

**Statement execution (reused)** — `run_query` in `src-tauri/src/features/connections/application/mod.rs:491`: `manager.get_sql(handle).await?.run_query(sql, options).await`. Timing (`elapsed_ms`) is produced by the engine adapter inside `EngineConnection::run_query` and carried on `QueryResult`.

**Persistence location** — `JsonFileSavedQueryRepository` (`infrastructure/mod.rs`) writes pretty-printed JSON at `<app_config_dir>/saved_queries.json` (composed in `src-tauri/src/lib.rs:96` via `config_dir.join("saved_queries.json")`). Corrupt-file policy follows the **connections** slice, not preferences:

- Missing file → empty list (first launch is not an error).
- Corrupt file → **`AppError::Serialization`** naming the file (`"Saved queries file is corrupted: … fix or remove the file to continue"`) — **never a silent reset** (saved queries are user data). The corrupt file is left untouched.
- Saves are **atomic**: write `*.json.tmp`, then `fs::rename` over the target; `create_dir_all` on parents.
- An internal `Mutex<()>` (`write_lock`) serializes the read-modify-write of `save`/`delete`; lock poison maps to a graceful `AppError::Io` ("restart the app"), not a panic.

### Tauri commands

`src-tauri/src/features/saved_queries/commands.rs` — thin presentation layer (deserialize → use-case → serialize). State `SavedQueriesState { repository: Box<dyn SavedQueryRepository + Send + Sync> }` is managed in `lib.rs:98`; commands registered in `lib.rs:174-176`. The execution command lives in the connections slice.

| command                                   | args                                                                           | returns                                           | errors                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| `saved_query_list`                        | —                                                                              | `Vec<SavedQuery>`                                 | `Serialization` (corrupt file), `Io`                             |
| `saved_query_save`                        | `query: SavedQuery`                                                            | `SavedQuery` (stored, with assigned id/`savedAt`) | `Invalid` (blank name/SQL), `Io`, `Serialization`                |
| `saved_query_delete`                      | `id: String`                                                                   | `()`                                              | `NotFound` (unknown id), `Io`, `Serialization`                   |
| `query_run` _(reused, connections slice)_ | `handleId: ConnectionHandleId`, `sql: String`, `options: Option<QueryOptions>` | `QueryResult`                                     | engine/driver errors as §5 messages; `NotFound` (unknown handle) |

`query_run` clamps `options.row_limit` to `MAX_ROW_LIMIT = 10_000` (`commands.rs:30`, `clamp_row_limit`); the default when `options` is omitted is `row_limit: 500`, `schema: None`.

## Frontend (React)

### State

**SQL editor / tab store** — the tab object carries its editor state inline so each tab is independent and survives workspace switches (`src/features/workspaces/types.ts`):

```ts
interface SqlTabState {
  // merged into the kind:"sql" Tab variant
  text: string; // editor buffer (committed on every change)
  result: QueryResult | null; // last success; mutually exclusive with error
  error: string | null; // last §5 failure message
  history: SqlHistoryEntry[]; // newest-first, deduped by sql, capped at 20
}
interface SqlHistoryEntry {
  sql: string;
  ok: boolean;
  rowCount?: number;
  error?: string;
  ranAt: number;
}
```

`running` is **not** in the store — it is transient local component state, since an in-flight query cannot outlive a tab unmount. Actions in `src/features/workspaces/state.ts`:

- `setSqlText(tabId, text)` — commits the buffer.
- `setSqlResult(tabId, result)` — sets `result`, clears `error`.
- `setSqlError(tabId, error)` — sets `error`, clears `result`.
- `pushSqlHistory(tabId, entry)` — `[entry, ...history.filter(h => h.sql !== entry.sql)].slice(0, SQL_HISTORY_MAX)` where `SQL_HISTORY_MAX = 20` (`state.ts:28`); re-running an identical statement moves it to the front (dedup).
- `openSqlTab()` / `openSqlTabWith(sql)` — append a fresh `Query N` SQL tab and focus it; the latter seeds the buffer (palette / "open in tab").
- All SQL mutations route through `patchSqlTab`, a no-op on non-SQL tabs.

**Saved-queries store** — `src/features/saved_queries/state.ts` (zustand, **one global instance**, holds ALL queries regardless of attachment; does no attachment filtering):

- `savedQueries: SavedQuery[]`, `loaded: boolean`, `loadError: string | null`.
- `load()` — idempotent (a settled load short-circuits, so every tab mount / palette open can call it freely). Structured `AppError` (corrupt file) → empty list + `loadError`; non-Tauri (browser dev) → empty list, no error.
- `save(input)` — **backend-first**, then patch the in-memory list from the backend reply (the JSON store is source of truth — never optimistic). Returns the stored value.
- `remove(id)` — backend-first delete, then filter out locally.
- `selectQueriesForConnection(queries, connectionId)` — pure selector returning every global query plus those whose `connectionId` matches `workspace.saved.id`.

### API — typed invoke wrappers

`src/features/saved_queries/api.ts` (mirrors the Rust wire type; cross-feature consumption of another slice's `api.ts`/`state.ts` is sanctioned):

- `interface SavedQuery { id; name; sql; savedAt; connectionId?: string | null }` and `interface SavedQueryInput { id?; name; sql; connectionId?: string | null }`.
- `savedQueryList(): Promise<SavedQuery[]>` → `invoke("saved_query_list")`.
- `savedQuerySave(query): Promise<SavedQuery>` → `invoke("saved_query_save", { query: { id: id ?? "", name, sql, savedAt: 0, connectionId: connectionId ?? null } })`. `savedAt` is filled by the backend, so a fresh save sends 0.
- `savedQueryDelete(id): Promise<void>` → `invoke("saved_query_delete", { id })`.

Execution wrapper — `src/shared/api/engine.ts:440`: `queryRun(handleId, sql, options?): Promise<QueryResult>` → `invoke("query_run", { handleId, sql, options })`.

### Components

**`SqlEditorTab`** (`src/features/workspaces/components/SqlEditorTab.tsx`) — the host. Layout: toolbar, editor wrap, results area.

- **Toolbar** (`.sql-toolbar`): **Run** button (`play_arrow`, filled, "Running…" while busy, disabled when running or buffer is blank); an **Explain** toggle (`account_tree`, flips the results area to the execution-order teaching panel — `ExecutionMinimap`/`ExplainPanel`); the `⌘↩ / Ctrl+Enter` hint; **snippet chips**; a flex spacer; then three popover `IconBtn`s — **save** (`bookmark_add`), **saved list** (`bookmarks`), **history** (`history`). Only one popover open at a time (`pop: "save" | "saved" | "history" | null`); outside-click / Esc closes it.
- **`run()`** — trims the buffer, ignores empty/while-running, calls `queryRun(workspace.handleId, sql, { schema: schemaName })`. On success → `setSqlResult` + `pushSqlHistory({ sql, ok:true, rowCount, ranAt })`; on failure → `setSqlError(appErrorMessage(err, "Query failed."))` + `pushSqlHistory({ sql, ok:false, error, ranAt })`. `running` toggles in `finally`. `schemaName` = the workspace's active schema (sidebar switcher), falling back to the first schema (SQLite: `"main"`).
- **`load(sql)`** — `setSqlText` + close popover; used by snippet chips, saved-list rows, and history rows.
- **`doSave()`** — name defaults to "Untitled query"; `connectionId = attach ? workspace.saved.id : null`; calls the store `save`, toasts `Saved "…" — attached to this workspace` or `… — shared across all workspaces`, resets the form, closes the popover; failure toasts the §5 message.

**`SqlCodeEditor`** (`src/features/workspaces/components/SqlCodeEditor.tsx`) — CodeMirror 6, mounted imperatively (one `EditorView` per mount in a layout effect; latest callbacks held in refs so the view is not re-created on parent renders). External `value` changes (snippet/history/saved load) are reconciled by a dispatched transaction, guarded by an equality check so typing doesn't trigger a redundant cursor-resetting dispatch.

- **Highlight palette** (`HighlightStyle` on lezer tags, §3.7): keyword/operatorKeyword/modifier → `var(--accent)` weight 500; string → `#e5c07b`; number/bool/null → `#7fb8e8`; function/standard-name → `#c678dd`; comments → `var(--text-faint)` italic.
- **Theme** (`EditorView.theme`, dark): transparent over `--bg0`, `--mono` 13px / line-height 1.65, content padding `12px 0`, line padding `0 16px`, accent caret, selection `color-mix(--accent 24%)`, no gutters, no `outline` on focus, no line wrapping (long lines scroll horizontally).
- **Keymap**: `Mod-Enter` runs (own keymap, wins over defaults); `indentWithTab` + `EditorState.tabSize.of(2)` + `indentUnit.of("  ")` make **Tab insert 2 spaces**; `history()` + `historyKeymap` give undo/redo; `bracketMatching()`, `drawSelection()`.

**Snippet chips** (`.snippet-chip`, `SQL_SNIPPETS` in `SqlEditorTab.tsx:43`) — per-engine starters; the shipped set is SQLite-appropriate: `list tables` (`sqlite_master`), `table columns` (`pragma_table_info`), `row counts` (`COUNT(*)`), `recent rows` (`ORDER BY rowid DESC LIMIT 50`). Clicking loads the snippet into the editor.

**Results area** (`.sql-results`) — four states:

1. **Explain** view (when toggled) — a back-to-Results tab strip + `ExplainPanel`.
2. **Error** (`.sql-error`, `role="alert"`) — red card: `error` icon + "Query failed" title + the mono driver message (§5).
3. **Result** — a status bar (`.sql-result-bar`): `check_circle` + either `Query OK` (no columns) or `N row(s)` + optional `(truncated)`, then `· {elapsedMs} ms · {schemaName}`. Body: nothing for non-row results; "Query returned no rows" placeholder for an empty SELECT; otherwise `<SqlResultGrid result={result} />`.
4. **Empty** — `terminal` icon + "Run a query to see results — try a snippet above".

**Save popover** (`.editor-pop.save-pop`) — title, name input (autofocus, Enter saves), an **"Attach to this workspace"** checkbox, a note (`Only visible in {workspace.name}` vs `Shared across all workspaces`), Save button.

**Saved-query list popover** (`.editor-pop.history-pop`, `role="menu"`) — title "Saved queries"; empty state prompts to use `bookmark_add`; otherwise `selectQueriesForConnection(savedQueries, workspace.saved.id)` rows: `bookmark` icon (accent), name, SQL preview (collapsed/truncated to 30 chars), a scope tag (`this workspace` / `global`), and a delete button (stops propagation; row click loads the SQL). Mounts trigger `loadSaved()` once.

**History popover** (`.editor-pop.history-pop`) — "Recent queries · this tab"; rows show `check`/`close` (accent / `#e06c75`) + SQL preview (64 chars) + `N rows` on success; click reloads the SQL into the editor.

**Command-palette integration** (`src/features/workspaces/components/CommandPalette.tsx`) — ⌘K. It calls `loadSaved()` and maps `selectQueriesForConnection(savedQueries, workspace.saved.id)` into commands `{ icon: "bookmark", label: q.name, hint: "saved query", run: () => openSqlTabWith(q.sql) }`, so selecting a saved query opens a new SQL tab seeded with it.

### Styling — §3.7 palette + layout

`src/features/workspaces/components/SqlEditorTab.css` (ported byte-identical from the prototype `ByteTable.html`, plus the two real-code additions `.save-pop-attach` and `.saved-scope`):

- `.sql-toolbar`: `padding: 8px 12px`, `border-bottom: 1px solid var(--border)`.
- `.sql-hint`: `10.5px`, `var(--text-faint)`.
- `.snippet-chip`: pill (`border-radius: 99px`), `var(--mono)` 10.5px, `var(--text-dim)` on `--bg2` with `--border`, `padding: 3px 10px`; hover → accent text + accent@50% border.
- `.sql-editor-wrap`: `height: 38%`, `min-height: 110px`.
- `.sql-result-bar`: `padding: 6px 14px`, `var(--mono)` 11px, `var(--text-dim)`, bottom border; `.dim` spans `var(--text-faint)`.
- `.sql-error`: `padding: 13px 15px`, `border-radius: 10px`, `background: #e06c7512`, `border: 1px solid #e06c7540`, `color: #e06c75`; `.sql-error-title` 12.5px 600; `.sql-error-msg` mono 11.5px, `color-mix(#e06c75 80%, --text)`.
- `.history-pop`: `--bg2` card, `--border`, `border-radius: 10px`, `max-height: 300px`, `padding: 6px`; `.history-pop-title` 10px 600 uppercase `--text-faint`.

## Shared data contracts

| concept       | Rust (`src-tauri`)                                                                                                                                  | TS (`src`)                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved query   | `domain::SavedQuery { id, name, sql, saved_at: u64, connection_id: Option<String> }` (camelCase wire; `connectionId` omitted when `None`)           | `api.ts SavedQuery { id; name; sql; savedAt: number; connectionId?: string \| null }`                                                                     |
| Save input    | `query: SavedQuery` (id `""` = new)                                                                                                                 | `api.ts SavedQueryInput { id?; name; sql; connectionId?: string \| null }`                                                                                |
| Run request   | `query_run(handle_id, sql, options: Option<QueryOptions>)`; `QueryOptions { row_limit: usize (default 500, clamp 10_000), schema: Option<String> }` | `queryRun(handleId, sql, options?)`; `QueryOptions { rowLimit?: number; schema?: string }`                                                                |
| Run result    | `engine::QueryResult { columns: Vec<ColumnMeta>, rows: Vec<Vec<Value>>, row_count, truncated, elapsed_ms }`; `ColumnMeta { name, type_hint }`       | `engine.ts QueryResult { columns: ColumnMeta[]; rows: CellValue[][]; rowCount; truncated; elapsedMs }`; `CellValue = string \| number \| boolean \| null` |
| History entry | — (renderer-only)                                                                                                                                   | `types.ts SqlHistoryEntry { sql; ok; rowCount?; error?; ranAt }`                                                                                          |
| Error card §5 | `AppError { Io \| Serialization \| NotFound \| Invalid }` with kind tags `io/serialization/notFound/invalid` (`shared/error.rs`)                    | rendered via `appErrorMessage(err, fallback)` into `.sql-error`                                                                                           |

Cell JSON mapping (engine adapter): NULL→null, int/real→number, text→string; integers beyond ±2^53→string (precision). Postgres `boolean`→JS bool (since M12) drives green/red rendering; SQLite never emits a bool.

## Behavior & edge cases

- **Multiple SQL tabs survive a workspace switch.** Each tab's `text`/`result`/`error`/`history` lives on the tab object in the workspace `ui`, so switching away and back restores buffer, last result, and history. `running` does not survive (the tab unmounts).
- **Save in A → load in B.** The saved-query store is global and persisted to one JSON file; a save with no attachment (`connectionId = null`) is visible from every workspace's list popover and palette. Attaching (`connectionId = workspace.saved.id`) scopes it to that connection's workspaces only.
- **History click restores.** Clicking a history (or saved, or snippet) row dispatches `setSqlText`, which the editor reconciles into the CodeMirror doc.
- **History dedup + cap.** Re-running identical SQL moves it to the front; the list never exceeds 20.
- **Error → red card.** A failed `queryRun` sets `error` (clearing `result`) and renders the §5 `.sql-error` card with the driver message; the failure is also recorded in history (`ok:false`).
- **Non-SELECT / write statements** return a column-less `QueryResult` → status shows "Query OK · X ms · schema" (no grid).
- **Truncation.** `row_limit` (default 500, max 10_000) cuts results short; `truncated` surfaces a `(truncated)` tag in the status bar.
- **Blank save.** A blank name defaults to "Untitled query" in the UI; the backend independently rejects blank name then blank SQL with §5 `Invalid` messages.
- **Corrupt store file.** `load()` surfaces `loadError` rather than presenting a false empty list; the file is never overwritten until it parses again.
- **Browser dev (no Tauri).** `load()` degrades to an empty list with no error.

## Acceptance criteria

- Running real SELECTs against the live DB shows the status row (`N rows · X ms · schema`) and the virtualized grid; non-row statements show "Query OK".
- ⌘↩ / Ctrl+Enter runs; Tab inserts two spaces; SQL keywords/strings/numbers/functions/comments are highlighted per §3.7.
- Snippet chips load their SQL into the editor.
- Saving a query in workspace A and reopening workspace B shows it in the saved-list popover and the ⌘K palette; selecting it from the palette opens a new SQL tab seeded with the query.
- The attach toggle scopes a query to the current workspace (hidden from others); unchecked stays global.
- A failing query renders the red §5 error card with the driver message and is added to history as a failure.
- Per-tab history is newest-first, deduped by SQL, capped at 20; clicking an entry restores its SQL.
- Opening several SQL tabs across two workspaces and switching back and forth preserves each tab's buffer, last result, and history.
- Deleting a saved query removes it everywhere; deleting an unknown id surfaces a §5 NotFound (not a silent success).

## Pixel / UX checklist

- Editor area is **38% of the tab height, min 110px**; transparent over `--bg0`; mono 13px / line-height 1.65; accent caret; selection accent@24%; no gutters; long lines scroll horizontally (no wrap).
- Snippet chips are pills (radius 99), mono 10.5px, `--bg2`/`--border`, padding `3px 10px`; hover → accent text + accent@50% border.
- `⌘↩ / Ctrl+Enter` hint is 10.5px `--text-faint`.
- Result status bar: mono 11px `--text-dim`, padding `6px 14px`, bottom border; `check_circle` accent icon; `·`-separated dim metadata; `(truncated)` dim.
- Error card: radius 10, bg `#e06c7512`, border `#e06c7540`, color `#e06c75`; title 12.5px 600 "Query failed"; message mono 11.5px `color-mix(#e06c75 80%, --text)`.
- Popovers: `--bg2` card, `--border`, radius 10, max-height 300px, padding 6; section title 10px 600 uppercase `--text-faint`.
- Save popover: name input autofocus, Enter saves; attach checkbox row + note line; Save button right-aligned.
- Saved-list rows: accent `bookmark` icon, name, mono SQL preview, `this workspace`/`global` scope tag, hover-revealed delete; empty state prompts `bookmark_add`.
- History rows: `check` (accent) / `close` (`#e06c75`) icon, 64-char SQL preview, `N rows` on success; empty state "Nothing yet — run a query".
- Result-grid cells match the browse grid (`CellContent`): NULL italic faint, numbers right-aligned `#7fb8e8`, booleans green/red, enum pills, density-tracked row height.
