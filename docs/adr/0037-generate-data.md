# ADR-0037 — Schema-aware fake data generation

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-19 (`fd3d912` feat(generate): add schema-aware data generation (M16))
- **Area:** Data movement
- **Related:** ADR-0003, ADR-0006, ADR-0028, ADR-0036, ADR-0047, `docs/M16-generate-data.md`, `docs/superpowers/plans/2026-06-19-m16-generate-data.md`

## Context

Testing a schema needs realistic rows that real, constraint-enforcing engines
accept: parents before children, FK values that exist, unique columns that do not
collide (also on a second run), values that fit `varchar(n)`, `tinyint`,
`decimal(p,s)` and the engine's datetime parser. The M16 doc fixes the UX at "pick a
size, see a plan, run" for a whole schema, append-only, with progress and cancel, and
lists self-referencing and circular FK groups as cases to handle.

## Decision

- **Backend slice `src-tauri/src/features/generate/`** split into pure modules and
  one use-case module:
  - `domain.rs` — wire types: `GenerateSize` (`1k`/`10k`/`100k`/`1m` → base rows),
    `TableRole` (`lookup`/`junction`/`entity`), `ColumnPlan`, `GeneratePlan`,
    `GenerateSummary`.
  - `planner.rs` — FK dependency graph (`build_deps`), cycle break, Kahn
    `topo_order` with alphabetical tiebreak, `classify_role` (all-FK table with ≥2
    columns → junction; name containing `status`, `type`, `country`, … → lookup;
    else entity) and `scale_rows` (lookup 20, entity = base, junction = 2× base
    capped at 5,000,000).
  - `generators.rs` — `parse_type` reads width/sign, precision/scale and length from
    the declared type; the declared type picks the generator and the column name
    only refines text columns (email, name, …). Datetimes use `YYYY-MM-DD
    HH:MM:SS` because MySQL rejects ISO `T`/`Z`. Randomness is a local SplitMix64
    `Rng` (no dependency).
  - `application.rs` — `build_plan` (preview) and `run_generation` (write).
- **Commands:** `generate_preview`, `generate_run` (gated by `ensure_writable`),
  `generate_cancel`. Cancel flags live in managed `GenerateState`, keyed by a
  renderer-supplied `run_id`; progress streams as `GenProgress` over a `Channel`.
- **Writes through two engine-port methods** in
  `src-tauri/src/shared/ports/sql/conn.rs`: `bulk_insert` (parameter-bound,
  per-chunk transaction, binary columns bound as bytes) and `fetch_pk_pool` (read up
  to `POOL_CAP` = 100,000 existing keys). Default impl is `Unsupported`; SQLite,
  MySQL, Postgres and MSSQL implement them (`src-tauri/src/engines/*/bulk.rs`).
- **Run semantics:** tables in topological order; `CHUNK` = 5,000 rows per
  `bulk_insert`; existing row count is used as an index offset so unique generators
  do not collide on a repeat run; auto-increment PKs and nullable columns with a
  DEFAULT are omitted; self-ref and cycle-breaking FK columns are marked
  `deferred`, inserted NULL, then filled by a second `wire_deferred` UPDATE pass.
  Cancel is checked between chunks and committed chunks persist; a per-table failure
  is recorded and the run continues.
- **Renderer:** `src/features/generate/api.ts`, `state.ts` (Zustand flow
  size → preview → run → summary) and `components/GenerateModal.tsx`, opened from
  the schema menu in `src/features/workspaces/components/Sidebar.tsx`; hidden for
  system schemas and when writes are not allowed.

## Alternatives considered

- **LLM-assisted value inference.** Marked YAGNI in the M16 doc; heuristics only.
- **Per-table count overrides, saved presets.** Deferred in the M16 doc; the plan is
  shown read-only.
- **A faker crate.** Not used; generators are hand-written over a local RNG. The
  reason is not recorded (inferred: keep dependencies and determinism under
  control).
- **Truncate-then-fill.** Not chosen; the M16 doc requires append with
  PK/UNIQUE/NOT NULL/FK/DEFAULT respected, so the action is non-destructive.
- **Building INSERT SQL in the slice.** Not chosen; quoting and binding stay in the
  adapters behind `bulk_insert`, consistent with ADR-0003.

## Consequences

- **Positive:** one action fills a schema with FK-consistent data; repeat runs
  append without unique collisions; cancellation never leaves a half-written chunk;
  the pure planner/generators are unit-tested without a database.
- **Negative / trade-offs:** role classification is a name heuristic; FK sourcing
  samples at most 100,000 parent keys; a NOT NULL deferred FK only gets a preview
  warning; CHECK constraints are not parsed beyond a note; ClickHouse and all
  non-SQL engines return `Unsupported`. The M16 doc notes Postgres has no live
  integration test.
- **Follow-ups:** the optional `seed` is accepted by `generate_run` (defaults to 0)
  but the modal exposes no seed control; per-table counts remain fixed.
