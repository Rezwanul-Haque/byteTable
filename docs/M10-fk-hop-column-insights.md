# M10 — FK hop + column insights

> **Provenance:** this document describes the **shipped code** in `bytetable/` as the source of truth, cross-checked against `MILESTONES.md` (M10) and `DESIGN_SPEC.md` §3.5 ("grid superpowers"). Where the shipped behaviour differs from the milestone sketch, the shipped behaviour wins and the delta is called out explicitly. **Imperative phrasing = a requirement that the code already meets** (so a from-scratch rebuild must reproduce it). File paths are repo-relative to `bytetable/`.

## Goal

The two data-grid "superpowers" of `DESIGN_SPEC.md` §3.5, on the M4 browse grid:

1. **FK hop** — a foreign-key cell renders as an accent underlined link. Clicking it opens a **peek popover** (300px) that does a **single-row lookup by key** against the referenced table and shows the referenced row's fields, with an **"Open in {refTable}"** button that opens/focuses that table's data tab with its filter **seeded** to `refColumn = value`.
2. **Column insights** — a chart icon on each header (shown on header hover) opens a **280px popover** that computes per-column statistics (`COUNT`, `COUNT DISTINCT`, null %, `min`/`max`, `avg` for numerics, top-5 frequency) **over the grid's current filtered set**, asynchronously with a small spinner so it never blocks the grid.

Both run entirely against existing connection handles; M10 adds **two thin slices** — `browse::row_lookup` (FK peek) and `insights::column_stats` — over the engine port.

> **Shipped delta vs. the MILESTONES sketch.** The sketch lists a third scope item: *"Both features also work on SQL-result grids when columns map to a known table."* **This is NOT shipped.** The M6 SQL-results grid (`src/features/workspaces/components/SqlResultGrid.tsx`) reuses the shared `CellContent` for cell visuals but does **not** thread FK metadata or an insights icon, because a SQL result has **no per-column table origin** (an arbitrary `SELECT` projects/joins/aliases columns, so a column cannot be mapped to a base table+column). `GridCell.tsx` documents this explicitly: a cell "without `fk`/`onFkClick` … renders exactly as before, so the SQL-results grid — which has no per-column table origin — is unchanged." Both superpowers ship **on the browse table grid only** (`DataGrid.tsx`). The `CellContent` API is the seam: if a future milestone supplies a column→(table, fk) origin for SQL results, the link cell lights up with no rewrite.

## Dependencies

- **M4 grid** (`src/features/browse/components/DataGrid.tsx`, `GridCell.tsx`) — hosts the FK link cells and the per-header chart icon; the header/cell structure was left with extensibility seams (see the `DataGrid.tsx` header comment, ~L20–L25) so M10 slots in without a rewrite. Cell rendering is the shared `CellContent`.
- **M7 introspection** (`features::introspection`, `table_meta`) — supplies FK metadata. Each column's `fk: FkRef | null` (`{ table, column }`) comes from `tableMeta`, cached in the grid's `colMeta` map (`colMeta.get(c.name)?.fk`). The backend lookups (`fetch_row_by_key`, `column_stats`) also re-introspect (`table_meta_blocking`) to validate schema/table/column and obtain the column list.
- **M5 filters** (`src/features/browse/filter.ts`, the `FilterSpec` compilation) — the **seeded condition** for "Open in {table}" is a one-condition `FilterSpec` (`column = value`), and column insights pass the grid's **current applied `FilterSpec`** to the backend so stats reflect the visible set. The backend reuses the *same* parameterized `where_clause` compilation that `fetch_rows` uses.

---

## Backend (Rust core)

### Domain — column-stats model, FK peek result

There is **no per-slice domain or infrastructure**; both M10 slices are deliberately thin (see `src-tauri/src/features/insights/mod.rs` doc comment). The wire DTOs live in the shared kernel `src-tauri/src/shared/engine.rs` because every slice that talks to a connection shares them:

- **`RowLookupRequest`** (`engine.rs` ~L834) — `{ schema, table, column, value: serde_json::Value }`, `serde(rename_all = "camelCase")`. `column` is the *referenced* column (parent pk/unique key); `value` is the FK cell's key, **bound as a parameter**. A `null` value never matches `=` in SQL, so the adapter treats it as "no match" rather than emitting `IS NULL`.
- **`RowLookup`** (~L856) — `{ columns: Vec<ColumnMeta>, row: Option<Vec<Value>>, match_count: u64 }`. `columns` is **always** returned (even on a miss) so the UI can label empty fields; `row` is the first match (or `None`); `match_count` is the total matching rows so the UI can flag a non-unique key as "1 of N".
- **`ColumnStatsRequest`** (~L885) — `{ schema, table, column, filter: Option<FilterSpec> (#[serde(default)]) }`. `filter` omitted/`None` ⇒ stats over the whole table.
- **`ColumnStats`** (~L905) — `{ total, distinct, nulls: u64, min, max: Option<Value>, avg: Option<f64>, numeric: bool, top: Vec<FreqEntry> }`. `total` includes NULLs; `distinct` = `count(DISTINCT col)`; `min`/`max` always returned (lexicographic for text); `avg`/`numeric` only meaningful for numeric columns.
- **`FreqEntry`** (~L868) — `{ value: Value, count: u64 }`, one top-value pair.

The two engine-port methods are **default-`Err`-stubbed** on the `EngineConnection` trait (`engine.rs` ~L1265 `fetch_row_by_key`, ~L1281 `column_stats`) so an engine that has not implemented them returns a clean error rather than failing to compile.

### Application — compute stats against current filtered WHERE; single-row lookup by FK key

Both use-cases are one-liners delegating to the open connection behind a handle (cross-feature composition over `connections::ConnectionManager` at the application layer):

- **FK peek** — `src-tauri/src/features/browse/application.rs::fetch_row_by_key(manager, handle, req)` ⇒ `manager.get_sql(handle).await?.fetch_row_by_key(req).await`.
- **Column stats** — `src-tauri/src/features/insights/application.rs::column_stats(manager, handle, req)` ⇒ `manager.get_sql(handle).await?.column_stats(req).await`.

A closed/unknown handle is an `AppError::NotFound` whose message contains "closed" (unit-tested in both slices).

**Engine adapter logic** (SQLite is the reference; `src-tauri/src/engines/sqlite/mod.rs`; Postgres `engines/postgres/mod.rs` and MySQL `engines/mysql/mod.rs` mirror it):

- `fetch_row_by_key_blocking` (~L982): `table_meta_blocking` for existence → `validate_column` (unknown column = §5 error) → if `value` is null, short-circuit to `{ columns, row: None, match_count: 0 }` → else bind the value and run `SELECT * FROM {qualified} WHERE {col} = ? LIMIT 1`, then `SELECT count(*) … WHERE {col} = ?` for `match_count` (skipped, = 0, when no row matched). Identifiers are `quote_ident`'d; the value is **always bound**, never interpolated.
- `column_stats_blocking` (~L1085): validate → compile the optional filter with the **same `where_clause`** `fetch_rows` uses (`WhereClause::default()` when no filter), so the filter params bind first in every stat query. Then a handful of sequential aggregate scans in one `spawn_blocking` hop:
  - `SELECT count(*), count(*) - count({col}), count(DISTINCT {col}) FROM {q}{where}` → `(total, nulls, distinct)`.
  - `SELECT min({col}), max({col}) …` → `min`/`max` (NULL over an empty/all-NULL set maps to `None`).
  - **Numeric detection** is value-driven (matches SQLite's dynamic typing): numeric iff `non_null_count > 0` and `count(typeof(col) IN ('integer','real')) == non_null_count`. An all-NULL set is **not** numeric.
  - `avg({col})` only when numeric.
  - Top-5: `SELECT {col}, count(*) AS freq FROM {q}{where} AND {col} IS NOT NULL GROUP BY {col} ORDER BY freq DESC, {col} ASC LIMIT 5` (ties broken by value for stable output).
  - Performance note in-code: each is a single indexed-or-full scan, "comfortably <1s on the ~100k-row tables the prototype targets"; not merged into one statement for readability (SQLite caches table pages across the back-to-back scans).

### Tauri commands

| table | command | args | returns | errors |
|---|---|---|---|---|
| `browse` | `row_lookup` | `handle_id: ConnectionHandleId`, `req: RowLookupRequest` | `RowLookup` | `AppError` (§5) — `NotFound` (closed handle / unknown schema/table/column), engine errors via `map_query_error` |
| `insights` | `column_stats` | `handle_id: ConnectionHandleId`, `req: ColumnStatsRequest` | `ColumnStats` | `AppError` (§5) — same `NotFound`/validation/engine surfaces |

Defined in `src-tauri/src/features/browse/commands.rs` (`row_lookup`) and `src-tauri/src/features/insights/commands.rs` (`column_stats`); both `#[tauri::command] async fn`, read the connections feature's managed `ConnectionsState`, deserialize → use-case → serialize (no logic). Registered in `src-tauri/src/lib.rs`'s `generate_handler!` (`features::browse::commands::row_lookup`, `features::insights::commands::column_stats`).

---

## Frontend (React)

### State — insights store (stats, loading); FK peek state

There is **no separate Zustand store** for M10. Both popovers are **local component state owned by `DataGrid`** plus per-popover fetch state:

- In `DataGrid.tsx` (~L292): `const [fkPeek, setFkPeek] = useState<FkPeekAnchor | null>(null)` and `const [insights, setInsights] = useState<InsightsAnchor | null>(null)` — each holds the open popover's **anchor** (clicked-cell / header rect + target) or `null` when closed. `closeFkPeek`/`closeInsights` reset to `null`. **Only one of each is open at a time** (opening insights clears `fkPeek` and vice-versa).
- Each popover component owns its async state: `FkPeek` and `ColumnInsights` each hold `{ result|stats, error, loading }` and fetch in a `useEffect` with an **`alive` flag** so a stale response from a superseded anchor is dropped.

### API — typed invoke wrappers

`src/shared/api/engine.ts`:

- `rowLookup(handleId, req: RowLookupRequest): Promise<RowLookup>` → `invoke("row_lookup", { handleId, req })`.
- `columnStats(handleId, req: ColumnStatsRequest): Promise<ColumnStats>` → `invoke("column_stats", { handleId, req })`.

Errors surface as `{ kind, message }` and are rendered via `appErrorMessage(err, fallback)`.

### Components

- **FK link cell** — `src/features/browse/components/GridCell.tsx`. `CellContent({ value, column, fk?, onFkClick? })`: when `fk && onFkClick` and the value is non-NULL, the cell renders a keyboard-operable `<button className="fk-link">` (accent underlined; numbers show `toFixed(2)` for non-integers; `title="→ {table}.{column}"`). NULL FK values and cells without `fk`/`onFkClick` render with the normal type-aware rendering (so the SQL-results grid is unaffected). `DataGrid` only threads `fk` when the FK target column actually resolved (`fkMeta && fkMeta.column`) — an unresolvable implicit FK (`FkRef.column === ""`) renders as plain text.
- **Peek popover** — `src/features/browse/components/FkPeek.tsx`. `FkPeekAnchor = { rect, refSchema, refTable, refColumn, value }`. On mount/anchor-change it calls `rowLookup(handleId, { schema: refSchema, table: refTable, column: refColumn, value })`. 300px `role="dialog"`, anchored under the clicked cell and **viewport-clamped** (`popoverPos`). Title: link icon + mono `refTable` + dim `where {refColumn} = {value}` + a `1 of N` `fk-matchcount` badge when `matchCount > 1`. Body: spinner ("Looking up…") → error → **zebra field list capped at `MAX_FIELDS = 7`** (each field renders its value via `CellContent`) → "No matching row" when `row` is null but lookup succeeded. Footer: **"Open in {refTable}"** button (`open_in_new` icon). Closes on outside mousedown / Esc / window blur.
- **"Open in {table}"** — `DataGrid.onOpenInTable` (~L534) calls `useWorkspacesStore.getState().openTableTabWithFilter(refSchema, refTable, refColumn, value)` then closes the peek. The store action (`src/features/workspaces/state.ts` ~L366) builds a **seeded `FilterSpec`**: one applied `{ column, op: "eq", value: stringifySeed(value) }` condition (set as both `applied` and `draft`). If the table tab already exists it is **focused, forced to data mode, and its filter replaced** with the seed; otherwise a new data-mode table tab is opened with the seeded filter. `compileToSpec` retypes the string seed per the column's declared type at fetch time.
- **ColumnInsightsPopover** — `src/features/browse/components/ColumnInsights.tsx`. `InsightsAnchor = { rect, column }`. On mount/anchor-change it calls `columnStats(handleId, { schema, table, column, filter })` where `filter` is the grid's **current applied `FilterSpec`** (so insights match the visible set). 280px `role="dialog"`, anchored + viewport-clamped. Title: `monitoring` icon + mono column name + dim `{total} rows shown`. Body: spinner ("Computing…") → error → stat grid (`distinct`; `nulls (N%)` where `nullPct = round(nulls/total*100)`; `min`/`max` only when non-null; `avg` only when `numeric && avg !== null`) → **"Most frequent" top-5** with accent fill bars scaled to `top[0].count` (min width 4%) and labels truncated at 22 chars. **Async with a spinner; never blocks the grid** (the grid keeps scrolling/rendering while the fetch is in flight).
- **Header chart icon** — in `DataGrid.tsx` (~L865): a `<button className="insight-btn" title="Insights: {col}">` with the `monitoring` icon, rendered in every header cell and shown on header hover (`.dg-th:hover .insight-btn`). `onClick` → `onInsightClick` which `stopPropagation()`s (so the header's sort click does not fire), captures the icon's rect, clears any open FK peek, and sets the insights anchor.

**M11 coexistence (FK click vs. double-click edit):** `onFkClick` (~L517) **defers the hop on a 250ms timer**; a double-click on an FK cell calls `clearPendingHop()` (via the td's `onDoubleClick`) to cancel the deferred hop and enter edit instead. A lone single click runs the hop after the timer elapses.

### Styling — §3.5 popovers

All popover CSS is in `src/features/browse/components/Popovers.css`, byte-ported from `ByteTable.html`'s `.fk-*` / `.dg-popover` / `.dg-pop-*` / `.insight-*` rules:

- `.dg-popover` base, `.insight-pop` (280px), `.fk-peek` (300px); `.dg-pop-title` / `.dg-pop-mono` / `.dg-pop-dim` / `.dg-pop-empty`.
- `.fk-fields` / `.fk-field` (zebra via `:nth-child(odd)`) / `.fk-field-name` / `.fk-field-val`; `.fk-open-btn` (+ `:hover`); `.fk-matchcount`.
- `.insight-stats` / `.insight-stat` (label + bold value); `.insight-bars` / `.insight-bar-row` / `.insight-bar-label` / `.insight-bar-track` / `.insight-bar-fill` / `.insight-bar-n`.
- **Added beyond the prototype** (the prototype's calls were instant mocks): `.dg-pop-loading` / `.dg-pop-spinner` loading affordances and the `.fk-matchcount` ">1 match" badge.
- The FK link cell styling (`.fk-link`, accent underlined) lives with the grid cell styles.

---

## Shared data contracts — TS + Rust types

| Concept | Rust (`src-tauri/src/shared/engine.rs`) | TS (`src/shared/api/engine.ts`) |
|---|---|---|
| FK peek request | `RowLookupRequest { schema, table, column: String, value: Value }` | `RowLookupRequest { schema, table, column: string, value: CellValue }` |
| FK peek result | `RowLookup { columns: Vec<ColumnMeta>, row: Option<Vec<Value>>, match_count: u64 }` | `RowLookup { columns: ColumnMeta[]; row: CellValue[] \| null; matchCount: number }` |
| Stats request | `ColumnStatsRequest { schema, table, column, filter: Option<FilterSpec> }` | `ColumnStatsRequest { schema, table, column; filter?: FilterSpec \| null }` |
| Stats result | `ColumnStats { total, distinct, nulls: u64, min, max: Option<Value>, avg: Option<f64>, numeric: bool, top: Vec<FreqEntry> }` | `ColumnStats { total, distinct, nulls: number; min, max: CellValue; avg: number \| null; numeric: boolean; top: FreqEntry[] }` |
| Freq pair | `FreqEntry { value: Value, count: u64 }` | `FreqEntry { value: CellValue; count: number }` |
| FK metadata (from M7) | `FkRef { table, column: String }` (empty `column` = unresolved) | `FkRef { table: string; column: string }` |

All Rust DTOs are `#[serde(rename_all = "camelCase")]`; round-trip / camelCase wire-shape tests live in `engine.rs` (~L2279–L2420). `match_count` ⇄ `matchCount`. `CellValue = string | number | boolean | null` (booleans reachable since M12 Postgres).

---

## Behavior & edge cases

- **Async never blocks the grid.** Both popovers fetch in a `useEffect`; the grid continues to scroll/render. A stale response (anchor changed mid-flight) is discarded via the `alive` flag, so rapid header-icon clicks / FK clicks don't race.
- **One popover at a time.** Opening the insights popover clears any open FK peek and vice-versa. Outside-click, Esc, and window blur all close.
- **NULL / unresolved FK.** A NULL FK cell renders as `null`, not a link. An FK whose target column is unresolved (`FkRef.column === ""`) renders as plain text (no link), because the lookup has no key column to match on.
- **Null FK key lookup** short-circuits in the adapter to `{ row: None, match_count: 0 }` (no DB hit) — the honest "no referenced row" answer.
- **Non-unique key** → `match_count > 1` shows the first row plus a "1 of N" badge.
- **Insights respect the current filter.** The popover passes the grid's applied `FilterSpec`; the adapter compiles it with the same parameterized `where_clause` as `fetch_rows`, so "N rows shown" and every stat match the visible filtered set. No filter ⇒ whole-table stats.
- **Numeric vs. text columns.** `min`/`max` always render (text is lexicographic); `avg` and numeric formatting only when the adapter flags `numeric` (value-driven on SQLite).
- **<1s on a 100k-row column** — a handful of single-scan aggregates in one blocking hop; documented and tested as the perf target.
- **SQL-result grids:** FK links / insights are **not** wired (no per-column table origin) — see the goal-section delta. This is the shipped state; the `CellContent` seam supports adding it later.
- **Security:** `column` is validated against the table's real columns before quoting (§5 error otherwise); `value` (FK key) is bound as a parameter, never interpolated, so an injection payload binds as an inert literal that matches nothing.

## Acceptance criteria

- **FK hop (e.g. `orders.user_id`):** the cell is an accent underlined link; clicking it opens a 300px peek showing the referenced `users` row (≤7 fields, zebra), titled `users · where id = {value}`; "Open in users" opens/focuses the `users` data tab **filtered to `id = {value}`** so the grid shows that row. ✅ (`FkPeek.tsx`, `onOpenInTable` → `openTableTabWithFilter`.)
- **Non-unique referenced key** shows the first match with a "1 of N" badge. ✅
- **Column insights** on a column returns in **< 1s on a ~100k-row column** and the numbers **match the equivalent manual queries** (`count`, `count(DISTINCT)`, null count/%, `min`/`max`, `avg`, top-5 by frequency), computed over the **current filter**. ✅ (`column_stats` adapter; perf + correctness tests in the SQLite/Postgres/MySQL adapter modules.)
- **Insights never block the grid** — popover fetches async with a spinner; the grid stays interactive; stale results are dropped. ✅
- **Unknown schema/table/column** → §5 error message (not a stack trace) in the popover body. ✅
- **All three SQL engines** implement `fetch_row_by_key` + `column_stats` identically behind the port (SQLite/Postgres/MySQL); the renderer is engine-agnostic. ✅

## Pixel / UX checklist

- **FK cell**: accent **underlined** link, type-aware value text (numbers right-aligned / `toFixed(2)` for non-integers); `title="→ {table}.{column}"`; NULL FK = faint small-caps `null` (not a link).
- **Hint footer** (§3.5, 10.5 faint): "…click a linked value to hop the FK · ⊿ for column insights".
- **FK peek popover**: 300px; title = link icon (accent) + mono `refTable` + dim `where col = v`; "1 of N" badge only when `matchCount > 1`; zebra field list capped at 7; "Open in {table}" button with `open_in_new` icon; spinner while loading; anchored under the cell, viewport-clamped.
- **Insights chart icon**: `monitoring` icon button in each header, revealed on **header hover** (`.dg-th:hover .insight-btn`); does not trigger sort (stopPropagation).
- **Column insights popover**: 280px; title = `monitoring` icon (accent) + mono column + dim "{N} rows shown"; stat grid (distinct, nulls + %, min, max, avg-when-numeric); "Most frequent" top-5 with **accent fill bars scaled to the max count** (≥4% min width) and 22-char-truncated labels; spinner ("Computing…") while loading.
- Both popovers: `role="dialog"`, close on outside-click / Esc / blur; only one open at a time.
