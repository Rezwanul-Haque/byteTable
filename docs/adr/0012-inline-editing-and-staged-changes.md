# ADR-0012 — Inline cell editing through a per-tab staged batch

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature)
- **Area:** Data browsing
- **Related:** ADR-0006, ADR-0007, ADR-0010, ADR-0013, ADR-0016, ADR-0017, ADR-0036, `docs/M11-inline-cell-editing.md`

## Context

Users edit data in the grid: change cells, add rows, delete rows. Writes to a live
database need a guard against hitting the wrong row (mass updates), a review step on
production connections, and must not lose typed-but-unsaved work when the user switches
tabs.

The feature shipped in two shapes. The first (`886eadf`, `0d978a8`, 2026-06-13) is the
one `docs/M11-inline-cell-editing.md` describes. Each cell commit fired `row_update`
right away, with an optimistic cache write and rollback on error. On 2026-06-18
(`93fff6d`, "edit or create new rows with confirmation") the grid moved to staging:
nothing is written until an explicit save. The staged model is what the code does today.

## Decision

- **Edits are staged, not written.** In `src/features/browse/sql/components/DataGrid.tsx`:
  - Edits to existing rows go into `pendingEdits: Map<pkKey, PendingRow { pk, cells }>`.
  - New rows (⌘I, toolbar "+", or Duplicate) go into `newRows`. They render at the top
    of page 0 with `row-staged` and a ✱ in the gutter.
  - An edited cell gets `cell-edited`. Editing a value back to its original removes it
    from the batch.
- **⌘S commits the whole batch as one script.** `buildBatchSql` writes one `UPDATE …
  WHERE <full pk>` per edited row and one `INSERT` per new row. It uses engine-aware
  quoting (`quoteIdent`, `sqlLiteral` doubles backslashes for MySQL) and binary literals
  (`decode(…,'hex')` on Postgres, `0x…` on SQL Server, `X'…'` elsewhere). `runSave`
  sends the script through the change-history recorder when recording is on
  (`recordIfOn`, ADR-0016). Otherwise it calls `execute_script_text`
  (`src-tauri/src/features/export/commands.rs`), which calls `ensure_writable`
  (ADR-0006) and runs the engine's `execute_script`.
- **Production review.** When the connection's env is `production` and
  `settings.confirmProd` is on, Save opens a modal that shows the exact batch SQL before
  it runs.
- **Editability gate.** `readOnlyReason` checks, in order: read-only workspace, no
  primary key, the cell is a pk column, or the row's key is not loaded. The reason shows
  as the cell's tooltip. A masked cell cannot be opened (ADR-0017). Cells of staged rows
  are always editable.
- **Staging survives a tab switch.** The grid mirrors its `Map`s into
  `ui.gridEdits[tabId]` (`TabGridEdits` in `src/features/workspaces/types.ts`) through
  `setTabGridEdits`, and on mount rehydrates from `storedTabGridEdits`
  (`a73e6a4`, 2026-08-12). `unsavedTabIds` marks dirty tabs in the tab strip.
  `UnsavedTabsModal` confirms before closing a dirty tab and offers "discard all". The
  batch is left out of persisted storage, so it does not outlive the session.
- **Primary-key prefill for new rows** (`addRow`, `duplicateRows`):
  - Integer pk: the maximum over the cached page plus staged rows, plus one. For an
    engine-generated pk this is only a display hint, because the INSERT leaves the
    column out.
  - UUID / `uniqueidentifier` / 16-byte binary pk with no default:
    `generatedPkValue` fills a UUID v7 (`adcae2b`, 2026-08-14).
  - A pk that is also a foreign key is never prefilled (`d16aac7`).
  - Anything else falls back to the parsed column default or NULL.
- **Rust `features/mutate`** is a thin slice. `row_update` (single cell, full-pk
  validation, bound values, affected-count check in a transaction) is still registered
  in `src-tauri/src/lib.rs`. `rows_delete` serves the grid's bulk delete with the same
  safety contract. `truncate_table`, `drop_table` and the schema commands live here too.

## Alternatives considered

- **Write each cell immediately (`row_update`, the original M11).** This was replaced
  by staging. The header comment in `DataGrid.tsx` gives the reason: "staging means
  nothing hits the DB until that explicit, reviewed save", and this pairs with the
  production confirm dialog.
- **Look up `SELECT max(pk) + 1` when staging into an integer pk the engine does not
  generate.** Proposed and declined on 2026-08-14; the user chose to keep the
  page-derived value. It can collide on page 2 and later, under a filter, or on tables
  larger than one page. A collision fails loudly with a unique-key error and writes
  nothing.
- **Generate UUID v4 keys.** v7 was chosen. The code comment says a time-ordered key
  "keeps index inserts sequential, where random v4 scatters them".
- **Keep staging only in component state.** This was the case before `a73e6a4`. It
  silently lost edits on a tab switch, because inactive tabs are unmounted.

## Consequences

- **Positive:** nothing reaches the database without an explicit save. A batch can be
  reviewed, discarded, or kept across tabs. Change history can record the whole save as
  one entry.
- **Negative / trade-offs:** the batch is SQL text with literals inlined on the client,
  not bound parameters. Correctness depends on `sqlLiteral` and `binaryLiteral`
  escaping. Atomicity is up to the engine: `execute_script_text` documents SQLite and
  Postgres as atomic and MySQL as not.
- **Negative / trade-offs:** primary-key columns are read-only in the grid. The
  page-derived integer prefill can collide (see above).
- **Follow-ups:** the `rowUpdate` wrapper in `src/shared/api/engine.ts` has no renderer
  caller. `row_update` is kept but unused by the grid.
