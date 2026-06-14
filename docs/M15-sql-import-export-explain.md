# M15 — SQL import/export, Explain, schema-map polish

> provenance: reconstructed from shipped code + the four M15 commits; imperative = requirement.
>
> M15 is the post-M13 polish pass (it is **not** in `MILESTONES.md`). It shipped across these commits — read with `git show <hash>`:
>
> - `ee1eb89` feat(export): backend CSV/SQL export + engine-aware truncate (Task 1)
> - `b043f97` feat(sql): export, truncate, and column show/hide UI (Task 2)
> - `e8ec267` feat(sql): execution-order minimap + Explain panel (Task 3)
> - `3a3e765` feat(m15): drop-schema across engines + menu nowrap fix (Task 4)
> - `9deec77` feat(io): add Import .sql (multi-statement, 3 engines) + round-trippable export
> - `a8df228` feat(import): table CSV/.sql + schema .sql import wired into three-dot menus
>
> **One correction vs. the title:** "Explain" did **not** ship as a backend `EXPLAIN`/`EXPLAIN ANALYZE` call. There is no `explain` Tauri command and no engine method (`grep -rni explain src-tauri/src` is empty). What shipped is a **renderer-only, client-side teaching view** — clause detection by string-matching the editor SQL, rendering the logical execution order + a synthetic plan tree. This spec documents what shipped.

## Goal

Round-trippable SQL/CSV import & export, two destructive schema-maintenance actions (truncate, drop schema), a teaching "Explain & analyze" view in the SQL editor, and per-column show/hide on the data grid — all engine-aware (SQLite / MySQL / Postgres) and env-aware (production gates).

Concretely, M15 ships:

- **Export** — a table to CSV or to a SQL dump (DDL + INSERTs), or a whole schema to a SQL dump. Generated **server-side** (full table, not the grid's page), written through the native save dialog.
- **Import** — a `.sql` dump run into a target schema (multi-statement, engine-aware atomicity); CSV / SQL-INSERT data parsed client-side and applied into one target table as generated INSERTs.
- **Truncate table** — empty a table, keeping structure; engine-aware (`TRUNCATE` vs `DELETE`).
- **Drop schema** — drop every table and leave an empty schema; engine-aware.
- **Explain** — an execution-order minimap under the editor + a clause-by-clause teaching panel; purely client-side.
- **Column show/hide** — a Columns popover on the table tab; display-only render filter on the grid.
- **Menu polish** — `.ctx-item { white-space: nowrap }` so long menu labels stay on one line.

The export side ports the prototype's `bytetable/export.jsx` (`csvVal`/`sqlVal`); the import side ports `import.jsx` / `schema-import.jsx`; the explain side ports `explain.jsx`. Where the prototype downloaded via a browser Blob / ran a mock engine, ByteTable produces text in the Rust backend and runs SQL against the real connection.

## Dependencies — M4 grid, M6 SQL editor, M7 introspection, native dialog plugin

- **M4 grid** (`features/browse` `DataGrid`) — gains a display-only `hiddenColumns` prop.
- **M6 SQL editor** (`SqlEditorTab`) — gains the Explain view toggle + minimap.
- **M7 introspection** (`features/introspection` store: `loadColumns`, `loadTables`, `invalidate`, `columnsKey`) — supplies target columns for import preview, table lists for the drop modal, and the FROM-step column count for Explain; refreshed after every mutating op.
- **Native dialog plugin** (`@tauri-apps/plugin-dialog`, `dialog:allow-save` / open) — the save/open file pickers. Dynamically imported so plain-browser dev degrades to an info toast.
- Reuses the existing engine port: `fetch_rows`, `table_meta`, `list_tables`, the `ConnectionManager`, `AppError` (§5 `{ kind, message }`), and the M11 production-confirm pattern.

## Backend (Rust core)

New slice: `src-tauri/src/features/export/` (`domain`, `application`, `commands`). Truncate + drop live in the existing `features/mutate` slice. The engine port (`src-tauri/src/shared/engine.rs`) gains five methods + an `ImportResult` type + two statement-counting helpers, implemented by all three adapters under `src-tauri/src/engines/{sqlite,mysql,postgres}/mod.rs`.

### Domain — export format (CSV/SQL), export target (table/result), explain result

`features/export/domain/mod.rs` — pure, no I/O, operate on `serde_json::Value` cells from `fetch_rows`:

- `enum ExportFormat { Csv, Sql }` — `#[serde(rename_all = "lowercase")]` → `"csv"` / `"sql"` on the wire.
- `fn csv_value(&Value) -> String` — ports `csvVal`: `null` → empty field; else its string form, quoted (and embedded `"` doubled) iff it contains `"`, `,`, or `\n`. Numbers/bools never need quoting.
- `fn sql_value(&Value) -> String` — ports `sqlVal`: `null` → `NULL`; bool → `true`/`false`; number → raw JSON; string → `'…'` with `'` doubled. (Structural values, never produced by `fetch_rows`, are defensively single-quoted as their JSON text.)

There is **no** "explain result" domain type — Explain is renderer-only (see Frontend). The export "target" (table vs result) is not a domain enum either: a table export pages `fetch_rows`; "result" export is the renderer handing a query result back through the same CSV/SQL formatting — the backend only knows table/schema.

### Application — export rows → CSV/SQL; engine-aware TRUNCATE; DROP SCHEMA per engine; EXPLAIN / EXPLAIN ANALYZE; parse + run an imported .sql file into a target schema

`features/export/application.rs`:

- **Application-layer paging, not a new per-engine method.** Export needs every row, but `fetch_rows` is page-limited. Rather than add an engine "give me all rows" call (which would triplicate SELECT/value-mapping), the use-cases page the **existing** `fetch_rows` in batches of `EXPORT_BATCH_ROWS = 1000` until exhausted, and read DDL from `table_meta`. The only engine-specific need — identifier quoting — is the new `EngineConnection::quote_identifier` hook.
- `export_table(manager, handle, schema, table, format) -> Result<String>` — dispatches to:
  - `export_table_csv` — header row of `csv_value`-quoted column names, then one `\n`-joined line per row; pages via `fetch_page`.
  - `export_table_sql` — `table_meta.ddl` (terminated with `;` if it does not already end in one, so the dump re-imports cleanly) + a blank line + `INSERT INTO {q(schema)}.{q(table)} ({quoted cols}) VALUES (…);` per row; `-- (no rows)` when empty.
- `export_schema_sql(manager, handle, schema) -> Result<String>` — header comment (`-- ByteTable schema dump`, schema name, table count, an FK-order caveat) + each table's `export_table_sql` in `list_tables` order, separated by blank lines + `-- ===== Table: {name} =====` banners. **FK ordering is not applied** (out of scope; the header warns a restore may need FK checks off).
- `export_save(path, contents) -> Result<()>` — `std::fs::write`; the save-dialog path is the consent (no scope check); IO failure → `AppError::Io("Could not write {path}: …")`.
- `read_text_file(path) -> Result<String>` — `std::fs::read_to_string`; open-dialog path is consent; failure → `AppError::Io("Could not read {path}: …")`.
- `execute_script_text(manager, handle, schema, sql) -> Result<ImportResult>` — runs a multi-statement SQL **string** via `connection.execute_script(schema, sql)` (the in-memory counterpart of file import, used by the CSV-import path which builds INSERTs client-side).
- `import_sql(manager, handle, schema, path) -> Result<ImportResult>` — composed: `read_text_file(path)` then `execute_script_text(…)`, so file-path import and text import share one path.

**TRUNCATE / DROP** live in `features/mutate/application.rs`:

- `truncate_table(manager, handle, schema, table) -> Result<TruncateResult>` — delegates to `connection.truncate_table` and wraps the count in `TruncateResult { affected: u64 }`.
- `drop_schema(manager, handle, schema) -> Result<()>` — delegates to `connection.drop_schema`.

**EXPLAIN / EXPLAIN ANALYZE** — not implemented in the backend. No application function, no command. (The title's intent landed as the client-side teaching view.)

### Infrastructure — per-engine SQL dialect for truncate/drop/explain

`src-tauri/src/shared/engine.rs` — `trait EngineConnection` gains (with `Unsupported` defaults except `quote_identifier`):

- `fn quote_identifier(&self, ident: &str) -> String` — **default**: ANSI double-quote (`"x"`, embedded `"` doubled) — correct for SQLite + Postgres. **MySQL overrides** to backticks (`` `x` ``).
- `async fn truncate_table(&self, schema, table) -> Result<u64>`:
  - **Postgres / MySQL**: count rows first (TRUNCATE reports none), then `TRUNCATE TABLE`. Returns the pre-count.
  - **SQLite** (no `TRUNCATE`): `DELETE FROM …` in a transaction; `affected` = rows deleted.
  - All validate the table exists (§5) and quote identifiers.
- `async fn drop_schema(&self, schema) -> Result<()>` — "drop all tables + leave an empty schema":
  - **Postgres**: `DROP SCHEMA "x" CASCADE; CREATE SCHEMA "x";` in **one transaction** — transactional DDL → atomic.
  - **MySQL** (schema == database): `DROP DATABASE \`x\`; CREATE DATABASE \`x\`;` on one acquired session. **DDL auto-commits → NOT atomic**; recreate immediately so success always leaves an empty database. Names are fully qualified, so no re-`USE` is needed.
  - **SQLite** (no droppable schema/file): `DROP TABLE` every non-`sqlite_%` table in a transaction with `PRAGMA defer_foreign_keys=ON`. **Never deletes the file.**
  - Validates the schema exists (plain `DROP`, no `IF EXISTS`) (§5); quotes per engine.
- `async fn execute_script(&self, schema, sql) -> Result<ImportResult>`:
  - **SQLite**: `execute_batch` inside `BEGIN`/`COMMIT` (atomic; rolls back on error). Rejects a non-`main` target schema with a §5 message (no current-schema redirect for unqualified `CREATE`s).
  - **Postgres**: explicit transaction + `SET search_path`, statements split client-side and run per statement (atomic — transactional DDL).
  - **MySQL**: `USE` + per-statement execution over the **TEXT protocol** (`&str` execute — the prepared protocol rejects `SHOW CREATE TABLE` DDL). DDL auto-commits → **NOT atomic**; a mid-script failure returns a §5 error naming how far it got.
- `struct ImportResult { statements: u64 }` — `#[serde(rename_all = "camelCase")]`. Best-effort top-level statement count.
- `fn count_statements(script) -> u64` / `fn split_statements(script) -> Vec<String>` — shared, quote/comment-aware (single/double/backtick literals with doubled-quote escaping, `--` line + `/* */` block comments). Back the count and the MySQL/Postgres client-side split. Not a full SQL tokenizer; does not understand dollar-quoting — accurate for ByteTable's own dumps + ordinary scripts; a miscount only affects the cosmetic toast number.

### Tauri commands — table

Registered in `src-tauri/src/lib.rs` (lines 164–171). All read `ConnectionsState` for the handle manager. All names match the `src/shared/api/engine.ts` wrappers.

| command               | args                                            | returns                       | errors                                                         |
| --------------------- | ----------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| `export_table`        | `handleId, schema, table, format: "csv"\|"sql"` | `String` (export text)        | §5 unknown schema/table                                        |
| `export_schema`       | `handleId, schema`                              | `String` (SQL dump)           | §5 unknown schema                                              |
| `export_save`         | `path, contents`                                | `()`                          | §5 `Io` ("Could not write {path}")                             |
| `read_text_file`      | `path`                                          | `String`                      | §5 `Io` ("Could not read {path}")                              |
| `execute_script_text` | `handleId, schema, sql`                         | `ImportResult { statements }` | §5 SQL error (engine-aware atomicity)                          |
| `import_sql`          | `handleId, schema, path`                        | `ImportResult { statements }` | §5 `Io` on read; §5 SQL error                                  |
| `truncate_table`      | `handleId, schema, table`                       | `TruncateResult { affected }` | §5 unknown schema/table; engine refusal (e.g. MySQL FK-parent) |
| `drop_schema`         | `handleId, schema`                              | `()`                          | §5 unknown schema                                              |

`truncate_table` / `drop_schema` are in `features/mutate/commands.rs`; the rest in `features/export/commands.rs`.

## Frontend (React)

### State — export options; import state; explain panel state; per-column visibility set

- **Export**: no persisted state — `runExport(kind, args, toast)` (`features/export/exportFlow.ts`) is a one-shot flow. `ExportKind = "tableCsv" | "tableSql" | "schemaSql"`.
- **Import**: modal-local. `ImportModal` holds `format: "csv"|"sql"`, `text`, `prev: TablePreviewResult | null`, `busy`, `error`; target columns come from the introspection cache (warmed via `loadColumns`). `SchemaImportModal` holds the chosen `path`, `prev: SchemaPreviewResult | null`, `busy`, `error`.
- **Truncate / Drop**: modal-local `typed` (production type-to-confirm), `busy`, `error`.
- **Explain panel**: `SqlEditorTab` local `const [view, setView] = useState<"result"|"explain">("result")` — a transient view flip, not buffer/result state (need not survive a workspace switch). Detected FROM table + cached column count are derived, not stored.
- **Per-column visibility**: `TableTab` local `const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set())` — holds the **hidden** names; the grid render-filters on it.

### API — typed invoke wrappers

`src/shared/api/engine.ts`:

- `type ExportFormat = "csv" | "sql"`
- `interface TruncateResult { affected: number }`
- `interface ImportResult { statements: number }`
- `exportTable(handleId, schema, table, format) -> Promise<string>` → `export_table`
- `exportSchema(handleId, schema) -> Promise<string>` → `export_schema`
- `exportSave(path, contents) -> Promise<void>` → `export_save`
- `readTextFile(path) -> Promise<string>` → `read_text_file`
- `executeScriptText(handleId, schema, sql) -> Promise<ImportResult>` → `execute_script_text`
- `importSql(handleId, schema, path) -> Promise<ImportResult>` → `import_sql`
- `truncateTable(handleId, schema, table) -> Promise<TruncateResult>` → `truncate_table`
- `dropSchema(handleId, schema) -> Promise<void>` → `drop_schema`

Import parsing helpers are **pure, client-side** in `src/features/import/parse.ts` (no Tauri): `parseCSV`, `parseInserts`, `parseInsertsByTable`, `toObjects` (CSV type coercion via the target column's `dataType`), `previewTable`, `previewSchema`, `buildInsertScript` (escaping mirrors backend `sql_value`: numbers/bools unquoted, strings `'…'` with `'` doubled, null → `NULL`; identifiers double-quoted). Explain helpers are pure in `src/features/workspaces/components/explainClauses.ts` (`EXEC_STEPS`, `detectClauses`, `clausePresent`, `WRITTEN_ORDER`, `RUN_ORDER`, `detectedTable`).

### Components

- **Export flow** (`features/export/exportFlow.ts`) — `runExport`: generate text via the backend **first** (so a §5 surfaces before the file picker) → native `save()` dialog (default name per kind: `{table}.csv`, `{table}.sql`, `{schema}_schema.sql`) → `exportSave` → `toast("Exported {file}", "ok")`. Cancelled dialog = silent; dialog plugin missing (browser dev) = `toast("Export requires the desktop app", "info")`.
- **Table import** (`features/import/components/ImportModal.tsx`) — pick file (CSV/SQL/TXT filters) → `readTextFile` → detect format by extension (`.sql`→sql, else csv; also a CSV/SQL segmented control + paste box) → `previewTable` against the target's columns (matched/unknown chips + row count + a 5-row sample) → on Import build `buildInsertScript(schema, table, matchedCols-in-target-order, objects)` → `executeScriptText` → toast `"Imported {N} rows into {table}"` + refresh (invalidate + force `loadTables` + `requestRefetch` open grids for that table). Dialog stays open on §5 error, shown inline.
- **Schema `.sql` import** (`features/import/components/SchemaImportModal.tsx`) — pick `.sql` → `readTextFile` → `previewSchema` (lists tables it would touch + per-table INSERT row counts + total; **informational only**, does not filter against the existing schema since the dump may create tables) → on Import run the **original file** via `importSql(handle, schema, path)` (preserves DDL + ordering) → toast `"Imported {file} — {N} statements"` + sidebar/grid refresh.
- **Explain panel + minimap** (`features/workspaces/components/explain.tsx`):
  - `ExecutionMinimap({ sql })` — two columns "Written / how you type it" (`WRITTEN_ORDER`) and "Run / how it executes" (`RUN_ORDER`); each clause is on/off via `clausePresent`, numbered when present (`·` when absent); a footnote on why SELECT (5th to run) lets ORDER BY use aliases but WHERE can't. Rendered **always**, under the editor.
  - `ExplainPanel({ sql, columnCount })` — non-SELECT SQL → "Nothing to explain yet". Otherwise: left = the present clauses in logical order, each a numbered step with keyword badge + label + description (FROM step enriched with the table name and, if cached, `· {N} cols`; SELECT shows "with aggregates" / "distinct rows"); right = a synthetic psql-style plan tree (`Limit`→`Sort`→`Unique`→`HashAggregate`/`Aggregate`→`Seq Scan on {table}` with a `Filter:` line when WHERE present) + a note that a real `EXPLAIN ANALYZE` adds row estimates / index usage / timing. **No backend call** — built from `detectClauses` alone.
  - `SqlEditorTab` adds an `account_tree` toggle Btn (`filled` when active) flipping `view`; the minimap renders in `.sql-editor-main`; the explain view replaces the result area with an `.explain-bar` (a `result-tab` "back to result" + an active "Explain & analyze" tab) and `ExplainPanel`. Result/error/empty rendering otherwise unchanged.
- **Column show/hide** (`features/workspaces/components/TableTab.tsx`) — a Columns popover (`.col-pop`) in the toolbar: All / None buttons, per-column checkbox + pk/fk icon + lowercased type, a shown/total badge on the toggle when any column is hidden. Passes `hiddenColumns={hiddenCols}` to `DataGrid`. The grid is **display-only**: it still fetches every column (the row cache stays aligned to the full `columns`), it just skips rendering hidden ones and drops their grid-template track (`DataGrid` `isHidden` predicate + filtered `gridCols`).
- **Drop Schema menu item** — sidebar Tables section `.sec-actions` menu (`more_horiz`): danger "Drop schema…" opening `DropSchemaModal` (table list + DROP/CREATE SQL preview, env-aware type-to-confirm). Labels aligned to the prototype: "Import SQL dump…", "Export schema (.sql)", "Drop schema…".
- **Export as SQL menu item** — table-actions menu (`more_vert` → `.ctx-menu.table-actions-menu`) on the table tab: `Export as CSV`, `Export as SQL (schema + data)`, separator, danger `Truncate table…`, plus `Import data…`. The sidebar table context menu mirrors Export CSV/SQL + danger Truncate + Import data; the schema row gets a `download` IconBtn ("Export schema … as .sql").
- **TruncateModal / DropSchemaModal** (`features/export/components/`) — both on the shared `Modal` (focus trap + Esc + scrim), both share the `.truncate-*` / `.btn-danger` CSS family. Production env (`normalizeEnv(env) === "production"`) requires typing the table/schema name to arm the danger button; non-production is a plain confirm. Success → toast with the affected/empty result + refresh; backend §5 error stays in-modal.

### Styling — context-menu nowrap fix; panel/minimap layout

- **Nowrap fix** (`Sidebar.css`): `.ctx-item { white-space: nowrap }` so "Export as SQL (schema + data)" and similar labels stay on one line. Menu dropdowns are position-scoped so `.ctx-menu` doesn't override the `.sec-actions`/`.table-actions` anchors (commit `22fa55a`).
- **Explain / minimap** (`SqlEditorTab.css`): `.exec-minimap` / `.exec-mini-*` (two-column written/run grid, on/off step rows), `.explain-panel` / `.explain-*` (two-column steps + plan tree, `.explain-plan-tree` mono `<pre>`), `.result-tab`, `.sql-editor-main` — ported byte-exact from the prototype.
- **Columns popover / menus** (`TableTab.css`): `.col-*`, `.ctx-item.danger`, `.ctx-menu-label`, `.ctx-sep`, `.btn-danger`, `.table-actions-menu`. **Import / modals** (`ImportModal.css`, `TruncateModal.css`): `.import-*`, `.sec-actions*`, `.schema-import-*`, `.truncate-*`. All ported byte-exact from `ByteTable.html`.

## Shared data contracts — TS + Rust types

| concept         | Rust (`src-tauri`)                                               | TS (`src/shared/api/engine.ts`)                                 |
| --------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| export format   | `enum ExportFormat { Csv, Sql }` (lowercase wire)                | `type ExportFormat = "csv" \| "sql"`                            |
| truncate result | `struct TruncateResult { affected: u64 }` (camelCase)            | `interface TruncateResult { affected: number }`                 |
| import result   | `struct ImportResult { statements: u64 }` (camelCase)            | `interface ImportResult { statements: number }`                 |
| export request  | command args: `handleId, schema, table?, format`                 | `exportTable` / `exportSchema` params                           |
| import request  | command args: `handleId, schema, path` (file) or `…, sql` (text) | `importSql` / `executeScriptText` params                        |
| explain         | **none** (client-side only)                                      | `DetectedClauses` (`explainClauses.ts`); never crosses the wire |

Import preview / parse contracts (TS-only, `features/import/parse.ts`): `Parsed`, `ParsedValue`, `RowObject`, `ImportFormat`, `TablePreview`/`TablePreviewResult` (+ `isPreviewError`), `SchemaPreview`/`SchemaPreviewResult` (+ `isSchemaPreviewError`), `TableGroup`.

## Behavior & edge cases — production guards; engine-correct syntax; import batching/errors; menu single-line

- **Production guards.** Truncate and Drop Schema both gate on `production` env with a type-to-confirm input (must equal the table/schema name to arm the danger button); non-production confirms directly. (Drop also lists the tables + total rows being destroyed.)
- **Engine-correct syntax.** Truncate: `TRUNCATE TABLE` on PG/MySQL (counted first), `DELETE` in a transaction on SQLite. Drop: PG `DROP SCHEMA … CASCADE; CREATE SCHEMA …` (atomic); MySQL `DROP/CREATE DATABASE` (non-atomic, recreate immediately); SQLite drops all user tables in a transaction, never the file. Identifier quoting per engine (`"x"` SQLite/PG, `` `x` `` MySQL).
- **Import statement batching / errors.** A `.sql` file/text runs through the engine's `execute_script`: **SQLite/Postgres atomic** (a mid-script failure rolls everything back — no half-created tables); **MySQL non-atomic** (DDL auto-commits — statements before the failure stay applied; the §5 error names how far it got). `ImportResult.statements` is the best-effort `count_statements` value used in the success toast. CSV import builds INSERTs client-side (matched columns only, in the target's column order) and runs them via `execute_script_text`. A bad file path is a §5 `Io` error.
- **Round-trip.** `export_table_sql` terminates the CREATE DDL with `;` so a dump re-imports cleanly via `import_sql` (or external `psql`/`sqlite3`). `parseInserts`/`splitValues` round-trip ByteTable's own quoting (`''`).
- **Export is server-side, full table.** Generation pages `fetch_rows` (1000/batch) over the whole table — not the grid's current page. The text is accumulated into one in-memory `String` (documented backlog: streaming to disk for very large tables).
- **Column hide is display-only.** Hiding never changes what is fetched; the row cache stays aligned to the full column set, so FK-hop / insights / inline-edit indexing is unaffected.
- **Explain is detection-only.** Clause presence is string-matched after masking string literals (`'…''…'`) and `--` comments; forgiving on multi-line SQL. No engine call, no row counts. Non-SELECT → "Nothing to explain yet".
- **Browser-dev degradation.** The dialog plugin is dynamically imported; in plain-browser dev the import rejects and export/import surface an info toast instead of crashing.
- **Menu labels single-line.** `.ctx-item { white-space: nowrap }` keeps long labels (e.g. "Export as SQL (schema + data)") on one line.

## Acceptance criteria

- **Export table CSV** — table-actions → "Export as CSV" produces a header row + one `\n`-line per row, full table; commas/quotes/newlines quoted per RFC-4180; NULL → empty field; written to the chosen path; toast.
- **Export table SQL** — "Export as SQL (schema + data)" produces the `CREATE TABLE …;` DDL + one `INSERT INTO "schema"."table" (…) VALUES (…);` per row; `'` doubled in string literals; `-- (no rows)` for an empty table.
- **Export schema SQL** — sidebar schema download / sec-actions → a dump with the header comment, every base table's DDL + INSERTs in listing order, FK-order caveat present.
- **Re-import** — importing an exported SQL dump into a fresh schema recreates the table + every row (e.g. 1 DDL + 3 INSERTs = `statements: 4`); apostrophe / comma / multi-line / NULL values survive the round trip.
- **Truncate across engines** — Truncate empties the table (structure kept); `affected` = prior row count; toast "Truncated {table} — N rows removed"; production env requires typing the name; an engine refusal (e.g. MySQL FK-parent) shows in-modal.
- **Drop schema across engines** — Drop leaves the schema **existing but empty** (PG drops+recreates; MySQL drops+recreates the database; SQLite drops every user table, keeps the file); a nonexistent schema is a §5 error; production env requires typing the name; sidebar shows the schema empty afterward.
- **Explain renders** — toggling the Explain view on a SELECT shows the logical-order step list (FROM→…→LIMIT, only present clauses) + the plan tree; the minimap shows written vs. run order with on/off numbering; a non-SELECT shows "Nothing to explain yet"; no backend call is made.
- **Column hide/show** — the Columns popover hides/shows columns (All/None work, shown/total badge updates); hidden columns drop from the grid header + body + template; data still fetches/edits correctly.
- **Menu nowrap** — "Export as SQL (schema + data)" and the sec-actions labels render on a single line.

## Pixel / UX checklist

- Columns popover: `.col-pop` with head (title + All/None), scrollable list, per-row checkbox + pk/fk icon + lowercased type; toggle button shows a shown/total badge only when something is hidden.
- Table-actions menu: `more_vert` → `.ctx-menu.table-actions-menu` with an "Export" label, Export as CSV (`table_view`), Export as SQL (schema + data) (`code`), Import data… (`upload`), `.ctx-sep`, danger Truncate table… (`delete_sweep`).
- Sidebar sec-actions: `more_horiz` → Import SQL dump… (`upload`), Export schema (.sql) (`download`), danger Drop schema… (`delete_forever`); schema row also has a `download` IconBtn; per-table context menu has Import data… + Export CSV/SQL + danger Truncate.
- Truncate / Drop modals: warning icon + danger button (`delete_forever`, "Truncate" / "Drop schema", "…ing" while busy); SQL preview `<pre>`; production tag chip (env color) + type-to-confirm input (`autoFocus`); Drop also shows the table list (name + row count).
- Import modals: CSV/SQL segmented control + "Choose file…", paste textarea, preview bar (N rows ready, matched columns, "ignoring: …" for unknown), 5-row sample table (NULL cells styled), inline §5 error; schema import shows the per-table row-count list + the atomicity note.
- Explain: `account_tree` toggle Btn (filled when active); minimap two columns with keyword chips + on/off numbers + footnote; panel two columns (numbered steps with keyword badges + descriptions | mono plan tree + a "real EXPLAIN ANALYZE also reports…" note); `.explain-bar` back-tab to the result.
- Menus: `.ctx-item` labels never wrap.
