# ADR-0038 — CSV/TSV data files as workspaces

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-08-18 (`58b103c` feat: open CSV/TSV files as workspace with profiling, data-quality checks and SQL like query options)
- **Area:** Data browsing
- **Related:** ADR-0006, ADR-0007, ADR-0011, ADR-0019, ADR-0036, ADR-0040

## Context

A user with a delimited file wants to know what is in it, whether it is clean, and
to query it, without importing it into a database or opening a spreadsheet. The
original plan was a read-only viewer. CSV has no types and no NULL, delimiters vary, and the
cardinal sin for such a tool is silently reshaping the user's file.

## Decision

- **Renderer-only slice `src/features/data_file/`**; the only backend pieces are
  shared commands: `read_text_file`, `save_text_file_atomic` (ADR-0036) and the
  normal SQLite adapter / `query_run`.
- **Pure core in `core.ts`** (tested by `core.test.ts`): `sniff` (delimiter + header
  detection, `DELIMS`), RFC-4180 `parse` that records ragged rows and per-record
  text spans, null tokens (`NULLS`: `""`, `null`, `nil`, …), type inference over
  `boolean | integer | decimal | datetime | date | uuid | email | url | json | text`
  (a type wins at ≥ 90% of non-null values, `TYPE_THRESHOLD`, with a minimum
  sample), per-column profiles and histograms, duplicate rows, and `findIssues`
  producing severity-ranked `Issue`s (ragged rows, type mismatches, empty /
  constant / sparse columns, padded values, duplicate keys, duplicate rows), each
  carrying a fix sentence and row indexes the Data tab can filter to.
- **One derived document per workspace.** `doc.ts` (`buildDoc`, `useDataFileDoc`)
  parses and profiles once per `workspace.file` change, shared by all tabs.
- **A data file is a workspace, not a connection.** `open.ts` (`useOpenDataFile`)
  opens an unsaved registry entry (empty `id`, so `sessionSync` skips it) with
  `engine: "sqlite"` and `path: ":memory:"`, and stores a `DataFileRef`
  (`name`, `path`, `size`, `text`, `opts`; `src/features/workspaces/types.ts`) on
  the workspace via `openFileWorkspace`. UI identity comes from `workspace.file`.
- **Four tabs** (`state.ts` `DataFileTabKind`: `data`, `profile`, `issues`, `sql`),
  view state in a Zustand store keyed by workspace id so it survives the
  active-workspace unmount. Components: `DataFileWorkspace`, `DataFileSidebar`,
  `DataFileDataTab`, `DataFileProfileTab`, `DataFileIssuesTab`, `DataFileSqlTab`,
  and `OpenDataFileSheet` (drop zone, delimiter/header/trim controls, live preview,
  three generated `DEMOS` from a seeded LCG in `demos.ts`).
- **SQL through the real engine.** `sqlSession.ts` loads the file into the
  in-memory SQLite database as one table (`buildLoadScript`, 200-row INSERT
  batches) and runs queries with the same `query_run` as any connection.
  `runDataFileQuery` allows only `select | with | explain | pragma`
  (`SELECT_ONLY`), enforced in the renderer, because the scratch copy is not what
  gets saved.
- **Filtering:** the structured filter builder is evaluated in memory
  (`filterRows.ts` `evaluateDraft`, reusing browse/sql operator definitions); the
  raw-WHERE mode runs against the scratch table and maps `rowid - 1` back to file
  rows (`selectMatchingRows`).
- **In-place editing, despite the original "read-only" plan.** `csvWrite.ts`
  `serializeFile` splices edits into the original text: untouched records and
  untouched fields are copied byte for byte (quoting, null spelling, BOM, CRLF,
  ragged counts); only edited fields are re-quoted. `save.ts` overwrites through
  `save_text_file_atomic` or writes "Save a copy" to a new path.
- **Two file sources** (`dialog.ts`): native picker + Tauri drag-drop paths in the
  desktop shell; `<input type=file>` + `FileReader` in plain-browser dev.

## Alternatives considered

- **Import into a real database.** Rejected: the viewer is not an importer.
- **A second query engine in the renderer.** Rejected in `sqlSession.ts`: reusing
  `query_run` keeps result grid, timings and §5 errors identical.
- **Pushing the structured filter to SQLite.** Rejected in `filterRows.ts`: in-memory
  evaluation is exact, has no IPC round trip and avoids quoting user text into SQL.
- **Re-serializing the whole file on save.** Rejected in `csvWrite.ts`: it would
  change cells the user never touched.
- **Parsing in Rust.** Not chosen; keeping the core pure TS makes it unit-testable
  and reusable by the importer, per the `core.ts` header (inferred as the main
  reason).

## Consequences

- **Positive:** profiling and quality checks are instant after open; SQL behaves
  exactly like the SQL editor; saves change only edited cells and are crash-safe.
- **Negative / trade-offs:** the whole file is held as one string in the webview
  and parsed on the main thread, so very large files are bounded by memory; the
  scratch database lives only as long as the workspace; mixed line endings
  collapse to the dominant one on save; `.csv`/`.tsv` are not in
  `bundle.fileAssociations`, so a double-click does not open them (ADR-0040).
- **Follow-ups:** no streaming or worker-based parse; SELECT-only is a renderer
  check, not a backend guarantee.
