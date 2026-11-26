# ADR-0026 — Query notebooks stored as one plain Markdown file

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-11-24 (first commit that shipped the feature: `b8fdcef` "notebook added")
- **Area:** SQL
- **Related:** ADR-0001, ADR-0004, ADR-0006, ADR-0007, ADR-0016, ADR-0021, ADR-0024, ADR-0040

## Context

Users want a document that mixes notes, queries and their results, which they
can keep in git and share. Four rules apply:

1. **the file is the notebook**: no hidden database, sidecar file or cell id;
2. **opening never runs anything**;
3. **Run all never changes data**: a write runs only from its own cell, after a
   confirmation that states the affected row count;
4. **no secrets in the file**: only the connection name and schema.

ByteTable ships no Tauri filesystem plugin. Quitting with unsaved notebooks must
not lose work, and the window hides to tray instead of quitting (ADR-0001).

## Decision

- **Format** (`src/features/notebooks/format.ts`):
  - YAML-ish front matter: `bytetable: notebook/1`, `title`, `connection`
    (name only) and `schema`.
  - Notes are plain Markdown. Each query is a ` ```sql ` block.
  - A saved result is a Markdown table between
    `<!-- bt:result rows=… ms=… at=… -->` and `<!-- /bt:result -->`.
  - `MAX_SAVED_ROWS = 20` rows are written per result and `MAX_SHOWN_ROWS = 200`
    are drawn.
  - Rows are arrays, not objects, because `SELECT *` across a join can return
    duplicate column names.
  - Results read from the file are flagged `saved`.
  - Any Markdown containing ` ```sql ` blocks opens as a notebook.
  `src/features/notebooks/example.md` is the bundled example.
- **Rust slice `src-tauri/src/features/notebooks/`:**
  - `domain.rs` has `StatementKind` `Read | Write | Transaction`, via
    `shared::readonly::sql_is_read_only` plus transaction leaders (`begin`,
    `commit`, `savepoint`, …). Transaction control is never run, because "a
    notebook runs each cell on whatever pooled connection is free, so it cannot
    hold a transaction".
  - `files.rs` reads and writes on the user's behalf. It caps reads at
    `MAX_NOTEBOOK_BYTES = 8 MiB` and allows writes only to `.md`/`.markdown`
    (`WRITABLE`), so "a renderer bug can never overwrite a database file". Writes
    are atomic (a hidden temp file, then rename). `notebook_stat` supports
    external-change detection.
  - Commands: `notebook_query_run` (cancellable via `notebook_query_cancel`;
    refuses writes on read-only workspaces; `MAX_CELL_ROWS = 10_000`),
    `notebook_classify`, `notebook_read`, `notebook_write`, `notebook_stat`,
    `app_set_unsaved` and `app_quit`.
  - **Quit guard:** `NotebooksState` keeps an `unsaved` flag. `hold_quit` (called
    from `lib.rs`'s exit handling) emits `app://quit-requested`, and the renderer
    answers through `UnsavedNotebooksModal.tsx` before calling `app_quit`.
- **Renderer `src/features/notebooks/`:**
  - `state.ts` (Zustand) and `runner.ts` are module functions on the store, so a
    run keeps going and lands its result while the tab is in the background.
  - The run policy: a read runs on Run and on Run all. A write gets a
    confirmation from its own cell and is skipped by Run all. Transaction control
    is an error.
  - The affected-row count for a write comes from the **query debugger's dry
    run** (`debugPlan`/`debugRunStep`, ADR-0021), so it is a real count.
  - Writes go through the change-history recorder when recording is on (ADR-0016).
  - `files.ts` handles new, open, save, save-as, recent files, and noticing
    changes made outside the app. `openRequest.ts` carries File ▸ Open recent as
    a window event.
  - Components: `NotebookTab.tsx`, `NbNote.tsx`, `NbQuery.tsx` (reuses
    `ResultChart`, ADR-0024), `NbMarkdown.tsx` and `NbAdd.tsx`, plus a File view
    for raw Markdown. A notebook is its own tab kind (ADR-0007).

## Alternatives considered

- **Store notebooks in an app database or a JSON sidecar with cell ids:**
  rejected by rule 1. Plain Markdown diffs line by line and renders on any git
  host.
- **Re-run queries on open:** rejected by rule 2. Saved results are shown and
  marked as coming from the file.
- **Grant the webview a filesystem plugin:** rejected in `files.rs`. It "would be
  a far wider permission than the feature needs". Narrow Rust commands accept only
  user-chosen paths and Markdown extensions.
- **Allow transactions across cells:** not possible on the pooled path, so
  transaction statements are refused (`domain.rs`). Writes apply immediately
  because "the app has no manual-transaction mode" (`runner.ts`).
- **Store connection details for portability:** rejected by rule 4. Only the
  connection name is kept, and secrets stay in the keychain (ADR-0004).

## Consequences

- **Positive:** notebooks are portable, reviewable text with no secrets. Opening
  one is side-effect free. Unsaved work is protected on quit. Writes are
  confirmed with real counts.
- **Negative / trade-offs:** only 20 rows per result survive in the file. Each
  notebook binds to one connection by name, so a renamed connection breaks the
  link. Cells cannot share session state (temp tables, `SET`). Non-SQL engines are
  not supported.
- **Follow-ups:** out of scope and absent in code: a sidebar
  notebooks list, "Add to notebook" from a SQL tab, Explain/Debug/assistant
  inside cells, query parameters, multiple connections, HTML/PDF export.
