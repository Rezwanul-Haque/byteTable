# ADR-0033 — Schema diff: structure-only comparison with a planned migration

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-07-30 (first commit that shipped the feature)
- **Area:** Schema
- **Related:** ADR-0002, ADR-0006, ADR-0028, ADR-0029

## Context

Users run several environments (dev, staging, production) and need to see how their
table structures have drifted, then get the DDL that reconciles them. The headline
promise is "Structure only. Row data is never read, copied, or moved." The
two schemas usually live on two different saved connections, and often only one of
them is open as a workspace. The differ needs a column and index snapshot, which only
the SQL adapters provide. Shipped in `5941b13` ("feat: schema diff for sql engines").

## Decision

- **Rust slice `src-tauri/src/features/schema_diff/`**:
  - Domain: pure `diff` and `plan` in `domain/mod.rs`.
  - Port: `SchemaReader` in `ports.rs`.
  - Adapter: `EngineSchemaReader` in `infrastructure/mod.rs`.
  - Use cases: `application.rs`.
- **Structure-only is a property of the port.** `SchemaReader::read_schema` returns a
  `SchemaSnapshot` of base tables with their columns and indexes, and nothing more.
  The adapter reuses the existing `list_tables` and `table_meta` and adds no new
  driver SQL. Views and materialized views are excluded. The `table_meta` calls run
  one at a time on purpose, to avoid a burst of requests against a shared pool (code
  comment).
- **Three commands**:
  - `schema_snapshot(handle, schema)` reads one schema.
  - `schema_diff_compare(source, target, target_engine)` is pure and touches no
    database.
  - `schema_diff_apply(handle, schema, statements)` calls `ensure_writable` first,
    then joins the statements into one script for `execute_script`.
- **Snapshots round-trip through the renderer.** Swapping direction or re-picking a
  side calls `schema_diff_compare` again without re-reading either database.
  `diff(A,B)` and `diff(B,A)` are computed independently, so no inverse logic exists.
- **Diff rules** (`domain::diff`):
  - Table status is `New`, `Changed`, `OnlyTarget` or `Same`, sorted by rank with a
    stable sort.
  - Column marks are `+`, `~` (keeps the old type), `-` or `=`. Index marks are
    `+idx` and `-idx`.
  - Types are normalised by `norm` (uppercase, whitespace stripped).
  - Primary-key indexes are skipped.
- **Planner** (`domain::plan`): emits `MigrationStatement { id, kind, sql, table,
  destructive }` in the *target* engine's dialect. MySQL and PG/SQLite branch. Names
  are left unqualified because the script path scopes to the schema (`SET
  search_path` / `USE`). `destructive` marks DROP TABLE, DROP COLUMN and DROP INDEX;
  the renderer starts those unchecked and tints them red.
- **Connection resolution** in `src/features/schema_diff/handles.ts`:
  - If a side is already open as a workspace, its handle is borrowed and never
    closed here.
  - Otherwise it is opened transiently from the registry and closed when the diff
    unmounts.
  - Handles are cached per comparison.
  - `DIFF_ENGINES = ["postgres", "mysql", "sqlite"]`.
- **UI** in `src/features/schema_diff/components/SchemaDiff.tsx`:
  - The current connection defaults to the right-hand (target) card. The comparison
    side starts unselected, and swap is disabled until one is picked.
  - The **Change DDL** modal shows the planned statements (`highlight.ts`).
  - Entry points: the workspace `diff` tab (`WorkspaceContent.tsx`) and
    `CompareSchemasModal` on the connect screen.
- **Sync mode exists in the component but has no entry point.** The `compareOnly`
  prop switches between modes. Sync mode has a checkbox plan, a review modal, a
  production gate that requires typing the target's name, and `schemaDiffApply`.
  Both shipped mount points pass `compareOnly`.

## Alternatives considered

- **New per-engine snapshot SQL.** Rejected in favour of composing `list_tables` and
  `table_meta`, so any engine with a sidebar can be diffed (adapter doc comment).
- **Diff in the renderer.** Moved to the Rust
  domain as pure, unit-tested functions. The use of a single source of truth for the
  dialect is inferred.
- **Apply through a dedicated port.** The `ports.rs` doc rejects this: apply reuses
  the target connection's script path so that statements share one transaction where
  the engine supports DDL transactions.

## Consequences

- **Positive:**
  - Row data cannot leak through this feature by construction.
  - Direction swaps cost nothing.
  - Cross-engine comparison works because the plan is emitted in the target's
    dialect.
- **Negative / trade-offs:**
  - MySQL DDL auto-commits, so a failed apply leaves earlier statements in place
    (`apply_migration` doc).
  - Views, routines, triggers, constraints other than indexes, and defaults are not
    diffed.
  - MSSQL and ClickHouse are excluded from `DIFF_ENGINES` even though they have
    `table_meta`.
- **Follow-ups:**
  - The sync/apply path is built but not reachable from the UI.
  - MSSQL and ClickHouse support.
