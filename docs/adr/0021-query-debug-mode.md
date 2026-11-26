# ADR-0021 — Query debug mode: step a SELECT by running each clause prefix

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-11-24 (first commit that shipped the feature: `d47c651` "debug mode on query tab")
- **Area:** SQL
- **Related:** ADR-0006, ADR-0016, ADR-0018, ADR-0019, ADR-0020

## Context

The question is "where did my rows go (or where did the
extra ones come from)?" A database runs a query as one unit, so there is nothing
to pause. Three rules apply: **read-only**, **exact numbers** (counts
come from running, never estimates), and **never surprising on a big table**
(capped and cancellable). The editor already had a clause-order minimap from
Explain (ADR-0020). Debug turns it into a stepper.

## Decision

- **Approach:** cut the statement at its top-level clause boundaries and run
  each prefix as its own read-only SELECT. The prefixes are FROM, each JOIN,
  WHERE, GROUP BY, the select list, DISTINCT, ORDER BY, and LIMIT/TOP.
- **Rust slice `src-tauri/src/features/query_debug/`:**
  - `domain.rs` finds clauses with the shared lexer `src-tauri/src/shared/sql_lex.rs`.
    It builds step SQL by **slicing the user's own text**, so quoting, aliases and
    vendor syntax survive unchanged. The only dialect knowledge is `LIMIT` vs SQL
    Server `TOP`. It returns facts only (clause, text, editor range, SQL); the
    renderer writes the sentences so they can be translated.
  - `CannotDebug` gives a reason per refusal: `Empty`, `Multiple`, `NotSelect`
    (including `INTO` / `FOR UPDATE`), `NoFrom`, `Parse { message }`,
    `MultipleTargets`, `UnreadableWrite`.
  - `StaticNote` covers shapes that are not broken out: HAVING and window
    functions run inside their step, a subquery/CTE source is one opaque step,
    and a set operation steps only its first branch.
  - `domain/write.rs` is an **UPDATE/DELETE dry run**. The write is rewritten into
    the SELECT that finds the rows it would change, with per-dialect mapping
    (Postgres `FROM`/`USING`, MySQL `UPDATE … JOIN`, SQL Server `UPDATE a … FROM`).
    That SELECT is stepped, and a last step shows `→ column` new values. The doc
    comment notes that cascades, triggers and write-only errors are invisible to
    it.
  - `application.rs`: `plan` runs at most one plan-only `EXPLAIN` (Postgres,
    MySQL, ClickHouse; `EXPLAIN QUERY PLAN` on SQLite) to turn a syntax error into
    `Cannot::Parse`. A slow planner does not cause a refusal. `run_step` returns a
    `SAMPLE_ROWS = 200` sample, an exact count, and join/WHERE probes (per-condition
    counts for up to `MAX_CONDS = 8` conditions). Each query passes through
    `guarded`, which rejects anything `shared::readonly::sql_is_read_only`
    refuses, applies `STEP_TIMEOUT = 30s`, and races a `CancellationToken`.
- **Commands** (`commands.rs`): `debug_plan`, `debug_run_step` (one step per
  call, so the list fills in as counts arrive) and `debug_cancel`.
  `QueryDebugState` holds one `CancellationToken` per renderer `run_id` and
  prunes cancelled ones.
- **Renderer:**
  - `src/features/workspaces/debugServer.ts` holds the typed wrappers.
  - `debugModel.ts` is a pure view model returning i18n `{ key, vars }` messages.
    It also holds `queryBudget`, `LARGE_TABLE_ROWS = 1_000_000` and
    `SAMPLE_BASE_ROWS = 100_000`.
  - `hooks/useQueryDebug.ts` runs steps sequentially and stops at the first
    failure, marking later steps "Not reached". Before a run over a source the
    catalog estimates above 1M rows, it asks (`BigTableAsk`) and offers sampling.
  - `components/DebugView.tsx` shows the step list and detail.
  - In `SqlEditorTab.tsx` the editor goes `readOnly` while debugging and the
    current clause is highlighted. F10 / Shift+F10 step forward and back, Esc
    exits. Run leaves debug mode.

## Alternatives considered

- **Estimate per-step rows from the planner:** ruled out by the "exact
  numbers" rule.
- **Rewrite the statement through a full SQL parser/AST:** not done.
  The domain docs say slicing means "no dialect knowledge is needed". Inferred:
  this also avoids dialect gaps that a generic parser would have.
- **One command that runs every step:** rejected in favour of one step per call,
  so the UI fills progressively and can stop between steps (`commands.rs`).
- **Execute writes inside a rolled-back transaction:** not done. Writes are
  turned into SELECTs, keeping rule 1. The trade-off is recorded in `write.rs`.
- **Stepping HAVING, CTEs, windows and UNION as their own steps:** out of scope.
  They are shown with static notes.

## Consequences

- **Positive:** every number shown is measured. It is safe on production because
  only reads are sent and each is timed out and cancellable. It works on every
  SQL engine with a `run_query` port, including those without EXPLAIN support,
  since the plan check is skipped there.
- **Negative / trade-offs:** each step re-runs a prefix, so a run issues
  `queryBudget` queries (2 per step plus probes) and can be heavy without
  sampling. A single statement only. The dry run cannot see cascades or
  triggers. Over 8 WHERE conditions, the per-condition breakdown is dropped.
- **Follow-ups:** breakpoints across scripts, stored procedures, and an
  assistant "explain this step" were all listed out of scope and are not
  implemented. Non-SQL engines are not supported.
