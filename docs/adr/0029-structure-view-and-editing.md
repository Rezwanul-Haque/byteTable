# ADR-0029 — Structure view and staged ALTER editing

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commits: `7d78f19` structure metadata, `5d1f793` read-only view, `482a142` staged ALTER backend)
- **Area:** Schema
- **Related:** ADR-0003, ADR-0006, ADR-0012, ADR-0028, `docs/M7-structure-view.md`, `docs/M8-structure-editing.md`

## Context

A table tab needs a Structure mode: columns, indexes, foreign keys, referenced-by, and
DDL (M7), and then the ability to change them (M8). Engines differ a lot here. SQLite has
no `ALTER COLUMN` and no `ADD/DROP CONSTRAINT`. MySQL and ClickHouse auto-commit each
DDL statement. Postgres runs DDL inside a transaction. ClickHouse has no foreign keys.
Schema changes are destructive, so the user must see the SQL before it runs and be able
to discard edits. The editing model also has to match the grid's staged-change pattern
(ADR-0012).

## Decision

- **Read side reuses introspection.** M7 extended `TableMeta` with `indexes`,
  `foreign_keys`, `referenced_by`, `ddl`, `comment` and reads it through
  `useIntrospectionStore.loadTableMeta` (ADR-0028). The view is
  `src/features/browse/sql/components/StructureView.tsx` (CSS in
  `src/features/browse/shared/styles/StructureView.css`). The slice does not keep its own
  schema cache.
- **Staged op model (Rust domain).** `src-tauri/src/features/structure/domain/mod.rs`
  defines `AlterOp`, internally tagged on `op`: `AddColumn`, `RenameColumn`, `ChangeType`,
  `SetNullable`, `SetDefault`, `DropColumn`, `SetComment`, `AddIndex`, `DropIndex`,
  `AddForeignKey`, `DropForeignKey`. Helpers: `is_native()` (SQLite needs no rebuild),
  `target_column()`, and `rejected_on_pk()`. Dropping or retyping a primary-key column is
  rejected at both preview and apply.
- **Two commands, one port method.** `alter_preview` and `alter_apply`
  (`src-tauri/src/features/structure/commands.rs`) call
  `EngineConnection::alter_table(schema, table, ops, apply: bool)`. Preview passes
  `apply == false` and must not touch the database. `alter_apply` calls
  `ensure_writable(…, "change table structure")` first (ADR-0006). The slice writes no SQL:
  each adapter builds its own DDL
  (`src-tauri/src/engines/{sqlite,postgres,mysql,mssql,clickhouse}/structure.rs`). The port's
  default returns `Unsupported("Structure editing is not supported for this engine yet.")`
  for any SQL adapter that does not override it.
- **Per-engine apply.**
  - SQLite: all-native batches run in one transaction. If any op needs a rebuild, the
    adapter does the 12-step metadata-reconstruction rebuild (new `CREATE TABLE`, copy,
    swap, recreate indexes, `foreign_key_check` before commit). It refuses tables whose
    DDL it cannot rebuild faithfully (CHECK, generated columns, AUTOINCREMENT,
    WITHOUT ROWID, COLLATE, triggers). The preview shows logical `ALTER` statements, not
    the rebuild SQL.
  - Postgres and SQL Server: one transaction, full rollback on error (DDL is
    transactional on both).
  - MySQL and ClickHouse: no atomicity, because DDL auto-commits. The module docs record
    this caveat, and the error names the statement that failed. ClickHouse rejects FK ops
    and does not emit sort-key, engine, or partition changes.
- **Renderer op accumulation.** `src/features/structure/ops.ts` holds the pure logic:
  - Folding (the rules are written in the `ops.ts` header) keeps one op per (kind,
    original column), with the last edit
    winning. An edit back to the introspected value removes the op. Edits to a
    just-added column change its `AddColumn` op.
  - `applyOpsToColumns` / `applyOpsToIndexes` / `applyOpsToForeignKeys` replay the
    ops over the snapshot to produce the working set. This mirrors the backend's
    `compute_target_columns`.
  - `toWireBatch` puts ops in phase order (drops, adds, in-place edits, renames,
    index/FK drops, index/FK adds), so every op names an original column.
  - The pending ops persist per tab in the workspace `ui` (`setTabStructureOps`).
    `src/features/structure/api.ts` only re-exports `alterPreview` / `alterApply` from
    `src/shared/api/engine.ts`.
- **Index/FK editing** (`01a28cb`, 2026-10-18). Editor-only `ReplaceIndexOp` and
  `ReplaceForeignKeyOp` keep the "redefine X" intent, which a drop + add pair cannot
  show. `toWireBatch` expands each into drop + add. Names come from
  `generateIndexName` / `generateForeignKeyName`. Tests are in
  `src/features/structure/indexOps.test.ts`.
- **Pending bar and ⌘S** (`cb23287`, 2026-08-14). The bar offers Review SQL, Discard, and
  Apply. ⌘/Ctrl+S applies the batch, the same key that commits the grid's staged rows,
  and ⌘I stages a new column. If a cell editor is open, the handler blurs it and defers
  one turn so the in-progress edit lands in the batch first. After apply, the view
  invalidates the cache and reloads `TableMeta`.
- **Read-only.** `useReadOnly()` makes every editable cell inert, but the backend
  `ensure_writable` check is what enforces it.

## Alternatives considered

- **Execute each inline edit immediately.** Rejected: the M8 spec requires a reviewable,
  discardable batch, matching the grid's staged changes (ADR-0012).
- **Generate DDL in the slice or the renderer.** Rejected (recorded in
  `features/structure/mod.rs`): DDL generation and execution are engine-specific and sit
  behind the port.
- **Show the literal SQLite rebuild SQL in Review SQL.** Rejected (recorded in
  `sqlite/structure.rs`): the preview is "truthful about WHAT changes".
- **Silently degrade on SQLite tables the rebuild cannot reproduce.** Rejected: the adapter
  refuses them so constraints and triggers are not lost.
- **`ALTER INDEX` for index redefinition.** Not possible: no engine can redefine an index
  in place (comment in `ops.ts`), so it is drop + add.

## Consequences

- **Positive:** All supported engines use one op model and one UI. Users see the SQL
  before it runs and can discard it. Primary-key safety is enforced on the server. ⌘S
  works the same in Data and Structure modes.
- **Negative / trade-offs:** MySQL and ClickHouse can partly apply a failed batch. The
  backend's validate/replay rules are duplicated in TypeScript (`ops.ts`) and must stay in
  step with the adapters. Some SQLite tables cannot be edited at all.
- **Follow-ups:** ClickHouse sort-key, engine, and partition edits. Column comments only work on Postgres and MySQL.
