//! SQLite engine adapter: implements the shared `Connector` /
//! `EngineConnection` ports with `rusqlite` (bundled SQLite).
//!
//! # Threading model
//!
//! `rusqlite::Connection` is synchronous and `!Sync`, so it lives behind
//! `Arc<std::sync::Mutex<…>>` and **every** operation hops through
//! `tokio::task::spawn_blocking` — async executor threads never block on
//! SQLite work (Tauri's async runtime is tokio). The mutex serializes
//! operations per connection, which matches SQLite's own single-writer
//! nature.
//!
//! # Documented choices (M2)
//!
//! - Opening uses `READ_WRITE` *without* `CREATE`: a typo'd path must fail,
//!   never silently create an empty database. A missing or non-database file
//!   produces a human message per DESIGN_SPEC §5.
//! - Row counts are exact `SELECT count(*)` per table — cheap enough for the
//!   local files M2 targets. Counting stops after
//!   [`MAX_COUNTED_TABLES`] tables (remaining tables get `None`) so a
//!   pathological schema cannot stall introspection; M3 revisits caching.
//! - Integers whose magnitude exceeds 2^53 − 1 (JavaScript's
//!   `Number.MAX_SAFE_INTEGER`) map to JSON strings, not numbers — the
//!   renderer would otherwise round them on parse. See
//!   [`JS_MAX_SAFE_INTEGER`].
//! - BLOB values map to the placeholder string `"[blob N bytes]"` rather
//!   than base64: the renderer has no blob viewer yet, and shipping
//!   megabytes of base64 across IPC for a grid cell helps no one. A real
//!   blob inspector (then base64 or a side channel) is a later milestone.
//! - `QueryOptions::schema` is advisory for SQLite (see the port docs):
//!   unqualified names resolve per SQLite's rules across `main` + attached.
//! - `run_query` executes whatever SQL it is given (read/write contexts are
//!   M6's job) but always enforces `row_limit`, reading one extra row to set
//!   `truncated`.
//!
//! # Documented choices (M3, `table_meta`)
//!
//! - Column metadata comes from `PRAGMA "schema".table_info("table")` and
//!   `PRAGMA "schema".foreign_key_list("table")` — no parsing of DDL text.
//! - `nullable` is the raw declared constraint (`notnull == 0`): SQLite does
//!   not set the flag for bare `PRIMARY KEY` columns (and, by a documented
//!   legacy quirk, non-INTEGER primary keys really can hold NULLs), so
//!   "nullable" here means "no NOT NULL constraint declared".
//! - `foreign_key_list` reports `to` as NULL for the implicit form
//!   `REFERENCES t` (no column list). We resolve it to the referenced
//!   table's primary-key column at the fk's `seq` position (same schema —
//!   SQLite fks never cross databases); when that fails (referenced table
//!   missing or without a declared pk) the column falls back to an **empty
//!   string** — an honest "unknown" beats guessing "id".
//! - A column appearing in several foreign keys keeps the first one
//!   `foreign_key_list` reports; `ColumnInfo.fk` is a single ref by design
//!   (sidebar icon + tooltip), M7's structure view gets the full list.
//! - `PRAGMA table_info` returns zero rows (not an error) for an unknown
//!   table, so existence is checked against `sqlite_schema` first to produce
//!   the §5 "Table 'x' does not exist. Available tables: …" message.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use crate::shared::engine::{
    ColumnInfo, ColumnMeta, ConnectionParams, Connector, Engine, EngineConnection, EngineInfo,
    FkRef, QueryOptions, QueryResult, SchemaInfo, TableInfo, TableMeta,
};
use crate::shared::error::AppError;

/// Stop running per-table `count(*)` after this many tables; the rest get
/// `approx_row_count: None`. Keeps introspection bounded on huge schemas.
const MAX_COUNTED_TABLES: usize = 200;

/// JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 − 1). SQLite integers whose
/// magnitude exceeds this serialize as JSON *strings* — a JSON number would
/// silently lose precision the moment the renderer parses it into a `number`.
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Opens SQLite database files. Stateless; registered once in `lib.rs`.
pub struct SqliteConnector;

#[async_trait]
impl Connector for SqliteConnector {
    async fn test(&self, params: &ConnectionParams) -> Result<EngineInfo, AppError> {
        let path = sqlite_path(params)?;
        run_blocking(move || open_validated(&path).map(|_| sqlite_engine_info())).await
    }

    async fn open(&self, params: &ConnectionParams) -> Result<Box<dyn EngineConnection>, AppError> {
        let path = sqlite_path(params)?;
        let connection = run_blocking(move || open_validated(&path)).await?;
        Ok(Box::new(SqliteEngineConnection {
            conn: Arc::new(Mutex::new(connection)),
            info: sqlite_engine_info(),
        }))
    }
}

/// One open SQLite database file.
pub struct SqliteEngineConnection {
    conn: Arc<Mutex<Connection>>,
    info: EngineInfo,
}

#[async_trait]
impl EngineConnection for SqliteEngineConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
        self.with_conn(list_schemas_blocking).await
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
        let schema = schema.to_string();
        self.with_conn(move |conn| list_tables_blocking(conn, &schema))
            .await
    }

    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
        let schema = schema.to_string();
        let table = table.to_string();
        self.with_conn(move |conn| table_meta_blocking(conn, &schema, &table))
            .await
    }

    async fn run_query(&self, sql: &str, options: QueryOptions) -> Result<QueryResult, AppError> {
        let sql = sql.to_string();
        self.with_conn(move |conn| run_query_blocking(conn, &sql, &options))
            .await
    }

    async fn close(&self) -> Result<(), AppError> {
        // rusqlite closes on drop; the manager dropping its Arc is the real
        // teardown. This hook exists for engines that need an explicit
        // goodbye (server engines, M12).
        Ok(())
    }
}

impl SqliteEngineConnection {
    /// Run `f` against the connection on the blocking pool.
    async fn with_conn<T, F>(&self, f: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, AppError> + Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        run_blocking(move || {
            let guard = conn.lock().map_err(|_| {
                AppError::Database(
                    "The connection is in a broken state after an earlier crash; \
                     close and reopen it."
                        .into(),
                )
            })?;
            f(&guard)
        })
        .await
    }
}

/// Hop to tokio's blocking pool and flatten the join error.
async fn run_blocking<T, F>(f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|err| AppError::Database(format!("A background database task failed: {err}.")))?
}

// ---------------------------------------------------------------------------
// Blocking implementations (the only place SQLite-specific SQL exists)
// ---------------------------------------------------------------------------

fn sqlite_path(params: &ConnectionParams) -> Result<String, AppError> {
    match params {
        ConnectionParams::Sqlite { path } => Ok(path.clone()),
        other => Err(AppError::Invalid(format!(
            "the SQLite connector received {} parameters",
            other.engine().display_name()
        ))),
    }
}

fn sqlite_engine_info() -> EngineInfo {
    EngineInfo {
        engine: Engine::Sqlite,
        server_version: format!("SQLite {}", rusqlite::version()),
    }
}

/// Open the file and prove it is a real SQLite database, with §5-style
/// errors for the two common failure modes (missing file, not a database).
fn open_validated(path: &str) -> Result<Connection, AppError> {
    if !Path::new(path).is_file() {
        return Err(AppError::Database(format!(
            "SQLite database file '{path}' does not exist."
        )));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|err| map_open_error(path, err))?;
    // SQLite opens lazily; force a header read so a non-database file fails
    // here, with a clear message, instead of on the first introspection call.
    conn.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
        .map_err(|err| map_open_error(path, err))?;
    Ok(conn)
}

fn map_open_error(path: &str, err: rusqlite::Error) -> AppError {
    if let rusqlite::Error::SqliteFailure(failure, _) = &err {
        match failure.code {
            rusqlite::ErrorCode::NotADatabase => {
                return AppError::Database(format!("'{path}' is not a SQLite database file."));
            }
            rusqlite::ErrorCode::CannotOpen => {
                return AppError::Database(format!(
                    "SQLite database file '{path}' could not be opened."
                ));
            }
            rusqlite::ErrorCode::PermissionDenied => {
                return AppError::Database(format!(
                    "Permission denied opening SQLite database file '{path}'."
                ));
            }
            _ => {}
        }
    }
    AppError::Database(format!(
        "Could not open '{path}': {}.",
        driver_message(&err)
    ))
}

fn list_schemas_blocking(conn: &Connection) -> Result<Vec<SchemaInfo>, AppError> {
    let names = schema_names(conn)?;
    let mut schemas = Vec::with_capacity(names.len());
    for name in names {
        // Best effort: a count failure (e.g. detached race) downgrades to
        // None rather than failing the whole listing.
        let table_count = count_tables(conn, &name).ok();
        schemas.push(SchemaInfo { name, table_count });
    }
    Ok(schemas)
}

fn schema_names(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare("PRAGMA database_list")
        .map_err(|err| map_query_error(conn, err))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    Ok(names)
}

fn count_tables(conn: &Connection, schema: &str) -> Result<u64, rusqlite::Error> {
    conn.query_row(
        &format!(
            "SELECT count(*) FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            quote_ident(schema)
        ),
        [],
        |row| row.get(0),
    )
}

/// Fail with the §5 "Schema 'x' does not exist…" message unless `schema` is
/// one of the connection's databases.
fn ensure_schema_exists(conn: &Connection, schema: &str) -> Result<(), AppError> {
    let schemas = schema_names(conn)?;
    if schemas.iter().any(|s| s == schema) {
        Ok(())
    } else {
        Err(AppError::Database(format!(
            "Schema '{schema}' does not exist. Available schemas: {}.",
            schemas.join(", ")
        )))
    }
}

fn list_tables_blocking(conn: &Connection, schema: &str) -> Result<Vec<TableInfo>, AppError> {
    ensure_schema_exists(conn, schema)?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT name FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            quote_ident(schema)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

    let mut tables = Vec::with_capacity(names.len());
    for (index, name) in names.into_iter().enumerate() {
        let approx_row_count = if index < MAX_COUNTED_TABLES {
            // Best effort: a failed count is None, not a failed listing.
            conn.query_row(
                &format!(
                    "SELECT count(*) FROM {}.{}",
                    quote_ident(schema),
                    quote_ident(&name)
                ),
                [],
                |row| row.get::<_, u64>(0),
            )
            .ok()
        } else {
            None
        };
        tables.push(TableInfo {
            name,
            approx_row_count,
        });
    }
    Ok(tables)
}

fn table_meta_blocking(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<TableMeta, AppError> {
    ensure_schema_exists(conn, schema)?;

    // `PRAGMA table_info` returns zero rows for an unknown table instead of
    // erroring, so prove existence first to get the §5 message (see module
    // docs).
    let exists: i64 = conn
        .query_row(
            &format!(
                "SELECT count(*) FROM {}.sqlite_schema WHERE type = 'table' AND name = ?1",
                quote_ident(schema)
            ),
            [table],
            |row| row.get(0),
        )
        .map_err(|err| map_query_error(conn, err))?;
    if exists == 0 {
        return Err(missing_table_error(conn, table));
    }

    let mut fk_by_column = foreign_keys_by_column(conn, schema, table)?;

    // table_info columns: cid(0), name(1), type(2), notnull(3), dflt(4), pk(5).
    // `pk` is the 1-based position within the primary key (0 = not part).
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.table_info({})",
            quote_ident(schema),
            quote_ident(table)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

    let columns = rows
        .into_iter()
        .map(|(name, data_type, notnull, pk)| ColumnInfo {
            fk: fk_by_column.remove(&name),
            name,
            data_type,
            nullable: notnull == 0,
            pk: pk > 0,
        })
        .collect();
    Ok(TableMeta { columns })
}

/// Foreign keys of `table`, keyed by the local (from) column. A column in
/// several fks keeps the first one reported (see module docs).
fn foreign_keys_by_column(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<HashMap<String, FkRef>, AppError> {
    // foreign_key_list columns: id(0), seq(1), table(2), from(3), to(4), ….
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.foreign_key_list({})",
            quote_ident(schema),
            quote_ident(table)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

    let mut by_column = HashMap::new();
    for (seq, ref_table, from, to) in rows {
        let column = match to {
            Some(column) => column,
            // Implicit `REFERENCES t`: resolve to the referenced table's pk
            // (same schema — SQLite fks never cross databases).
            None => referenced_pk_column(conn, schema, &ref_table, seq.max(0) as usize),
        };
        by_column.entry(from).or_insert(FkRef {
            table: ref_table,
            column,
        });
    }
    Ok(by_column)
}

/// The referenced table's primary-key column at position `seq`, for
/// resolving implicit fk targets. Best effort: an unresolvable pk (missing
/// table, no declared pk) yields an empty string — an honest "unknown"
/// rather than a guessed "id" (see module docs).
fn referenced_pk_column(conn: &Connection, schema: &str, ref_table: &str, seq: usize) -> String {
    let sql = format!(
        "PRAGMA {}.table_info({})",
        quote_ident(schema),
        quote_ident(ref_table)
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return String::new();
    };
    let Ok(columns) = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
        })
        .and_then(Iterator::collect::<Result<Vec<(i64, String)>, _>>)
    else {
        return String::new();
    };
    let mut pk_columns: Vec<(i64, String)> =
        columns.into_iter().filter(|(pk, _)| *pk > 0).collect();
    pk_columns.sort_by_key(|(position, _)| *position);
    pk_columns
        .into_iter()
        .nth(seq)
        .map(|(_, name)| name)
        .unwrap_or_default()
}

fn run_query_blocking(
    conn: &Connection,
    sql: &str,
    options: &QueryOptions,
) -> Result<QueryResult, AppError> {
    let started = Instant::now();
    let mut stmt = conn
        .prepare(sql)
        .map_err(|err| map_query_error(conn, err))?;

    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .iter()
        .map(|col| ColumnMeta {
            name: col.name().to_string(),
            type_hint: col.decl_type().unwrap_or("").to_string(),
        })
        .collect();
    let column_count = columns.len();

    let mut out_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;
    let mut rows = stmt.query([]).map_err(|err| map_query_error(conn, err))?;
    while let Some(row) = rows.next().map_err(|err| map_query_error(conn, err))? {
        if out_rows.len() >= options.row_limit {
            truncated = true;
            break;
        }
        let mut values = Vec::with_capacity(column_count);
        for index in 0..column_count {
            let value = row
                .get_ref(index)
                .map_err(|err| map_query_error(conn, err))?;
            values.push(value_to_json(value));
        }
        out_rows.push(values);
    }

    Ok(QueryResult {
        columns,
        row_count: out_rows.len(),
        rows: out_rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// SQLite value → JSON. Blobs become a `"[blob N bytes]"` placeholder (see
/// module docs); non-finite reals become null (JSON has no NaN/Infinity);
/// integers beyond ±[`JS_MAX_SAFE_INTEGER`] become decimal strings so the
/// renderer never rounds them (see `QueryResult::rows` in `shared::engine`).
fn value_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 => {
            serde_json::Value::from(i)
        }
        ValueRef::Integer(i) => serde_json::Value::String(i.to_string()),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(bytes) => {
            serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned())
        }
        ValueRef::Blob(bytes) => serde_json::Value::String(format!("[blob {} bytes]", bytes.len())),
    }
}

/// Quote an identifier for interpolation into SQLite SQL: wrap in double
/// quotes, doubling embedded quotes.
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// The bare driver message, without rusqlite's error-chain wrapping.
fn driver_message(err: &rusqlite::Error) -> String {
    match err {
        rusqlite::Error::SqliteFailure(_, Some(message)) => message.clone(),
        other => other.to_string(),
    }
}

/// Map a query-time driver error to a §5-style human message.
///
/// Best effort: "no such table" gets the available-tables suffix, "no such
/// column" passes through cleaned, everything else is the driver message
/// capitalized — never a Rust error chain.
fn map_query_error(conn: &Connection, err: rusqlite::Error) -> AppError {
    let raw = driver_message(&err);
    if let Some(table) = raw.strip_prefix("no such table: ") {
        return missing_table_error(conn, strip_location_suffix(table));
    }
    if let Some(column) = raw.strip_prefix("no such column: ") {
        return AppError::Database(format!(
            "Column '{}' does not exist.",
            strip_location_suffix(column)
        ));
    }
    AppError::Database(humanize(&raw))
}

/// The §5 unknown-table message, with the "available tables" listing.
fn missing_table_error(conn: &Connection, table: &str) -> AppError {
    let tables = all_table_names(conn);
    let listing = if tables.is_empty() {
        "(none)".to_string()
    } else {
        tables.join(", ")
    };
    AppError::Database(format!(
        "Table '{table}' does not exist. Available tables: {listing}."
    ))
}

/// Newer SQLite appends ` in <sql> at offset N` to "no such …" messages;
/// drop it so only the offending name remains.
fn strip_location_suffix(name: &str) -> &str {
    match name.find(" in ") {
        Some(index) => &name[..index],
        None => name,
    }
}

/// Every user table across all schemas, for "available tables" listings.
/// Attached-schema tables are qualified (`aux.users`); failures are skipped
/// — this only feeds an error message.
fn all_table_names(conn: &Connection) -> Vec<String> {
    let Ok(schemas) = schema_names(conn) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for schema in schemas {
        let sql = format!(
            "SELECT name FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            quote_ident(&schema)
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            continue;
        };
        let Ok(rows) = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        else {
            continue;
        };
        for name in rows {
            if schema == "main" {
                names.push(name);
            } else {
                names.push(format!("{schema}.{name}"));
            }
        }
    }
    names
}

/// Capitalize the first letter and ensure a trailing period.
fn humanize(message: &str) -> String {
    let trimmed = message.trim();
    let mut chars = trimmed.chars();
    let capitalized = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "The database reported an unknown error".to_string(),
    };
    if capitalized.ends_with(['.', '!', '?']) {
        capitalized
    } else {
        format!("{capitalized}.")
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// Create a real SQLite file with a `users` table (3 rows, mixed types)
    /// and an empty `orders` table.
    fn create_fixture_db(path: &Path) {
        let conn = Connection::open(path).expect("create db");
        conn.execute_batch(
            "CREATE TABLE users (
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL,
                 score REAL,
                 avatar BLOB
             );
             INSERT INTO users (id, name, score, avatar)
                 VALUES (1, 'ada', 9.5, x'C0FFEE'),
                        (2, 'grace', NULL, NULL),
                        (3, 'linus', 7.25, NULL);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL);",
        )
        .expect("seed db");
    }

    fn params_for(path: &Path) -> ConnectionParams {
        ConnectionParams::Sqlite {
            path: path.to_string_lossy().into_owned(),
        }
    }

    async fn open_fixture(dir: &tempfile::TempDir) -> Box<dyn EngineConnection> {
        let path = dir.path().join("fixture.db");
        create_fixture_db(&path);
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open fixture db")
    }

    #[tokio::test]
    async fn test_reports_sqlite_engine_and_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.db");
        create_fixture_db(&path);
        let info = SqliteConnector
            .test(&params_for(&path))
            .await
            .expect("test connection");
        assert_eq!(info.engine, Engine::Sqlite);
        assert!(
            info.server_version.starts_with("SQLite 3."),
            "got version {:?}",
            info.server_version
        );
    }

    #[tokio::test]
    async fn missing_file_is_a_human_error_and_creates_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nope.db");
        let err = match SqliteConnector.open(&params_for(&path)).await {
            Ok(_) => panic!("opening a missing file must fail"),
            Err(err) => err,
        };
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            format!("SQLite database file '{}' does not exist.", path.display())
        );
        assert!(!path.exists(), "open must not create the file");
    }

    #[tokio::test]
    async fn non_database_file_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("notes.db");
        fs::write(&path, "definitely not a sqlite database, just some text")
            .expect("write text file");
        let err = SqliteConnector.test(&params_for(&path)).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("'{}' is not a SQLite database file.", path.display())
        );
    }

    #[tokio::test]
    async fn wrong_engine_params_are_rejected() {
        let err = SqliteConnector
            .test(&ConnectionParams::Postgres {
                host: "h".into(),
                port: 5432,
                database: "d".into(),
                user: "u".into(),
                tls: false,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }

    #[tokio::test]
    async fn lists_main_schema_with_table_count() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let schemas = conn.list_schemas().await.expect("list schemas");
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0].name, "main");
        assert_eq!(schemas[0].table_count, Some(2));
    }

    #[tokio::test]
    async fn attached_databases_show_up_as_schemas() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;

        let aux_path = dir.path().join("aux.db");
        {
            let aux = Connection::open(&aux_path).expect("create aux db");
            aux.execute_batch("CREATE TABLE logs (id INTEGER PRIMARY KEY, line TEXT);")
                .expect("seed aux");
        }
        conn.run_query(
            &format!("ATTACH DATABASE '{}' AS aux", aux_path.display()),
            QueryOptions::default(),
        )
        .await
        .expect("attach");

        let schemas = conn.list_schemas().await.expect("list schemas");
        let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["main", "aux"]);

        let tables = conn.list_tables("aux").await.expect("list aux tables");
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "logs");
        assert_eq!(tables[0].approx_row_count, Some(0));
    }

    #[tokio::test]
    async fn lists_tables_with_row_counts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let tables = conn.list_tables("main").await.expect("list tables");
        let summary: Vec<(&str, Option<u64>)> = tables
            .iter()
            .map(|t| (t.name.as_str(), t.approx_row_count))
            .collect();
        assert_eq!(summary, vec![("orders", Some(0)), ("users", Some(3))]);
    }

    #[tokio::test]
    async fn unknown_schema_is_a_human_error_listing_available_schemas() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.list_tables("warehouse").await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Schema 'warehouse' does not exist. Available schemas: main."
        );
    }

    /// Open a db exercising every `table_meta` facet: explicit + implicit
    /// fk targets, composite pk, NOT NULL, untyped columns, a non-"id" pk
    /// on the implicitly referenced table.
    async fn open_meta_fixture(dir: &tempfile::TempDir) -> Box<dyn EngineConnection> {
        let path = dir.path().join("meta.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                 CREATE TABLE series (series_code TEXT PRIMARY KEY, title TEXT);
                 CREATE TABLE books (
                     id INTEGER PRIMARY KEY,
                     title TEXT NOT NULL,
                     author_id INTEGER NOT NULL REFERENCES authors(id),
                     series_code TEXT REFERENCES series,
                     ghost_id INTEGER REFERENCES phantoms,
                     notes
                 );
                 CREATE TABLE order_items (
                     order_id INTEGER,
                     item_no INTEGER,
                     qty INTEGER NOT NULL,
                     PRIMARY KEY (order_id, item_no)
                 );",
            )
            .expect("seed db");
        }
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open meta fixture")
    }

    #[tokio::test]
    async fn table_meta_reports_types_nullability_pk_and_fks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_meta_fixture(&dir).await;
        let meta = conn.table_meta("main", "books").await.expect("table meta");

        let expected = vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "INTEGER".into(),
                // SQLite does not set `notnull` for bare PRIMARY KEY columns;
                // `nullable` reports the declared constraint (module docs).
                nullable: true,
                pk: true,
                fk: None,
            },
            ColumnInfo {
                name: "title".into(),
                data_type: "TEXT".into(),
                nullable: false,
                pk: false,
                fk: None,
            },
            ColumnInfo {
                name: "author_id".into(),
                data_type: "INTEGER".into(),
                nullable: false,
                pk: false,
                // Explicit target: REFERENCES authors(id).
                fk: Some(FkRef {
                    table: "authors".into(),
                    column: "id".into(),
                }),
            },
            ColumnInfo {
                name: "series_code".into(),
                data_type: "TEXT".into(),
                nullable: true,
                pk: false,
                // Implicit target (`REFERENCES series`): resolved to the
                // referenced table's pk, which is deliberately not "id".
                fk: Some(FkRef {
                    table: "series".into(),
                    column: "series_code".into(),
                }),
            },
            ColumnInfo {
                name: "ghost_id".into(),
                data_type: "INTEGER".into(),
                nullable: true,
                pk: false,
                // Implicit target on a table that does not exist: the table
                // name survives, the column falls back to "" (module docs).
                fk: Some(FkRef {
                    table: "phantoms".into(),
                    column: String::new(),
                }),
            },
            ColumnInfo {
                name: "notes".into(),
                // Untyped column: empty declared type, not a made-up one.
                data_type: String::new(),
                nullable: true,
                pk: false,
                fk: None,
            },
        ];
        assert_eq!(meta.columns, expected);
    }

    #[tokio::test]
    async fn table_meta_marks_every_member_of_a_composite_pk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_meta_fixture(&dir).await;
        let meta = conn
            .table_meta("main", "order_items")
            .await
            .expect("table meta");
        let flags: Vec<(&str, bool, bool)> = meta
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.pk, c.nullable))
            .collect();
        assert_eq!(
            flags,
            vec![
                ("order_id", true, true),
                ("item_no", true, true),
                ("qty", false, false),
            ]
        );
    }

    #[tokio::test]
    async fn table_meta_for_unknown_table_lists_available_tables() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.table_meta("main", "customers").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Table 'customers' does not exist. Available tables: orders, users."
        );
    }

    #[tokio::test]
    async fn table_meta_for_unknown_schema_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.table_meta("warehouse", "users").await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Schema 'warehouse' does not exist. Available schemas: main."
        );
    }

    #[tokio::test]
    async fn run_query_maps_values_and_reports_timing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let result = conn
            .run_query(
                "SELECT id, name, score, avatar FROM users ORDER BY id",
                QueryOptions::default(),
            )
            .await
            .expect("run query");

        let column_names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(column_names, vec!["id", "name", "score", "avatar"]);
        assert_eq!(result.columns[0].type_hint, "INTEGER");
        assert_eq!(result.columns[1].type_hint, "TEXT");

        assert_eq!(result.row_count, 3);
        assert!(!result.truncated);
        assert_eq!(
            result.rows[0],
            vec![
                serde_json::json!(1),
                serde_json::json!("ada"),
                serde_json::json!(9.5),
                serde_json::json!("[blob 3 bytes]"),
            ]
        );
        // NULLs map to JSON null.
        assert_eq!(result.rows[1][2], serde_json::Value::Null);
        // Timing is present and sane (a local select is far under a minute).
        assert!(result.elapsed_ms < 60_000);
    }

    #[tokio::test]
    async fn row_limit_truncates_and_flags_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let limited = conn
            .run_query(
                "SELECT id FROM users ORDER BY id",
                QueryOptions {
                    row_limit: 2,
                    schema: None,
                },
            )
            .await
            .expect("limited query");
        assert_eq!(limited.row_count, 2);
        assert_eq!(limited.rows.len(), 2);
        assert!(limited.truncated);

        let exact = conn
            .run_query(
                "SELECT id FROM users ORDER BY id",
                QueryOptions {
                    row_limit: 3,
                    schema: None,
                },
            )
            .await
            .expect("exact-limit query");
        assert_eq!(exact.row_count, 3);
        assert!(!exact.truncated, "limit == row count is not truncation");
    }

    #[tokio::test]
    async fn missing_table_error_lists_available_tables() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn
            .run_query("SELECT * FROM customers", QueryOptions::default())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Table 'customers' does not exist. Available tables: orders, users."
        );
    }

    #[tokio::test]
    async fn missing_column_and_syntax_errors_are_cleaned_driver_messages() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;

        let err = conn
            .run_query("SELECT nickname FROM users", QueryOptions::default())
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Column 'nickname' does not exist.");

        let err = conn
            .run_query("SELEKT * FROM users", QueryOptions::default())
            .await
            .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("syntax error"),
            "expected a syntax message, got {message:?}"
        );
        assert!(
            !message.contains("rusqlite") && !message.contains("Error {"),
            "driver chains must not leak: {message:?}"
        );
    }

    #[tokio::test]
    async fn integers_beyond_js_safe_range_round_trip_as_strings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("big.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(&format!(
                "CREATE TABLE nums (val INTEGER);
                 INSERT INTO nums (val) VALUES ({max}), ({min}), (42);",
                max = i64::MAX,
                min = i64::MIN,
            ))
            .expect("seed db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db");
        let result = conn
            .run_query(
                "SELECT val FROM nums ORDER BY rowid",
                QueryOptions::default(),
            )
            .await
            .expect("run query");
        // Beyond ±2^53 − 1: strings, preserving every digit.
        assert_eq!(result.rows[0][0], serde_json::json!("9223372036854775807"));
        assert_eq!(result.rows[1][0], serde_json::json!("-9223372036854775808"));
        // Within the safe range: a plain JSON number.
        assert_eq!(result.rows[2][0], serde_json::json!(42));
    }

    #[test]
    fn value_to_json_switches_to_strings_exactly_past_the_safe_boundary() {
        let safe = JS_MAX_SAFE_INTEGER;
        assert_eq!(
            value_to_json(ValueRef::Integer(safe)),
            serde_json::json!(9_007_199_254_740_991_i64)
        );
        assert_eq!(
            value_to_json(ValueRef::Integer(-safe)),
            serde_json::json!(-9_007_199_254_740_991_i64)
        );
        assert_eq!(
            value_to_json(ValueRef::Integer(safe + 1)),
            serde_json::json!("9007199254740992")
        );
        assert_eq!(
            value_to_json(ValueRef::Integer(-safe - 1)),
            serde_json::json!("-9007199254740992")
        );
    }

    #[test]
    fn quote_ident_doubles_embedded_quotes() {
        assert_eq!(quote_ident("plain"), "\"plain\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn humanize_capitalizes_and_punctuates() {
        assert_eq!(
            humanize("near \"x\": syntax error"),
            "Near \"x\": syntax error."
        );
        assert_eq!(humanize("Already done."), "Already done.");
    }
}
