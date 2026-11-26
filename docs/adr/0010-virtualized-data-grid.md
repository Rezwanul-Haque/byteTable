# ADR-0010 — Paged table grid, virtualized within the page

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature)
- **Area:** Data browsing
- **Related:** ADR-0003, ADR-0005, ADR-0007, ADR-0011, ADR-0012, ADR-0014, `docs/M4-tab-system-data-grid.md`

## Context

The table tab is the main surface of the app: open a table, see its rows, sort them, and
move through them. Tables can hold millions of rows. The renderer is a webview, so it
cannot hold or lay out a whole table, and every row has to cross the Tauri IPC boundary
as JSON. The same grid also has to work on SQLite, Postgres, MySQL, SQL Server and
ClickHouse, which differ in identifier quoting, placeholders and count cost.

The first version shipped on 2026-06-13 (`ff9b346` backend, `e927c45` grid, `36855ce`
merge). `docs/M4-tab-system-data-grid.md` records one change from the original sketch:
the grid uses explicit paging, not one scroll-driven window over the whole table.

## Decision

- **One page per fetch, virtualized within it.** `TableTab`
  (`src/features/workspaces/components/TableTab.tsx`) owns `offset` and `pageSize`. The
  default comes from `settings.defaultLimit`, with `DEFAULT_PAGE_SIZE = 300` as the
  fallback and a pager offering `PAGE_SIZE_OPTIONS = [50, 100, 300, 1000]`. `DataGrid`
  (`src/features/browse/sql/components/DataGrid.tsx`) fetches exactly that page and
  virtualizes its rows with `@tanstack/react-virtual` (`useVirtualizer`,
  `ROW_OVERSCAN = 12`). Above `COL_VIRT_THRESHOLD = 30` visible columns a second,
  horizontal virtualizer windows the columns too (`COL_OVERSCAN = 3`).
- **Thin Rust slice.** `src-tauri/src/features/browse/` has only `application.rs` and
  `commands.rs`. `rows_fetch(handle_id, req: FetchRowsRequest) -> RowsPage` resolves the
  handle through `ConnectionManager::get_sql` and calls `EngineConnection::fetch_rows`.
  The DTOs live in `src-tauri/src/shared/ports/sql/query.rs`. The SQL itself is built in
  each engine (`src-tauri/src/engines/<engine>/query.rs`, ADR-0003).
- **Adapter contract.** The adapter checks that the table exists, validates the sort
  column against the real columns before quoting it, emits `ASC`/`DESC` from the
  `SortDirection` enum, binds `LIMIT`/`OFFSET`, clamps the limit to
  `MAX_PAGE_ROWS = 10_000`, and runs `COUNT(*)` with the same WHERE as the page query, so
  `totalRows` is exact and follows the filter (ADR-0011). `skip_count: true` (added for
  ADR-0015) skips the count. Integers beyond ±2^53 are sent as strings.
- **Sort cycle.** Clicking a header cycles asc → desc → none. Sort and hidden columns
  are per-tab view state in `ui.tableViews[tabId]`, which is persisted. A sort change
  resets the pager to page 1.
- **Ephemeral result state is kept apart from persisted UI state.**
  `src/features/workspaces/tabMeta.ts` (global Zustand, keyed by tab id) holds
  `meta` (row count, timing), `scrollTop` (saved on unmount), `refetchNonce`,
  `discardNonce`, and a one-page `pageCache`. The cache lets a tab switch paint from
  memory and then revalidate quietly when its key (connection, table, sort, filter,
  paging) still matches.
- **Stale responses are dropped.** A `generationRef` is bumped on every reset, and a
  response from an older generation is ignored.
- **One cell renderer.** `CellContent` in `src/features/browse/shared/components/GridCell.tsx`
  draws NULL, numbers, booleans, pills, FK links, binary values and masked values. The
  SQL result grid (ADR-0019) uses it too.
- **Rows are cached by absolute index** (`offset + i`), so the row-number gutter and the
  primary-key logic for editing (ADR-0012) stay correct on any page.

## Alternatives considered

- **One virtual scroll over the whole table, fetching windows as you scroll.** This was
  the original sketch. M4 records the switch to explicit paging as "Bug-2 fix", but
  not why. Inferred reasons: it keeps a fixed memory ceiling, gives a scrollbar that
  matches what is loaded, and gives each page one `OFFSET`.
- **Keyset (cursor) paging instead of `OFFSET`.** Not adopted. Inferred: arbitrary
  sorts, filters and tables without a usable key make keyset paging hard to apply
  everywhere. `OFFSET` is uniform across engines.
- **Estimated or cached counts.** Not adopted for the grid. The count is exact on every
  fetch. Only lineage opts out, through `skip_count`.
- **Keeping sort in local component state.** M4 originally did this. It was later moved
  into persisted `tableViews` so that sort survives a remount.

## Consequences

- **Positive:** the DOM size and the fetched data are bounded by one page (at most
  10,000 rows, at most about 30 rendered columns). Sorting and counting run in the
  database. The browse slice does no engine-specific work.
- **Positive:** tab switches are cheap because of `pageCache`, and scroll position
  survives switching workspaces.
- **Negative / trade-offs:** an exact `COUNT(*)` on every fetch can be slow on large
  tables. Deep `OFFSET` pages get slower as the offset grows. Moving past the current
  page is a pager click, not a scroll.
- **Negative / trade-offs:** `DataGrid.tsx` is about 2,700 lines. It also holds
  staging, the inspector bridge, the FK peek, insights and masking (ADR-0012 to
  ADR-0017).
- **Follow-ups:** non-SQL engines have their own grids (for example
  `src/features/browse/dynamo/components/DynamoItemGrid.tsx`) and do not use this one.
