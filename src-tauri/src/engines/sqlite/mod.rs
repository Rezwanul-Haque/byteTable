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
//! - BLOB values: small ones (≤ 32 bytes — UUIDs/keys) map to a `0x…` hex
//!   string so they're readable + usable; larger ones map to the `"[N bytes]"`
//!   placeholder (no blob viewer yet, and shipping megabytes across IPC for a
//!   grid cell helps no one). Shared via `shared::engine::binary_to_json`.
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
//!
//! # Documented choices (M7, structure view §3.6)
//!
//! `table_meta` also populates the structure-view fields of [`TableMeta`]:
//!
//! - `indexes` from `PRAGMA index_list` (name/unique/origin) + `PRAGMA
//!   index_info` (member columns, ordered by `seqno`). `primary` is
//!   `origin == "pk"`; `origin` is SQLite's `"c"`/`"u"`/`"pk"` passed through.
//!   Note an `INTEGER PRIMARY KEY` is an alias for the rowid and has NO entry
//!   in `index_list` (it is the rowid, not a separate index); only a
//!   *non-rowid* pk (composite, or a non-INTEGER pk) produces an implicit
//!   `origin == "pk"` index. Expression members report a NULL name from
//!   `index_info` and are skipped, so an expression index simply has fewer
//!   named columns.
//! - `foreign_keys` reuses `PRAGMA foreign_key_list`, now grouped by the `id`
//!   column into one [`ForeignKeyInfo`] per constraint with columns ordered by
//!   `seq` (so a composite fk is a single entry). `on_delete`/`on_update` come
//!   from the pragma's `on_delete`/`on_update` columns. SQLite has no fk
//!   constraint names, so `name` is always `None`. Implicit `REFERENCES t`
//!   (NULL `to`) resolves the referenced column to the parent's pk, same as
//!   `ColumnInfo.fk` (empty string when unresolvable — module docs above).
//! - `referenced_by` scans every *other* user table in the SAME schema and
//!   keeps the foreign keys whose target table is THIS table, grouped per
//!   constraint. Cost: one `foreign_key_list` pragma per other table — O(N)
//!   for N tables, each a cheap schema-only read (no table scan). This is fine
//!   for the local schemas ByteTable targets; the scan is deliberately
//!   unbounded (unlike the row-count cap) because a pragma over the schema is
//!   far cheaper than `count(*)` and §3.6 needs the complete inbound list to
//!   be truthful. SQLite fks never cross databases, so only the table's own
//!   schema is scanned.
//! - `ddl` is `SELECT sql FROM "schema".sqlite_schema WHERE type='table' AND
//!   name = ?`, returned verbatim (the modal syntax-highlights it; verbatim is
//!   truthful). `None` if the row has no stored SQL (existence is already
//!   proven before this point, so a missing table never reaches here).
//! - `comment` is always `None` — SQLite has no table comments (the field is
//!   modelled for §3.6 and server engines; see [`TableMeta::comment`]).

mod bulk;
mod error;
mod introspect;
mod mutate;
mod objects;
mod query;
mod sql;
mod structure;

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rusqlite::{Connection, OpenFlags};

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{
    count_statements, AlterResult, ColumnStats, ColumnStatsRequest, ConnectionParams, Connector,
    DbObjectDefinition, DbObjectInfo, DbObjectKind, DeleteRowsRequest, DeleteRowsResult, Engine,
    EngineConnection, EngineInfo, FetchRowsRequest, ImportResult, OpenConnection, QueryOptions,
    QueryResult, RowLookup, RowLookupRequest, RowsPage, SchemaInfo, TableInfo, TableMeta,
    UpdateCellRequest, UpdateResult,
};
use crate::shared::error::AppError;

use bulk::{bulk_insert_blocking, fetch_pk_pool_blocking};
use error::driver_message;
use introspect::{list_schemas_blocking, list_tables_blocking, table_meta_blocking};
use mutate::{
    delete_rows_blocking, drop_schema_blocking, execute_script_blocking, truncate_table_blocking,
    update_cell_blocking,
};
use query::{
    column_stats_blocking, fetch_row_by_key_blocking, fetch_rows_blocking, run_query_blocking,
};
use sql::quote_ident;

/// Opens SQLite database files. Stateless; registered once in `lib.rs`.
pub struct SqliteConnector;

#[async_trait]
impl Connector for SqliteConnector {
    async fn test(&self, params: &ConnectionParams) -> Result<EngineInfo, AppError> {
        let path = sqlite_path(params)?;
        run_blocking(move || open_validated(&path).map(|_| sqlite_engine_info())).await
    }

    async fn open(&self, params: &ConnectionParams) -> Result<OpenConnection, AppError> {
        let path = sqlite_path(params)?;
        let connection = run_blocking(move || open_validated(&path)).await?;
        Ok(OpenConnection::sql(SqliteEngineConnection {
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

    fn object_kinds(&self) -> &'static [DbObjectKind] {
        objects::KINDS
    }

    async fn list_objects(
        &self,
        schema: &str,
        kind: DbObjectKind,
    ) -> Result<Vec<DbObjectInfo>, AppError> {
        let schema = schema.to_string();
        self.with_conn(move |conn| objects::list_blocking(conn, &schema, kind))
            .await
    }

    async fn object_definition(
        &self,
        schema: &str,
        kind: DbObjectKind,
        name: &str,
        _detail: Option<&str>,
    ) -> Result<DbObjectDefinition, AppError> {
        let schema = schema.to_string();
        let name = name.to_string();
        self.with_conn(move |conn| objects::definition_blocking(conn, &schema, kind, &name))
            .await
    }

    fn drop_object_sql(
        &self,
        schema: &str,
        kind: DbObjectKind,
        name: &str,
        detail: Option<&str>,
    ) -> Result<String, AppError> {
        objects::drop_sql(schema, kind, name, detail)
    }

    async fn run_query(&self, sql: &str, options: QueryOptions) -> Result<QueryResult, AppError> {
        let sql = sql.to_string();
        self.with_conn(move |conn| run_query_blocking(conn, &sql, &options))
            .await
    }

    async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
        self.with_conn(move |conn| fetch_rows_blocking(conn, &req))
            .await
    }

    async fn fetch_row_by_key(&self, req: RowLookupRequest) -> Result<RowLookup, AppError> {
        self.with_conn(move |conn| fetch_row_by_key_blocking(conn, &req))
            .await
    }

    async fn column_stats(&self, req: ColumnStatsRequest) -> Result<ColumnStats, AppError> {
        self.with_conn(move |conn| column_stats_blocking(conn, &req))
            .await
    }

    async fn alter_table(
        &self,
        schema: &str,
        table: &str,
        ops: &[AlterOp],
        apply: bool,
    ) -> Result<AlterResult, AppError> {
        let schema = schema.to_string();
        let table = table.to_string();
        let ops = ops.to_vec();
        self.with_conn(move |conn| {
            structure::alter_table_blocking(conn, &schema, &table, &ops, apply)
        })
        .await
    }

    async fn update_cell(&self, req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
        self.with_conn(move |conn| update_cell_blocking(conn, &req))
            .await
    }

    async fn delete_rows(&self, req: DeleteRowsRequest) -> Result<DeleteRowsResult, AppError> {
        self.with_conn(move |conn| delete_rows_blocking(conn, &req))
            .await
    }

    fn quote_identifier(&self, ident: &str) -> String {
        quote_ident(ident)
    }

    async fn truncate_table(&self, schema: &str, table: &str) -> Result<u64, AppError> {
        let schema = schema.to_string();
        let table = table.to_string();
        self.with_conn(move |conn| truncate_table_blocking(conn, &schema, &table))
            .await
    }

    async fn drop_schema(&self, schema: &str) -> Result<(), AppError> {
        let schema = schema.to_string();
        self.with_conn(move |conn| drop_schema_blocking(conn, &schema))
            .await
    }

    async fn execute_script(
        &self,
        schema: &str,
        sql: &str,
        on_progress: crate::shared::engine::ProgressCallback<'_>,
    ) -> Result<ImportResult, AppError> {
        // SQLite runs the dump as one atomic `execute_batch` on a blocking
        // thread, which can't report mid-batch (and the borrowed callback can't
        // cross into spawn_blocking), so progress is coarse: 0% before, 100%
        // after. Local SQLite imports are fast, so a single jump is fine.
        let total = count_statements(sql);
        on_progress(0, total);
        let schema = schema.to_string();
        let sql = sql.to_string();
        let result = self
            .with_conn(move |conn| execute_script_blocking(conn, &schema, &sql))
            .await?;
        on_progress(result.statements, result.statements);
        Ok(result)
    }

    async fn bulk_insert(
        &self,
        schema: &str,
        table: &str,
        columns: &[String],
        binary: &[bool],
        rows: &[Vec<serde_json::Value>],
    ) -> Result<u64, AppError> {
        let (schema, table) = (schema.to_string(), table.to_string());
        let columns = columns.to_vec();
        let binary = binary.to_vec();
        let rows = rows.to_vec();
        self.with_conn(move |conn| {
            bulk_insert_blocking(conn, &schema, &table, &columns, &binary, &rows)
        })
        .await
    }

    async fn fetch_pk_pool(
        &self,
        schema: &str,
        table: &str,
        columns: &[String],
        cap: u64,
    ) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
        let (schema, table) = (schema.to_string(), table.to_string());
        let columns = columns.to_vec();
        self.with_conn(move |conn| fetch_pk_pool_blocking(conn, &schema, &table, &columns, cap))
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

#[cfg(test)]
pub(super) mod test_support {

    use std::path::Path;

    use super::*;
    use crate::shared::engine::*;

    /// Create a real SQLite file with a `users` table (3 rows, mixed types)
    /// and an empty `orders` table.
    pub(crate) fn create_fixture_db(path: &Path) {
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

    pub(crate) fn params_for(path: &Path) -> ConnectionParams {
        ConnectionParams::Sqlite {
            path: path.to_string_lossy().into_owned(),
        }
    }

    pub(crate) async fn open_fixture(
        dir: &tempfile::TempDir,
    ) -> std::sync::Arc<dyn EngineConnection> {
        let path = dir.path().join("fixture.db");
        create_fixture_db(&path);
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open fixture db")
            .into_sql()
            .expect("sql connection")
    }

    /// Open a fresh empty SQLite db (no fixture tables) for generate tests.
    pub(crate) async fn open_empty(
        dir: &tempfile::TempDir,
    ) -> std::sync::Arc<dyn EngineConnection> {
        let path = dir.path().join("empty.db");
        {
            // touch an empty db file so open_validated accepts it
            Connection::open(&path).expect("create db");
        }
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open empty db")
            .into_sql()
            .expect("sql connection")
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::test_support::*;
    use super::*;
    use crate::shared::engine::*;

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
                database: Some("d".into()),
                user: Some("u".into()),
                tls_mode: crate::shared::engine::TlsMode::Disable,
                ssh: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }
}
