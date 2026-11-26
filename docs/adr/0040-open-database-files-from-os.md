# ADR-0040 — Opening database and script files from the OS

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-10-18 (`f8eb93f` feat: double click SQLite/sql files to open in bytetable)
- **Area:** App shell
- **Related:** ADR-0001, ADR-0006, ADR-0018, ADR-0026, ADR-0036, ADR-0053

## Context

Users expect to double-click a `.sqlite` / `.db` file or a `.sql` script in Finder,
Explorer or a Linux file manager and have ByteTable open it. The OS delivers the
path differently per platform: macOS sends an Apple Event (`RunEvent::Opened`) on
both cold and warm start, with nothing in `argv`; Windows and Linux put the path in
`argv`, and when ByteTable is already running the second process's `argv` reaches
the first through the single-instance plugin. On a cold start the path arrives
before the webview has loaded its JavaScript. The release profile uses
`panic = "abort"`, so a panic in this early path kills the app.

An "Open .sql file" button in the SQL editor
toolbar; that shipped earlier and separately (`989f53a`, 2026-06-18:
`openSqlFileDialog` in `src/features/workspaces/components/SqlEditorTab.tsx`). This
ADR covers the OS association.

## Decision

- **Static association in `src-tauri/tauri.conf.json` `bundle.fileAssociations`:**
  `sqlite`, `sqlite3`, `db`, `db3` (role Editor); `sql` (role Editor); and, added
  with notebooks (`b8fdcef`, ADR-0026), `md` / `markdown` as role Viewer with
  `rank: "Alternate"` so ByteTable never becomes the default Markdown app.
- **Runtime slice `src-tauri/src/features/file_open/`.** `classify` maps an extension
  (case-insensitive) to `OpenKind` `database | script | notebook`;
  `paths_from_args` filters `argv` by extension (skipping `argv[0]` and flags);
  `describe` returns `PendingOpen { path, kind }`. The extension lists carry a
  comment that they must stay in step with `tauri.conf.json` and the "Open SQLite
  file…" picker filter.
- **Queue, then pull.** `PendingOpens` (a `Mutex<Vec<PathBuf>>` whose `push` skips paths already waiting, since macOS can deliver a file via both argv and `Opened`) is managed in
  `lib.rs` before any plugin, because macOS can deliver `Opened` before `setup`.
  `queue_open` uses `try_state` (never `state`) so "not managed yet" drops the open
  instead of aborting. It pushes the paths and emits `file-open://pending` with no
  payload. `file_open_take_pending` is the only way a path leaves the queue. Fed
  from: `RunEvent::Opened` (macOS), `std::env::args()` in setup (Windows/Linux cold
  start), and the single-instance callback (warm start).
- **`file_open_read_script`** reads a script with an 8 MiB cap
  (`MAX_SCRIPT_BYTES`) and lossy UTF-8 decoding, so a stray non-UTF-8 byte does not
  refuse the file.
- **Renderer bridge `src/features/workspaces/osFileOpen.ts` (`useOsFileOpen`).**
  Drains on mount (cold start) and on every nudge (warm start). A database opens as a
  workspace through the existing SQLite open path; a script opens in an editor tab
  titled after the file when a SQL workspace is active, otherwise in the read-only
  `SqlFileViewer.tsx` (also used when the active workspace is Redis, DynamoDB,
  MongoDB, Cassandra or Typesense, which cannot render a `sql` tab); a Markdown file
  opens as a notebook. Calls are no-ops in plain-browser dev.

## Alternatives considered

- **Emit the paths in the event payload, queue only when no window exists.** This was
  the earlier version; `mod.rs` records that it lost every cold open because the
  window exists during `build()` before its JavaScript listens.
- **Hold a script until the user connects.** Earlier behaviour per `osFileOpen.ts`;
  replaced because a double-click did nothing visible.
- **Take the first `argv` element as the path.** Rejected in `paths_from_args`:
  launchers pass flags and Linux `%F` can pass several files.
- **Push a `sql` tab into any workspace.** Rejected in `osFileOpen.ts`: non-SQL
  shells would show a blank pane.

## Consequences

- **Positive:** cold and warm opens work on all three OSes with one code path in the
  frontend; no double-opens (single drain command); early-life events cannot crash
  the app.
- **Negative / trade-offs:** three extension lists must be kept in sync by hand;
  scripts over 8 MiB are refused (large dumps go through Import, ADR-0036); a script
  opened without a SQL workspace is view-only; `.csv` / `.tsv` are not associated, so
  data files (ADR-0038) open only from inside the app.
- **Follow-ups:** no file association for `.csv`/`.tsv`; no "save back to the opened
  `.sql` path" from an editor tab.
