//! Use-cases for the export slice (M15): build the CSV / SQL text for a table
//! or a whole schema, and write generated text to a user-chosen path.
//!
//! # Generation approach — application-layer paging (not a per-engine method)
//!
//! Export needs ALL rows, but the engine port has no "give me every row" call;
//! `fetch_rows` is page-limited (each adapter clamps to its `MAX_PAGE_ROWS`).
//! Rather than add a new per-engine streaming method to `EngineConnection`
//! (which would duplicate the SELECT/value-mapping logic three times), the
//! export use-cases page through the EXISTING `fetch_rows` in batches until the
//! table is exhausted, and read the `CREATE TABLE` DDL from `table_meta`. The
//! only engine-specific need left — quoting identifiers for the `INSERT`
//! statements — is satisfied by the small `EngineConnection::quote_identifier`
//! hook (double quotes for SQLite/Postgres, backticks for MySQL), so no engine
//! SQL leaks into this layer. Value→CSV/SQL formatting lives in `domain` as
//! pure helpers.
//!
//! Perf/cap note (M15, documented backlog): the text is accumulated into one
//! `String` in memory. For very large tables this is a large allocation;
//! streaming straight to the destination file is a future enhancement. The
//! batch size below bounds peak row buffering, not the final string.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::{EngineConnection, FetchRowsRequest, ImportResult};
use crate::shared::error::AppError;

use super::domain::{csv_value, sql_value, ExportFormat};

/// Rows pulled per `fetch_rows` page during export. Each adapter clamps a
/// request to its own `MAX_PAGE_ROWS` (10k for SQLite); 1000 is comfortably
/// under every adapter's ceiling and keeps per-batch buffering small.
const EXPORT_BATCH_ROWS: u32 = 1000;

/// Generate the export text for one table in the chosen format.
pub async fn export_table(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    table: &str,
    format: ExportFormat,
) -> Result<String, AppError> {
    let connection = manager.get_sql(handle).await?;
    match format {
        ExportFormat::Csv => export_table_csv(connection.as_ref(), schema, table).await,
        ExportFormat::Sql => export_table_sql(connection.as_ref(), schema, table).await,
    }
}

/// Generate a SQL dump (DDL + data) for every base table in a schema,
/// concatenated in `list_tables` order, separated by blank lines, under a
/// header comment. FK ordering is NOT applied (M15 scope) — the header notes
/// that a restore may need foreign-key checks disabled.
pub async fn export_schema_sql(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
) -> Result<String, AppError> {
    let connection = manager.get_sql(handle).await?;
    let tables = connection.list_tables(schema).await?;

    let mut out = String::new();
    out.push_str("-- ByteTable schema dump\n");
    out.push_str(&format!("-- schema: {schema}\n"));
    out.push_str(&format!("-- {} tables\n", tables.len()));
    out.push_str(
        "-- NOTE: tables are dumped in listing order, NOT foreign-key order; \
         a restore may need FK checks disabled.\n\n",
    );

    for (index, table) in tables.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&format!("-- ===== Table: {} =====\n", table.name));
        let dump = export_table_sql(connection.as_ref(), schema, &table.name).await?;
        out.push_str(&dump);
        if !dump.ends_with('\n') {
            out.push('\n');
        }
    }
    Ok(out)
}

/// Write generated export text to a user-chosen path (create/truncate). The
/// path comes from the native save dialog, so the user's choice is the consent
/// — no scope check (mirrors `schema_map::diagram_export`). Any IO failure
/// surfaces a §5 human sentence naming the path.
pub fn export_save(path: &str, contents: &str) -> Result<(), AppError> {
    std::fs::write(path, contents)
        .map_err(|err| AppError::Io(format!("Could not write {path}: {err}")))
}

/// Read a user-picked text file (CSV or `.sql`) into a `String` for the
/// renderer to preview/parse. The `path` comes from the native open dialog, so
/// the user's choice is the consent — no scope check (mirrors `export_save`'s
/// path handling). A missing / unreadable file is a §5 IO error naming the
/// path (the same shape `import_sql`'s read used).
pub fn read_text_file(path: &str) -> Result<String, AppError> {
    std::fs::read_to_string(path)
        .map_err(|err| AppError::Io(format!("Could not read {path}: {err}")))
}

/// Run a multi-statement SQL script given as TEXT (not a file path) into
/// `schema` via the engine's `execute_script`. This is the in-memory
/// counterpart of `import_sql`: the renderer can hand over generated SQL (e.g.
/// `INSERT`s built from a parsed CSV) without round-tripping through a temp
/// file. Engine-aware atomicity is the engine's (atomic for SQLite/Postgres,
/// non-atomic for MySQL — see `EngineConnection::execute_script`); any SQL
/// failure surfaces its §5 message. Returns the number of statements executed.
pub async fn execute_script_text(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    sql: &str,
) -> Result<ImportResult, AppError> {
    let connection = manager.get_sql(handle).await?;
    connection.execute_script(schema, sql).await
}

/// Import a `.sql` dump: read the file at `path` (the path comes from the
/// renderer's native open dialog, so the user's choice is the consent — no
/// scope check, mirroring `export_save`'s write side), then run the whole
/// multi-statement script into `schema` via the engine's `execute_script`.
///
/// Composed from `read_text_file` + `execute_script_text` so the file-path
/// import and the text import share one code path. The read is the I/O
/// counterpart of `export_save`'s write: a missing / unreadable file is a §5 IO
/// error naming the path. The script itself runs engine-aware (atomic for
/// SQLite/Postgres, non-atomic for MySQL — see
/// `EngineConnection::execute_script`); any SQL failure surfaces its §5 message.
/// Returns the number of statements executed.
pub async fn import_sql(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    path: &str,
) -> Result<ImportResult, AppError> {
    let contents = read_text_file(path)?;
    execute_script_text(manager, handle, schema, &contents).await
}

// ---------------------------------------------------------------------------
// CSV / SQL generation (engine-agnostic; pages via fetch_rows)
// ---------------------------------------------------------------------------

/// CSV: a header row of column names, then one line per row, every field
/// formatted by `csv_value` (the prototype's `csvVal`). Lines are joined by
/// `\n`, matching `toCSV`.
async fn export_table_csv(
    connection: &dyn EngineConnection,
    schema: &str,
    table: &str,
) -> Result<String, AppError> {
    // First page also gives us the column metadata for the header. An unknown
    // schema/table surfaces here as the adapter's §5 error.
    let first = fetch_page(connection, schema, table, 0).await?;
    let columns: Vec<String> = first.columns.iter().map(|c| c.name.clone()).collect();

    let mut lines: Vec<String> = Vec::new();
    lines.push(
        columns
            .iter()
            .map(|name| csv_value(&serde_json::Value::String(name.clone())))
            .collect::<Vec<_>>()
            .join(","),
    );

    let mut offset = 0u64;
    let mut page = first;
    loop {
        for row in &page.rows {
            lines.push(row.iter().map(csv_value).collect::<Vec<_>>().join(","));
        }
        let fetched = page.rows.len() as u64;
        if fetched < u64::from(EXPORT_BATCH_ROWS) {
            break; // last (short) page
        }
        offset += fetched;
        page = fetch_page(connection, schema, table, offset).await?;
        if page.rows.is_empty() {
            break;
        }
    }

    Ok(lines.join("\n"))
}

/// SQL: the table's `CREATE TABLE` DDL (from `table_meta.ddl`) followed by one
/// `INSERT INTO "schema"."table" (cols) VALUES (...);` per row, every value
/// formatted by `sql_value` (the prototype's `sqlVal`). Identifiers are quoted
/// per engine via `connection.quote_identifier`.
async fn export_table_sql(
    connection: &dyn EngineConnection,
    schema: &str,
    table: &str,
) -> Result<String, AppError> {
    // table_meta validates existence (§5) and supplies the DDL + column order.
    let meta = connection.table_meta(schema, table).await?;
    let columns: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    // Per-column "is binary" flags: binary columns export as an engine hex
    // literal (X'..' / bytea) so they round-trip, instead of a quoted string.
    let binary_cols: Vec<bool> = meta
        .columns
        .iter()
        .map(|c| crate::shared::engine::is_binary_type(&c.data_type))
        .collect();

    let qualified = format!(
        "{}.{}",
        connection.quote_identifier(schema),
        connection.quote_identifier(table)
    );
    let quoted_cols = columns
        .iter()
        .map(|c| connection.quote_identifier(c))
        .collect::<Vec<_>>()
        .join(", ");

    let mut out = String::new();
    match &meta.ddl {
        Some(ddl) => {
            out.push_str(ddl);
            // Terminate the CREATE statement so the dump is a valid, re-importable
            // multi-statement script. Engines report the DDL verbatim WITHOUT a
            // trailing `;` (SQLite's `sqlite_schema.sql`, MySQL's `SHOW CREATE
            // TABLE`); Postgres's assembled DDL already ends `);`. Append `;`
            // only when the DDL does not already end with one — so `import_sql`
            // (and any external psql/sqlite3 restore) does not glue the first
            // INSERT onto the CREATE.
            if !ddl.trim_end().ends_with(';') {
                out.push(';');
            }
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
        None => out.push_str(&format!("-- (no DDL available for {qualified})\n")),
    }
    out.push('\n');

    let mut wrote_any = false;
    let mut offset = 0u64;
    loop {
        let page = fetch_page(connection, schema, table, offset).await?;
        if page.rows.is_empty() {
            break;
        }
        for row in &page.rows {
            let values = row
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    if binary_cols.get(i).copied().unwrap_or(false) {
                        binary_sql_value(connection, v)
                    } else {
                        sql_value(v)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            out.push_str(&format!(
                "INSERT INTO {qualified} ({quoted_cols}) VALUES ({values});\n"
            ));
            wrote_any = true;
        }
        let fetched = page.rows.len() as u64;
        if fetched < u64::from(EXPORT_BATCH_ROWS) {
            break;
        }
        offset += fetched;
    }
    if !wrote_any {
        out.push_str("-- (no rows)\n");
    }

    Ok(out)
}

/// Render one cell of a binary column for the SQL dump. A `0x`-hex value (from
/// `binary_to_json`) becomes an engine binary literal (`X'..'` / bytea) so it
/// round-trips; NULL stays NULL. A large-blob placeholder ("[N bytes]") — whose
/// bytes were never loaded — cannot be reconstructed, so it exports as NULL (a
/// documented loss; ByteTable does not yet stream full blobs).
fn binary_sql_value(connection: &dyn EngineConnection, value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::String(s) => {
            match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                Some(hex) if hex.len() % 2 == 0 && hex.bytes().all(|b| b.is_ascii_hexdigit()) => {
                    connection.binary_literal(&hex.to_ascii_lowercase())
                }
                _ => "NULL".to_string(),
            }
        }
        other => sql_value(other),
    }
}

/// Fetch one export-sized page (no sort, no filter) at `offset`.
async fn fetch_page(
    connection: &dyn EngineConnection,
    schema: &str,
    table: &str,
    offset: u64,
) -> Result<crate::shared::engine::RowsPage, AppError> {
    connection
        .fetch_rows(FetchRowsRequest {
            schema: schema.to_string(),
            table: table.to_string(),
            sort: None,
            filter: None,
            offset,
            limit: EXPORT_BATCH_ROWS,
        })
        .await
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::shared::engine::{
        ColumnInfo, ColumnMeta, Engine, EngineInfo, OpenConnection, QueryOptions, QueryResult,
        RowsPage, SchemaInfo, TableInfo, TableMeta, UpdateCellRequest, UpdateResult,
    };

    /// A fake connection backed by an in-memory table: fixed columns + rows,
    /// with a DDL string. `fetch_rows` honours offset/limit so the paging loop
    /// is exercised. Other methods are stubs.
    struct FakeTable {
        columns: Vec<String>,
        rows: Vec<Vec<serde_json::Value>>,
        ddl: Option<String>,
    }

    #[async_trait]
    impl EngineConnection for FakeTable {
        fn engine_info(&self) -> EngineInfo {
            EngineInfo {
                engine: Engine::Sqlite,
                server_version: "fake".into(),
            }
        }
        async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
            Ok(vec![])
        }
        async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, AppError> {
            Ok(vec![TableInfo {
                name: "t".into(),
                approx_row_count: Some(self.rows.len() as u64),
            }])
        }
        async fn table_meta(&self, _schema: &str, _table: &str) -> Result<TableMeta, AppError> {
            Ok(TableMeta {
                columns: self
                    .columns
                    .iter()
                    .map(|name| ColumnInfo {
                        name: name.clone(),
                        data_type: "TEXT".into(),
                        nullable: true,
                        pk: false,
                        default_value: None,
                        fk: None,
                    })
                    .collect(),
                ddl: self.ddl.clone(),
                ..Default::default()
            })
        }
        async fn run_query(
            &self,
            _sql: &str,
            _options: QueryOptions,
        ) -> Result<QueryResult, AppError> {
            unreachable!()
        }
        async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
            let start = req.offset as usize;
            let end = (start + req.limit as usize).min(self.rows.len());
            let slice = if start >= self.rows.len() {
                Vec::new()
            } else {
                self.rows[start..end].to_vec()
            };
            Ok(RowsPage {
                columns: self
                    .columns
                    .iter()
                    .map(|name| ColumnMeta {
                        name: name.clone(),
                        type_hint: "TEXT".into(),
                    })
                    .collect(),
                rows: slice,
                offset: req.offset,
                limit: req.limit,
                total_rows: Some(self.rows.len() as u64),
                elapsed_ms: 0,
            })
        }
        async fn update_cell(&self, _req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
            unreachable!()
        }
        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    async fn manager_with(conn: FakeTable) -> (ConnectionManager, ConnectionHandleId) {
        let manager = ConnectionManager::new();
        let handle = manager.insert(OpenConnection::sql(conn)).await;
        (manager, handle)
    }

    #[test]
    fn binary_sql_value_emits_hex_literal_else_null() {
        // FakeTable inherits the default `X'..'` binary literal.
        let conn = FakeTable {
            columns: vec![],
            rows: vec![],
            ddl: None,
        };
        assert_eq!(
            binary_sql_value(&conn, &serde_json::json!("0xC0FFEE")),
            "X'c0ffee'"
        );
        assert_eq!(binary_sql_value(&conn, &serde_json::json!("0x")), "X''");
        assert_eq!(binary_sql_value(&conn, &serde_json::Value::Null), "NULL");
        // A large-blob placeholder can't be reconstructed → NULL.
        assert_eq!(
            binary_sql_value(&conn, &serde_json::json!("[4096 bytes]")),
            "NULL"
        );
        // Odd-length / non-hex strings are not treated as binary literals.
        assert_eq!(binary_sql_value(&conn, &serde_json::json!("0xABC")), "NULL");
    }

    #[tokio::test]
    async fn csv_has_header_then_one_line_per_row_with_escaping() {
        let conn = FakeTable {
            columns: vec!["id".into(), "name".into()],
            rows: vec![
                vec![serde_json::json!(1), serde_json::json!("Ada")],
                vec![serde_json::json!(2), serde_json::json!("a,\"b\"")],
                vec![serde_json::json!(3), serde_json::json!(null)],
            ],
            ddl: None,
        };
        let (manager, handle) = manager_with(conn).await;
        let csv = export_table(&manager, &handle, "main", "t", ExportFormat::Csv)
            .await
            .unwrap();
        assert_eq!(csv, "id,name\n1,Ada\n2,\"a,\"\"b\"\"\"\n3,");
    }

    #[tokio::test]
    async fn sql_has_ddl_then_one_insert_per_row() {
        let conn = FakeTable {
            columns: vec!["id".into(), "name".into()],
            rows: vec![
                vec![serde_json::json!(1), serde_json::json!("O'Brien")],
                vec![serde_json::json!(2), serde_json::json!(null)],
            ],
            ddl: Some("CREATE TABLE t (id INTEGER, name TEXT)".into()),
        };
        let (manager, handle) = manager_with(conn).await;
        let sql = export_table(&manager, &handle, "main", "t", ExportFormat::Sql)
            .await
            .unwrap();
        // The DDL is terminated with `;` so the dump re-imports cleanly.
        assert!(sql.starts_with("CREATE TABLE t (id INTEGER, name TEXT);\n\n"));
        assert!(
            sql.contains("INSERT INTO \"main\".\"t\" (\"id\", \"name\") VALUES (1, 'O''Brien');")
        );
        assert!(sql.contains("INSERT INTO \"main\".\"t\" (\"id\", \"name\") VALUES (2, NULL);"));
    }

    #[tokio::test]
    async fn empty_table_csv_is_just_the_header() {
        let conn = FakeTable {
            columns: vec!["id".into()],
            rows: vec![],
            ddl: None,
        };
        let (manager, handle) = manager_with(conn).await;
        let csv = export_table(&manager, &handle, "main", "t", ExportFormat::Csv)
            .await
            .unwrap();
        assert_eq!(csv, "id");
    }

    #[tokio::test]
    async fn empty_table_sql_notes_no_rows() {
        let conn = FakeTable {
            columns: vec!["id".into()],
            rows: vec![],
            ddl: Some("CREATE TABLE t (id INTEGER)".into()),
        };
        let (manager, handle) = manager_with(conn).await;
        let sql = export_table(&manager, &handle, "main", "t", ExportFormat::Sql)
            .await
            .unwrap();
        assert!(sql.contains("-- (no rows)"));
    }

    #[tokio::test]
    async fn paging_crosses_batch_boundary() {
        // More rows than one export batch → the loop must page until exhausted.
        let n = (EXPORT_BATCH_ROWS as usize) + 5;
        let rows: Vec<Vec<serde_json::Value>> =
            (0..n).map(|i| vec![serde_json::json!(i as i64)]).collect();
        let conn = FakeTable {
            columns: vec!["id".into()],
            rows,
            ddl: Some("CREATE TABLE t (id INTEGER)".into()),
        };
        let (manager, handle) = manager_with(conn).await;
        let csv = export_table(&manager, &handle, "main", "t", ExportFormat::Csv)
            .await
            .unwrap();
        // header + every row present
        assert_eq!(csv.lines().count(), n + 1);
        assert!(csv.lines().last().unwrap().ends_with(&(n - 1).to_string()));

        let sql = export_table(&manager, &handle, "main", "t", ExportFormat::Sql)
            .await
            .unwrap();
        assert_eq!(sql.matches("INSERT INTO").count(), n);
    }

    #[tokio::test]
    async fn schema_dump_has_header_and_each_table() {
        let conn = FakeTable {
            columns: vec!["id".into()],
            rows: vec![vec![serde_json::json!(1)]],
            ddl: Some("CREATE TABLE t (id INTEGER)".into()),
        };
        let (manager, handle) = manager_with(conn).await;
        let dump = export_schema_sql(&manager, &handle, "main").await.unwrap();
        assert!(dump.starts_with("-- ByteTable schema dump"));
        assert!(dump.contains("-- schema: main"));
        assert!(dump.contains("-- ===== Table: t ====="));
        assert!(dump.contains("CREATE TABLE t (id INTEGER)"));
        assert!(dump.contains("INSERT INTO"));
    }

    #[test]
    fn export_save_writes_then_reads_back_identical() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.csv");
        let contents = "id,name\n1,Ada\n";
        export_save(&path.to_string_lossy(), contents).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), contents);
    }

    #[test]
    fn export_save_to_a_bad_path_is_an_io_error_naming_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("no/such/dir/out.csv");
        let err = export_save(&bad.to_string_lossy(), "x").unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert!(err.to_string().contains("Could not write"));
    }

    #[test]
    fn read_text_file_round_trips_a_tempdir_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("in.csv");
        let contents = "id,name\n1,Ada\n2,O'Brien\n";
        std::fs::write(&path, contents).unwrap();
        assert_eq!(read_text_file(&path.to_string_lossy()).unwrap(), contents);
    }

    #[test]
    fn read_text_file_on_a_missing_path_is_an_io_error_naming_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.csv");
        let err = read_text_file(&missing.to_string_lossy()).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert!(err.to_string().contains("Could not read"));
    }

    #[tokio::test]
    async fn closed_handle_is_a_not_found() {
        let manager = ConnectionManager::new();
        let handle = ConnectionHandleId("ghost".into());
        let err = export_table(&manager, &handle, "main", "t", ExportFormat::Csv)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn unknown_table_csv_is_a_human_error() {
        let conn = FakeUnknownTable;
        let manager = ConnectionManager::new();
        let handle = manager.insert(OpenConnection::sql(conn)).await;
        let err = export_table(&manager, &handle, "main", "ghost", ExportFormat::Csv)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));
    }

    /// A fake whose `fetch_rows` / `table_meta` reject any table as missing —
    /// to prove an unknown table surfaces the adapter's §5 error through both
    /// export paths.
    struct FakeUnknownTable;

    #[async_trait]
    impl EngineConnection for FakeUnknownTable {
        fn engine_info(&self) -> EngineInfo {
            EngineInfo {
                engine: Engine::Sqlite,
                server_version: "fake".into(),
            }
        }
        async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
            Ok(vec![])
        }
        async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, AppError> {
            Ok(vec![])
        }
        async fn table_meta(&self, _schema: &str, table: &str) -> Result<TableMeta, AppError> {
            Err(AppError::Database(format!(
                "Table '{table}' does not exist. Available tables: (none)."
            )))
        }
        async fn run_query(
            &self,
            _sql: &str,
            _options: QueryOptions,
        ) -> Result<QueryResult, AppError> {
            unreachable!()
        }
        async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
            Err(AppError::Database(format!(
                "Table '{}' does not exist. Available tables: (none).",
                req.table
            )))
        }
        async fn update_cell(&self, _req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
            unreachable!()
        }
        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }
}

/// SQLite-backed export integration tests: the REAL `engines::sqlite` adapter
/// against a tempdir database file, exercised through the export use-cases. No
/// env gating — a tempdir SQLite file is always available (mirrors the M15
/// task's "tempdir SQLite" requirement). The Postgres/MySQL equivalents live in
/// their own adapter modules behind `BYTETABLE_TEST_*_URL`.
#[cfg(test)]
mod sqlite_integration {
    use super::*;
    use crate::engines::sqlite::SqliteConnector;
    use crate::shared::engine::{ConnectionParams, Connector};

    async fn open_fixture(dir: &tempfile::TempDir) -> (ConnectionManager, ConnectionHandleId) {
        let path = dir.path().join("export_fixture.db");
        {
            let conn = rusqlite::Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE users (
                     id INTEGER PRIMARY KEY,
                     name TEXT NOT NULL,
                     note TEXT
                 );
                 INSERT INTO users (id, name, note) VALUES
                     (1, 'Ada', 'has, comma'),
                     (2, 'O''Brien', NULL),
                     (3, 'multi\nline', 'has \"quote\"');
                 CREATE TABLE empties (id INTEGER PRIMARY KEY);",
            )
            .expect("seed db");
        }
        let params = ConnectionParams::Sqlite {
            path: path.to_string_lossy().into_owned(),
        };
        let open = SqliteConnector.open(&params).await.expect("open fixture");
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;
        (manager, handle)
    }

    #[tokio::test]
    async fn csv_export_header_rows_and_escaping_against_real_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (manager, handle) = open_fixture(&dir).await;
        let csv = export_table(&manager, &handle, "main", "users", ExportFormat::Csv)
            .await
            .expect("export csv");
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "id,name,note");
        // header + 3 rows, but row 3's name contains a literal newline inside a
        // quoted field, so a naive line split sees 5 physical lines — that is
        // correct, RFC-4180 CSV (a quoted field may span lines).
        assert_eq!(lines.len(), 5);
        // Comma-bearing field is quoted.
        assert!(csv.contains("1,Ada,\"has, comma\""));
        // Apostrophe is NOT special in CSV; null note → empty trailing field.
        assert!(csv.contains("2,O'Brien,"));
        // Embedded quote doubled + whole field quoted.
        assert!(csv.contains("\"has \"\"quote\"\"\""));
    }

    #[tokio::test]
    async fn sql_export_has_ddl_and_one_insert_per_row_against_real_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (manager, handle) = open_fixture(&dir).await;
        let sql = export_table(&manager, &handle, "main", "users", ExportFormat::Sql)
            .await
            .expect("export sql");
        assert!(sql.contains("CREATE TABLE users"));
        assert_eq!(sql.matches("INSERT INTO").count(), 3);
        assert!(sql.contains("INSERT INTO \"main\".\"users\" (\"id\", \"name\", \"note\")"));
        // Apostrophe doubled in the SQL string literal.
        assert!(sql.contains("'O''Brien'"));
        // NULL note rendered as NULL.
        assert!(sql.contains(", NULL);"));
    }

    #[tokio::test]
    async fn empty_table_exports_against_real_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (manager, handle) = open_fixture(&dir).await;
        let csv = export_table(&manager, &handle, "main", "empties", ExportFormat::Csv)
            .await
            .expect("export csv");
        assert_eq!(csv, "id");
        let sql = export_table(&manager, &handle, "main", "empties", ExportFormat::Sql)
            .await
            .expect("export sql");
        assert!(sql.contains("-- (no rows)"));
    }

    #[tokio::test]
    async fn schema_dump_covers_all_tables_against_real_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (manager, handle) = open_fixture(&dir).await;
        let dump = export_schema_sql(&manager, &handle, "main")
            .await
            .expect("export schema");
        assert!(dump.contains("-- ByteTable schema dump"));
        assert!(dump.contains("-- ===== Table: empties ====="));
        assert!(dump.contains("-- ===== Table: users ====="));
        assert!(dump.contains("CREATE TABLE users"));
    }

    #[tokio::test]
    async fn export_then_save_round_trips_to_a_tempdir_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (manager, handle) = open_fixture(&dir).await;
        let csv = export_table(&manager, &handle, "main", "users", ExportFormat::Csv)
            .await
            .expect("export csv");
        let out = dir.path().join("users.csv");
        export_save(&out.to_string_lossy(), &csv).expect("save");
        assert_eq!(std::fs::read_to_string(&out).expect("read back"), csv);
    }

    /// Open a FRESH (empty) tempdir SQLite database for import targets.
    async fn open_empty(dir: &tempfile::TempDir) -> (ConnectionManager, ConnectionHandleId) {
        let path = dir.path().join("import_target.db");
        // Create an empty but valid database (the adapter opens READ_WRITE, no
        // CREATE, so the file must already exist and be a real db).
        {
            let conn = rusqlite::Connection::open(&path).expect("create db");
            conn.execute_batch("CREATE TABLE _seed (x INTEGER); DROP TABLE _seed;")
                .expect("init db");
        }
        let params = ConnectionParams::Sqlite {
            path: path.to_string_lossy().into_owned(),
        };
        let open = SqliteConnector.open(&params).await.expect("open target");
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;
        (manager, handle)
    }

    #[tokio::test]
    async fn import_round_trips_an_exported_table_against_real_sqlite() {
        // Export a table from the seeded fixture, then import its dump into a
        // fresh database and verify the table + every row landed.
        let src_dir = tempfile::tempdir().expect("tempdir");
        let (src_mgr, src_handle) = open_fixture(&src_dir).await;
        let dump = export_table(&src_mgr, &src_handle, "main", "users", ExportFormat::Sql)
            .await
            .expect("export sql");
        let path = src_dir.path().join("users.sql");
        export_save(&path.to_string_lossy(), &dump).expect("save dump");

        let dst_dir = tempfile::tempdir().expect("tempdir");
        let (dst_mgr, dst_handle) = open_empty(&dst_dir).await;
        let result = import_sql(&dst_mgr, &dst_handle, "main", &path.to_string_lossy())
            .await
            .expect("import");
        // DDL + 3 INSERTs.
        assert_eq!(result.statements, 4);

        // The table exists with all three rows.
        let conn = dst_mgr.get_sql(&dst_handle).await.unwrap();
        let meta = conn.table_meta("main", "users").await.expect("meta");
        assert!(meta.columns.iter().any(|c| c.name == "name"));
        let page = export_table(&dst_mgr, &dst_handle, "main", "users", ExportFormat::Csv)
            .await
            .expect("read back");
        assert!(page.contains("Ada"));
        assert!(page.contains("O'Brien"));
        assert_eq!(page.lines().count(), 5); // header + 3 rows (one spans lines)
    }

    #[tokio::test]
    async fn import_hand_written_multi_statement_against_real_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mgr, handle) = open_empty(&dir).await;
        let script = "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT);\n\
                      INSERT INTO widgets (id, label) VALUES (1, 'one');\n\
                      INSERT INTO widgets (id, label) VALUES (2, 'two');\n";
        let path = dir.path().join("widgets.sql");
        export_save(&path.to_string_lossy(), script).expect("write script");

        let result = import_sql(&mgr, &handle, "main", &path.to_string_lossy())
            .await
            .expect("import");
        assert_eq!(result.statements, 3);

        let conn = mgr.get_sql(&handle).await.unwrap();
        let tables = conn.list_tables("main").await.unwrap();
        assert!(tables.iter().any(|t| t.name == "widgets"));
        let widgets = tables.iter().find(|t| t.name == "widgets").unwrap();
        assert_eq!(widgets.approx_row_count, Some(2));
    }

    #[tokio::test]
    async fn import_with_error_in_second_statement_rolls_back_against_real_sqlite() {
        // SQLite import is atomic (BEGIN/COMMIT): a failure in statement 2 must
        // leave the table from statement 1 NOT created.
        let dir = tempfile::tempdir().expect("tempdir");
        let (mgr, handle) = open_empty(&dir).await;
        let script = "CREATE TABLE good (id INTEGER);\n\
                      INSERT INTO nonexistent_table (id) VALUES (1);\n";
        let path = dir.path().join("bad.sql");
        export_save(&path.to_string_lossy(), script).expect("write script");

        let err = import_sql(&mgr, &handle, "main", &path.to_string_lossy())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));

        // Rolled back: `good` was NOT created.
        let conn = mgr.get_sql(&handle).await.unwrap();
        let tables = conn.list_tables("main").await.unwrap();
        assert!(
            !tables.iter().any(|t| t.name == "good"),
            "statement 1's table must have rolled back; tables: {:?}",
            tables.iter().map(|t| &t.name).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn import_a_bad_file_path_is_an_io_error_naming_the_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mgr, handle) = open_empty(&dir).await;
        let missing = dir.path().join("does_not_exist.sql");
        let err = import_sql(&mgr, &handle, "main", &missing.to_string_lossy())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert!(err.to_string().contains("Could not read"));
    }

    #[tokio::test]
    async fn execute_script_text_runs_a_multi_statement_string_against_real_sqlite() {
        // The text counterpart of import_sql: hand the engine generated SQL
        // (no temp file) and verify the rows landed.
        let dir = tempfile::tempdir().expect("tempdir");
        let (mgr, handle) = open_empty(&dir).await;
        let sql = "CREATE TABLE gadgets (id INTEGER PRIMARY KEY, label TEXT);\n\
                   INSERT INTO gadgets (id, label) VALUES (1, 'one');\n\
                   INSERT INTO gadgets (id, label) VALUES (2, 'O''Brien');\n";
        let result = execute_script_text(&mgr, &handle, "main", sql)
            .await
            .expect("execute_script_text");
        assert_eq!(result.statements, 3);

        let conn = mgr.get_sql(&handle).await.unwrap();
        let tables = conn.list_tables("main").await.unwrap();
        let gadgets = tables
            .iter()
            .find(|t| t.name == "gadgets")
            .expect("gadgets table created");
        assert_eq!(gadgets.approx_row_count, Some(2));
        // The apostrophe-bearing row round-trips through the SQL string literal.
        let csv = export_table(&mgr, &handle, "main", "gadgets", ExportFormat::Csv)
            .await
            .expect("read back");
        assert!(csv.contains("O'Brien"));
    }

    #[tokio::test]
    async fn execute_script_text_insert_only_into_a_seeded_table() {
        // The CSV-import code path: INSERTs (no DDL) into a table that already
        // exists, the way ImportModal generates them.
        let dir = tempfile::tempdir().expect("tempdir");
        let (mgr, handle) = open_fixture(&dir).await;
        let sql = "INSERT INTO \"main\".\"users\" (\"id\", \"name\", \"note\") \
                   VALUES (10, 'Imported', 'via text');\n";
        let result = execute_script_text(&mgr, &handle, "main", sql)
            .await
            .expect("execute_script_text");
        assert_eq!(result.statements, 1);
        let csv = export_table(&mgr, &handle, "main", "users", ExportFormat::Csv)
            .await
            .expect("read back");
        assert!(csv.contains("Imported"));
    }

    #[tokio::test]
    async fn execute_script_text_with_a_bad_statement_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mgr, handle) = open_empty(&dir).await;
        let err = execute_script_text(&mgr, &handle, "main", "INSERT INTO ghost (id) VALUES (1);")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
    }
}
