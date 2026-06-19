# M16 — Generate Data (schema-aware fake data)

> provenance: **implemented on branch `feat/m16-generate-data` — not yet
> committed.** Built per the plan in
> `docs/superpowers/plans/2026-06-19-m16-generate-data.md`. Backend complete
> (Rust slice `features/generate/` + engine `bulk_insert`/`fetch_pk_pool` on all
> three SQL adapters) with 23 new tests; frontend slice `src/features/generate/`
> wired into the schema actions menu. Verified: `cargo test` (418 pass),
> `cargo clippy --all-targets` clean, `npm run typecheck`/`lint`/`build` clean.
> SQLite is exercised end-to-end (zero orphan FKs, uniqueness across append,
> self-ref, cancel). MySQL has a gated end-to-end test
> (`BYTETABLE_TEST_MYSQL_URL`) covering type/constraint fidelity — datetime
> format, varchar length, tinyint range, decimal, sized-string ids, FK ordering.
> Postgres is unit-tested at the SQL-builder level; its live path has no
> integration test yet. Generators parse the full declared type (width/sign,
> precision/scale, length) and emit engine-portable datetimes.
> Imperative = requirement; anything marked *(deferred)* / *(YAGNI)* is out of
> v1 scope.

## Goal

A one-click **Generate Data** action that fills a whole schema with realistic
fake data, with no hand-written SQL. The user picks only a target size; the
system introspects the schema, figures out table structure and relationships,
and generates data that respects them.

Concretely, M16 ships:

- **Schema-level "Generate data" action** — one icon at the schema level opens a
  Generate modal. The action plans and populates **every table in the schema**,
  not one table at a time.
- **Size choice** — `1k`, `10k`, `100k`, `1M`. This is the *base* row count for
  entity tables; other tables scale relative to it (see Smart scaling).
- **Relationship-aware ordering** — tables are filled parent-before-child by a
  topological sort of foreign keys. Foreign-key columns are populated from real
  parent primary keys, so the generated data has **zero orphan FKs**.
- **Self-referential & circular FKs handled** — `employees.manager_id`-style
  self-refs and circular FK groups are filled by inserting the FK columns NULL
  first, then a second UPDATE pass wires them.
- **Column-name-aware values** — a heuristic dictionary maps column name +
  declared type to a realistic generator (emails look like emails, prices look
  like prices, `created_at` looks like a timestamp). Not random noise.
- **Append, constraint-respecting** — generation is **non-destructive**: it adds
  rows alongside existing data, honoring PK / UNIQUE / NOT NULL / FK / DEFAULT.
- **Progress + cancel** — long runs (100k–1M) stream progress (per-table, rows
  done/total, rows/sec, ETA) and can be cancelled; commits are chunked so
  already-written data survives a cancel.
- **Engine-aware** — SQLite, MySQL, PostgreSQL. Redis: feature hidden.

## Decisions locked

| Topic | Decision |
|-------|----------|
| Generation engine | Rust backend, batched multi-row INSERT |
| Scope of one action | Whole schema, FK-ordered |
| Value inference | Heuristic dictionary (name + type) |
| Existing data | Append; respect PK/UNIQUE/NOT NULL/FK/DEFAULT |
| Per-table counts | Smart per-table scaling from the chosen base |
| Engines | PostgreSQL, MySQL, SQLite |
| Long runs | Progress + cancel, chunked commits |
| FK edge cases | Self-ref + circular groups handled |

Deferred: LLM-assisted inference *(YAGNI — heuristic only)*; saved per-schema
presets *(YAGNI v1)*; per-table count override in the UI *(may follow; v1 shows
the computed plan read-only)*. **Open for confirmation:** an optional `seed`
field for reproducible runs (small add, off by default).

## Dependencies — M2/M12 engines, M3 introspection, M9 schema-map, M11 mutate pattern

- **Engines** (`src-tauri/src/engines/{sqlite,mysql,postgres}/mod.rs`, M2/M12) —
  gain the new bulk-insert + PK-pool methods. Redis is excluded.
- **M3 introspection** (`features/introspection`, `table_meta`) — supplies, per
  table: `columns` (name, `data_type`, `nullable`, `pk`, `default`, `fk`),
  `foreign_keys` (composite, ordered), `indexes` (UNIQUE detection),
  `referenced_by` (inbound FKs — used for role classification).
- **M9 schema-map / structure toolbar** — host for the schema-level entry icon.
- **M11 mutate** — reuse the production-confirm pattern and `AppError` §5
  `{ kind, message }` shape. Generation writes user data, so the run is gated by
  the same env-aware confirm.
- **Connection layer** — `ConnectionManager` open handles; engine port
  `EngineConnection` in `src-tauri/src/shared/engine.rs`.

## Backend (Rust core)

New vertical slice `src-tauri/src/features/generate/`, mirroring `mutate` /
`introspection` (`commands`, `application`, plus `planner` and `generators`
modules). The engine port gains two methods, implemented by all three SQL
adapters.

### Commands — `features/generate/commands.rs`

- `generate_preview(handle, schema) -> GeneratePlan` — introspects the schema and
  returns the **plan** without writing anything: insertion order, per-table role
  + computed row count, per-column generator mapping, and warnings (columns the
  dictionary can't confidently satisfy, CHECK constraints, detected cycles).
- `generate_run(handle, schema, size, seed?) -> GenerateSummary` — executes the
  plan, streaming progress as Tauri events. Returns a summary (rows inserted per
  table, elapsed, any per-table failures).
- `generate_cancel(runId)` — sets the cancel flag; checked between chunks.

### Planner — `features/generate/planner.rs` (pure, unit-tested)

- **Dependency graph + topological sort** of tables by `foreign_keys`. Output is
  the parent-before-child insertion order.
- **Cycle / self-ref detection** — circular FK groups and self-references are
  identified; their FK columns are marked *deferred* (insert NULL first, wire in
  a second UPDATE pass). Deferred columns must be nullable; if a NOT NULL FK
  participates in a cycle, the plan emits a warning and best-effort orders it.
- **Role classification** per table, driving Smart scaling:
  - *lookup / reference* — enum-like: few columns, heavily present in other
    tables' `referenced_by`, or name matches `status|type|category|role|country|
    currency|…`. Small fixed count.
  - *junction* — only FK columns (+ a composite PK made of them). Scales up
    (~base × fanout).
  - *entity / fact* — everything else. Gets the chosen base count.
- **Smart scaling** — the chosen size is the base for *entity* tables. Lookup
  tables get a small count; junction tables scale with their parents. Counts are
  surfaced in the preview so the user sees them before running.

### Generators — `features/generate/generators.rs` (pure, unit-tested)

- **Heuristic dictionary**: `(column_name, data_type) -> Generator`. Name
  patterns include email, first/last/full name, username, phone, address / city
  / state / zip / country, company, url, title, slug, description→lorem,
  price/amount/cost→decimal, qty/age/count→bounded int, created_at/updated_at/
  *_at/date→timestamp, `is_*`/`has_*`→bool, uuid, json. Falls back to a
  type-driven generator when no name matches.
- **Type fidelity** — generated values respect the declared type (int / decimal
  / text / bool / date / timestamp / json), not just the name guess.
- **Constraint handling**:
  - *PK* — integer auto-increment PKs are omitted from the INSERT (DB assigns).
    Non-auto PKs get unique generated values.
  - *UNIQUE* (column or unique index) — the generator tracks emitted values
    (set / counter suffix) so a run produces no duplicates, and on **append**
    starts past existing values.
  - *NOT NULL* — always produces a value. *Nullable* — sprinkles NULL at a low
    rate. *Has DEFAULT + nullable* — may omit the column so the DB default fires.
  - *FK* — picks uniformly from the parent PK pool (existing + newly inserted).
- **Seedable RNG** — optional `seed` makes a run reproducible.

### Application — `features/generate/application.rs`

Orchestrates plan → run, depending on `ConnectionManager` + introspection:

1. Build the plan (planner) from introspected `table_meta`.
2. For each table in topo order:
   - Load/refresh the **parent PK pools** for its FK targets via
     `fetch_pk_pool` (sampled, capped to bound memory — see below).
   - Generate rows in chunks of `GENERATE_CHUNK_ROWS` (e.g. 1k–10k), build a
     multi-row parameterized INSERT, execute it, **commit per chunk**.
   - Track newly inserted PKs into the pool for downstream children.
   - Emit a progress event per chunk; check the cancel flag.
3. Run the deferred-FK UPDATE pass for cycle/self-ref columns.

### Engine port — `src-tauri/src/shared/engine.rs` (+ three adapters)

Two new `EngineConnection` methods:

- `bulk_insert(schema, table, columns, rows) -> u64` — engine-aware multi-row
  insert in a transaction. PostgreSQL/MySQL multi-row `INSERT … VALUES (…),(…)`
  (or `COPY` for Postgres if it proves necessary at 1M); SQLite batched INSERT in
  one transaction. Identifiers quoted per engine (reuse M15
  `quote_identifier`). Values bound as parameters.
- `fetch_pk_pool(schema, table, pk_columns, cap) -> Vec<Row>` — returns up to
  `cap` existing primary-key tuples for FK sourcing and append-uniqueness
  baselining (e.g. current max for counter-based unique generators). `cap` bounds
  memory on large parent tables (sampled, not full scan).

## Frontend (renderer)

New slice `src/features/generate/`:

- **Entry** — a "Generate data" icon at schema level (schema-map / structure
  toolbar; hidden for Redis connections).
- **Modal** —
  1. Size picker: `1k / 10k / 100k / 1M` (+ optional seed field, if shipped).
  2. **Preview** (from `generate_preview`): table list with role, computed row
     count, sample column→generator mappings, and warnings. Read-only in v1.
  3. Generate button → production-confirm (reuses M11 pattern, since this writes
     user data).
  4. **Progress** view: per-table bar, rows done/total, rows/sec, ETA, Cancel.
  5. **Summary** on completion: rows inserted per table, elapsed, failures.
- `api.ts` — `invoke` wrappers for the three commands + the progress-event
  listener.
- `state.ts` — zustand store: plan, run status, progress, cancel.

## Error handling

- **Constraint violation mid-run** → §5 `AppError` reporting the table (and, when
  available, the offending row); already-committed chunks remain (append
  semantics). The summary lists partial successes.
- **Dictionary can't satisfy a column** (CHECK constraint, exotic/unknown type)
  → best-effort generator + a **warning in the preview** before the run, so the
  user decides before any write.
- **Cycle with a NOT NULL FK** → warning in the preview; best-effort ordering.
- **Huge parent tables** → `fetch_pk_pool` cap samples the pool to bound memory.
- **Empty schema** → friendly empty state. **Redis / unsupported engine** →
  action hidden.
- **Cancel** → stops between chunks; committed chunks persist; summary reflects
  what was written.

## Testing

- **Rust unit** (fake `EngineConnection`): topological sort + cycle/self-ref
  break; role classification; smart count scaling; generator dictionary
  (name+type → value); uniqueness tracking incl. append baselining; FK-pool
  sampling.
- **Rust integration** (SQLite in-memory): a schema with FKs, a self-ref, a
  cycle, and UNIQUE columns → generate at a small size and assert: correct
  per-table row counts, **zero orphan FKs**, uniqueness preserved, NOT NULL never
  violated, append leaves existing rows intact.
- **Frontend**: store tests for progress accumulation and cancel; preview
  rendering of plan + warnings.

## Out of scope (v1)

- LLM-assisted column inference (heuristic dictionary only).
- Saved/reusable per-schema generation presets.
- Per-table count editing in the UI (plan is shown read-only).
- `COPY`/`LOAD DATA` fast paths — only if multi-row INSERT proves too slow at 1M.
