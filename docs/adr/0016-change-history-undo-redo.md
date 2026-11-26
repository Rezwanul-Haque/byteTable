# ADR-0016 — Local change history with checked, transactional undo and redo

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-11-25 (first commit that shipped the feature)
- **Area:** Data browsing
- **Related:** ADR-0002, ADR-0006, ADR-0012, ADR-0013, ADR-0019, ADR-0021, ADR-0026, ADR-0036, ADR-0049

## Context

A committed write cannot be taken back with ⌘Z. Users wanted "undo my last change"
after commit, for changes made from the grid, SQL tabs, notebooks and Truncate. The
feature was built to five rules:

1. Never overwrite newer data.
2. Never undo blind.
3. Undo is all or nothing.
4. Say what the log cannot do.
5. The log stays on this machine.

Recording real row values also raises a privacy concern, and each engine reads back
changed rows differently.

Shipped in `9161571` (2026-11-25).

## Decision

- **A full Rust slice** `src-tauri/src/features/change_history/` (ADR-0002):
  - `domain/`: pure and unit-tested. It holds the entry model (`Entry`, `Change`,
    `Source = grid|statement|transaction|action`), `diff`, the per-row `check` (`State =
    ok|conflict|noop|done` with a `Why`), `flip` for redo, the reversing SQL per
    `Dialect` (Postgres, MySQL, SQLite, SQL Server) in `sql.rs`, and the statement
    analysis in `capture.rs`.
  - `store.rs`: one SQLite file, `change-history.db` in the app data dir (wired in
    `src-tauri/src/lib.rs`), one JSON entry per row.
  - `application.rs` and `commands.rs`: `history_record`, `history_truncate`,
    `history_list`/`get`/`check`/`apply`, `history_clear`/`prune`/`totals`, and
    `history_set_recording`/`history_recording`.
- **Recording runs the user's writes itself.** `record` pins one session.
  - For a write in auto-commit, it opens a transaction, reads the target rows (locked)
    with the dry-run SELECT from query debug (`features/query_debug::domain`, ADR-0021),
    runs the write, reads the same keys again, and commits.
  - INSERT rows come back from the write: `RETURNING *` (Postgres, SQLite),
    `OUTPUT inserted.*` (SQL Server), or a single-row key read-back on MySQL
    (`InsertHow::MysqlSingle`).
  - An explicit `BEGIN … COMMIT` becomes one entry. `ROLLBACK` records nothing.
  - Table metadata is read before pinning, because a SQL Server session holds the
    connection's only client.
- **"Can't undo" is recorded, never guessed.** `Cant = structure | large | nokey |
  multitable | unsupported`. Upserts, `CALL`/`EXEC`, `MERGE`, savepoint rollbacks and
  more than `undoMaxRows` rows are listed without values or without undo.
- **Undo is checked twice.** `history_check` shows the verdict for each row.
  `history_apply(id, reviewed)` re-reads the rows under lock inside its own transaction.
  If any verdict differs from the reviewed one it rolls back, otherwise it runs exactly
  the shown statements. Rows whose verdict is conflict are skipped, which is what makes
  partial undo ("Undo 1 of 2 rows") possible. Redo flips the changes. A read-only
  workspace refuses both `history_record` writes and `history_apply` (ADR-0006).
- **Renderer** `src/features/change_history/`:
  - `recording.ts`: `recordingOn` requires a SQL, non-data-file workspace with both
    `settings.undoRecord` and the per-connection switch on. `recordIfOn` is the call
    site used by the grid save and bulk delete (ADR-0012).
  - `writes.ts#isWrite`: keeps plain reads on the editor's usual `query_run` path.
  - SQL tabs, notebooks (`NbQuery.tsx`) and `TruncateModal.tsx` call `historyRecord` /
    `historyTruncate` directly.
  - The tab (`ChangeHistoryTab`, `UndoDetail`, `UndoRow`) and settings
    (`HistorySettingsPane`): defaults `undoKeepDays: 7`, `undoKeepEntries: 500`,
    `undoMaxRows: 1000`.
- **Every route opens a review.** The status-bar chip, the palette, the menu, the
  inspector's `HistoryRowLink`, the toast's "View in history", and ⌥⌘Z
  (`WorkspaceShell.tsx`) all open the entry. None of them runs an undo directly.

## Alternatives considered

- **Snapshot whole tables before a write** Not adopted.
  A locked before/after read of the touched keys is used instead.
- **Relying on database features (binlog, temporal tables, PITR).** Out of scope.
  Inferred: they are engine-specific, often unavailable to the user, and would not stay
  on the machine.
- **Encrypting the store.** Wanted, but `store.rs` says it is "Not
  encrypted yet … deferred by decision". Clearing deletes the rows and runs `VACUUM`.
- **One-click undo from a toast.** Out of scope by rule 2 ("Never undo blind").

## Consequences

- **Positive:**
  - Committed changes from the grid, SQL tabs, notebooks and Truncate become
    reversible.
  - Newer data is never overwritten, because of the re-check under lock.
  - Each limitation is shown per entry.
- **Negative / trade-offs:**
  - While recording, writes run through a different execution path from `query_run`.
  - Extra locked reads add latency and lock time to each write.
  - The log holds real row values unencrypted on disk.
- **Negative / trade-offs:** ClickHouse is excluded (`Dialect::of`: "no transactions,
  and its mutations run asynchronously"), as are non-SQL engines and CSV data files.
  Structure changes (CREATE / ALTER / DROP) are listed but cannot be undone.
- **Follow-ups:** store encryption, redo of a partly undone change, and export of the
  log, which are out of scope for now.
