# ADR-0014 — FK peek / hop and column insights as thin engine-port lookups

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature)
- **Area:** Data browsing
- **Related:** ADR-0003, ADR-0010, ADR-0011, ADR-0015, ADR-0017, ADR-0028, `docs/M10-fk-hop-column-insights.md`

## Context

Two grid features the design spec names in §3.5:

- **FK hop:** a foreign-key cell links to the row it references. The user can peek at
  that row and open its table filtered to it.
- **Column insights:** per-column statistics (count, distinct, nulls, min/max, avg, top
  values) computed over what the grid currently shows.

Both need foreign-key metadata from introspection (ADR-0028). Both must not block the
grid, and both must stay safe against key values and filters taken from user data.

Shipped on 2026-06-13: `3f82077` (backend), `a7b7848` (popovers), `ec85320` (merge).

## Decision

- **Two thin commands over the engine port.**
  - `row_lookup(handle_id, req: RowLookupRequest) -> RowLookup` lives in
    `src-tauri/src/features/browse/commands.rs`. It returns `columns`, the first
    matching `row`, and `match_count`.
  - `column_stats(handle_id, req: ColumnStatsRequest) -> ColumnStats` lives in
    `src-tauri/src/features/insights/`. It returns `total`, `distinct`, `nulls`,
    `min`/`max`, `avg`, `numeric` and the top 5 values.
  Both slices only route to `EngineConnection::fetch_row_by_key` / `column_stats`.
  Those methods have default `Err` stubs in `src-tauri/src/shared/ports/sql/conn.rs`,
  so an engine without them fails cleanly. SQLite, Postgres, MySQL, SQL Server and
  ClickHouse implement both.
- **Adapter rules.**
  - The lookup validates the column and binds the key value.
  - A null key short-circuits to "no match" with no query.
  - `binary: true` binds `0x`/UUID text as raw bytes, so binary keys match.
  - `column_stats` compiles the grid's current `FilterSpec` with the same `where_clause`
    as `fetch_rows` (ADR-0011), so the stats describe the filtered set.
  - The SQLite adapter runs the aggregates as a few sequential scans in one blocking
    hop, and decides `numeric` from the values (`typeof`), not the declared type.
- **No store.** The popovers are local state in `DataGrid` (`fkPeek`, `insights`
  anchors). Only one is open at a time.
  - `FkPeek.tsx` fetches in an effect and drops stale replies with an `alive` flag. It
    shows at most `MAX_FIELDS = 7` fields and a "1 of N" badge when the key is not
    unique.
  - `ColumnInsights.tsx` fetches the same way.
  - Both are in `src/features/browse/sql/components/`, styled by `Popovers.css`.
- **The hop is a seeded filter.** "Open in {table}" calls
  `openTableTabWithFilter(refSchema, refTable, refColumn, value)` in
  `src/features/workspaces/state.ts`. It focuses or opens that table's data tab, with
  one applied `eq` condition as both `draft` and `applied`. The hop resolves to the
  active tab copy when the table is open twice (ADR-0007).
- **Click vs. double-click.** A click on an FK cell schedules the hop on a 250ms timer.
  A double-click calls `clearPendingHop()` and enters inline edit (ADR-0012) instead.
- **FK links only when resolvable.** The grid passes `fk` to `CellContent` only when the
  target column resolved. NULL FK values render as plain `null`.
- **Later additions.**
  - The peek can copy a binary key's UUID or its stored-bytes form (`40d0121`).
  - It offers "Trace this row" into lineage (ADR-0015).
  - Values in both popovers go through masking (ADR-0017).

## Alternatives considered

- **A JOIN in the page query to show referenced data inline.** Not built. Inferred:
  the peek fetches one row on demand, which keeps the page query a plain `SELECT *`.
- **Computing stats in the renderer from the loaded page.** Not chosen. The stats run
  over the whole filtered set in the database, so they describe more than the visible
  page (inferred from the request design).
- **FK links and insights in SQL result grids.** Deliberately not shipped. M10 records
  that an arbitrary `SELECT` has "no per-column table origin", so a result column cannot
  be mapped to a base table.

## Consequences

- **Positive:** both features reuse the bound-parameter and filter compilation paths,
  and each engine adds two adapter methods rather than new slices.
- **Positive:** the async popovers never block scrolling, and stale replies are
  dropped.
- **Negative / trade-offs:** `column_stats` runs several full or indexed scans per open.
  On large unindexed tables that costs real database time. The M10 target was under 1s
  on about 100k rows.
- **Negative / trade-offs:** the 250ms hop delay adds latency to every FK click so that
  double-click edit can still work.
- **Follow-ups:** FK links and insights are absent from SQL result grids and from
  non-SQL engine grids.
