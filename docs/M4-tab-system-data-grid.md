# M4 — Tab system + data grid

Status: shipped, merged on `main` (`feat: M4 — tab system + virtualized data grid`).

> **Provenance:** this document is reconstructed from the SHIPPED code, not the
> design sketch — where the prototype/handoff and the code differ, the code
> wins and the delta is called out. Source of truth: `MILESTONES.md` M4,
> `DESIGN_SPEC.md` §3.4 (tab bar) / §3.5 (data grid) / §3.10 (status bar), and
> the files cited inline. **Imperative mood = a requirement** a rebuild MUST
> satisfy; prose marked "shipped:" records a decision already made.
>
> Two notable deltas from the §3.5 sketch, both load-bearing:
>
> 1. **Explicit paging, not scroll-driven windowing.** The grid does NOT
>    virtualize the whole table. The table tab owns `offset` + `pageSize`, a
>    bottom **pager** (prev/next/page-size) moves the window, and the grid
>    fetches EXACTLY one page (`rows_fetch(..., { offset, limit: pageSize })`)
>    then virtualizes WITHIN that page with `@tanstack/react-virtual`. (Bug-2
>    fix in `DataGrid.tsx` — the prototype's `.table-footer` pager.)
> 2. **Three commands serve the grid surface but only two ship in this slice.**
>    `rows_fetch` (the page) and `row_lookup` (FK peek, wired in M10) live in
>    the browse slice; the cell `row_update` is the **mutate** slice (M11). All
>    wire DTOs live in `shared::engine`, shared across slices.

## Goal

The heart of the app: a tab system that hosts table/SQL/map tabs per workspace,
and a fast type-aware data grid behind page-wise `LIMIT`/`OFFSET` fetches with a
real `ORDER BY` and an exact `COUNT(*)` "N rows" status. Tabs and per-tab scroll
survive workspace switches.

## Dependencies — M0–M3, virtualization lib actually used

- **M0** design system / tokens — `--grid-row-h` (26/32px by density),
  `--grid-fs`, `--accent`, `--number`, `--bg0/1/2`, `--border`
  (`src/shared/styles/tokens.css`).
- **M1** workspace rail + connect screen — `WorkspaceShell` / `Workspace`.
- **M2** SQLite connections — open `handleId`, `ConnectionManager`,
  `EngineConnection` port; the engine adapter that runs the page query.
- **M3** sidebar + introspection — the introspection cache the grid warms for
  pk/fk/type column meta (`useIntrospectionStore.loadColumns`); the sidebar's
  "Open data" is the primary entry that opens a table tab.
- **Virtualization library (shipped): `@tanstack/react-virtual` `3.13.12`**
  (`package.json`), used via `useVirtualizer` in `DataGrid.tsx`. It virtualizes
  the rows of the CURRENT page only.
- **zustand** for the workspaces store + the ephemeral `tabMeta` store.

## Backend (Rust core)

The browse slice is deliberately thin: no domain or infrastructure of its own
(`src-tauri/src/features/browse/mod.rs`). Wire DTOs live in
`crate::shared::engine`; engine-specific SQL lives in `crate::engines::*`
behind the `EngineConnection` port; open handles are owned by the connections
feature's `ConnectionManager` (consumed at the application layer — sanctioned
cross-feature composition).

### Domain / Ports / Application — paged query (limit/offset), sort, row count

- **Port** (`shared::engine`, `EngineConnection` trait): `fetch_rows(req:
FetchRowsRequest) -> Result<RowsPage, AppError>` and `fetch_row_by_key(req:
RowLookupRequest) -> Result<RowLookup, AppError>`.
- **Application** (`features/browse/application.rs`):
  - `fetch_rows(manager, handle, req)` → `manager.get_sql(handle).await?.fetch_rows(req).await`.
  - `fetch_row_by_key(manager, handle, req)` → same shape (M10 FK peek).
  - No Tauri, no drivers; a closed/unknown handle is a §5 `AppError::NotFound`
    whose message contains "closed".
- **Paging model:** `offset` (u64, zero-based) + `limit` (u32). The adapter
  clamps `limit` to `MAX_PAGE_ROWS` (shipped = **10_000**; one constant per
  engine module). Offset/limit are BOUND as parameters, never interpolated.
- **Sort:** `req.sort: Option<SortSpec> { column, direction: Asc|Desc }`. The
  adapter validates `column` against the table's real columns (unknown column →
  §5 error) before quoting it, and emits the fixed `ASC`/`DESC` keyword from the
  enum — `SortDirection::sql_keyword()` — so the direction carries no injection
  surface. `None` leaves order to the engine.
- **Row count:** `RowsPage.total_rows: Option<u64>` is an EXACT `COUNT(*)`
  matching the request (whole table in M4; the _filtered_ count once M5 adds a
  `FilterSpec`). Computed per fetch. `None` means the count could not be
  obtained.

### Infrastructure — engine query exec w/ timing

SQLite adapter, `src-tauri/src/engines/sqlite/mod.rs`
(`fetch_rows_blocking`, ~L880–966); MySQL (`engines/mysql/mod.rs` ~L300) and
Postgres (`engines/postgres/mod.rs` ~L300) mirror it. Shipped order of work:

1. `table_meta_blocking(schema, table)` — existence check first (unknown
   schema/table → §5 human messages) AND the real column list for validation.
2. Build `ORDER BY` from the validated `SortSpec` (column quoted via
   `quote_ident`, direction from the enum keyword); `None` → no clause.
3. Build the optional `WHERE` body + bound params (M5; empty in M4).
4. `limit = req.limit.min(MAX_PAGE_ROWS)`; `qualified = "schema"."table"`.
5. `SELECT count(*) FROM {qualified}{where}` → `total_rows` (filter params bind
   first; no limit/offset on the count).
6. `SELECT * FROM {qualified}{where}{order_by} LIMIT ? OFFSET ?` — WHERE params,
   then `limit`, then `offset` bound positionally.
7. Map columns from `stmt.columns()` → `ColumnMeta { name, type_hint }`
   (`type_hint` = `decl_type()`, may be empty). Map each value to JSON:
   NULL → null, int/real → number, text → string, **integers beyond ±2^53 →
   string** (JS safe-integer precision), blobs → adapter placeholder.
8. `elapsed_ms = started.elapsed()` — real timing, surfaced to the status bar.

### Tauri commands — `features/browse/commands.rs`

Registered in `src-tauri/src/lib.rs` `generate_handler!`. Deserialize →
use-case → serialize; no logic. All `async fn` (real DB work). Commands read
the connections feature's managed `ConnectionsState` for the handle manager.

| command      | args                                                     | returns     | errors                                                                                                     |
| ------------ | -------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `rows_fetch` | `handle_id: ConnectionHandleId`, `req: FetchRowsRequest` | `RowsPage`  | `NotFound` (closed/unknown handle, msg contains "closed"); §5 unknown schema/table; §5 unknown sort column |
| `row_lookup` | `handle_id`, `req: RowLookupRequest`                     | `RowLookup` | as above; §5 unknown lookup column (M10 FK peek; not exercised by M4 itself)                               |

> `query_run` (connections slice) and `row_update` (`features/mutate/commands.rs`,
> M11) are NOT part of M4 but share the grid surface — `query_run` feeds the M6
> SQL result grid, `row_update` powers inline edit. M4 ships only `rows_fetch`.

## Frontend (React)

### State — tabs store + status-bar/result state

**Tabs store** (`src/features/workspaces/state.ts`, zustand; types in
`types.ts`). Tabs live on each workspace's `ui` object
(`WorkspaceUiState.tabs` + `activeTabId`), so switching workspaces preserves
each workspace's open tabs + active tab **for free** (the per-workspace `ui`
pattern). All tab actions go through `patchActiveUi` and operate on the
**active** workspace only (no-ops when none active). Opening a tab is
synchronous — never touches the backend; the grid fetches lazily on mount.

- **Tab kinds** (discriminated union `Tab`):
  - `table` — `{ id, kind, schema, table, mode: "data" | "structure" }`.
  - `sql` — `{ id, kind, title } & SqlTabState` (M6; carries `text/result/error/history`).
  - `map` — `{ id, kind, schema }` (M9, one per schema).
- **Focus-not-duplicate** (§3.4): `openTableTab(schema, table, mode?)` focuses
  an existing `table` tab matching `schema`+`table` (optionally switching its
  mode) instead of opening a second. `openMapTab(schema)` focuses an existing
  map for the same schema. SQL tabs always open fresh ("Query N").
- **Order:** tabs render left-to-right in array order; new tabs append.
- **Active:** `activeTabId` (always references a tab in `tabs`, or `null`).
  `closeTab` re-picks the left neighbour (else right, else `null` →
  EmptyState), and prunes the closed tab's `filters`/`structureEdits` entries.
- **Per-tab SQL numbering:** module-local `sqlCounters` keyed by workspace id;
  only increments; pruned via a store subscription when a workspace closes
  (kept out of persisted `ui`).
- Actions: `openTableTab`, `openTableTabWithFilter` (M10 FK-hop seed),
  `openSqlTab`, `openSqlTabWith`, `openMapTab`, `closeTab`, `setActiveTab`,
  `setTableTabMode`, plus M5/M6/M8 actions.

**Ephemeral result + scroll/refresh store** (`tabMeta.ts`, zustand, GLOBAL —
keyed by globally-unique tab id, so it spans workspaces). Deliberately separate
from persisted `ui` because counts/timing/scroll are ephemeral _result_ state
and high-frequency:

- `meta[tabId]: { totalRows?, shownRows?, elapsedMs? }` — the grid reports
  `totalRows` + `elapsedMs` after each fetch; the toolbar + status bar read it.
- `scrollTop[tabId]` — grid vertical scroll, committed on UNMOUNT only (churn
  rule), restored on remount → **scroll persists across workspace switches**.
- `refetchNonce[tabId]` — monotonic; the toolbar's refresh + retry bump it, the
  mounted grid watches its own nonce and re-fetches (declarative seam, nothing
  to unregister).
- `rowCountLabel(meta)` — shared "N rows" / "n of N rows" / "— rows" formatter
  (toolbar + status bar use it so they never drift).
- **Per-tab paging state** (`offset`, `pageSize`) is LOCAL to `TableTab` (not
  persisted) — resets to page 1 on identity/sort/filter change.
- **Per-tab sort state** is LOCAL to `DataGrid` (`useState<SortSpec | null>`).

**Status bar state** (`StatusBar.tsx`): reads the active workspace + the active
tab's `tabMeta`. Shows context info only for `table` tabs:
`rowCountLabel(meta)` + ` · {elapsedMs} ms` once timing lands.

### API — typed invoke wrappers (`src/shared/api/engine.ts`)

```ts
rowsFetch(handleId, req: FetchRowsRequest): Promise<RowsPage>   // invoke("rows_fetch", { handleId, req })
rowLookup(handleId, req: RowLookupRequest): Promise<RowLookup>  // invoke("row_lookup", …) — M10
```

camelCase wire shape matches the Rust `#[serde(rename_all = "camelCase")]`
DTOs. Errors come back as `{ kind, message }`; render via
`appErrorMessage(err, fallback)` (`shared/api/error`).

### Components

| component                    | file                                                     | role                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TabBar**                   | `features/workspaces/components/TabBar.tsx` (+ `.css`)   | 37px strip: kind-icon + mono title + close ×; active = 2px accent top bar; "+" → new SQL tab; trailing terminal toggle (M14).                       |
| **Tab** (row)                | same file                                                | one `role="tab"` div: icon (`table`/`account_tree` in structure mode / `terminal` for sql / `hub` for map), `tab-title`, hover/active close button. |
| **DataGrid**                 | `features/browse/components/DataGrid.tsx` (+ `.css`)     | virtualized rows of ONE page, sticky header, sticky row-number gutter, sort, FK/insights/edit seams.                                                |
| **GridCell** (`CellContent`) | `features/browse/components/GridCell.tsx`                | the ONLY place `.cell-*` visuals are produced; shared with the M6 SQL result grid.                                                                  |
| **TableTab**                 | `features/workspaces/components/TableTab.tsx` (+ `.css`) | toolbar (Data/Structure seg, Filters, WHERE readout, refresh, "N rows"), hosts `DataGrid`, owns the bottom **pager** + hint footer.                 |
| **StatusBar**                | `features/workspaces/components/StatusBar.tsx`           | §3.10 bottom strip.                                                                                                                                 |
| **WorkspaceContent**         | `features/workspaces/components/WorkspaceContent.tsx`    | routes the active tab to TableTab / SqlEditorTab / map placeholder / EmptyState; renders TabBar.                                                    |

**TabBar** (`TabBar.tsx`): `tabIcon(tab)` maps kind → Material Symbol with the
structure-mode swap; `tabTitle(tab, defaultSchema)` → bare `table` for the
default schema, else `schema.table`; SQL → `title`; map → `schema · map`.
Middle-click (`mouseDown` button 1) closes (§3.4/§3.12). Keyboard: Enter/Space
select, Delete/Backspace close; `role="tablist"`/`role="tab"`/`aria-selected`.

**DataGrid** (`DataGrid.tsx`) — props from `TableTab`: `handleId`, `tabId`,
`schema`, `table`, `filter`/`filterKey` (M5), `hiddenColumns` (M15),
**`offset`**, **`pageSize`**, `onSortChange`. Behavior:

- One `rows_fetch` per `(handleId, schema, table, sort, filterKey, refetchNonce,
offset, pageSize)` generation; a `generationRef` discards stale late responses.
- Page rows cached by **absolute** index (`offset + i`) in a ref so the row
  gutter + edit pk logic stay correct across pages; `pageRowCount` drives the
  virtualizer count; absent rows render a shimmer skeleton.
- `useVirtualizer({ count: pageRowCount, estimateSize: () => rowHeight,
overscan: 12 })`; `rowHeight` read live from `--grid-row-h` and re-measured
  via a `MutationObserver` on `:root[data-density]`.
- **Explicit per-column pixel tracks** (Bug 1): each row is its own CSS grid, so
  the grid measures one width per visible column once
  (`clamp(max(header intrinsic, widest sampled cell), 90, 400)px`, gutter
  `38px`) and builds `--grid-cols` so header + body align. Hidden columns drop
  their track but stay in the row cache (fetch is full-width).
- **Sort cycle** `cycleSort`: header click cycles **asc → desc → none(null)**;
  the active column shows `arrow_upward`/`arrow_downward` in accent. A sort
  change fires `onSortChange()` (TableTab resets `offset` to 0) then flips local
  sort → re-fetch with real `ORDER BY`.
- Selected cell tracked in `selected: {row, col}`; row gets `.row-selected`,
  cell gets `.cell-selected` (1.5px accent inset outline).
- States: full-screen error (with Retry → `requestRefetch`), loading
  ("Loading {schema}.{table}…"), empty ("Empty table…" / "No rows match…").
- Seams present but owned by later milestones: FK link click (M10), header
  insights icon (M10), double-click inline edit (M11).

**GridCell** (`CellContent`): NULL → `.cell-null` (italic faint small-caps
"null"); `number` → `.cell-num` (right-aligned, `--number` `#7fb8e8`);
`boolean` → `.cell-true` (accent) / `.cell-false` (`#e06c75`); string in a pill
column (`status`/`method`) with a known enum value → `.cell-pill` tinted
`{color}1a`; FK value (M10, when `fk`+`onFkClick`) → `.fk-link` accent
underlined button; else `.cell-text`.

**Pager** (in `TableTab`): `DEFAULT_PAGE_SIZE = 300`, options `[50, 100, 300,
1000]`. Reads `meta.totalRows` for the range readout
`"{from}–{to} of {total} · Page p of pages"`; prev disabled at `offset === 0`,
next disabled when count unknown or `offset + pageSize >= total`. Hint footer
(§3.5 copy): "Double-click a cell to edit · click a header to sort · stack
conditions under Filters · click a linked value to hop the FK · ⊿ for column
insights".

### Styling

- **§3.5 grid** (`DataGrid.css`): header `.dg-th` **height 30px**, `--bg1`,
  bottom+right `--border`, name 11.5px / type label 9.5px faint, pk key icon
  (rotated 45°, accent) + fk `link` icon + sort arrow (accent). Body `.dg-td`
  **height `var(--grid-row-h)` = 26px compact / 32px comfortable** (density via
  `:root[data-density]`). Row-number gutter `.dg-rownum` sticky-left, **min-width
  38px**, 10px faint, right-aligned. Cell colors: `.cell-null` faint italic
  small-caps; `.cell-num` `--number`; `.cell-true` accent / `.cell-false`
  `#e06c75`; `.cell-pill` r99 tinted `{color}1a`. Row hover tint (`--bg2` 70%);
  `.row-selected` accent 7% tint; **`.cell-selected` outline `1.5px solid
--accent`, offset `-1.5px`, r2** (the selected-cell outline).
- **§3.10 status bar** (`StatusBar.css`): 28px, `--bg1`, top border — ws color
  chip · name (600) · `EnvTag` · server version (mono faint) · tunnel lock
  (when tunneled; SQLite never) · "schema: x" · spacer · context info (rows ·
  timing for table tabs) · "UTF-8". (Prototype "mock engine" tag intentionally
  dropped.)
- **§3.4 tab bar** (`TabBar.css`): 37px, `--bg1`; active tab `--bg0` + 2px
  accent top bar; close × visible on hover/active; **middle-click closes**;
  strip scrolls horizontally with hidden scrollbar (overflow). "+" → new SQL.
- **Keyboard** (`WorkspaceShell.tsx`): **⌘/Ctrl+T → new SQL tab**
  (`openSqlTab`); **⌘/Ctrl+K → command palette** (`CommandPalette`, ships with
  table-jump + structure + map + saved queries + new SQL + close). (⌃` toggles
  the M14 console — not part of M4.)

## Shared data contracts — TS + Rust types

Rust in `src-tauri/src/shared/engine.rs`; TS mirror in
`src/shared/api/engine.ts`. camelCase on the wire.

**Row value** — `CellValue = string | number | boolean | null` (TS) ↔ JSON-
mapped `serde_json::Value` (Rust); big ints (>±2^53) arrive as `string`;
`boolean` reachable only from Postgres (M12). NULL → `null`.

**Column meta** — `ColumnMeta { name: string; typeHint: string }` ↔ `ColumnMeta
{ name, type_hint }`. `typeHint` is display only.

**Sort** — `SortSpec { column: string; direction: "asc" | "desc" }` ↔
`SortSpec { column, direction: SortDirection }`.

**Page request** — `FetchRowsRequest { schema, table, sort: SortSpec | null,
filter?: FilterSpec | null, offset: number, limit: number }` ↔ Rust
`FetchRowsRequest { schema, table, sort: Option<SortSpec>, filter:
Option<FilterSpec>, offset: u64, limit: u32 }`. (`filter` is the M5 seam; M4
sends `null`/omits it.)

**Page response** — `RowsPage { columns: ColumnMeta[]; rows: CellValue[][];
offset: number; limit: number; totalRows: number | null; elapsedMs: number }` ↔
Rust `RowsPage { columns, rows: Vec<Vec<Value>>, offset, limit, total_rows:
Option<u64>, elapsed_ms: u64 }`. `offset`/`limit` echo the (clamped) request.

**Row lookup (M10 seam)** — `RowLookupRequest { schema, table, column, value }`
→ `RowLookup { columns, row: CellValue[] | null, matchCount }`.

## Behavior & edge cases

- **1M-row table at 60fps:** met via explicit paging + within-page
  virtualization. The grid never holds more than one page (`pageSize`, default
  300, max `MAX_PAGE_ROWS` = 10_000) of DOM-windowed rows; `COUNT(*)` is exact.
  Scrolling within a page is `@tanstack/react-virtual`'d (overscan 12); moving
  beyond the page is a pager fetch, not a scroll.
- **Focus-not-duplicate:** re-opening an already-open `schema.table` focuses the
  existing tab (and can switch its data/structure mode); never a duplicate. Map
  tabs are one-per-schema.
- **Scroll + tab persistence across workspace switch:** tabs + `activeTabId`
  live in per-workspace `ui` (preserved on switch); `scrollTop` lives in the
  global `tabMeta` store keyed by tab id, committed on grid unmount and restored
  on remount once the canvas has its full height (so it doesn't snap to 0).
- **Sort cycle asc → desc → none → real `ORDER BY`:** local sort state drives
  `rows_fetch.sort`; the adapter validates the column and emits the enum
  keyword; clearing sort omits `ORDER BY` (engine order). A sort change resets
  paging to page 1.
- **Refresh / retry:** `tabMeta.requestRefetch(tabId)` bumps a nonce → the grid
  resets its generation, clears the page cache, re-fetches + re-counts.
- **Stale-response guard:** `generationRef` discards any `rows_fetch` resolution
  from a superseded generation (fast sort/page toggling can't render stale rows).
- **Big integers:** rendered as their string form (precision preserved); right-
  aligned only when actually a JS `number`.
- **Empty / no-pk / unknown column:** empty table → empty state; unknown sort
  column → §5 error in the full-screen error state with Retry; the count being
  `null` shows "— rows" and disables next.
- **Close last tab → EmptyState**; close active tab → left-neighbour active.

## Acceptance criteria

- Open **5 tabs across 2 workspaces** (mix of table/SQL); switch workspaces back
  and forth — each workspace shows ITS tabs, its active tab, and each grid
  restores its prior scroll position.
- **Sort a 100k-row table < 500ms perceived:** header click re-fetches page 1
  with `ORDER BY`; the exact `COUNT(*)` + first page return well under the
  budget on SQLite.
- Re-opening an open table focuses it (no duplicate); a map opens once per
  schema.
- Status bar shows the active table tab's "N rows · X ms" from real backend
  timing; "— rows" before the first fetch resolves.
- Page-size + prev/next move the window; the range readout
  ("{from}–{to} of {total} · Page p of pages") stays correct; next disabled on
  the last page.
- ⌘T opens a new SQL tab; ⌘K opens the palette; middle-click closes a tab.

## Pixel / UX checklist

- [ ] Tab bar 37px, `--bg1`; active tab `--bg0` + 2px accent top bar; close ×
      on hover/active; "+" right of tabs; strip scrolls horizontally (hidden
      scrollbar); middle-click closes.
- [ ] Tab title mono 11.5; `schema.table` only for non-default schema; sql =
      "Query N"; map = "schema · map".
- [ ] Header row **30px**, `--bg1`; column name 11.5 + type 9.5 faint; pk key
      icon rotated 45° accent, fk `link` icon; active sort arrow accent
      (up=asc / down=desc).
- [ ] Body row height **26px compact / 32px comfortable** (`--grid-row-h`, live
      density swap).
- [ ] Row-number gutter sticky-left, **38px**, 10px faint, right-aligned;
      shows absolute `index+1`.
- [ ] Cell colors: NULL italic faint small-caps; number `--number` `#7fb8e8`
      right-aligned; boolean accent(true)/`#e06c75`(false); status/method enum
      pills tinted `{color}1a`, r99.
- [ ] Row hover tint; **selected cell = 1.5px accent inset outline** (offset
      -1.5px, r2); selected row 7% accent tint.
- [ ] Bottom hint footer copy (10.5 faint): "Double-click a cell to edit · click
      a header to sort · stack conditions under Filters · click a linked value
      to hop the FK · ⊿ for column insights".
- [ ] Status bar 28px, `--bg1`, top border; ws chip · name · env tag · version ·
      tunnel lock · "schema: x" · spacer · "N rows · X ms" · "UTF-8".
- [ ] ⌘T new SQL tab · ⌘K palette · header click sorts · pager prev/next.
