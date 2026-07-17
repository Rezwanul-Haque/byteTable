//! PostgreSQL engine adapter: implements the shared `Connector` /
//! `EngineConnection` ports with `sqlx` (async-native, runtime-tokio).
//!
//! # Threading model
//!
//! Unlike the SQLite adapter (synchronous `rusqlite` wrapped in
//! `spawn_blocking`), `sqlx` is async-native, so every method awaits the
//! [`PgPool`] directly — no blocking pool, no mutex. One ByteTable connection
//! owns a small [`PgPool`] (a handful of connections): pooling lets the
//! introspection helpers that fire several short queries (e.g. `table_meta`)
//! run without head-of-line blocking, and the pool transparently reconnects a
//! dropped TCP connection. `close` drains the pool for an orderly goodbye.
//!
//! # Multi-schema
//!
//! Postgres is genuinely multi-schema (`public` + user schemas), unlike
//! SQLite's `main` + attached files. Every query is schema-qualified by the
//! schema the caller passes; `list_schemas` enumerates user schemas (system
//! schemas — `pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp*` —
//! excluded).
//!
//! # Documented choices (M12, Task 1)
//!
//! - **Password / TLS**: the connector needs the password only at connect time.
//!   It arrives as a transient [`crate::shared::engine::ConnectSecret`] (never
//!   persisted, not part of `ConnectionParams`) threaded from the command layer
//!   — see that type's docs for the Task 3 keychain seam. TLS mode is mapped
//!   from the params' granular `tls_mode`
//!   (`disable`/`prefer`/`require`/`verify-ca`/`verify-full`) via
//!   [`sql::ssl_mode_from_token`] (M12 Task 3, replacing the Task-1 `tls: bool`).
//!   A tunnelled connection (params `ssh`) opens an SSH local-forward first
//!   (see [`crate::engines::ssh`]) and points the driver at the local endpoint.
//! - **Row counts** (`list_tables`): `pg_class.reltuples`, the planner's
//!   *estimate* (refreshed by ANALYZE/autovacuum), not an exact `COUNT(*)`.
//!   This is the standard cheap Postgres answer — an exact count would scan
//!   every table. A never-analyzed table reports `-1` ("unknown"), mapped to
//!   `None`. (`fetch_rows` still computes an EXACT filtered `COUNT(*)` for the
//!   grid's "n of N rows" — that count must be precise.)
//! - **Value → JSON** (see [`decode_value`]): int2/4 → number; int8 → number
//!   within ±2^53 else string (the `CellValue` precision contract); float4/8 →
//!   number; numeric → number when it round-trips through f64 losslessly, else
//!   the exact decimal *string* (preserve precision); bool → JSON bool (the
//!   reason `CellValue` grew a boolean arm — Postgres has native booleans);
//!   text/varchar/char/name/uuid/timestamp/date/time/interval → string; json/
//!   jsonb → the serialized JSON *string* (kept a string so the grid renders it
//!   as text, consistent with other engines); bytea → `"[N bytes]"` placeholder
//!   (matches the SQLite blob style); arrays / other → their Postgres text
//!   representation (string); NULL → null.
//! - **DDL** (`table_meta.ddl`): Postgres has no single "show me the CREATE
//!   TABLE" function, and `pg_dump`-grade output is a large undertaking. We
//!   assemble a *reasonable, valid-ish* `CREATE TABLE` from the catalog
//!   (columns with type/nullability/default, the primary key, and table-level
//!   foreign keys). It is faithful to the column/constraint shape but does not
//!   reproduce CHECK constraints, exclusion constraints, partitioning, storage
//!   parameters, or comments — documented as a best-effort reconstruction for
//!   the §3.6 DDL modal, not a backup tool.
//! - **alter_table**: Postgres has native `ALTER TABLE` for every op we model
//!   (ADD/DROP/RENAME COLUMN, ALTER COLUMN TYPE … USING, SET/DROP NOT NULL,
//!   SET/DROP DEFAULT), so apply runs the real statements in a transaction — no
//!   table rebuild (much cleaner than SQLite). The preview SQL IS the verbatim
//!   ALTER it will run. pk-protection (no drop/retype of a pk column) matches
//!   the SQLite policy.

mod bulk;
mod error;
mod introspect;
mod mutate;
mod objects;
mod query;
mod sql;
mod structure;

use async_trait::async_trait;
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::Row;

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{
    AlterResult, ColumnStats, ColumnStatsRequest, ConnectSecret, ConnectionParams, Connector,
    DbObjectDefinition, DbObjectInfo, DbObjectKind, DeleteRowsRequest, DeleteRowsResult, Engine,
    EngineConnection, EngineInfo, FetchRowsRequest, ImportResult, OpenConnection, QueryOptions,
    QueryResult, RowLookup, RowLookupRequest, RowsPage, SchemaInfo, TableInfo, TableMeta,
    UpdateCellRequest, UpdateResult,
};
use crate::shared::error::AppError;

use crate::engines::ssh::{db_password, open_tunnel_if_needed, tunnel_override};

use sql::quote_ident;

use bulk::{bulk_insert, fetch_pk_pool};
use error::{map_connect_error, map_query_error};
use introspect::{list_schemas, list_tables, table_meta};
use mutate::{delete_rows, drop_schema, execute_script, truncate_table, update_cell};
use query::{column_stats, fetch_row_by_key, fetch_rows, run_query};
use structure::alter_table;

/// Max connections in one ByteTable connection's pool. Small: a desktop client
/// drives a few short introspection/grid queries at a time, never a server's
/// worth of concurrency.
const POOL_MAX_CONNECTIONS: u32 = 4;

/// Opens PostgreSQL connections. Stateless; registered once in `lib.rs`.
pub struct PostgresConnector;

#[async_trait]
impl Connector for PostgresConnector {
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
        // When the connection is tunnelled, open the bastion forward first and
        // point the driver at the local endpoint. The tunnel lives only for
        // this scope — test never keeps a connection open.
        let tunnel = open_tunnel_if_needed(params, secret).await?;
        let (host_over, port_over) = tunnel_override(&tunnel);
        let options = sql::connect_options(params, db_password(secret), host_over, port_over)?;
        let mut conn = <sqlx::PgConnection as sqlx::Connection>::connect_with(&options)
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
        let options = sql::connect_options(params, db_password(secret), host_over, port_over)?
            // Disable sqlx's prepared-statement cache. Otherwise, after DDL that
            // changes an object's result columns (CREATE/DROP/recreate a view,
            // matview, table…), a reused pooled connection re-executes a cached
            // plan whose result type no longer matches → Postgres errors
            // "cached plan must not change result type" until a retry re-prepares.
            // A data client runs ad-hoc DDL constantly, so we always re-prepare.
            .statement_cache_capacity(0);
        let pool = PgPoolOptions::new()
            .max_connections(POOL_MAX_CONNECTIONS)
            .connect_with(options)
            .await
            .map_err(map_connect_error)?;
        // Read the server version once on a pool connection so `engine_info`
        // (sync) can return it without another round trip.
        let mut conn = pool.acquire().await.map_err(map_query_error)?;
        let info = read_engine_info(conn.as_mut()).await?;
        drop(conn);
        Ok(OpenConnection::sql(PostgresEngineConnection {
            pool,
            info,
            _tunnel: tunnel,
        }))
    }
}

/// One open PostgreSQL connection (backed by a small pool). When the
/// connection is reached through an SSH bastion, the live tunnel is held here
/// so it lives exactly as long as the pool (dropped together on `close`).
pub struct PostgresEngineConnection {
    pool: PgPool,
    info: EngineInfo,
    _tunnel: Option<crate::engines::ssh::SshTunnel>,
}

#[async_trait]
impl EngineConnection for PostgresEngineConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
        list_schemas(&self.pool).await
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
        list_tables(&self.pool, schema).await
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

    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
        table_meta(&self.pool, schema, table).await
    }

    async fn run_query(&self, sql: &str, options: QueryOptions) -> Result<QueryResult, AppError> {
        run_query(&self.pool, sql, options).await
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

    /// Postgres bytea literal: `'\xDEADBEEF'::bytea` (hex format; valid with the
    /// default standard_conforming_strings=on). Overrides the default `X'..'`,
    /// which Postgres does not accept for bytea.
    fn binary_literal(&self, hex: &str) -> String {
        format!("'\\x{hex}'::bytea")
    }

    async fn truncate_table(&self, schema: &str, table: &str) -> Result<u64, AppError> {
        truncate_table(&self.pool, schema, table).await
    }

    async fn drop_schema(&self, schema: &str) -> Result<(), AppError> {
        drop_schema(&self.pool, schema).await
    }

    async fn create_schema(&self, schema: &str) -> Result<(), AppError> {
        // A duplicate name surfaces the engine's §5 error via map_query_error.
        sqlx::query(&format!("CREATE SCHEMA {}", quote_ident(schema)))
            .execute(&self.pool)
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

/// Read engine + server version from a live connection.
async fn read_engine_info<'c, E>(conn: E) -> Result<EngineInfo, AppError>
where
    E: sqlx::Executor<'c, Database = sqlx::Postgres>,
{
    let row = sqlx::query("SHOW server_version")
        .fetch_one(conn)
        .await
        .map_err(map_query_error)?;
    let raw: String = row.get(0);
    Ok(EngineInfo {
        engine: Engine::Postgres,
        server_version: sql::display_version(&raw),
    })
}

#[cfg(test)]
mod integration;
