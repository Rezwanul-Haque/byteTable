# ADR-0013 — Row inspector as a non-modal drawer that stages into the grid

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-07-15 (first commit that shipped the feature)
- **Area:** Data browsing
- **Related:** ADR-0010, ADR-0012, ADR-0015, ADR-0016, ADR-0017, ADR-0038

## Context

Wide rows, long text, JSON documents, binary keys and timestamps are hard to read and
edit in a 26px grid cell. Users wanted the whole record in one vertical view, with an
editor that fits each column's type, without giving up the grid's staged-save model
(ADR-0012). The requirement was a TablePlus-style right-side drawer in which edits are
staged, never written directly.

First shipped in `2128a95` (2026-07-15). Later additions:

- staging on ⌘S instead of committing (`f2eb8ec`)
- per-field copy (`41b1304`)
- read-only binary pk viewer (`d802926`)
- reload button (`e0cc9e3`)
- ⌘E toggle (`39fd096`)
- copy row as CSV / JSON / SQL / values (`365f83d`)

## Decision

- **Drawer, not modal.** `RowInspector` (`src/features/browse/sql/components/RowInspector.tsx`)
  is rendered into a portal. Its shell CSS is
  `src/features/browse/shared/styles/InspectorShell.css`: a 420px fixed panel at
  `z-index: 44`, below every modal scrim (50) and below the title bar. There is no
  scrim, so the grid stays interactive and double-click editing still works.
- **The grid owns it.** `DataGrid` holds `inspect` (the target row) and `inspectDirty`.
  A cell click opens the drawer or moves it to that row, unless the drawer has unstaged
  drafts. ⌘/Ctrl+E (`toggleInspect`) opens it on the selected row and focuses the
  selected cell's field, or closes it. Prev/next navigation is disabled while the drawer
  is dirty. Reload re-reads only the inspected row, as a one-row window under the page's
  sort and filter, so the page underneath does not flicker.
- **Edits stage into the grid's batch.** "Stage changes" calls `stageFromInspector`,
  which goes through the same `stageRealValue` / `stageNewValue` paths as inline edits.
  The save bar and ⌘S then commit them (ADR-0012). While the drawer holds unstaged
  edits, the grid's ⌘S handler steps aside, so one keystroke does not both stage and
  commit (`f2eb8ec`).
- **Type-aware field editors** (`RowInspectorField`):
  - pk: locked.
  - text and number: an input, or a textarea for long text.
  - boolean: true / false / null chips.
  - JSON: `JsonField` with validation; invalid JSON blocks staging.
  - binary and UUID: `BinaryEditorModal` and `UuidEditorModal`.
  - temporal: `RiDateTime` in `src/features/browse/shared/components/DateTimeField.tsx`,
    UTC by default with a timezone switch.
  - Emptying any input drafts NULL.
- **Copy.** The copy-row menu offers `RowCopyFormat = "csv" | "json" | "sql" |
  "values"`, all built by the grid's `serializeRows`:
  - CSV re-serializes JSON cells with single quotes so they stay readable after CSV
    quote-doubling. The code notes this form is "no longer parsable JSON".
  - JSON gives one object for a single row.
  - SQL gives one engine-quoted `INSERT` per row.
  - "values" gives bare values one per line, and is single-row only.
  Each field also has its own copy button.
- **Shared pieces.** `DateTimeField`, `JsonField` and the shell CSS sit in
  `browse/shared/` because the DynamoDB item drawer
  (`src/features/browse/dynamo/components/DynamoItemDrawer.tsx`) uses them. The CSV
  data-file tab (`src/features/data_file/components/DataFileDataTab.tsx`, ADR-0038)
  reuses `RowInspector` itself.
- **Hooks for later features.** The header hosts `HistoryRowLink` (ADR-0016) and
  `LineageLink` (ADR-0015). Every value goes through masking (`MaskedText` /
  `maskShow`, ADR-0017).

## Alternatives considered

- **A modal record editor.** Rejected in favour of a non-modal drawer
  at z 44 below modals. Inferred reason: users keep the grid usable alongside the
  drawer.
- **Having the drawer write rows itself.** Rejected. Nothing writes
  directly. `f2eb8ec` removed an early path where the drawer committed the batch.
- **Separate drawer implementations per engine.** Partly avoided. The shell and field
  editors are shared through `browse/shared/`, but DynamoDB still has its own drawer
  component.

## Consequences

- **Positive:** one commit path for all grid edits, with the production confirm and
  change history applying to drawer edits for free.
- **Positive:** JSON, binary and temporal values get proper editors without growing the
  cell UI.
- **Negative / trade-offs:** the drawer depends heavily on `DataGrid` internals
  (targets, row cache, `serializeRows`). Behaviour is spread across two large
  components.
- **Negative / trade-offs:** copy output is not masked. Masking is display-only by rule
  (ADR-0017), so a copied row carries the real values.
- **Follow-ups:** none recorded in the code.
