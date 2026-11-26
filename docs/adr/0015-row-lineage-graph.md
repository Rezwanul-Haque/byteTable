# ADR-0015 — Row lineage built in the renderer from bounded existing reads

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-11-26 (first commit that shipped the feature)
- **Area:** Data browsing
- **Related:** ADR-0007, ADR-0010, ADR-0013, ADR-0014, ADR-0017, ADR-0028, ADR-0030, ADR-0031

## Context

From one row, users want to follow foreign keys in both directions: "this order, its
customer, its items, its payments". The FK peek (ADR-0014) covers only one hop outward.
The feature was built to four rules:

- declared foreign keys only;
- broken or empty references are shown, not hidden;
- read-only;
- bounded, so that a table with a million referencing rows does not slow the tab.

It is scoped to SQL engines and single-column keys.

Shipped in `01bfa9c` (2026-11-26).

## Decision

- **A new tab kind, no new Rust slice.** `Tab` gains `{ kind: "lineage", schema,
  trail: LineageStop[], at }` in `src/features/workspaces/types.ts`.
  - `openLineageTab(schema, table, key)` in `src/features/workspaces/state.ts` focuses
    an existing tab whose `trail[0]` is that row, or opens a new one.
  - "Walking" to a related row appends to `trail` and moves `at`
    (`setLineageTrail`). The trail lives on the tab because only the active tab is
    mounted.
- **The FK graph comes from introspection.** `src/features/lineage/model.ts` builds a
  `TableShape { pk, columns, fks, refs }` from cached `TableMeta`. The header comment
  says "Only DECLARED foreign keys count … never guessed from a column name". Composite
  keys are left out. `hooks/useLineageTable.ts` warms the cache and returns the table's
  single-column pk when lineage applies, or null.
- **Loading is a fixed number of bounded queries** (`src/features/lineage/load.ts`),
  all through the existing `rows_fetch` / `row_lookup`, so values stay bound:
  - centre row: one lookup by pk;
  - parents: one `IN (…)` per (target table, column);
  - each child stack: the first `CHILD_LIMIT = 8` rows (with `skip_count`) and a count
    via `row_lookup`'s `matchCount`, side by side;
  - second-hop labels: one `IN (…)` per target table, at most `MAX_IN = 200` values;
  - each query has a `QUERY_TIMEOUT_MS = 10_000` timeout, and at most
    `MAX_PARALLEL = 4` stacks load at once.
  Results stream into `LineageData` through an updater keyed by
  handle, schema, table and key, so replies from an older row are dropped. A slow
  count shows "count unavailable" without holding back the rows.
- **One backend change.** `FetchRowsRequest.skip_count` (`#[serde(default)]`) in
  `src-tauri/src/shared/ports/sql/query.rs`, implemented in every SQL adapter, so a
  stack's first 8 rows do not wait on `COUNT(*)` over a large match set.
- **Canvas.** `components/LineageTab.tsx` draws parents on the left, the centre, and
  one stack per referencing table on the right, with curved links. It has pan / zoom /
  drag via `shared/ui/canvasView` and `useWheelNavigation` (shared with the
  Brainstorm board, ADR-0031) and a side panel. `graph.ts` derives labels, hops and
  facts on every render, so they follow masking as soon as it changes (ADR-0017).
  Dragging moves cards on screen only.
- **Entry points.**
  - The row inspector header shows `LineageLink`, but only when the table is linked,
    the row has a single-column key, and the row is not a staged new row (ADR-0013).
  - The FK peek shows "Trace this row" (ADR-0014).

## Alternatives considered

- **A dedicated Rust lineage command doing the traversal server-side.** Not built.
  Inferred: composing the existing `rows_fetch` / `row_lookup` reuses their validation,
  binding and binary-key support, and lets each stack stream in on its own.
- **Inferring links from column names (`user_id` → `users`).** Rejected by
  rule 1.
- **Drawing more than one hop as nodes, saving layouts, exporting the graph.** Out of
  scope. The second hop is text only.

## Consequences

- **Positive:** the work per open is fixed regardless of row counts. The feature is
  read-only by construction, since it calls only read commands. The rest of the graph
  survives a failed or slow stack, which has its own Retry.
- **Negative / trade-offs:**
  - Tables with composite or missing primary keys, views and non-SQL engines get no
    lineage.
  - A query past its timeout is abandoned, not cancelled (comment on
    `QUERY_TIMEOUT_MS`), so it can keep running on the server.
- **Negative / trade-offs:** only declared constraints count. Schemas that rely on
  implicit FKs show nothing.
- **Follow-ups:** lineage from SQL result rows or the command palette, composite keys,
  and layout saving are out of scope for now.
