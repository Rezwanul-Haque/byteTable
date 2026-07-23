//! MySQL engine adapter: implements the shared `Connector` /
//! `EngineConnection` ports with `sqlx` (async-native, runtime-tokio). Mirrors
//! the Postgres adapter (`engines::postgres`) method-for-method; only the
//! dialect differs — backtick identifiers, `?` placeholders, "schemas are
//! databases", and `SHOW CREATE TABLE` for the DDL.
//!
//! # Threading model
//!
//! Like the Postgres adapter and unlike SQLite (synchronous `rusqlite` wrapped
//! in `spawn_blocking`), `sqlx` is async-native, so every method awaits the
//! [`MySqlPool`] directly — no blocking pool, no mutex. One ByteTable connection
//! owns a small pool; `close` drains it for an orderly goodbye.
//!
//! # Multi-schema = multi-database
//!
//! MySQL has no schema layer between server and table the way Postgres does:
//! its "schema" *is* a database (`information_schema.schemata` ≡ databases).
//! So `list_schemas` enumerates user databases (the four system DBs — `mysql`,
//! `information_schema`, `performance_schema`, `sys` — excluded) and every table
//! reference is qualified as `` `database`.`table` ``. The connection's default
//! database (the one in the connect URL) is just the unqualified default; the
//! adapter always qualifies, so it can read any database the user can see.
//!
//! # Documented choices (M12, Task 2)
//!
//! - **Password / TLS / SSH**: identical seam to the Postgres adapter — the
//!   password arrives as a transient [`ConnectSecret`] (never persisted), and
//!   the granular `tls_mode` maps via [`sql::ssl_mode_from_token`] (M12 Task 3,
//!   replacing the Task-2 `tls: bool`). A tunnelled connection (params `ssh`)
//!   opens an SSH local-forward first (see [`crate::engines::ssh`]) and points
//!   the driver at the local endpoint. engine_info version comes from
//!   `SELECT VERSION()`.
//! - **Row counts** (`list_tables`): `information_schema.tables.table_rows`,
//!   which for InnoDB is an *estimate* (the storage engine's cached cardinality,
//!   not an exact `COUNT(*)`), exactly analogous to Postgres' `reltuples`. An
//!   exact count would scan every table. (`fetch_rows` still computes an EXACT
//!   filtered `COUNT(*)` for the grid's "n of N rows".)
//! - **Value → JSON** (see [`decode_value`]): tinyint/smallint/mediumint/int →
//!   number; bigint → number within ±2^53 else string (the `CellValue`
//!   precision contract); **unsigned bigint** likewise (large unsigned values →
//!   string); decimal → number when it round-trips through f64 losslessly, else
//!   the exact decimal *string* (preserve precision, via the `bigdecimal`
//!   feature); float/double → number; char/varchar/text → string;
//!   date/datetime/timestamp/time/year → string; **bool/tinyint(1)** → the
//!   integer 0/1, **NOT a JSON bool** — MySQL has no native BOOLEAN type
//!   (`BOOL`/`BOOLEAN` is an alias for `TINYINT(1)` and the driver returns it as
//!   an integer), so honestly surfacing it as a number is correct and matches
//!   the SQLite adapter's numeric bools. (Only Postgres emits native JSON bool.)
//!   json → the serialized JSON *string*; enum/set → string; bit → number when
//!   it fits, else string; blob/binary → `"[N bytes]"` placeholder; NULL → null.
//! - **DDL** (`table_meta.ddl`): MySQL exposes `SHOW CREATE TABLE` directly,
//!   which returns the exact, faithful `CREATE TABLE` the server stores — far
//!   cleaner than the Postgres adapter's catalog reconstruction. We use it
//!   verbatim.
//! - **alter_table**: MySQL supports native `ALTER TABLE` for every op we model
//!   (ADD COLUMN, RENAME COLUMN [8.0+], MODIFY COLUMN for type/nullable, ALTER
//!   COLUMN SET/DROP DEFAULT, DROP COLUMN). **Caveat — non-atomic batches:**
//!   unlike Postgres (transactional DDL) and SQLite (single-statement rebuild),
//!   MySQL **auto-commits each DDL statement implicitly**, so a multi-statement
//!   ALTER batch is NOT atomic — if statement N fails, statements 1..N-1 have
//!   already landed and cannot be rolled back. We mitigate: validate ALL ops
//!   first (so a structurally-bad batch never starts), run sequentially, and on
//!   a mid-batch failure return a §5 error naming exactly which statements were
//!   applied so the user can recover. This real MySQL limitation is surfaced
//!   honestly rather than hidden. `SetNullable` needs the column's current type
//!   (MySQL's `MODIFY COLUMN` couples type + nullability), read from `table_meta`.
//!   pk-protection (no drop/retype of a pk column) matches the other adapters.

mod bulk;
mod error;
mod introspect;
mod mutate;
mod objects;
mod query;
mod sql;
mod structure;

use async_trait::async_trait;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::Row;

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{
    AlterResult, ColumnStats, ColumnStatsRequest, ConnectSecret, ConnectionParams, Connector,
    DbObjectDefinition, DbObjectInfo, DbObjectKind, DeleteRowsRequest, DeleteRowsResult, Engine,
    EngineConnection, EngineInfo, FetchRowsRequest, ImportResult, OpenConnection, QueryOptions,
    QueryResult, RowLookup, RowLookupRequest, RowsPage, SchemaInfo, StatementOutcome, TableInfo,
    TableMeta, UpdateCellRequest, UpdateResult,
};
use crate::shared::error::AppError;

use crate::engines::ssh::{db_password, open_tunnel_if_needed, tunnel_override};

use sql::quote_ident;

use bulk::{bulk_insert, fetch_pk_pool};
use error::{map_connect_error, map_query_error};
use introspect::{list_schemas, list_tables, table_meta};
use mutate::{delete_rows, drop_schema, execute_script, truncate_table, update_cell};
use query::{column_stats, fetch_row_by_key, fetch_rows, run_batch, run_query};
use structure::alter_table;

/// Max connections in one ByteTable connection's pool. Small: a desktop client
/// drives a few short introspection/grid queries at a time.
const POOL_MAX_CONNECTIONS: u32 = 4;

/// Opens MySQL connections. Stateless; registered once in `lib.rs`.
pub struct MysqlConnector;

#[async_trait]
impl Connector for MysqlConnector {
    async fn test(&self, params: &ConnectionParams) -> Result<EngineInfo, AppError> {
        self.test_with_secret(params, None).await
    }

    async fn open(&self, params: &ConnectionParams) -> Result<OpenConnection, AppError> {
        self.open_with_secret(params, None).await
    }

    async fn test_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<EngineInfo, AppError> {
        // Open the SSH tunnel (if any) first; it lives only for this scope.
        let tunnel = open_tunnel_if_needed(params, secret).await?;
        let (host_over, port_over) = tunnel_override(&tunnel);
        let options = sql::connect_options(params, db_password(secret), host_over, port_over)?;
        let mut conn = <sqlx::MySqlConnection as sqlx::Connection>::connect_with(&options)
            .await
            .map_err(map_connect_error)?;
        let info = read_engine_info(&mut conn).await?;
        let _ = sqlx::Connection::close(conn).await;
        Ok(info)
    }

    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        // Open the SSH tunnel (if any) before the pool, and keep its handle on
        // the connection so the tunnel lives exactly as long as the pool does.
        let tunnel = open_tunnel_if_needed(params, secret).await?;
        let (host_over, port_over) = tunnel_override(&tunnel);
        let options = sql::connect_options(params, db_password(secret), host_over, port_over)?;
        let pool = MySqlPoolOptions::new()
            .max_connections(POOL_MAX_CONNECTIONS)
            .connect_with(options)
            .await
            .map_err(map_connect_error)?;
        // Read the server version once on a pool connection so `engine_info`
        // (sync) can return it without another round trip.
        let mut conn = pool.acquire().await.map_err(map_query_error)?;
        let info = read_engine_info(conn.as_mut()).await?;
        drop(conn);
        Ok(OpenConnection::sql(MysqlEngineConnection {
            pool,
            info,
            _tunnel: tunnel,
        }))
    }
}

/// One open MySQL connection (backed by a small pool). When the connection is
/// reached through an SSH bastion, the live tunnel is held here so it lives
/// exactly as long as the pool (dropped together on `close`).
pub struct MysqlEngineConnection {
    pool: MySqlPool,
    info: EngineInfo,
    _tunnel: Option<crate::engines::ssh::SshTunnel>,
}

#[async_trait]
impl EngineConnection for MysqlEngineConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
        list_schemas(&self.pool).await
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
        list_tables(&self.pool, schema).await
    }

    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
        table_meta(&self.pool, schema, table).await
    }

    fn object_kinds(&self) -> &'static [DbObjectKind] {
        objects::KINDS
    }

    async fn list_objects(
        &self,
        schema: &str,
        kind: DbObjectKind,
    ) -> Result<Vec<DbObjectInfo>, AppError> {
        objects::list(&self.pool, schema, kind).await
    }

    async fn object_definition(
        &self,
        schema: &str,
        kind: DbObjectKind,
        name: &str,
        detail: Option<&str>,
    ) -> Result<DbObjectDefinition, AppError> {
        objects::definition(&self.pool, schema, kind, name, detail).await
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
        run_query(&self.pool, sql, options).await
    }

    async fn run_batch(
        &self,
        statements: &[String],
        options: QueryOptions,
    ) -> Result<Vec<StatementOutcome>, AppError> {
        run_batch(&self.pool, statements, options).await
    }

    async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
        fetch_rows(&self.pool, req).await
    }

    async fn fetch_row_by_key(&self, req: RowLookupRequest) -> Result<RowLookup, AppError> {
        fetch_row_by_key(&self.pool, req).await
    }

    async fn column_stats(&self, req: ColumnStatsRequest) -> Result<ColumnStats, AppError> {
        column_stats(&self.pool, &req).await
    }

    async fn update_cell(&self, req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
        update_cell(&self.pool, &req).await
    }

    async fn delete_rows(&self, req: DeleteRowsRequest) -> Result<DeleteRowsResult, AppError> {
        delete_rows(&self.pool, &req).await
    }

    fn quote_identifier(&self, ident: &str) -> String {
        quote_ident(ident)
    }

    async fn truncate_table(&self, schema: &str, table: &str) -> Result<u64, AppError> {
        truncate_table(&self.pool, schema, table).await
    }

    async fn drop_schema(&self, schema: &str) -> Result<(), AppError> {
        drop_schema(&self.pool, schema).await
    }

    async fn create_schema(&self, schema: &str) -> Result<(), AppError> {
        use sqlx::Executor as _;
        // MySQL "schema" == database. A duplicate name surfaces the engine's §5
        // error via map_query_error.
        self.pool
            .execute(format!("CREATE DATABASE {}", quote_ident(schema)).as_str())
            .await
            .map_err(map_query_error)?;
        Ok(())
    }

    async fn execute_script(
        &self,
        schema: &str,
        sql: &str,
        on_progress: crate::shared::engine::ProgressCallback<'_>,
    ) -> Result<ImportResult, AppError> {
        execute_script(&self.pool, schema, sql, on_progress).await
    }

    async fn alter_table(
        &self,
        schema: &str,
        table: &str,
        ops: &[AlterOp],
        apply: bool,
    ) -> Result<AlterResult, AppError> {
        alter_table(&self.pool, schema, table, ops, apply).await
    }

    async fn bulk_insert(
        &self,
        schema: &str,
        table: &str,
        columns: &[String],
        binary: &[bool],
        rows: &[Vec<serde_json::Value>],
    ) -> Result<u64, AppError> {
        bulk_insert(&self.pool, schema, table, columns, binary, rows).await
    }

    async fn fetch_pk_pool(
        &self,
        schema: &str,
        table: &str,
        columns: &[String],
        cap: u64,
    ) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
        fetch_pk_pool(&self.pool, schema, table, columns, cap).await
    }

    async fn close(&self) -> Result<(), AppError> {
        // Drain the pool for an orderly goodbye. Tolerant of concurrent
        // operations (the manager hands out Arc clones): close() waits for the
        // pool to drain; in-flight queries on other clones finish first.
        self.pool.close().await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

/// Read engine + server version from a live connection (`SELECT VERSION()`).
async fn read_engine_info<'c, E>(conn: E) -> Result<EngineInfo, AppError>
where
    E: sqlx::Executor<'c, Database = sqlx::MySql>,
{
    let row = sqlx::query("SELECT VERSION() AS v")
        .fetch_one(conn)
        .await
        .map_err(map_query_error)?;
    let raw: String = row.try_get("v").unwrap_or_default();
    Ok(EngineInfo {
        engine: Engine::Mysql,
        server_version: sql::display_version(&raw),
    })
}

#[cfg(test)]
mod integration;
