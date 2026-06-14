# M5 — Stackable filter builder

> Provenance: reverse-engineered from the shipped code (the source of truth), cross-checked against `design_handoff_bytetable_latest/MILESTONES.md` (M5) and `DESIGN_SPEC.md` §3.5. Imperative sentences ("the panel re-applies…", "values are bound…") are **requirements** a rebuild must satisfy; descriptive notes give the rationale. Primary files: `src/features/browse/filter.ts`, `src/features/browse/components/FilterPanel.tsx` (+ `.css`), `src/features/workspaces/types.ts`, `src/features/workspaces/components/TableTab.tsx`; backend `src-tauri/src/shared/engine.rs`, `src-tauri/src/features/browse/{application.rs,commands.rs}`, and the three adapter compilers `src-tauri/src/engines/{sqlite/mod.rs, mysql/sql.rs, postgres/sql.rs}`.

## Goal

A per-table-tab **stackable filter builder** (DESIGN_SPEC §3.5) that compiles to a **real, parameterized WHERE clause** applied to both the page query and the row count. The panel docks under the data-mode toolbar; users stack condition rows (column / operator / value), toggle individual rows on/off, read the effective WHERE in the toolbar, clear all, and drop into a raw "Edit as SQL" escape hatch.

The load-bearing security invariant: in builder ("conditions") mode **every value is bound as a query parameter, never string-interpolated**. The WHERE string shown in the toolbar and pre-filled into raw mode is **cosmetic** — it is built by a separate display path (`draftToDisplaySql`) and is never sent as a query. Only the explicit raw-mode string is interpolated (a documented power-user escape hatch, same trust level as the M6 query editor).

## Dependencies — M4

Builds directly on **M4 — Tab system + data grid**:

- The grid (`DataGrid`) and `rows_fetch` command already exist; M5 adds an optional `filter: FilterSpec | null` to `FetchRowsRequest` (the wire request M4 introduced for paging + sort). When present it applies to BOTH the page query and the `COUNT(*)`, so `RowsPage.totalRows` becomes the _filtered_ total ("n of N rows").
- Filter state lives in the per-workspace, per-tab `ui.filters` map keyed by tab id (the same WorkspaceUiState that survives workspace switches). The grid's reset machinery keys on the compiled filter (`filterKey`), so committing a filter re-windows + re-counts exactly like a sort change.
- The toolbar (Data | Structure segmented control, refresh, row-count) and `TableTab.tsx` host already exist from M4; M5 inserts the Filters toggle, the WHERE readout, the clear-filters icon, and mounts `FilterPanel` under the toolbar.

## Backend (Rust core)

### Domain — filter condition model

All wire types live in `src-tauri/src/shared/engine.rs`.

**`FilterOp`** (`#[serde(rename_all = "camelCase")]`) — the **13 operators**, the _only_ thing that selects a comparison; each maps to a fixed SQL fragment in the adapters:

| #   | Variant       | Wire token    | §3.5 label     | SQL fragment (value bound as `?`/`$n`)      |
| --- | ------------- | ------------- | -------------- | ------------------------------------------- |
| 1   | `Eq`          | `eq`          | `=`            | `"c" = ?`                                   |
| 2   | `Ne`          | `ne`          | `≠`            | `"c" <> ?`                                  |
| 3   | `Gt`          | `gt`          | `>`            | `"c" > ?`                                   |
| 4   | `Gte`         | `gte`         | `≥`            | `"c" >= ?`                                  |
| 5   | `Lt`          | `lt`          | `<`            | `"c" < ?`                                   |
| 6   | `Lte`         | `lte`         | `≤`            | `"c" <= ?`                                  |
| 7   | `Contains`    | `contains`    | `contains`     | `"c" LIKE ? ESCAPE '\'` (pattern `%v%`)     |
| 8   | `NotContains` | `notContains` | `not contains` | `"c" NOT LIKE ? ESCAPE '\'` (pattern `%v%`) |
| 9   | `BeginsWith`  | `beginsWith`  | `begins with`  | `"c" LIKE ? ESCAPE '\'` (pattern `v%`)      |
| 10  | `EndsWith`    | `endsWith`    | `ends with`    | `"c" LIKE ? ESCAPE '\'` (pattern `%v`)      |
| 11  | `InList`      | `inList`      | `in list`      | `"c" IN (?, ?, …)`                          |
| 12  | `IsNull`      | `isNull`      | `is null`      | `"c" IS NULL` (no value, no bind)           |
| 13  | `IsNotNull`   | `isNotNull`   | `is not null`  | `"c" IS NOT NULL` (no value, no bind)       |

`FilterOp::needs_value(self) -> bool` returns `false` only for `IsNull`/`IsNotNull`. The prototype `filters.jsx` internal ids differ (`neq`/`ncontains`/`begins`/`ends`/`in`/`null`/`nnull`); the renderer maps them to these wire tokens (documented in `engine.ts`).

**`FilterValue`** (`#[serde(untagged)]`) — `Scalar(serde_json::Value)` for comparison/LIKE ops, `List(Vec<Value>)` for `inList`. A JSON array deserializes to `List`, anything else to `Scalar`. A contained `null` is rejected by the adapter ("Use IS NULL / IS NOT NULL to compare with NULL.").

**`Condition`** (`#[serde(rename_all = "camelCase")]`) — `{ column: String, op: FilterOp, value: Option<FilterValue> }`. `value` is `None` for the null checks, required otherwise. `column` MUST be validated against the table's real columns before quoting (unknown column → §5 error, same check as the sort column).

**`Combinator`** (`#[serde(rename_all = "lowercase")]`) — `And`/`Or`; `sql_keyword()` returns the fixed literal `"AND"`/`"OR"`. The connective is a top-level join across rows (the first row's prefix is rendered `WHERE`, the rest take the combinator). Mixed/nested boolean logic is the job of raw mode.

**`FilterSpec`** (`#[serde(tag = "mode", rename_all = "lowercase")]`):

- `Conditions { items: Vec<Condition>, combinator: Combinator }` → `{"mode":"conditions","items":[…],"combinator":"and"}` — fully parameterized.
- `Raw { sql: String }` → `{"mode":"raw","sql":"…"}` — the WHERE body, interpolated verbatim (escape hatch).

`FetchRowsRequest` (and `ColumnStatsRequest`, M10) carry `#[serde(default)] pub filter: Option<FilterSpec>`.

### Application — compile conditions → parameterized WHERE + bind params; validate raw SQL by execution

The browse use-case layer (`src-tauri/src/features/browse/application.rs`) is a thin pass-through: `fetch_rows(manager, handle, req)` resolves the open handle and delegates to `EngineConnection::fetch_rows(req)`. **No filter logic lives in the use-case layer** — compilation is per-adapter (the WHERE syntax differs per engine).

Each adapter owns a `where_clause(meta, table, &FilterSpec) -> Result<WhereClause, AppError>` returning a `{ sql: Option<String>, params: Vec<SqlValue> }`:

- **`Raw { sql }`** → trimmed; empty string yields `WhereClause::default()` (no predicate, not an error). Otherwise `sql: Some(format!("({trimmed})"))`, **no params** (the string carries its own literals). This is the only interpolation path. "Validation by execution": the clause runs against the DB; a malformed clause surfaces as the engine's §5 error, propagated back to the renderer.
- **`Conditions { items, combinator }`** → for each condition, `condition_sql(meta, table, condition, &mut params)`:
  - `validate_column` (unknown column → §5 error listing available columns), then `quote_ident` the column — the only interpolated identifier.
  - Emit the fixed per-op fragment (table above). Comparison/LIKE/`inList` **push the value(s) onto `params`** and emit `?` (SQLite/MySQL) or `$n` (Postgres) placeholders; never interpolate the value.
  - LIKE family: `escape_like` doubles the escape char then escapes `%`/`_`, builds the `%v%`/`v%`/`%v` pattern, binds it as text, and emits `… ESCAPE '\'` (SQLite/Postgres; MySQL's default LIKE escape is already `\`, so it omits the explicit clause to stay valid under `NO_BACKSLASH_ESCAPES`).
  - `json_to_sql_value`: JSON null → §5 "Use IS NULL / IS NOT NULL"; bool → integer 0/1 (SQLite/MySQL) or native bool (Postgres); number → i64/f64 (u64 overflow preserved as text); string → text; array/object → §5 "A filter value must be a single text, number, or boolean."
  - `inList`: a `Scalar` where a list is expected, or an empty list, → §5 errors. Each item bound, placeholders joined.
  - Empty `items` → `WhereClause::default()` (whole table).
  - Fragments joined by `{combinator.sql_keyword()}`.

The WHERE params **bind first** (positional order), then `LIMIT`/`OFFSET` (also bound), so the page query and the `COUNT(*)` share the identical compiled clause + binds. The injection guarantee is asserted by adapter tests (`where_clause_every_operator_shape_and_bind_order`, the round-trip serde tests in `engine.rs`).

### Tauri commands

`src-tauri/src/features/browse/commands.rs` — M5 adds **no new command**; it extends M4's `rows_fetch` (and M10's `column_stats`) with the optional `filter` field.

| command                            | args                                                                                                                   | returns                                                                                          | errors (`AppError` → `{kind, message}`)                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rows_fetch`                       | `handleId: string`, `req: FetchRowsRequest` (`schema`, `table`, `sort?`, **`filter?: FilterSpec`**, `offset`, `limit`) | `RowsPage` (`columns`, `rows`, `offset`, `limit`, **`totalRows` = filtered count**, `elapsedMs`) | `NotFound` (closed/unknown handle, "…closed"); `Database` (unknown column, NULL-compare misuse, non-scalar value, empty `inList`, or any raw-mode syntax error from the engine) |
| `column_stats` (M10, filter-aware) | `handleId`, `req: ColumnStatsRequest` (`schema`, `table`, `column`, **`filter?`**)                                     | `ColumnStats` over the current filtered set                                                      | same families                                                                                                                                                                   |

## Frontend (React)

### State — filter store

Per-tab filter state lives in the persisted per-workspace `ui.filters: Record<string, TabFilterState>` keyed by tab id (`src/features/workspaces/types.ts`), mutated via the workspaces store action `setTabFilter(tabId, next)` (`state.ts`). Filter input is low-frequency (apply/toggle only), so it belongs in persisted `ui`, not the ephemeral tabMeta result store.

- **`UiCondition`** = `{ id: string; enabled: boolean; column: string; op: FilterOp; value: string }`. `value` is **always a string** here (what the text input holds); compilation types it per the column's declared type and, for `inList`, splits on commas. `id` is stable (`fc-<base36 time>-<seq>`) for React keys + edit targeting.
- **`FilterDraft`** = `{ conditions: UiCondition[]; combinator: Combinator; rawMode: boolean; rawSql: string }`. **Both modes are kept** so toggling between builder and raw never loses the other's content; `rawMode` selects which compiles.
- **`TabFilterState`** = `{ draft: FilterDraft; applied: FilterDraft | null }`. `draft` = what the panel edits (dirty); `applied` = what the grid fetches with (`null` = no filter). Apply deep-clones `draft` into `applied` so later draft edits don't leak in.

`TableTab.tsx` derives, via `useMemo`:

- `filterSpec = applied ? compileToSpec(applied, columns) : null` — the wire `FilterSpec | null`.
- `filterKey = filterSpec ? JSON.stringify(filterSpec) : ""` — the grid's reset key.
- `appliedWhere = appliedDisplaySql(applied, columns)` — the **cosmetic** effective WHERE readout.
- `hasApplied = filterSpec !== null` — drives the accent dot, the WHERE readout vs "no filters applied", and the clear-filters icon.
- `filterError: string | null` — local `useState`; set from the grid's `onFilterError` (raw-mode backend §5 error), cleared on every `onFilterChange`.

### API — typed invoke wrappers

`src/shared/api/engine.ts`: `rowsFetch(handleId, req): Promise<RowsPage>` → `invoke("rows_fetch", { handleId, req })`; `columnStats(handleId, req): Promise<ColumnStats>` → `invoke("column_stats", { handleId, req })`. TS types `FilterOp`, `Combinator`, `FilterValue` (`CellValue | CellValue[]`), `Condition`, `FilterSpec`, `FetchRowsRequest.filter?` mirror the Rust serde exactly. The grid (M4) consumes `filterSpec` + `filterKey` and calls `rowsFetch`; M5 introduces no new wrapper.

### Components

**`FilterPanel`** (`src/features/browse/components/FilterPanel.tsx`) — props `{ open, columns, state: TabFilterState, error, onChange }`. Two commit paths:

- `apply(nextDraft)` → `onChange({ draft: nextDraft, applied: cloneDraft(nextDraft) })` (commit draft→applied).
- `setDraft(nextDraft)` → `onChange({ ...state, draft: nextDraft })` (dirty mutate only).

**`ConditionRow`** (rendered inline per `draft.conditions`):

- **Prefix** `.filter-and`: `WHERE` for row 0, else `draft.combinator.toUpperCase()`.
- **Enable checkbox** `.filter-check`/`.filter-checkbox` (custom 16px box, accent fill + check icon when on): `onChange` → `updateCond(id, { enabled }, reapply=true)` — **re-applies immediately**.
- **Column select** `.filter-select`: options from `columns`; `updateCond(id, { column }, false)` (draft only).
- **Operator select** `.filter-op`: options from `FILTER_OPS` (label text); `updateCond(id, { op }, false)`.
- **Value input** `.filter-value`: shown only when `opNeedsValue(op)` (else a `.filter-novalue` spacer); `type="number"` for numeric columns except `inList`; placeholder `value, value, value` for `inList` else `value…`; `updateCond(id, { value }, false)`; **Enter** → `apply(draft)`.
- **Remove ×** `.saved-del`: `removeCond(id)` — re-applies (removing changes the effective filter); removing the last row replaces it with a fresh blank `newCondition`.

**Apply button + dirty state** (footer): `<Btn variant={dirty ? "filled" : "tonal"} icon="check">Apply</Btn>` → `apply(draft)`. `dirty` = `draftToDisplaySql(draft) !== draftToDisplaySql(applied)` (cosmetic SQL compared — captures the effective filter in both modes).

**Effective-WHERE readout** lives in the **toolbar** (`TableTab.tsx`, not the panel): `.applied-where` shows `appliedWhere` (ellipsized, `title` = full) when `hasApplied && appliedWhere`, else `.applied-where.empty` "no filters applied".

**Clear-all**: footer `<Btn variant="text">Clear</Btn>` → `apply(emptyDraft(firstColumn))`; the toolbar `filter_alt_off` icon (visible only when `hasApplied`) → `clearFilters()` clears applied AND draft AND error.

**Edit-as-SQL raw editor**: footer `.filter-rawtoggle` (`code`/`tune` icon, "Edit as SQL"/"Use builder") → `switchMode()`. Entering raw mode **pre-fills `rawSql` from `draftToDisplaySql(draft, columns)`** (the cosmetic clause); leaving keeps conditions intact. Raw row `.filter-raw-row` = `WHERE` label + `.where-input` (placeholder `status = 'paid' AND (total > 100 OR country IN ('DE', 'FR'))`); `.error` class on backend error, `.applied` class when applied; **Enter** → `apply(draft)`. The footer "Add condition" and the count note are hidden in raw mode.

**Footer count note** `.filter-count-note`: `{activeConditionCount} of {total} condition(s) active` (an active condition is enabled and, if the op needs a value, has a non-empty value). Replaced by `.filter-err-inline` (error icon + message) when `error` is set.

### Styling — §3.5 filter panel

`src/features/browse/components/FilterPanel.css` (ported byte-identical from `ByteTable.html` "v2: stackable filter builder"; the toolbar toggle + WHERE readout live in `TableTab.css`):

- Panel `--bg1`, bottom border, `padding: 9px 12px 8px`, column flex `gap: 7px`; `.hidden` → `display: none`.
- Rows: flex `gap: 8px`, `align-items: center`; `.disabled` dims select/value/prefix to `opacity: 0.45`.
- Prefix `.filter-and`: mono 10px, weight 600, accent, `width: 44px` right-aligned, `letter-spacing: 0.04em`.
- Checkbox `.filter-checkbox`: 16px, `border-radius: 5px`, `1.5px` faint border; `.on` → accent bg + border, `on-accent` check.
- Selects: `--bg0`, `1px` border, `border-radius: 7px`, mono 11.5px, accent focus border; column `max-width: 170px`, `.filter-op` `max-width: 130px`.
- Value `.filter-value`: `flex: 1`, mono 11.5px, `--bg0`, accent focus.
- Raw row: `.where-label` mono 11px weight 600 accent; `.where-input` `flex: 1` `--bg1` `border-radius: 8px`; `.applied` → 60%-accent border; `.error` → `#e06c75`.
- Footer `.filter-foot`: flex `gap: 10px`; `.filter-add`/`.filter-rawtoggle` 11.5px dim, hover bg `--bg2`; `.filter-count-note` mono 10.5px faint; `.filter-err-inline` mono 11px `#e06c75`, ellipsized `max-width: 50%`.
- Remove `.saved-del`: 20px square, `border-radius: 5px`, faint; hover `#e06c75` on `#e06c7518`.

## Shared data contracts — TS + Rust types for a filter set + value binding

A 3-condition filter set, on the wire (`conditions` mode), with values **bound** server-side:

```jsonc
// FilterSpec — what rowsFetch sends as req.filter
{
  "mode": "conditions",
  "combinator": "and",
  "items": [
    { "column": "status", "op": "eq", "value": "paid" }, // → "status" = $1   ($1="paid")
    { "column": "total", "op": "gte", "value": 100 }, // → "total" >= $2   ($2=100)
    { "column": "country", "op": "inList", "value": ["DE", "FR"] }, // → "country" IN ($3,$4)
  ],
}
```

```rust
// engine.rs — Rust mirror (camelCase serde)
FilterSpec::Conditions {
    combinator: Combinator::And,
    items: vec![
        Condition { column: "status".into(),  op: FilterOp::Eq,     value: Some(FilterValue::Scalar(json!("paid"))) },
        Condition { column: "total".into(),   op: FilterOp::Gte,    value: Some(FilterValue::Scalar(json!(100))) },
        Condition { column: "country".into(), op: FilterOp::InList, value: Some(FilterValue::List(vec![json!("DE"), json!("FR")])) },
    ],
}
```

Raw mode: `{ "mode": "raw", "sql": "status = 'paid' AND (total > 100 OR country IN ('DE','FR'))" }` → `WHERE (status = 'paid' AND (total > 100 OR country IN ('DE','FR')))`, no binds.

**Value-binding contract**: `UiCondition.value` (string) → `typedValue(raw, columnType)` chooses the JSON type (bool for `BOOL*`, number for `INT|NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT` columns when the text parses, else trimmed string) → rides as a JSON param in `Condition.value` → adapter `json_to_sql_value` maps it to a bound `SqlValue`. Typing only chooses **which JSON type**; it never builds SQL.

## Behavior & edge cases

- **Enable-checkbox re-applies immediately** (§3.5): toggling a row's checkbox calls `apply` (commits draft→applied at once), unlike column/operator/value edits which only mark the draft dirty. Removing a row and Clear also re-apply immediately.
- **Apply timing**: column/operator/value edits apply on **Enter** (in value or raw input) or the **Apply** button; the Apply button is `filled` when dirty, `tonal` when clean.
- **Per-type quoting/binding**: builder values are bound (numbers as numeric binds, bools as 0/1 or native bool, strings as text). The cosmetic display (`draftToDisplaySql` → `quoteDisplay`) quotes numbers/bools raw and single-quotes+escapes strings (`'` doubled) — **for human reading only**; it is never executed in conditions mode.
- **LIKE wildcards bind literally**: a user `%` or `_` in a `contains` value is escaped (`escape_like` + `ESCAPE '\'`) so it matches literally, not as a wildcard.
- **NULL handling**: comparing against NULL via `eq`/etc. is rejected ("Use IS NULL / IS NOT NULL…"); the null-check ops (`isNull`/`isNotNull`) hide the value input and bind nothing.
- **SQL injection inert** (conditions mode): an injection payload typed into a value field (e.g. `'; DROP TABLE users; --`) is bound as a parameter — it becomes an inert string literal that simply matches no rows. The cosmetic readout may _show_ the payload quoted, but that string is never the query. Identifiers (columns) are validated against the table and `quote_ident`-quoted; operators and combinators are enum-driven fixed literals. Only raw mode interpolates — a documented, opt-in escape hatch.
- **Raw-mode errors render inline §5-style**: a bad raw clause fails at execution; the grid's `onFilterError(message)` sets `filterError`, keeps the panel open (`setPanelOpen(true)`), shows the message in `.filter-err-inline` (red error icon + text), and applies `.error` to the `.where-input`. A fresh `onFilterChange` clears the error; the grid clears it on success.
- **Empty filter = whole table**: no active conditions (or empty raw SQL) compiles to `null`/`WhereClause::default()` — the grid fetches the unfiltered table and the readout shows "no filters applied".
- **Filtered count**: with a filter applied, `RowsPage.totalRows` is the filtered `COUNT(*)`, so the toolbar reads "n of N rows" against the filtered total.
- **Persistence**: filter state is per-tab in persisted `ui.filters` and survives workspace switches; the panel open/closed flag is local component state.

## Acceptance criteria

1. **Stack 3 conditions**: add `status = paid`, `total ≥ 100`, `country in list DE, FR` (combinator AND), Apply → grid shows only matching rows; the WHERE readout shows the cosmetic clause; "n of N rows" reflects the filtered count; backend binds 4 params (one per scalar + two list items).
2. **Toggle one off**: uncheck the `total ≥ 100` row → the filter **re-applies immediately** (no Apply press), grid + readout + count update to the 2-condition result; the row dims to 45% and its checkbox shows hollow.
3. **Raw OR**: switch to "Edit as SQL" → the input pre-fills from the built conditions; edit to add `OR (total > 100 OR country IN ('DE', 'FR'))`, press Enter/Apply → grid + readout reflect the raw clause (runs as `WHERE (<raw>)`); switching back to builder keeps the original conditions intact.
4. **Injection attempt inert**: type `' OR 1=1; DROP TABLE x; --` into a value field in builder mode, Apply → no rows are dropped, no error; the value binds as a literal string that matches nothing. A syntactically broken **raw** clause surfaces the engine's §5 error inline in the panel, panel stays open, no rows mutate.

## Pixel / UX checklist

- [ ] Toolbar **Filters** button: filter icon + "Filters" label; accent **dot** when `hasApplied`; `open` state styling when the panel is shown.
- [ ] Panel docks under the toolbar, full content width, `--bg1`, bottom border, ~9/12/8px padding; hidden via `display:none` when closed.
- [ ] Row layout: 44px right-aligned accent mono `WHERE`/`AND`/`OR` prefix · 16px r5 checkbox (accent fill + check when on) · column select (≤170px) · operator select (≤130px) · mono value input (flex) · 20px × remove.
- [ ] Disabled rows dim selects/value/prefix to opacity 0.45.
- [ ] All 13 operators appear in the operator select with the §3.5 labels (`=  ≠  >  ≥  <  ≤  contains  not contains  begins with  ends with  in list  is null  is not null`); null ops hide the value input.
- [ ] Numeric column → `type="number"` value input (except `inList`); `inList` placeholder `value, value, value`, else `value…`.
- [ ] Footer: "+ Add condition" (hidden in raw mode) · "Edit as SQL"/"Use builder" toggle · "n of m condition(s) active" note · text **Clear** · **Apply** (filled when dirty, tonal when clean).
- [ ] Raw row: accent mono `WHERE` label + flex mono input; `.applied` 60%-accent border, `.error` `#e06c75` border; placeholder matches the prototype example.
- [ ] Inline error: red error icon + mono 11px message, ellipsized to 50% width; replaces the count note; panel stays open.
- [ ] Toolbar WHERE readout: mono 11px ellipsized clause with full-text `title`; italic faint "no filters applied" when empty; `filter_alt_off` clear icon visible only when applied.
