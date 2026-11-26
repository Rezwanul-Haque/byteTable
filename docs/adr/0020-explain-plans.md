# ADR-0020 — Explain plans come from the engine, with a modelled fallback

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-14 (first commit that shipped the feature: `e8ec267` "execution-order minimap + Explain panel (M15 Task 3)"; real engine plans from `2d6c73d`/`e8b6a5e`, 2026-08-13)
- **Area:** SQL
- **Related:** ADR-0003, ADR-0006, ADR-0018, ADR-0019, ADR-0021, `docs/M15-sql-import-export-explain.md`

## Context

M15 shipped Explain as a **renderer-only teaching view**. `docs/M15-…` notes that
"there is no `explain` Tauri command". The view detected clauses by
string-matching (`src/features/workspaces/explainClauses.ts`) and drew a synthetic
psql-style tree. The slice docs (`src-tauri/src/features/explain/mod.rs`) state
the problem with that: it "always read as a sequential scan and never named an
index, so it disagreed with what the same query showed in a terminal".

Explain needs three views, and per-node row counts for queries with aliases and
JOINs. ByteTable has no in-browser engine to compute those counts, so they come
from the server's plan (see `explainParse.ts`).
Explain must also be safe on production connections, where running the user's
statement may not be acceptable.

## Decision

- **Rust slice `src-tauri/src/features/explain/`** (domain / application /
  commands). It issues plain `EXPLAIN` statements over the existing `run_query`
  port, so no engine adapter needed new driver code. The dialect lives in this
  slice, "the same call schema_diff makes for its per-engine DDL" (`mod.rs`).
- **Commands:**
  - `explain_capabilities` → `ExplainCapabilities { plan, analyze, structured, note }`.
  - `explain_plan` → `Option<ServerPlan>`: the machine-readable form, **never
    executes** (`EXPLAIN (FORMAT JSON)` on Postgres, `EXPLAIN FORMAT=JSON` on
    MySQL, `EXPLAIN QUERY PLAN` on SQLite). `PLAN_ROW_LIMIT = 2000`. `None`
    means "fall back", not an error.
  - `explain_raw { analyze }` → the engine's text verbatim. With `analyze: true`
    it runs `EXPLAIN ANALYZE` (MySQL) or `EXPLAIN (ANALYZE, BUFFERS)` (Postgres).
    That form executes, so it is guarded by `refuse_executing_writes` in
    read-only workspaces (ADR-0006).
  - `explain_measure` runs the statement (`MEASURE_ROW_LIMIT = 1000`) plus
    `SELECT COUNT(*)` probes built by `domain::statement::count_probes`, giving
    exact "rows read" and "rows kept". A failed probe becomes "—" and does not
    fail the measurement. A "kept" count larger than "scanned" is clamped.
- **Parsers** (`domain/postgres.rs`, `mysql.rs`, `sqlite.rs`) map each engine's
  output onto one `PlanNode` model (`NodeKind`: scan/join/agg/sort/unique/limit/other,
  `rows`, `ms`, cost). They are unit-tested against JSON captured from real
  servers (`domain/fixtures/*.json`, `domain/tests.rs`). Statement slicing uses
  the shared clause lexer `src-tauri/src/shared/sql_lex.rs`.
- **Engine scope:** Postgres and MySQL support everything. SQLite has a plan but
  no ANALYZE. ClickHouse gets a raw plan only (pipeline, not structured).
  SQL Server and Oracle report no support. The recorded reason: showplan needs a
  session-wide `SET` and `DBMS_XPLAN` needs a second query, and "neither survives
  one pooled statement".
- **Renderer:** `src/features/workspaces/components/explain.tsx` draws three
  views over one analysis: **Plan** (node table + tree + warnings), **How it
  runs** (the M15 clause-order view) and **Raw output** (with an
  EXPLAIN / EXPLAIN ANALYZE toggle). Supporting modules:
  - `explainServer.ts` holds the wire types and must "never learn a dialect";
  - `explainRun.ts` wraps measurement and folds in cached sidebar row estimates;
  - `explainParse.ts` is a forgiving SELECT-shape parser that never throws;
  - `explainModel.ts` builds the modelled tree and swaps in the server plan via
    `withServerPlan`, tagging `source` and `share` (time vs cost) so the view
    says which tree is on screen.
- **Production gate:** the plan-only fetch runs on every connection. Measurement
  is automatic on dev/staging and waits for a Measure click when
  `normalizeEnv(env) === "production"`.

## Alternatives considered

- **Keep the client-side model only:** this was the M15 state, and it was
  replaced because it disagreed with real plans (recorded in `mod.rs`). The
  model remains as the fallback.
- **An in-browser mock engine (aliases/JOIN execution):** not applicable.
  Queries run on a real server, so `explainParse.ts` reads shape only.
- **Put EXPLAIN in each `crate::engines::*` adapter:** rejected in `mod.rs`.
  EXPLAIN is a plain statement and the parsing is "presentation-shaped rather
  than connection-shaped".
- **Always run `EXPLAIN ANALYZE`:** rejected. It executes the statement, so it is
  behind an explicit toggle and the read-only guard.
- **SQL Server showplan via a pinned session:** not done. The slice reports no
  support instead, because a pooled connection cannot guarantee the `SET`
  applies to the next batch.

## Consequences

- **Positive:** the plan tree shows the access paths the optimizer chose. It is
  safe to open on production because plan-only executes nothing. Parsers are
  covered by real-output fixtures.
- **Negative / trade-offs:** SQL Server, Oracle and ClickHouse (structured)
  still show the modelled tree, which is labelled as such. Row probes only work
  for statements with a readable `FROM`. The "kept" probe is skipped when the
  statement has a JOIN. Measurement runs the query a second time on top of any
  normal Run.
- **Follow-ups:** SQL Server showplan would need session pinning similar to
  `run_batch` (ADR-0019). Non-SQL engines have no explain.
