# ADR-0017 — Display-only data masking behind one renderer entry point

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-11-25 (first commit that shipped the feature)
- **Area:** Data browsing
- **Related:** ADR-0005, ADR-0010, ADR-0012, ADR-0013, ADR-0014, ADR-0015, ADR-0016, ADR-0019, ADR-0024, ADR-0026, ADR-0049, ADR-0054

## Context

Users share their screen and take screenshots while browsing real data. They want one
switch that hides emails, phone numbers, tokens and similar values wherever row values
are drawn. The feature was built to five rules:

1. Display only: data, queries, copy and export are untouched.
2. The real value never reaches the DOM: not as text, tooltip, input value or
   aria-label.
3. Always visible when on.
4. Safe by default: the switch persists, and revealed columns are forgotten on each
   switch-on.
5. List the limits in Settings.

Aliased columns (`SELECT email AS e`) have to be caught too.

Shipped in `3735933` (2026-11-25).

## Decision

- **Renderer-only feature, no Rust slice.** `src/features/masking/`:
  - `mask.ts` is pure. It holds `kindOf`
    (column name regexes for email / phone / secret / person, plus value regexes for
    email, JWT, API key prefixes, long hex and base64), `render` ("just enough shape to
    tell rows apart, never the length"), `maskSqlText` for string literals in SQL text,
    and a custom column list where `*` is a wildcard.
  - `state.ts` holds the runtime. `maskShow` / `maskText` / `maskShowByName` are "THE
    entry point every render site calls … No render site decides for itself".
- **Name or value triggers masking.** A value is masked when its column base name
  matches (`u.email` → `email`) or when the value itself looks sensitive. That is how
  aliases are caught. `maskShowByName` judges by name only, for values being typed, so
  text does not vanish mid-word.
- **Settings and session state.** `maskOn`, `maskEmail`, `maskPhone`, `maskSecret`,
  `maskPerson` and `maskCustom` live in the persisted settings (`src/features/settings/api.ts`,
  ADR-0049). Defaults: off, with email, phone and secret on and person off. Revealed
  columns are an in-memory `Set` in `useMaskStore`, never saved. A settings
  subscription calls `hideAll()` on every off → on change.
- **Synchronous reads.** Render sites call `getState()`, so cells do not each subscribe.
  A view (grid, inspector, chart) subscribes once with `useMask()` and re-renders.
- **Render sites:**
  - `CellContent` (`GridCell.tsx`), which checks masking before its binary, JSON and FK
    branches;
  - `DataGrid` header eye (`MaskHeadBtn`) and row labels;
  - `RowInspector`, `FkPeek`, `ColumnInsights`;
  - `SqlResultGrid`;
  - `ResultChart`;
  - `NotebookTab`;
  - change history (`UndoRow`, `UndoDetail`, `ChangeHistoryTab`);
  - lineage (`graph.ts`, `model.ts`, `LineageTab`).
  A masked grid cell cannot be opened for inline edit (ADR-0012), because the editor
  would put the real value in an input.
- **Toggle routes.** `toggleMask()` is reached from ⇧⌘M (`MaskSwitches.tsx`), the
  status-bar switch, the title-bar pill, the menu (`titlebarMenus.ts`, command `mask`)
  and the command palette (ADR-0054).

## Alternatives considered

- **Masking in the backend or in the query.** Rejected by rule 1. The data must stay
  real for copy, export and edits. Inferred: a backend mask would also break editing and
  FK lookups on masked keys.
- **Masking by column name only.** Not enough. The requirements need
  `SELECT email AS e` to be masked, so value patterns are checked too.
- **Hiding values with CSS (blur or `color: transparent`).** Ruled out by rule 2: the
  real value must not be in the page at all.
- **Persisting revealed columns.** Rejected by rule 4. They are kept in memory and
  cleared on each switch-on.

## Consequences

- **Positive:** one function decides masking for every view. New views follow by
  calling `maskShow` / `maskText`, and copy and export stay exact.
- **Negative / trade-offs:** detection is heuristic. Values that match no name or value
  pattern are shown, and non-sensitive values that look like tokens (long hex, base64)
  get masked.
- **Negative / trade-offs:** out of scope:
  - copy and export carry the real values;
  - SQL editor text and query history are not masked;
  - notebook notes are not masked;
  - values inside JSON in an unmasked column are not masked;
  - non-SQL engine grids, the CSV viewer and the terminal are not masked
    (`CellContent`'s `noMask` covers those grids).
- **Follow-ups:** per-connection rules and automatic screen-share detection are out
  of scope for now.
