# M3 — Sidebar: introspection, schema switcher, refresh

Status: shipped, merged on `main` (`feat: M3 — sidebar: introspection`).

> **Provenance.** This spec documents the *shipped* M3 surface as it exists in the repo today (the sidebar later absorbed M7/M11/M15 additions — structure mode, truncate, import/export, drop-schema — which are flagged inline and are NOT part of M3 proper). Source of truth is the code, not the prototype. Every "must / required" sentence below is a build requirement; descriptive prose ("the prototype keeps…") is rationale. Design intent: handoff `MILESTONES.md` §M3 + `DESIGN_SPEC.md` §3.3. Rebuild target: a code generator could reproduce M3 from this file plus the cited paths.
>
> **Slice-shape note (load-bearing).** M3 introspection is split across two backend features by deliberate design (see `src-tauri/src/features/introspection/mod.rs`):
> - The **new** introspection surface (`table_meta`, column lists for the expandable rows) lives in `features::introspection`.
> - The **table list** (`connection_tables`) and **schema list** (`connection_schemas`) predate the introspection slice and still live in `features::connections`; the renderer already depends on those command names, so consolidating them is *deferred* (the `mod.rs` doc says so explicitly). Do not move them as part of M3.
> - On the renderer there is **no** `src/features/introspection/api.ts`. The introspection slice is renderer-state-only: `src/features/introspection/state.ts` (a zustand cache). Its typed invoke wrappers are borrowed — `tableMeta` from `src/shared/api/engine.ts`, `connectionTables`/`connectionSchemas` from `src/features/connections/api.ts`.
> - The **Sidebar component** lives at `src/features/workspaces/components/Sidebar.tsx` (it composes workspace identity + the introspection cache), NOT under `src/features/introspection/`. Structural sidebar UI state (selected schema, expanded tables) is persisted on `workspace.ui`; search text + open popovers are transient local state.

## Goal

The full left sidebar per DESIGN_SPEC §3.3, backed by **real** SQLite introspection: a workspace header, a schema switcher popover, a refresh control, a searchable table list with live row counts, inline-expandable column lists (pk/fk icons + type labels), and a per-table context menu. Switching workspaces must preserve each workspace's selected schema and expanded-table set; switching back must re-render instantly from cache.

## Dependencies — M0–M2

- **M0** — design system: `--bg*`/`--text*`/`--accent` tokens, `EngineBadge`, `Icon`, `IconBtn`, `Btn`, `useToast`/`toastContext`, `ENV_COLOR`/`envColors`, `@keyframes spin` (defined in `ConnectScreen.css`, same bundle).
- **M1** — workspace rail + connect screen: the workspace shell and the `Workspace` model the sidebar reads (`workspace.saved`, `workspace.color`, `workspace.name`, `workspace.handleId`, `workspace.schemas`, `workspace.ui`).
- **M2** — SQLite connections + the engine seam: `ConnectionManager` (owns open handles by `ConnectionHandleId`), `EngineConnection` port (`list_schemas` / `list_tables` / `table_meta`), the SQLite adapter, the shared DTOs (`SchemaInfo` / `TableInfo` / `TableMeta` / `ColumnInfo` / `FkRef`), and the `connection_schemas` / `connection_tables` commands. M3 adds the `table_meta` command + the renderer sidebar on top of this; it adds no new engine methods.

## Backend (Rust core)

### Domain — table/column/schema introspection types

All introspection DTOs are shared across every slice that talks to a connection, so they live in `src-tauri/src/shared/engine.rs` (NOT in a per-slice `domain/`). The introspection slice deliberately has no domain or infrastructure of its own (`features/introspection/mod.rs`). The M3-relevant types (all `#[serde(rename_all = "camelCase")]`):

- `SchemaInfo { name: String, table_count: Option<u64> }` — wire `tableCount`. SQLite: `main` + attached databases.
- `TableInfo { name: String, approx_row_count: Option<u64> }` — wire `approxRowCount`. For SQLite this is an exact `count(*)`; `Option` so a huge schema can skip counting (see ceiling below).
- `TableMeta { columns: Vec<ColumnInfo>, comment, indexes, foreign_keys, referenced_by, ddl }` — M3 reads only `columns`; the rest is additive M7 §3.6 surface. `#[derive(Default)]` so fakes build `TableMeta { columns, ..Default::default() }`.
- `ColumnInfo { name, data_type, nullable, pk, default_value (wire "default"), fk: Option<FkRef> }`. M3 sidebar reads `name`, `data_type` (display label only, may be empty), `pk`, `fk`.
- `FkRef { table: String, column: String }`.

### Ports — `EngineConnection` introspection methods

There is **no** standalone `SchemaReader` trait. The M2 note in `engine.rs` records that the original `SchemaReader`/`QueryExecutor` stubs were folded into one port, [`EngineConnection`] in `src-tauri/src/shared/engine.rs`, because introspection and query execution are both operations *on an open connection*. The async-commands rule applies: the trait is `#[async_trait]` and every DB-touching command is `async fn`. M3 uses three methods:

```rust
#[async_trait]
pub trait EngineConnection: Send + Sync {
    fn engine_info(&self) -> EngineInfo;
    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError>;
    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError>;
    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError>;
    // … run_query / fetch_rows / etc. are later milestones …
}
```

`table_meta` on an unknown table is a §5 human error ("Table 'x' does not exist. Available tables: …"). Open handles are owned by `features::connections::application::ConnectionManager`; the SQL accessor is `manager.get_sql(handle).await?` (returns a `NotFound` "closed" error for a stale handle, and a §5 "not available for this engine" on a SQL/KV kind mismatch).

### Application — list tables (+ row counts), list schemas, refresh

Two slices, one composition rule (`domain ← application ← {infrastructure | commands}`):

- **`features::introspection::application::get_table_meta`** (`src-tauri/src/features/introspection/application.rs`):
  ```rust
  pub async fn get_table_meta(
      manager: &ConnectionManager, handle: &ConnectionHandleId,
      schema: &str, table: &str,
  ) -> Result<TableMeta, AppError> {
      manager.get_sql(handle).await?.table_meta(schema, table).await
  }
  ```
  This is sanctioned cross-feature composition: the introspection slice consumes the connections feature's *public application API* (`ConnectionManager`) at its own application layer.

- **`features::connections::application::connection_schemas` / `connection_tables`** (`src-tauri/src/features/connections/application/mod.rs`):
  ```rust
  pub async fn connection_schemas(manager, handle) -> Result<Vec<SchemaInfo>, AppError> {
      manager.get_sql(handle).await?.list_schemas().await
  }
  pub async fn connection_tables(manager, handle, schema) -> Result<Vec<TableInfo>, AppError> {
      manager.get_sql(handle).await?.list_tables(schema).await
  }
  ```

- **Refresh** has no backend use-case: it is a *renderer* operation that force-refetches `connection_schemas` + `connection_tables` (see Frontend). There is no `refresh_schema` command.

### Infrastructure — engine-specific introspection (SQLite at M3)

All engine SQL lives in `src-tauri/src/engines/sqlite/mod.rs` behind the port. The driver is `rusqlite` (sync, `!Sync`): the adapter wraps the `Connection` in `Arc<Mutex<…>>` and hops every operation through `spawn_blocking`.

- **`list_schemas` → `list_schemas_blocking`**: `PRAGMA database_list` for the names (`main` + attached), then a best-effort `count_tables` per schema:
  ```sql
  SELECT count(*) FROM {schema}.sqlite_schema
  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  ```
  A count failure (e.g. a detach race) downgrades that schema's `table_count` to `None` rather than failing the whole listing.

- **`list_tables` → `list_tables_blocking`**: `ensure_schema_exists` first (a §5 "Schema 'x' does not exist. Available schemas: …" on a miss), then:
  ```sql
  SELECT name FROM {schema}.sqlite_schema
  WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  ```
  Tables come back **sorted by name**. Per table, an exact row count `SELECT count(*) FROM {schema}.{table}` — but **only for the first `MAX_COUNTED_TABLES` (= 200) tables**; the rest get `approx_row_count: None`. This caps introspection cost on huge schemas. A failed individual count is `None`, not a failed listing. All identifiers are quoted via `quote_ident`.

- **`table_meta` → `table_meta_blocking`**: `ensure_schema_exists`, then prove the table exists (`PRAGMA table_info` returns zero rows for an unknown table instead of erroring, so existence is checked against `sqlite_schema` first to emit the §5 message), then `PRAGMA table_info` for columns (+ `foreign_key_list`/`index_list`/DDL for the M7 fields).

**Multi-engine note (deferred to M12).** Only the SQLite adapter ships at M3. `engines/mysql` and `engines/postgres` exist in the tree but their introspection is M12 work; the schema switcher's multi-schema branch is likewise a placeholder until then (SQLite is `main` + attached only). The port shape does not change for M12 — only new adapters implement the same three methods.

### Tauri commands

Registered in `src-tauri/src/lib.rs` via `tauri::generate_handler![…]`. All `async fn`, all return `Result<T, AppError>` (AppError serializes to the §5 error envelope the renderer's `appErrorMessage` reads).

| command | feature / file | args | returns | errors |
|---|---|---|---|---|
| `connection_schemas` | connections `commands.rs` | `handleId: ConnectionHandleId` | `Vec<SchemaInfo>` | `NotFound` (closed handle), `Unsupported` (KV engine), `Database` |
| `connection_tables` | connections `commands.rs` | `handleId`, `schema: String` | `Vec<TableInfo>` | as above + `Database` "Schema 'x' does not exist…" |
| `table_meta` | introspection `commands.rs` | `handleId`, `schema: String`, `table: String` | `TableMeta` | as above + `Database` "Table 'x' does not exist. Available tables: …" |

`table_meta` handler (the whole slice's presentation layer):
```rust
#[tauri::command]
pub async fn table_meta(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId, schema: String, table: String,
) -> Result<TableMeta, AppError> {
    application::get_table_meta(state.manager(), &handle_id, &schema, &table).await
}
```
Note it reads the *connections* feature's managed `ConnectionsState` for the handle manager — sanctioned cross-feature composition at the command boundary (the introspection slice registers no state of its own).

## Frontend (React)

### State — the introspection cache (`src/features/introspection/state.ts`)

A zustand store, `useIntrospectionStore`, that caches what the backend returned. It lives **outside** the workspaces store on purpose, so it survives workspace switches; it is invalidated explicitly. Keys use a NUL (` `) separator (cannot appear in a UUID handle id or in identifiers, so keys never collide):

- `tablesKey(handleId, schema)` → `TablesEntry { tables: TableInfo[], fetchedAt: number }`
- `columnsKey(handleId, schema, table)` → `ColumnsEntry { columns: ColumnInfo[], fetchedAt }`
- `tableMetaKey(handleId, schema, table)` → `TableMetaEntry` (M7 §3.6; `meta` suffix; shares `loading`/`errors` maps)

Maps: `tables`, `columns`, `tableMetas`, `loading: Record<string, boolean>`, `errors: Record<string, string>`.

Actions:
- `loadTables(handleId, schema, { force? })` → `Promise<TableInfo[] | null>`. Cache-first; `force` refetches and overwrites, and on a *successful forced* refetch **drops that schema's cached column lists + table metas** (`omitPrefixed(columns, tablesKey + SEP)`) — refresh exists to pick up out-of-band DDL, which affects columns as much as tables; expanded rows refetch lazily. Never rejects: on failure resolves `null` and writes `errors[tablesKey]`. De-duped via a module-local `inflightTables` map (handles StrictMode's doubled effects).
- `loadColumns(handleId, schema, table)` → `Promise<ColumnInfo[] | null>`. Cache-first; calls `tableMeta(...)` and stores `meta.columns`. Same null-on-failure contract; de-duped via `inflightColumns`.
- `loadTableMeta(...)` (M7) — warms the `columns` cache from the same payload.
- `invalidate(handleId, schema?)` — drops everything under the handle (workspace closed) or under one schema prefix. Used by `closeWorkspace`.

**Per-workspace structural state** lives on `workspace.ui` (in `src/features/workspaces/state.ts` / `types.ts`, `WorkspaceUiState`): `schemaName?: string` and `expandedTables?: string[]`, mutated via `patchWorkspaceUi(id, patch)`. The schema list itself is `workspace.schemas: SchemaInfo[]`, replaced by `setWorkspaceSchemas(id, schemas)` after a refresh. Search text and open-popover booleans are transient `useState` in the component (and reset when App re-keys the sidebar by workspace id).

### API — typed invoke wrappers

No introspection-specific api.ts. The sidebar imports:
- `tableMeta(handleId, schema, table): Promise<TableMeta>` — `src/shared/api/engine.ts` → `invoke("table_meta", { handleId, schema, table })`.
- `connectionTables(handleId, schema): Promise<TableInfo[]>` — `src/features/connections/api.ts` → `invoke("connection_tables", { handleId, schema })`.
- `connectionSchemas(handleId): Promise<SchemaInfo[]>` — `src/features/connections/api.ts` → `invoke("connection_schemas", { handleId })`.

### Components — `Sidebar` (`src/features/workspaces/components/Sidebar.tsx`)

One component renders the whole §3.3 sidebar. Structure (top → bottom):

1. **Workspace header** (`.sidebar-conn`): 3px `.ws-color-bar` (workspace color) · `EngineBadge size={26}` · name + `.env-dot` (color = `ENV_COLOR[normalizeEnv(env)]`) · detail line via `connectionDetail(params)` with a leading `vpn_lock` tunnel icon when `connectionIsTunneled(params)` (M12; SQLite never tunnels) · `power_settings_new` IconBtn → `closeWorkspace`.
2. **Schema row** (`.schema-row`): `.schema-btn` (`schema` icon accent + `schemaName` mono + `expand_more` chevron, `aria-haspopup="menu"`) toggling `.schema-pop`; a `hub` IconBtn → `openMapTab` (schema map); a `sync` IconBtn → `refresh()`, getting class `sidebar-sync-spinning` while `refreshing`. (Shipped also carries a `download` schema-export IconBtn — M15, not M3.)
   - **Schema switcher popover** (`.schema-pop`, `role="menu"`): one `role="menuitemradio"` button per `workspace.schemas`, `aria-checked` on the active one, with a trailing `.schema-pop-count` = `schemaTableCount(s)` (live cache count first: `tablesMap[tablesKey(handle, s.name)]?.tables.length`, else `s.tableCount`, else `—`). Click → `setSchema(name)` = `patchWorkspaceUi(id, { schemaName })` + close + refocus the button. Roving arrow-key nav via `onMenuKeyDown`.
3. **Search** (`.sidebar-search`): `search` icon + input `placeholder="Filter tables…"`, controlled by local `query`; a `close` IconBtn clears it when non-empty. Filtering is case-insensitive substring on `t.name` (`query.trim().toLowerCase()`).
4. **Section label** (`.sidebar-section-label`): `TABLES` + `.sidebar-count` = `tables.length`. (Shipped also has the M15 `.sec-actions` three-dot menu here — import/export/drop-schema — not M3.)
5. **Table list** (`.sidebar-tables`): four states — error (`tablesError` && `tables === null` → `.sidebar-error`, a stale list keeps rendering instead), loading (`tables === null` → spinner + "Loading tables…"), empty schema (`.sidebar-nomatch` "No tables in this schema yet."), or the rows. Each row (`.table-item`, `role="button"`, `tabIndex={0}`):
   - `.table-expand` chevron button (`chevron_right`, `aria-expanded`, gets `.open`/rotate-90 when expanded) → `stopPropagation` + `toggleExpanded(name)`.
   - `table` icon (accent when active, faint otherwise).
   - `.table-item-name` (mono 12, dim; `--text`/500 when active).
   - `.table-item-count` = `rowCountLabel(t.approxRowCount)` → `count === null ? "—" : count.toLocaleString()`.
   - Row click → `openTableTab(schema, table)` (M4); Enter/Space same; Shift+F10 / ContextMenu key opens the context menu at the row; right-click → `openCtxMenu`. Active styling: a row is `.active` when the active tab is a table tab for the current schema+table (M4 wiring; M3 shipped the CSS with no active tab).
   - **Inline column list** (`.table-cols`, shown when expanded): for each `ColumnInfo` a `.table-col` with `.table-col-icon` (pk → `key` icon accent rotated 45°, else fk → `link` icon faint, else nothing), `.table-col-name` (mono 11), `.table-col-type` = `c.dataType.toLowerCase()` (mono 9.5 faint). While loading/erroring, a single `.table-col-note` shows `columnsError ?? "Loading…"`. Columns are fetched lazily by an effect that, for each expanded table present in the current list, calls `loadColumns` — and re-runs when refresh bumps the entry (so expanded rows re-introspect after a refresh).
   - "No tables match `query`" (`.sidebar-nomatch`) when the filter empties the list.
6. **Footer** (`.sidebar-footer`): full-width tonal `Btn icon="terminal"` "New SQL query" → `openSqlTab` (M6).

**Refresh behavior** (`refresh()` in `Sidebar.tsx`): guarded against re-entry (`if (refreshing) return`); sets `refreshing`, records `started = Date.now()`, then `Promise.all([connectionSchemas(handleId), loadTables(handleId, schemaName, { force: true })])`. On success: `setWorkspaceSchemas(id, schemas)` and `refreshed = fresh.length`. On failure: read `errors[tablesKey]` (or a fallback). **Then enforce a 750ms minimum spinner** (`await sleep(750 - elapsed)` if positive), clear `refreshing`, and toast — exact success copy `Schema "{schemaName}" refreshed — {N} tables` (`"ok"`), else the failure message (`"err"`). (Note the curly quotes `“”` around the schema name in the shipped string.)

**Context menu** (`.ctx-menu`, `role="menu"`, clamped into the viewport via `CTX_MENU_W`/`CTX_MENU_H`). The four M3 items:
- **Open data** (`table` icon) → `openTableTab(schema, table)` (M4).
- **View structure** (`account_tree` icon) → `openTableTab(schema, table, "structure")` — **stubbed for M3 / wired in M7**; in M3 it opened a data tab.
- **Query in SQL editor** (`terminal` icon) → `openSqlTab` — **stubbed for M3 / wired in M6**.
- **Show in schema map** (`hub` icon) → `openMapTab(schema)` — **stubbed for M3 / wired in M9**.

(Shipped also has M15 items below a separator — Export as CSV/SQL, Import data…, Truncate table… — and their modals. NOT M3.) The menu, the schema popover, and the schema-actions menu all close on outside-mousedown / Escape / window blur, returning focus to their opener.

### Styling — §3.3 layout

From `src/features/workspaces/components/Sidebar.css` (+ `Sidebar.css` is imported by the component):

- Sidebar **248px** wide (set on `.sidebar` / shell), `--bg1` column with right border.
- `.ws-color-bar` 3px workspace-color strip at the header's left edge.
- `.schema-pop`: `--bg2`, 1px border, radius 10, popover shadow `0 12px 32px rgba(0,0,0,.45)`, absolutely positioned `top: calc(100% + 4px)`, z-index 40. Items mono 12, dim; hover `--bg3`; active accent. `.schema-pop-count` mono 10 faint.
- `.sidebar-sync-spinning`: `animation: spin .7s linear infinite; color: var(--accent)` (the `@keyframes spin` is shared from `ConnectScreen.css`). This is the rotation; the **750ms minimum is enforced in JS** (the refresh function), independent of the CSS spin period.
- `.sidebar-search`: `--bg0` field, radius 8, border tints `--accent` on `:focus-within`.
- `.sidebar-section-label`: 10px 600 uppercase, letter-spacing .1em, faint; `.sidebar-count` mono.
- `.table-item`: flex, gap 8, padding 6px 8px, radius 7, `transition: background .1s`; hover `--bg2`; `.active` = `color-mix(--accent 12%, --bg2)` and its `.table-item-name` → `--text`/500.
- `.table-item-name` mono 12 dim ellipsized; `.table-item-count` mono 10 faint.
- `.table-expand` 16×16 r4 faint, `transition: transform .12s`, `.open` rotates 90°.
- `.table-cols` indented `padding: 1px 8px 5px 30px`; `.table-col` gap 6 padding 2.5px 6px r5 hover `--bg2`; `.table-col-icon` 13px slot; `.table-col-name` mono 11 dim; `.table-col-type` mono 9.5 faint.
- Toast copy (success): `Schema “{schema}” refreshed — {N} tables`.

## Shared data contracts — TS + Rust

Rust in `src-tauri/src/shared/engine.rs`; TS in `src/shared/api/engine.ts` (kept in lockstep; camelCase on the wire).

| Rust | TS | wire fields (M3-relevant) |
|---|---|---|
| `SchemaInfo` | `SchemaInfo` | `name: string`, `tableCount: number \| null` |
| `TableInfo` | `TableInfo` | `name: string`, `approxRowCount: number \| null` |
| `ColumnInfo` | `ColumnInfo` | `name`, `dataType`, `nullable`, `pk`, `default?` (null/absent), `fk: FkRef \| null` |
| `FkRef` | `FkRef` | `table: string`, `column: string` (`column` may be `""` for an unresolvable implicit fk) |
| `TableMeta` | `TableMeta` | `columns: ColumnInfo[]` (+ M7 fields `comment?`, `indexes`, `foreignKeys`, `referencedBy`, `ddl?`) |
| `Engine` | `Engine` | `"sqlite" \| "mysql" \| "postgres" \| "redis"` (lowercase) |

`AppError` serializes to the §5 envelope; the renderer turns it into a sentence via `appErrorMessage(err, fallback)` (`src/shared/api/error.ts`).

## Behavior & edge cases

- **Out-of-band rename surfaced by refresh.** A table renamed in another tool is invisible until **Refresh**, which `force`-refetches `connection_tables` (overwriting the cache) *and* `connection_schemas`, then `setWorkspaceSchemas`. The forced refetch drops the schema's cached column lists + table metas, so an expanded row picks up the new columns on its lazy refetch. Acceptance test: rename a table out-of-band → Refresh → it appears.
- **100-table perf / no jank.** Filtering is plain case-insensitive `includes` over the in-memory list (no per-keystroke I/O). Tables arrive pre-sorted by name from SQLite. The list is a simple scroll container (`.sidebar-tables { overflow-y: auto }`); column lists fetch lazily only for expanded rows. Whole-map zustand selects are fine because entries change only on rare fetch completions. Acceptance test: search + expansion on a 100-table DB without jank.
- **Row-count caching / the 200-table ceiling.** Counts are an exact `count(*)` per table, but only for the first **200** tables (`MAX_COUNTED_TABLES`); beyond that `approxRowCount` is `null` and the cell renders `—`. A failed individual count is `null`, not a failed listing. The TableInfo cache (`fetchedAt`) means counts are computed once per fetch and reused across workspace switches until a refresh forces a recompute.
- **Stale handle / wrong engine.** `manager.get_sql` returns a `NotFound` "closed" error for a dropped handle and an `Unsupported` "not available for this engine" error for a Redis (KV) connection — both surface as §5 sentences.
- **Dropped selected schema.** If a refresh removes the selected schema (out-of-band `DETACH`), `schemaName` falls back to `workspace.schemas[0]?.name` (or `"main"` for SQLite) rather than introspecting a ghost schema.
- **Empty / failed list.** Empty schema → "No tables in this schema yet."; failed first load with no cache → `.sidebar-error` sentence; a failed *refresh* keeps the stale list rendered and surfaces the error only via the toast.

## Acceptance criteria

1. Opening a real SQLite `.db` shows its actual tables in the sidebar, sorted by name, each with a live row count (or `—` past the 200-table ceiling / on count failure).
2. The schema button opens a popover listing every schema (`main` + attached) with table counts; selecting one re-introspects and persists on `workspace.ui.schemaName`.
3. Refresh: the sync icon spins for **≥750ms**, re-introspects schemas + tables (picking up out-of-band DDL incl. renames), and toasts `Schema “{schema}” refreshed — {N} tables`.
4. The search input filters the list case-insensitively with no I/O per keystroke; "No tables match …" shows when empty.
5. Expanding a row lazily loads and shows its columns with pk (rotated key, accent) / fk (link, faint) icons, mono names, and lowercased type labels; expanded state persists across workspace switches and re-introspects after a refresh.
6. The context menu offers Open data / View structure / Query in SQL editor / Show in schema map; in M3 the latter three are stubs (wired in M7 / M6 / M9 respectively).
7. Switching away and back to a workspace renders its sidebar instantly from cache with its own selected schema + expanded set intact.
8. Backend: `connection_schemas`, `connection_tables`, `table_meta` are registered async commands returning the documented DTOs and §5 errors; a closed handle is a `NotFound` "closed" error.

## Pixel / UX checklist

- Sidebar 248px; header 3px workspace-color bar; `EngineBadge` 26px; env dot colored by environment.
- Schema button: `schema` icon accent + name in mono + `expand_more` chevron; popover `--bg2` r10 shadow `0 12px 32px rgba(0,0,0,.45)`, active item accent + `aria-checked`, trailing count mono 10 faint (`—` when unknown).
- Refresh icon `sync`; spins via `spin .7s linear infinite` + accent tint while refreshing; **750ms minimum** enforced in JS.
- Search field `--bg0` r8, accent border on focus, "Filter tables…" placeholder, clearable.
- Section label `TABLES` 10px/600 uppercase tracking .1em faint + mono count.
- Table row r7, padding 6px 8px, hover `--bg2`, active = accent@12% tint with `--text`/500 name; `table` icon faint→accent when active; name mono 12 ellipsized; count mono 10 faint right-aligned, `toLocaleString()` formatted.
- Expand chevron 16×16 r4, rotates 90° when open.
- Column rows indented 30px; pk = `key` icon accent rotated 45°; fk = `link` icon faint; name mono 11; type mono 9.5 faint, lowercased.
- Footer: full-width tonal "New SQL query" button (`terminal` icon).
- Toast success copy verbatim (curly quotes): `Schema “{schema}” refreshed — {N} tables`.
