# ADR-0011 — Stackable filter builder compiled to a bound WHERE clause

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature)
- **Area:** Data browsing
- **Related:** ADR-0003, ADR-0010, ADR-0014, `docs/M5-filter-builder.md`

## Context

Users need to narrow a table grid without writing SQL. The filter applies to the grid
query and to its row count. Values come straight from text inputs, so building SQL from
them invites injection. Each engine has different placeholders (`?`, `$n`, `@Pn`),
identifier quoting and `LIKE` escaping. Power users also want an escape hatch for
`OR` / nested logic that a flat row list cannot express.

Shipped in `3bd8f8d` (backend) and `2d4217b` (panel) on 2026-06-13. Later additions
include the ⌘/Ctrl+F toggle (`116eb89`) and binary-column binding.

## Decision

- **A structured wire model, not SQL text.** `FilterSpec` lives in
  `src-tauri/src/shared/ports/sql/query.rs` (`#[serde(tag = "mode")]`).
  `Conditions { items, combinator }` holds a list of `Condition { column, op, value,
  binary }`. `Raw { sql }` holds the WHERE body as typed by the user. `FilterOp` has 13
  operators (`eq` … `isNotNull`), and each one maps to a fixed SQL fragment.
  `Combinator` is a single flat `AND`/`OR` across all rows.
- **Compilation happens in each adapter.** Every SQL engine has a `where_clause` in
  `src-tauri/src/engines/{sqlite,postgres,mysql,mssql,clickhouse}/sql.rs`. It validates
  the column against the table's real columns, quotes it, and binds values as
  parameters. `LIKE` values are escaped (`escape_like` plus `ESCAPE '\'`, which MySQL
  leaves out). A null value is rejected with "Use IS NULL / IS NOT NULL". An empty
  `inList` is an error. The page query and `COUNT(*)` share one compiled clause, and the
  WHERE parameters bind before `LIMIT`/`OFFSET`. No new Tauri command was added:
  `rows_fetch` and `column_stats` (ADR-0014) take an optional `filter`.
- **Raw mode is the only path that interpolates.** The trimmed text is wrapped as
  `(<raw>)` with no parameters. A syntax error comes back as the engine's error and
  shows inline in the panel. The code treats it as trusted the same way the SQL editor
  is (ADR-0018).
- **Two separate outputs on the renderer.** `src/features/browse/sql/filter.ts`:
  - `compileToSpec(draft, columns)` builds the wire spec. It types each value by the
    column's declared type (number, bool or string). It sets `binary` for binary
    columns, so the backend binds `0x`/UUID text as raw bytes.
  - `draftToDisplaySql` and `appliedDisplaySql` build a display-only WHERE string. It
    drives the toolbar readout and the raw-mode prefill, and it is never sent as the
    query in conditions mode.
- **State.** `ui.filters[tabId]` holds `TabFilterState { draft, applied }` in the
  persisted per-workspace UI state. `FilterDraft` keeps both the condition list and
  `rawSql`, so switching modes loses neither. `TableTab` derives `filterSpec` and
  `filterKey = JSON.stringify(filterSpec)`. The grid resets on `filterKey`, exactly as
  it does for a sort change.
- **Apply rules.** Editing a column, operator or value only marks the draft dirty, and
  Enter or Apply commits it. Toggling a row's checkbox, removing a row, or Clear
  re-applies immediately (`src/features/browse/sql/components/FilterPanel.tsx`).
- **FK hop reuses it.** `openTableTabWithFilter` (ADR-0014) seeds a one-condition `eq`
  filter.

## Alternatives considered

- **Building WHERE SQL in the renderer and sending text.** Rejected. The module header
  in `filter.ts` gives the reason: with bound parameters there is "NO client-side SQL
  assembly and nothing to inject".
- **A nested AND/OR tree builder.** Not built. `M5` assigns mixed or
  nested logic to raw mode. Inferred: this keeps the panel a single flat list.
- **One shared compiler in the browse application layer.** Not chosen. `M5` records
  that WHERE syntax differs per engine, so compiling belongs to each adapter.

## Consequences

- **Positive:** injection through builder values does nothing. Adapter tests cover it
  (for example `column_stats_filter_injection_payload_is_inert`). Column names are
  validated and operators come from an enum.
- **Positive:** the filtered count, column insights and FK hop all go through one
  compiled clause.
- **Negative / trade-offs:** raw mode interpolates the text verbatim. That is an opt-in
  hole the same size as the SQL editor. It is blocked from writes only by whatever the
  engine refuses inside a WHERE.
- **Negative / trade-offs:** the ClickHouse `where_clause` renders escaped literals
  rather than bound parameters (its tests are named
  `where_clause_comparison_renders_escaped_literal`). Its safety rests on escaping, not
  on binding.
- **Negative / trade-offs:** one combinator applies to every row. There is no grouping
  without raw mode.
- **Follow-ups:** none recorded in the code.
