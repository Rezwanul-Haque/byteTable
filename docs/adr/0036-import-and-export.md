# ADR-0036 — SQL/CSV import and export through the engine port

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-14 (`ee1eb89` feat(export): backend CSV/SQL export + engine-aware truncate)
- **Area:** Data movement
- **Related:** ADR-0003, ADR-0005, ADR-0006, ADR-0012, ADR-0028, ADR-0038, ADR-0040, `docs/M15-sql-import-export-explain.md`

## Context

Users need to get a table or a whole schema out as CSV or a restorable SQL dump, and
to bring CSV / `INSERT` data or a multi-table `.sql` dump back in. Building the
export text in the browser and downloading a Blob would only see the grid's current
page, and a webview Blob download is not a native save. Engines differ in identifier
quoting, in whether a multi-statement script can run atomically, and in how (or
whether) a foreign key can be bypassed for truncate/drop. Import and truncate are
writes, so read-only workspaces (ADR-0006) must refuse them in Rust.

## Decision

- **Backend slice `src-tauri/src/features/export/`** (`domain` ← `application` ←
  `commands`), owning no infrastructure. Commands: `export_table`, `export_schema`,
  `export_save`, `export_save_bytes`, `save_text_file_atomic`, `read_text_file`,
  `execute_script_text`, `import_sql`.
- **Full-table export by paging the existing port.** `application.rs` loops
  `EngineConnection::fetch_rows` in 1000-row batches until exhausted and reads DDL
  from `table_meta`; no per-engine "all rows" method was added. The only
  engine-specific hook is `EngineConnection::quote_identifier`.
- **Pure formatters in `domain/mod.rs`:** `csv_value` (quote iff `"`, `,` or `\n`)
  and `sql_value` (`NULL`, bare numbers/bools, `'…'` with `'` doubled).
  `ExportFormat` is `csv | sql`;
  `ExportScope` is `schema | data | both` and only affects SQL.
- **Restorable dumps.** `export_schema_sql` emits tables in FK dependency order via
  a Kahn topological sort (`topo_order`); tables in a cycle fall back to listing
  order and the header comment warns that FK checks may need disabling. Table names
  are written unqualified so the dump restores into whatever schema the import
  session targets; `EngineConnection::dump_qualifies_schema` opts MSSQL and
  ClickHouse out.
- **Progress over a per-invoke `tauri::ipc::Channel<Progress>`** (`{done,total}`:
  rows, tables or statements), rendered by
  `src/features/export/components/ExportProgressModal.tsx`.
- **Native dialogs, user choice as consent.** The renderer
  (`src/features/export/exportFlow.ts`) gets a path from `@tauri-apps/plugin-dialog`
  and `export_save` writes it with no scope check; in plain-browser dev the dynamic
  import fails and an info toast is shown.
- **Import runs as SQL text.** `import_sql` = `read_text_file` +
  `execute_script_text`, both calling `EngineConnection::execute_script` (atomic on
  SQLite/Postgres, non-atomic on MySQL, per the port docs). Both are gated by
  `ensure_writable`.
- **Parsing and preview in the renderer.** `src/features/import/parse.ts` holds the pure
  parsers `parseCSV`, `parseInserts`, `parseInsertsByTable`,
  `previewTable`, `previewSchema`, plus `buildInsertScript` (escaping mirrors
  `sql_value`). `ImportModal.tsx` imports CSV / INSERTs into one table, matching
  file columns to target columns from the introspection store (ADR-0028);
  `SchemaImportModal.tsx` previews a pasted or loaded dump and runs it verbatim.
  On success both invalidate introspection and refresh open grids.
- **Destructive schema maintenance lives here in the UI** (`TruncateModal`,
  `DropTableModal`, `EmptySchemaModal`, `DeleteSchemaModal`, `CreateTableModal`,
  `CreateSchemaModal` under `src/features/export/components/`), with the backend
  calls in `features/mutate`. `src/features/export/fkOverride.ts` (added `be6c1b8`,
  2026-08-14) gives a per-engine FK-override checkbox label/hint for truncate and
  drop (Postgres CASCADE, MySQL/SQLite disable checks, MSSQL its own wording,
  ClickHouse `null` — no FKs) and sends one `force` flag each adapter interprets.
- **Durable overwrite for editing.** `save_text_file_atomic` (temp file beside the
  target, `sync_all`, rename, optional `.bak`) exists for the data-file editor
  (ADR-0038); `export_save_bytes` takes base64 for the brainstorm board's PNG
  (ADR-0031).

## Alternatives considered

- **A per-engine streaming "fetch all rows" method.** Rejected in the
  `application.rs` header: it would duplicate SELECT/value-mapping per adapter.
- **Renderer-side Blob export.** Replaced because it only covers the
  loaded page; the M15 doc records "server-side (full table, not the grid's page)".
- **Schema-qualified dumps.** Rejected in the `application.rs` header: restoring
  would write back into the source table and fail on duplicate keys.
- **One generic "disable FK checks" option.** Rejected in `fkOverride.ts`: Postgres
  has no such switch and CASCADE is a different promise, so the label is per engine.
- **Parsing imports in Rust.** Not chosen; parsing client-side lets the modal show a
  matched/unknown-column preview before anything is sent (inferred).

## Consequences

- **Positive:** dumps round-trip into a different schema; exports cover every row;
  no new adapter surface beyond `quote_identifier` / `dump_qualifies_schema`;
  progress is scoped to one invoke so concurrent operations do not cross-talk.
- **Negative / trade-offs:** export text is accumulated in one in-memory `String`
  and sent over IPC (documented as a backlog item in `application.rs`); MySQL
  imports are not atomic; FK cycles can produce a dump that needs FK checks off;
  SQL engines only (`get_sql`) — Redis/Dynamo/Mongo/Cassandra/Typesense have their
  own export paths, if any.
- **Follow-ups:** stream exports straight to the destination file. Import from a
  URL is not implemented.
