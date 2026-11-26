# ADR-0032 — Object explorer and non-table database objects

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-26 (first commit that shipped the feature)
- **Area:** Schema
- **Related:** ADR-0003, ADR-0006, ADR-0007, ADR-0018, ADR-0028, `docs/M22-object-explorer.md`, `docs/superpowers/plans/2026-06-25-sql-db-objects.md`

## Context

Tables were the only thing the sidebar showed. Real schemas also hold views,
materialized views, functions, procedures and triggers, sometimes hundreds of them.
Engines differ in which of these exist (SQLite has views and triggers only; MySQL has
no materialized views; ClickHouse has no procedures or triggers), and routine and
trigger bodies contain `$$…$$` dollar quoting or `BEGIN…END` blocks that the app's
`;`-splitting script path cannot handle (the plan cites the
`shared/engine.rs::count_statements` doc for this).

The work shipped in two steps: the object layer (sidebar groups, DDL viewer, drop,
edit-via-SQL-editor) on 2026-06-26 in `59d3dbf`, and the M22 Object Explorer grid tab
on 2026-07-09 in `1913669`.

## Decision

- **Every non-table object is a named object with a `CREATE` DDL body.** The wire
  types `DbObjectKind` (`view | materialized_view | function | procedure | trigger`),
  `DbObjectInfo` and `DbObjectDefinition` live next to the other engine types and are
  mirrored in `src/shared/api/engine.ts`. `src/features/db_objects/api.ts` re-exports
  them so the slice imports from itself.
- **Four introspection commands** in `src-tauri/src/features/introspection/commands.rs`:
  `list_objects(handle, schema, kind)`, `object_definition(…, name, detail)`,
  `drop_object(…)` and `run_object_ddl(handle, statements: Vec<String>)`. The last two
  call `ensure_writable` first (ADR-0006). `detail` carries the trigger's table or a
  Postgres routine's identity args, so a precise `DROP` can be built for overloaded
  functions.
- **Whole-statement execution.** `run_object_ddl` hands each string to
  `run_statements` verbatim, with no splitting. The renderer owns the statement list.
- **Per-engine catalog code** sits in `src-tauri/src/engines/<engine>/objects.rs`
  (Postgres, MySQL, SQLite, then MSSQL and ClickHouse). An engine/kind pair it does
  not support returns an empty list. The renderer's capability table is
  `ENGINE_OBJECTS` in `src/features/db_objects/kinds.ts`. The non-SQL engines map to
  `[]`.
- **Editing goes through the SQL editor, not a dedicated editor tab.**
  `ObjectViewer.tsx` shows the DDL read-only. "Edit" calls `openSqlTabWith(editableObjectDDL(…))`
  (`src/features/db_objects/ddl.ts`), which keeps `CREATE OR REPLACE` where
  `hasOrReplace` says the dialect has it and otherwise puts a `dropPrefix` `DROP …`
  in front. New objects open `newObjectTemplate(engine, kind)`. The plan's
  `ObjectEditor.tsx` was never built.
- **Viewer actions**: browse-as-rows for views and materialized views (`browseSql`,
  `isBrowsable`), Postgres `REFRESH MATERIALIZED VIEW` via `runObjectDdl`, copy DDL,
  and drop through `ObjectDropModal` with a production gate.
- **Caching**: object lists and definitions are cached in
  `src/features/introspection/state.ts` (`loadObjects`, `loadObjectDefinition`,
  `invalidateObjects`). See ADR-0028.
- **M22 Object Explorer** (`ObjectExplorer.tsx`, tab kind `objexplorer`, one tab per
  schema):
  - Facet rail plus a sortable, filterable grid whose columns change per facet
    (`columnsFor`).
  - Multi-select Export DDL concatenates `object_definition` output into
    `<schema>_objects.sql`.
  - `BulkDropModal.tsx` requires typing `drop <N>` on production.
- **Enriched list rows instead of N definition fetches.** `DbObjectInfo` gained
  optional `#[serde(default)]` metadata (owner, returns, language, volatility, arg
  count, trigger timing/events/enabled, approx rows, size). One `list_objects` call
  fills the grid, and fields an engine cannot source render as `—`.
- **Sidebar escalation**: `SidebarObjectGroups.tsx` caps each section at `CAP = 12`.
  Past that it shows "Show all N in Explorer →". The section header has an "Explore
  all" button.

## Alternatives considered

- **Reuse `execute_script_text`** for object DDL. The plan rejected this because the
  `;` splitter corrupts dollar-quoted and `BEGIN…END` bodies.
- **A dedicated object-editor tab** (`ObjectEditor.tsx` in the plan). Not shipped.
  Opening the DDL in the existing SQL editor reuses its run, confirm and history
  machinery (ADR-0018, ADR-0019). The reason is inferred from the code.
- **Fetch each object's definition to fill the Explorer grid.** M22 rejected this as
  N round trips on a big schema and enriched the list row instead.
- **Show every object in the sidebar.** The cap of 12 plus escalation keeps the tree
  usable on large schemas (inferred).

## Consequences

- **Positive:**
  - One model covers five object kinds across five SQL engines.
  - Routine bodies are never re-parsed by the backend.
  - Adding a metadata column is additive and does not break older adapters.
- **Negative / trade-offs:**
  - Grid coverage is uneven. SQLite only gets trigger timing and events, parsed from
    the stored SQL by `parse_trigger_sql`, and MySQL has no volatility.
  - The frontend `dropPrefix` must stay in sync with the backend `drop_object_sql`.
  - Editing through the SQL editor means an alter is only as atomic as the
    statements the user runs.
  - Redis, DynamoDB, MongoDB, Cassandra and Typesense have no object catalog.
- **Follow-ups:**
  - Bulk drop runs `dropObject` one object at a time with no transaction, so a
    failure partway through leaves the earlier drops applied.
