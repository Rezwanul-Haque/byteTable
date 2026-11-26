# ADR-0028 — Introspection slice and renderer sidebar cache

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature: `69b123e feat(introspection): column-level table metadata for the M3 sidebar`)
- **Area:** Schema
- **Related:** ADR-0002, ADR-0003, ADR-0005, ADR-0006, ADR-0029, ADR-0032, ADR-0049, `docs/M3-sidebar-introspection.md`

## Context

The sidebar needs schema lists, table lists with row counts, and per-table column
lists (pk/fk icons, type labels). The same metadata feeds the structure view (ADR-0029),
the grid, and the object explorer (ADR-0032). Each fetch is a round-trip to a live
database, and users switch between workspaces often; re-introspecting on every switch
would make the sidebar blank and flicker. Engines also differ in what "schema" means
(SQLite: `main` + attached databases; MySQL/Postgres/ClickHouse: real schemas plus
server internals like `mysql`, `pg_catalog`).

## Decision

- **Thin Rust slice.** `src-tauri/src/features/introspection/` has only `application.rs`
  and `commands.rs` — no domain or infrastructure. The wire DTOs (`SchemaInfo`,
  `TableInfo`, `TableMeta`, `ColumnInfo`, `FkRef`) live in the shared engine port
  (`src-tauri/src/shared/ports/sql/`), and engine SQL lives in the adapters behind
  `EngineConnection` (ADR-0003). The slice composes the connections feature's
  `ConnectionManager` (`manager.get_sql(handle)`) at its application layer
  (`mod.rs` documents this as sanctioned cross-feature composition).
- **Commands.** `table_meta(handleId, schema, table)` is the M3 addition; the slice later
  gained `list_objects`, `object_definition`, `drop_object`, `run_object_ddl` (ADR-0032).
  The mutating two call `ensure_writable` first (ADR-0006). The older
  `connection_schemas` / `connection_tables` commands stay in
  `src-tauri/src/features/connections/commands.rs`; a code comment records that moving
  them is deferred because "the renderer already depends on their names".
- **Row-count ceiling.** The SQLite adapter counts exact rows only for the first
  `MAX_COUNTED_TABLES = 200` tables (`src-tauri/src/engines/sqlite/introspect.rs`); the
  rest get `approx_row_count: None`. Server engines report estimates (e.g. Postgres
  maps a negative estimate to `None`). Failed per-table counts degrade to `None`, not an
  error.
- **Renderer cache, no `api.ts`.** `src/features/introspection/state.ts` is a Zustand store
  that caches `tables`, `columns`, `tableMetas`, `objects`, `objectDefs` keyed by
  NUL-separated composite keys (`tablesKey`, `columnsKey`, `tableMetaKey`, `objectsKey`,
  `objectDefKey`). The store lives outside the workspaces store so it survives workspace
  switches. The invoke wrappers it uses are borrowed from `src/shared/api/engine.ts` and
  `src/features/connections/api.ts`.
- **Cache semantics.** Loads are cache-first; concurrent non-forced loads are de-duplicated
  through module-local in-flight promise maps. Loads never reject — they resolve `null` and
  put a human message in `errors[key]`. `loadTableMeta` also warms the `columns` cache
  from the same payload. A forced `loadTables` drops the schema's column/meta caches
  (prefix match) unless `keepColumnCaches` is set; the settings auto-refresh tick in
  `src/features/workspaces/components/Sidebar.tsx` passes `keepColumnCaches: true` so an
  open Structure view does not blank every tick (fix `6333272`). `invalidate(handleId,
  schema?)` drops everything under a handle when a workspace closes.
- **Where UI state lives.** The sidebar component is
  `src/features/workspaces/components/Sidebar.tsx`, not in the introspection slice.
  Selected schema and expanded tables (`expandedTables`) persist on `workspace.ui`;
  search text and popovers are local state.
- **Schema switcher and system schemas** (`ffcbd85`, 2026-08-17). `EngineConnection` gained
  `list_system_schemas()` (default: empty) alongside `list_schemas()`, which deliberately
  hides server internals. `connection_schemas` takes `includeSystem: Option<bool>`
  defaulting to `false`, and appends system schemas (`is_system: true`) only when asked.
  MySQL, Postgres, and ClickHouse implement it; the renderer's `SYSTEM_SCHEMA_ENGINES`
  set offers the toggle only for those. SQL Server keeps the default because its catalog
  is in the hidden Resource database (doc comment in `conn.rs`). The toggle is the
  `showSystemSchemas` setting (`src/features/settings/api.ts`, default `true`), flipped
  from the switcher itself or Settings. System schemas render in a separate group with a
  lock icon and are treated as no-write (`noWrites = schemaIsSystem || workspace.readOnly`);
  `delete_schema` in every adapter refuses them.

## Alternatives considered

- **Consolidate all introspection commands in the new slice now.** Rejected for M3 per the
  recorded comment: renaming would break existing renderer call sites. Left as debt.
- **A per-slice `domain/` for introspection DTOs.** Rejected (recorded in `mod.rs`): every
  slice that talks to a connection shares them, so they sit in the shared port.
- **Cache inside the workspaces store or React Query.** Not chosen. The recorded reason for
  a separate store is surviving workspace switches; avoiding another data-fetching library
  in favour of the existing Zustand pattern (ADR-0005) is inferred.
- **System schemas always mixed into the listing.** Rejected: the port doc says the default
  listing "stays user data only". The wire flag defaults to off so callers that do not ask
  (other slices) never see them.

## Consequences

- **Positive:** Switching back to a workspace renders its sidebar from cache instantly; one
  `table_meta` round-trip serves both the structure view and column lists; huge SQLite
  schemas do not run thousands of `count(*)`s.
- **Negative / trade-offs:** Introspection commands are split across two Rust slices.
  The cache has no TTL — staleness is handled only by manual refresh, the auto-refresh
  tick, and explicit invalidation after DDL. The setting is called "opt-in" in the commit
  title but ships defaulted on in the renderer; only the backend default is off.
- **Follow-ups:** Move `connection_schemas` / `connection_tables` into
  `features::introspection`. SQL Server and SQLite expose no system schemas.
