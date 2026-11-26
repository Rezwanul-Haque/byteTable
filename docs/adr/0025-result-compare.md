# ADR-0025 — Result compare: backend runs both sides, renderer diffs

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-11-26 (first commit that shipped the feature: `527fcb6` "result compare - run two versions of a query and see the rows only in one, and the rows that changed")
- **Area:** SQL
- **Related:** ADR-0006, ADR-0019, ADR-0021, ADR-0024, ADR-0033

## Context

When a user edits a query, they want to know how the result changed: which rows
appeared, which disappeared, and which changed value. Four rules apply:

1. never show a partial answer that looks complete;
2. always show how rows were matched, and the weaknesses of that key;
3. read-only, so only SELECTs are compared;
4. print the equality rule under every comparison.

The scope is one SQL tab comparing two SELECTs on the same connection.
Cross-connection diff, saved-query or other-tab sources, export and float
tolerance were out of scope.

## Decision

- **Split of work.** The backend runs the queries. The renderer does the diff,
  because key and order choices change without re-running (recorded in
  `src-tauri/src/features/result_compare/application.rs`).
- **Rust slice `src-tauri/src/features/result_compare/`** (application +
  commands only, no domain/ports):
  - `check` sends only a single, provably read statement, using
    `shared::readonly::{sql_is_read_only, statement_count}`. Both sides are
    checked before either is sent. A refused side is never sent. The `Refusal`
    values are `Empty | Write | Multi | TooMany`.
  - `MAX_ROWS = 100_000` per side. The adapter reads one extra row to detect
    overflow, and an oversized side is refused rather than truncated (rule 1).
    This limit is above the normal `query_run` ceiling of 10,000 rows.
  - **Same snapshot where possible.** `snapshot_begin` opens a read-only
    snapshot transaction on one pinned session (`EngineConnection::pin`):
    `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` on Postgres, and
    `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` on MySQL. Both sides
    run inside it. If the begin fails (e.g. an old server), it rolls back and the
    sides run back to back. `CompareOutcome.snapshot` reports which happened.
  - Commands: `compare_run` and `compare_cancel`. `CompareState` maps a renderer
    `run_id` to a `CancellationToken`. The run is spawned, so a cancelled run
    still ends its transaction and returns a clean pooled connection after the
    command has answered.
- **Renderer `src/features/result_compare/`:**
  - `compareModel.ts` is pure.
    - `norm`/`same` define equality: NULL equals NULL, numbers by value,
      numeric text by value, other text exactly, JSON as compact text.
    - `sharedColumns` limits the comparison to columns both sides return;
      columns on only one side are listed.
    - `suggestKey` picks a shared column that is never NULL and never repeated,
      preferring `id`, then `*_id`, then code-like names. If none qualifies,
      rows are matched as whole rows.
    - `diff` produces Changed (cell-level, for key matching), Only in A, Only in
      B and Same. `dupes` reports a non-unique key. Row order is ignored unless
      `ordered` is set.
    - `verdictOf` gives the verdict, and `SHOW_ROWS = 200` rows are drawn per
      list.
  - Above `OFF_THREAD_ROWS = 20_000` combined rows, `hooks/useCompareDiff.ts`
    runs `diff` in `compare.worker.ts`, which posts progress every 5,000 rows.
  - `readSql.ts` ports the backend read-only check so a refused side never
    leaves the renderer. The backend check is the actual guard.
  - `components/ComparePanel.tsx` is the **Compare** view in `SqlEditorTab`. A is
    the editor; B is the previous run, a workspace history entry (ADR-0019), or
    pasted SQL in an editable box. A new Run leaves Compare.

## Alternatives considered

- **Diff in Rust:** not chosen. The module comment says the comparison needs the
  user's key and order choices, "which change without re-running". Keeping it in
  the renderer means changing the key does not cost an IPC round trip.
- **Compare only the first N rows:** rejected by rule 1. The code refuses with
  `TooMany`.
- **Run the sides in parallel on two connections:** not done. Running in one
  snapshot transaction gives a consistent read on Postgres and MySQL. Inferred:
  parallel runs would see different data under concurrent writes.
- **SQL `EXCEPT` / `FULL OUTER JOIN` on the server:** not used. Inferred: it
  would not handle cell-level change reporting, column mismatches, or engines
  without `EXCEPT`.

## Consequences

- **Positive:** the verdict is never silently partial, and the key and equality
  rules are always shown. Read-only is enforced twice (renderer and Rust).
  Postgres and MySQL compare against one snapshot.
- **Negative / trade-offs:** other engines run the two sides back to back and
  may see different data. Up to 2 × 100,000 rows are held in renderer memory and
  posted to a worker. There is no float tolerance and no case or whitespace
  folding. The diff uses one suggested key column, though the model accepts a
  `key: string[]`.
- **Follow-ups:** comparing across connections (ADR-0033 covers schema diff, not
  data), using a saved query or another tab as B, and exporting differences were
  all out of scope and are not implemented.
