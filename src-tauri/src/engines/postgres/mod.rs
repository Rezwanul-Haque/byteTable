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

mod sql;

use std::time::Instant;

use async_trait::async_trait;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Column, Row, TypeInfo};

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{
    split_statements, AlterResult, ColumnInfo, ColumnMeta, ColumnStats, ColumnStatsRequest,
    ConnectSecret, ConnectionParams, Connector, Engine, EngineConnection, EngineInfo,
    FetchRowsRequest, FkRef, ForeignKeyInfo, FreqEntry, ImportResult, InboundFkInfo, IndexInfo,
    OpenConnection, PkPredicate, QueryOptions, QueryResult, RowLookup, RowLookupRequest, RowsPage,
    SchemaInfo, TableInfo, TableMeta, UpdateCellRequest, UpdateResult,
};
use crate::shared::error::AppError;

use crate::engines::ssh::{db_password, open_tunnel_if_needed, tunnel_override};

use sql::{
    is_numeric_type, order_by_clause, qualified, quote_ident, validate_column, where_clause,
    BoundValue, WhereClause, JS_MAX_SAFE_INTEGER,
};

/// Page-size ceiling for `fetch_rows` (mirrors the SQLite adapter and the
/// connections slice's `MAX_ROW_LIMIT`).
const MAX_PAGE_ROWS: u32 = 10_000;

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
        let options = sql::connect_options(params, db_password(secret), host_over, port_over)?;
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
        // User schemas only (system schemas excluded), each with a cheap table
        // count from the catalog.
        let rows = sqlx::query(
            "SELECT n.nspname AS name, \
                count(c.oid) FILTER (WHERE c.relkind = 'r') AS table_count \
             FROM pg_namespace n \
             LEFT JOIN pg_class c ON c.relnamespace = n.oid \
             WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND n.nspname NOT LIKE 'pg_toast%' \
               AND n.nspname NOT LIKE 'pg_temp%' \
               AND n.nspname NOT LIKE 'pg_toast_temp%' \
             GROUP BY n.nspname \
             ORDER BY n.nspname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(map_query_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let name: String = row.get("name");
                let count: i64 = row.try_get("table_count").unwrap_or(0);
                SchemaInfo {
                    name,
                    table_count: Some(count.max(0) as u64),
                }
            })
            .collect())
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
        ensure_schema_exists(&self.pool, schema).await?;
        // Base tables in the schema, with the planner's row ESTIMATE
        // (reltuples). A never-analyzed table reports -1 → None (module docs).
        let rows = sqlx::query(
            "SELECT c.relname AS name, c.reltuples::bigint AS est \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind = 'r' \
             ORDER BY c.relname",
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await
        .map_err(map_query_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let name: String = row.get("name");
                let est: i64 = row.try_get("est").unwrap_or(-1);
                TableInfo {
                    name,
                    approx_row_count: if est < 0 { None } else { Some(est as u64) },
                }
            })
            .collect())
    }

    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
        table_meta(&self.pool, schema, table).await
    }

    async fn run_query(&self, sql: &str, options: QueryOptions) -> Result<QueryResult, AppError> {
        let started = Instant::now();

        // One acquired connection so the `SET search_path` and the query share a
        // session. `SET` on the pool surface lands on a random pooled connection,
        // so the query — which may grab a DIFFERENT pooled connection — would
        // resolve unqualified names against the default search_path instead of
        // the selected schema. Pinning the session is the same fix the MySQL
        // adapter uses.
        let mut conn = self.pool.acquire().await.map_err(map_query_error)?;

        // Apply the schema as the search_path for unqualified names, when given.
        // Best effort: a bad schema simply leaves the default search_path.
        if let Some(schema) = &options.schema {
            use sqlx::Executor as _;
            let _ = conn.execute(format!("SET search_path TO {}", quote_ident(schema)).as_str()).await;
        }

        // Read one extra row to detect truncation (matches the SQLite adapter).
        let rows = sqlx::query(sql)
            .fetch_all(&mut *conn)
            .await
            .map_err(map_query_error)?;

        let columns = if let Some(first) = rows.first() {
            column_meta(first)
        } else {
            // No rows returned: ask the engine to describe the statement so an
            // empty SELECT still reports its column headers (the grid shows the
            // columns with a "0 rows" body). A DML/DDL statement describes to no
            // columns, which is exactly what we want ("Query OK"). Best effort —
            // a describe failure falls back to no columns.
            use sqlx::Executor as _;
            match (&mut *conn).describe(sql).await {
                Ok(described) => described
                    .columns()
                    .iter()
                    .map(|col| ColumnMeta {
                        name: col.name().to_string(),
                        type_hint: col.type_info().name().to_string(),
                    })
                    .collect(),
                Err(_) => Vec::new(),
            }
        };

        let mut out_rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut truncated = false;
        for row in &rows {
            if out_rows.len() >= options.row_limit {
                truncated = true;
                break;
            }
            out_rows.push(decode_row(row));
        }

        Ok(QueryResult {
            columns,
            row_count: out_rows.len(),
            rows: out_rows,
            truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
        let started = Instant::now();
        let meta = table_meta(&self.pool, &req.schema, &req.table).await?;
        let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();

        let order_by = match &req.sort {
            Some(sort) => Some(order_by_clause(&column_names, &req.table, sort)?),
            None => None,
        };
        let where_clause = match &req.filter {
            Some(filter) => where_clause(&column_names, &req.table, filter)?,
            None => WhereClause::default(),
        };
        let where_sql = match &where_clause.sql {
            Some(body) => format!(" WHERE {body}"),
            None => String::new(),
        };

        let limit = req.limit.min(MAX_PAGE_ROWS);
        let qualified = qualified(&req.schema, &req.table);

        // Exact filtered COUNT(*) for "n of N rows" (§3.5).
        let count_sql = format!("SELECT count(*) AS n FROM {qualified}{where_sql}");
        let mut count_query = sqlx::query(&count_sql);
        for value in &where_clause.params {
            count_query = bind_value(count_query, value);
        }
        let total_rows: i64 = count_query
            .fetch_one(&self.pool)
            .await
            .map_err(map_query_error)?
            .get("n");

        // Page query: WHERE, ORDER BY, then LIMIT/OFFSET as the next $N binds.
        let limit_placeholder = where_clause.next_index();
        let offset_placeholder = limit_placeholder + 1;
        let mut page_sql = format!("SELECT * FROM {qualified}{where_sql}");
        if let Some(clause) = &order_by {
            page_sql.push_str(&format!(" ORDER BY {clause}"));
        }
        page_sql.push_str(&format!(
            " LIMIT ${limit_placeholder} OFFSET ${offset_placeholder}"
        ));

        let mut page_query = sqlx::query(&page_sql);
        for value in &where_clause.params {
            page_query = bind_value(page_query, value);
        }
        page_query = page_query.bind(i64::from(limit)).bind(req.offset as i64);

        let rows = page_query
            .fetch_all(&self.pool)
            .await
            .map_err(map_query_error)?;

        // Column metadata: prefer the live result shape; fall back to the
        // introspected columns when the page is empty.
        let columns = if let Some(first) = rows.first() {
            column_meta(first)
        } else {
            meta.columns
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name.clone(),
                    type_hint: c.data_type.clone(),
                })
                .collect()
        };

        let out_rows: Vec<Vec<serde_json::Value>> = rows.iter().map(decode_row).collect();

        Ok(RowsPage {
            columns,
            rows: out_rows,
            offset: req.offset,
            limit,
            total_rows: Some(total_rows.max(0) as u64),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn fetch_row_by_key(&self, req: RowLookupRequest) -> Result<RowLookup, AppError> {
        let meta = table_meta(&self.pool, &req.schema, &req.table).await?;
        let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
        validate_column(&column_names, &req.table, &req.column)?;

        let columns: Vec<ColumnMeta> = meta
            .columns
            .iter()
            .map(|c| ColumnMeta {
                name: c.name.clone(),
                type_hint: c.data_type.clone(),
            })
            .collect();

        // A null key never matches `=` in SQL — short-circuit to a clean miss.
        if req.value.is_null() {
            return Ok(RowLookup {
                columns,
                row: None,
                match_count: 0,
            });
        }
        let bound = if req.binary {
            BoundValue::from_binary_operand(&req.value)?
        } else {
            BoundValue::from_json_operand(&req.value)?
        };

        let qualified = qualified(&req.schema, &req.table);
        let col = quote_ident(&req.column);

        let row_sql = format!("SELECT * FROM {qualified} WHERE {col} = $1 LIMIT 1");
        let row = bind_value(sqlx::query(&row_sql), &bound)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_query_error)?
            .map(|r| decode_row(&r));

        let match_count = if row.is_none() {
            0
        } else {
            let count_sql = format!("SELECT count(*) AS n FROM {qualified} WHERE {col} = $1");
            let n: i64 = bind_value(sqlx::query(&count_sql), &bound)
                .fetch_one(&self.pool)
                .await
                .map_err(map_query_error)?
                .get("n");
            n.max(0) as u64
        };

        Ok(RowLookup {
            columns,
            row,
            match_count,
        })
    }

    async fn column_stats(&self, req: ColumnStatsRequest) -> Result<ColumnStats, AppError> {
        column_stats(&self.pool, &req).await
    }

    async fn update_cell(&self, req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
        update_cell(&self.pool, &req).await
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

/// §5 "Schema 'x' does not exist…" unless `schema` is a user schema.
async fn ensure_schema_exists(pool: &PgPool, schema: &str) -> Result<(), AppError> {
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM pg_namespace WHERE nspname = $1")
        .bind(schema)
        .fetch_optional(pool)
        .await
        .map_err(map_query_error)?;
    if exists.is_some() {
        return Ok(());
    }
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT nspname FROM pg_namespace \
         WHERE nspname NOT IN ('pg_catalog', 'information_schema') \
           AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' \
         ORDER BY nspname",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    Err(AppError::Database(format!(
        "Schema '{schema}' does not exist. Available schemas: {}.",
        if names.is_empty() {
            "(none)".to_string()
        } else {
            names.join(", ")
        }
    )))
}

// ---------------------------------------------------------------------------
// Value binding + decoding
// ---------------------------------------------------------------------------

/// Bind a [`BoundValue`] to a sqlx query with its native Postgres type. The
/// caller has already emitted the matching `$N` placeholder. Binding natively
/// (bool→bool, int→i64, float→f64, text→text) lets the common grid/filter cases
/// compare correctly; a value's JSON type matches the cell it came from.
fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    value: &'q BoundValue,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match value {
        BoundValue::Null => query.bind(Option::<String>::None),
        BoundValue::Bool(b) => query.bind(*b),
        BoundValue::Int(i) => query.bind(*i),
        BoundValue::Float(f) => query.bind(*f),
        BoundValue::Text(s) => query.bind(s.as_str()),
        BoundValue::Bytes(b) => query.bind(b.as_slice()),
    }
}

/// Column metadata for a result row: name + the Postgres type name as the
/// display type hint.
fn column_meta(row: &PgRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|col| ColumnMeta {
            name: col.name().to_string(),
            type_hint: col.type_info().name().to_string(),
        })
        .collect()
}

/// Decode every column of a row to JSON (module docs for the mapping).
fn decode_row(row: &PgRow) -> Vec<serde_json::Value> {
    (0..row.columns().len())
        .map(|i| decode_value(row, i))
        .collect()
}

/// Decode one column of a [`PgRow`] to JSON, dispatching on the Postgres type
/// name (`col.type_info().name()`). See the module docs for the full mapping.
/// Unknown types fall back to the column's text representation; a decode error
/// degrades to null rather than failing the whole row.
fn decode_value(row: &PgRow, index: usize) -> serde_json::Value {
    use serde_json::Value;

    let col = &row.columns()[index];
    let type_name = col.type_info().name();

    match type_name {
        "BOOL" => match row.try_get::<Option<bool>, _>(index) {
            Ok(Some(b)) => Value::Bool(b),
            Ok(None) => Value::Null,
            Err(_) => Value::Null,
        },
        "INT2" | "SMALLINT" => decode_int(row, index, |row| {
            row.try_get::<Option<i16>, _>(index)
                .map(|o| o.map(i64::from))
        }),
        "INT4" | "INT" | "INTEGER" => decode_int(row, index, |row| {
            row.try_get::<Option<i32>, _>(index)
                .map(|o| o.map(i64::from))
        }),
        "INT8" | "BIGINT" => decode_int(row, index, |row| row.try_get::<Option<i64>, _>(index)),
        "OID" => decode_int(row, index, |row| {
            row.try_get::<Option<i32>, _>(index)
                .map(|o| o.map(i64::from))
        }),
        "FLOAT4" | "REAL" => match row.try_get::<Option<f32>, _>(index) {
            Ok(Some(f)) => number_or_null(f64::from(f)),
            _ => Value::Null,
        },
        "FLOAT8" | "DOUBLE PRECISION" => match row.try_get::<Option<f64>, _>(index) {
            Ok(Some(f)) => number_or_null(f),
            _ => Value::Null,
        },
        // numeric/decimal: decode to an arbitrary-precision BigDecimal (the
        // `bigdecimal` sqlx feature) and stringify it, then map: a lossless
        // JS-safe value becomes a JSON number, otherwise the exact decimal
        // string (the CellValue precision contract — module docs). MONEY has no
        // BigDecimal decode; fall back to its text form.
        "NUMERIC" | "DECIMAL" => match row.try_get::<Option<sqlx::types::BigDecimal>, _>(index) {
            // `normalized()` strips trailing-zero scale (sqlx's PG NUMERIC
            // decode can carry extra scale, e.g. `9.50` → `9.5000`), so a clean
            // value round-trips to a JSON number and only genuinely
            // high-precision values stay strings.
            Ok(Some(d)) => numeric_text_to_json(&d.normalized().to_string()),
            Ok(None) => Value::Null,
            Err(_) => get_as_text(row, index)
                .map(Value::String)
                .unwrap_or(Value::Null),
        },
        "MONEY" => get_as_text(row, index)
            .map(|t| numeric_text_to_json(&t))
            .unwrap_or(Value::Null),
        // bytea → hex when small (UUID/key), placeholder when large; shared with
        // SQLite/MySQL so binary renders identically everywhere.
        "BYTEA" => match row.try_get::<Option<Vec<u8>>, _>(index) {
            Ok(Some(bytes)) => crate::shared::engine::binary_to_json(&bytes),
            _ => Value::Null,
        },
        // json/jsonb → serialized JSON string (kept a string so the grid renders
        // it as text, consistent with other engines).
        "JSON" | "JSONB" => match row.try_get::<Option<serde_json::Value>, _>(index) {
            Ok(Some(v)) => Value::String(v.to_string()),
            Ok(None) => Value::Null,
            Err(_) => get_as_text(row, index)
                .map(Value::String)
                .unwrap_or(Value::Null),
        },
        // Temporal types decode to chrono values, not String — format them to a
        // display string (the "timestamps don't show" fix). TIMETZ/INTERVAL stay
        // in the text fallback below.
        "DATE" | "TIMESTAMP" | "TIMESTAMPTZ" | "TIME" => get_temporal(row, index, type_name)
            .or_else(|| get_as_text(row, index))
            .map(Value::String)
            .unwrap_or(Value::Null),
        // Text-like and everything else (uuid, timetz, interval, arrays, enums,
        // …): the column's text form. sqlx decodes most of these as String
        // directly; arrays/unknowns fall through to the text cast.
        _ => get_as_text(row, index)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

/// Decode a Postgres temporal column (DATE/TIMESTAMP/TIMESTAMPTZ/TIME) to a
/// display string. These arrive as chrono types (the `chrono` sqlx feature),
/// NOT as `String`, so a plain text read returns NULL — the "timestamps don't
/// show" bug. TIMESTAMPTZ keeps its offset; the rest format naively.
fn get_temporal(row: &PgRow, index: usize, type_name: &str) -> Option<String> {
    use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
    const DT_FMT: &str = "%Y-%m-%d %H:%M:%S%.f";
    match type_name {
        "DATE" => row
            .try_get::<Option<NaiveDate>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format("%Y-%m-%d").to_string()),
        "TIMESTAMP" => row
            .try_get::<Option<NaiveDateTime>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format(DT_FMT).to_string()),
        "TIMESTAMPTZ" => row
            .try_get::<Option<DateTime<Utc>>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format("%Y-%m-%d %H:%M:%S%.f%:z").to_string()),
        "TIME" => row
            .try_get::<Option<NaiveTime>, _>(index)
            .ok()
            .flatten()
            .map(|t| t.format("%H:%M:%S%.f").to_string()),
        _ => None,
    }
}

/// Decode an integer column, applying the ±2^53 string-fallback (the
/// `CellValue` precision contract). `getter` reads the native width as i64.
fn decode_int<F>(row: &PgRow, _index: usize, getter: F) -> serde_json::Value
where
    F: Fn(&PgRow) -> Result<Option<i64>, sqlx::Error>,
{
    match getter(row) {
        Ok(Some(i)) if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 => serde_json::Value::from(i),
        Ok(Some(i)) => serde_json::Value::String(i.to_string()),
        _ => serde_json::Value::Null,
    }
}

/// A finite f64 as a JSON number; non-finite (NaN/Inf — JSON has neither) → null.
fn number_or_null(f: f64) -> serde_json::Value {
    serde_json::Number::from_f64(f)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// Map a NUMERIC's exact decimal text to JSON: a lossless, JS-safe number when
/// possible, else the exact string (preserve precision — module docs).
fn numeric_text_to_json(text: &str) -> serde_json::Value {
    // Integer-valued and within the JS-safe range → number.
    if let Ok(i) = text.parse::<i64>() {
        if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 {
            return serde_json::Value::from(i);
        }
        return serde_json::Value::String(text.to_string());
    }
    if let Ok(f) = text.parse::<f64>() {
        // Only surface as a number when formatting it back yields the same
        // decimal — otherwise we'd silently lose precision; keep the string.
        if f.is_finite() {
            let round_trip = format!("{f}");
            if round_trip == text {
                return number_or_null(f);
            }
        }
    }
    serde_json::Value::String(text.to_string())
}

/// Read a column as its Postgres text representation via an explicit `::text`
/// decode. sqlx returns most types as `String`; for ones it cannot, this is the
/// honest text form. `None` on NULL or decode failure.
fn get_as_text(row: &PgRow, index: usize) -> Option<String> {
    row.try_get::<Option<String>, _>(index).ok().flatten()
}

// ---------------------------------------------------------------------------
// table_meta (introspection)
// ---------------------------------------------------------------------------

/// Column-level + structure metadata for one table (module docs for sources).
async fn table_meta(pool: &PgPool, schema: &str, table: &str) -> Result<TableMeta, AppError> {
    ensure_schema_exists(pool, schema).await?;

    // Existence: a base table or view in the schema. (We surface the §5 missing
    // message with the available-tables listing, like the SQLite adapter.)
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'v', 'm', 'p')",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(map_query_error)?;
    if exists.is_none() {
        return Err(missing_table_error(pool, schema, table).await);
    }

    let pk_columns = primary_key_columns(pool, schema, table).await?;
    let foreign_keys = foreign_keys(pool, schema, table).await?;
    let fk_by_column = fk_by_first_column(&foreign_keys);

    // Columns from information_schema.columns; udt_name carries the canonical
    // type (int4/int8/bool/numeric/_text/jsonb/…) we use for numeric detection.
    let col_rows = sqlx::query(
        "SELECT column_name, data_type, udt_name, is_nullable, column_default \
         FROM information_schema.columns \
         WHERE table_schema = $1 AND table_name = $2 \
         ORDER BY ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    let mut columns = Vec::with_capacity(col_rows.len());
    let mut udt_by_name = std::collections::HashMap::new();
    for row in &col_rows {
        let name: String = row.get("column_name");
        let data_type: String = row.get("data_type");
        let udt_name: String = row.get("udt_name");
        let is_nullable: String = row.get("is_nullable");
        let default_value: Option<String> = row.try_get("column_default").unwrap_or(None);
        udt_by_name.insert(name.clone(), udt_name.clone());
        columns.push(ColumnInfo {
            fk: fk_by_column.get(&name).cloned(),
            pk: pk_columns.iter().any(|c| c == &name),
            name,
            // Display `data_type` (information_schema's readable form, e.g.
            // "integer", "timestamp with time zone"). For ARRAY columns
            // data_type is just "ARRAY"; prefer the udt_name (e.g. "_text").
            data_type: if data_type == "ARRAY" {
                udt_name
            } else {
                data_type
            },
            nullable: is_nullable.eq_ignore_ascii_case("YES"),
            default_value,
        });
    }

    let indexes = table_indexes(pool, schema, table).await?;
    let referenced_by = inbound_foreign_keys(pool, schema, table).await?;
    let comment = table_comment(pool, schema, table).await?;
    let ddl = Some(assemble_ddl(
        schema,
        table,
        &columns,
        &pk_columns,
        &foreign_keys,
    ));

    Ok(TableMeta {
        columns,
        comment,
        indexes,
        foreign_keys,
        referenced_by,
        ddl,
    })
}

/// Primary-key column names, in key order.
async fn primary_key_columns(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, AppError> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname \
         FROM pg_index i \
         JOIN pg_class c ON c.oid = i.indrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey) \
         WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary \
         ORDER BY array_position(i.indkey, a.attnum)",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;
    Ok(names)
}

/// Outbound foreign keys, grouped per constraint with ordered column lists and
/// on_delete/on_update actions decoded from confdeltype/confupdtype.
async fn foreign_keys(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT con.conname AS name, \
            con.confdeltype::text AS on_delete, con.confupdtype::text AS on_update, \
            cl.relname AS ref_table, \
            (SELECT array_agg(att.attname ORDER BY u.ord) \
             FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord) \
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum) AS cols, \
            (SELECT array_agg(att.attname ORDER BY u.ord) \
             FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ord) \
             JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.attnum) AS ref_cols \
         FROM pg_constraint con \
         JOIN pg_class c ON c.oid = con.conrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_class cl ON cl.oid = con.confrelid \
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f' \
         ORDER BY con.conname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let name: String = row.get("name");
            let cols: Vec<String> = row.try_get("cols").unwrap_or_default();
            let ref_cols: Vec<String> = row.try_get("ref_cols").unwrap_or_default();
            let ref_table: String = row.get("ref_table");
            let on_delete: String = row.get("on_delete");
            let on_update: String = row.get("on_update");
            ForeignKeyInfo {
                name: Some(name),
                columns: cols,
                ref_table,
                ref_columns: ref_cols,
                on_delete: Some(fk_action(&on_delete)),
                on_update: Some(fk_action(&on_update)),
            }
        })
        .collect())
}

/// Decode a `pg_constraint.confdeltype` / `confupdtype` action char.
fn fk_action(code: &str) -> String {
    match code {
        "a" => "NO ACTION",
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .to_string()
}

/// Per-column fk map for `ColumnInfo.fk` (sidebar icon): the first fk a column
/// participates in, target = the parallel referenced column.
fn fk_by_column(foreign_keys: &[ForeignKeyInfo]) -> std::collections::HashMap<String, FkRef> {
    let mut map = std::collections::HashMap::new();
    for fk in foreign_keys {
        for (i, col) in fk.columns.iter().enumerate() {
            map.entry(col.clone()).or_insert(FkRef {
                table: fk.ref_table.clone(),
                column: fk.ref_columns.get(i).cloned().unwrap_or_default(),
            });
        }
    }
    map
}

/// Alias kept readable at the call site.
fn fk_by_first_column(foreign_keys: &[ForeignKeyInfo]) -> std::collections::HashMap<String, FkRef> {
    fk_by_column(foreign_keys)
}

/// Indexes on the table (name, member columns in order, unique, primary).
async fn table_indexes(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT ic.relname AS name, idx.indisunique AS uniq, idx.indisprimary AS prim, \
            (SELECT array_agg(a.attname ORDER BY k.ord) \
             FROM unnest(idx.indkey) WITH ORDINALITY k(attnum, ord) \
             LEFT JOIN pg_attribute a ON a.attrelid = idx.indrelid AND a.attnum = k.attnum \
             WHERE a.attname IS NOT NULL) AS cols \
         FROM pg_index idx \
         JOIN pg_class tc ON tc.oid = idx.indrelid \
         JOIN pg_namespace n ON n.oid = tc.relnamespace \
         JOIN pg_class ic ON ic.oid = idx.indexrelid \
         WHERE n.nspname = $1 AND tc.relname = $2 \
         ORDER BY ic.relname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let name: String = row.get("name");
            let unique: bool = row.get("uniq");
            let primary: bool = row.get("prim");
            let columns: Vec<String> = row.try_get("cols").unwrap_or_default();
            IndexInfo {
                name,
                columns,
                unique,
                primary,
                // Postgres does not expose SQLite's c/u/pk origin code; mark the
                // primary-key index, leave the rest None.
                origin: if primary {
                    Some("pk".to_string())
                } else {
                    None
                },
            }
        })
        .collect())
}

/// Inbound foreign keys (§3.6 "referenced by"): constraints in the same schema
/// whose referenced table is this one.
async fn inbound_foreign_keys(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<InboundFkInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT child.relname AS child_table, con.confdeltype::text AS on_delete, \
            (SELECT array_agg(att.attname ORDER BY u.ord) \
             FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord) \
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum) AS cols, \
            (SELECT array_agg(att.attname ORDER BY u.ord) \
             FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ord) \
             JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.attnum) AS ref_cols \
         FROM pg_constraint con \
         JOIN pg_class parent ON parent.oid = con.confrelid \
         JOIN pg_namespace pn ON pn.oid = parent.relnamespace \
         JOIN pg_class child ON child.oid = con.conrelid \
         WHERE pn.nspname = $1 AND parent.relname = $2 AND con.contype = 'f' \
         ORDER BY child.relname, con.conname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let child_table: String = row.get("child_table");
            let cols: Vec<String> = row.try_get("cols").unwrap_or_default();
            let ref_cols: Vec<String> = row.try_get("ref_cols").unwrap_or_default();
            let on_delete: String = row.get("on_delete");
            InboundFkInfo {
                table: child_table,
                columns: cols,
                ref_columns: ref_cols,
                on_delete: Some(fk_action(&on_delete)),
            }
        })
        .collect())
}

/// The table's comment (`COMMENT ON TABLE`), via `obj_description`.
async fn table_comment(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Option<String>, AppError> {
    let comment: Option<String> = sqlx::query_scalar(
        "SELECT obj_description(c.oid) \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(map_query_error)?
    .flatten();
    Ok(comment.filter(|s| !s.is_empty()))
}

/// Assemble a reasonable, valid-ish `CREATE TABLE` from the catalog (module
/// docs: best-effort, not pg_dump-grade). Columns with type/nullability/default,
/// the primary key, and table-level foreign keys.
fn assemble_ddl(
    schema: &str,
    table: &str,
    columns: &[ColumnInfo],
    pk_columns: &[String],
    foreign_keys: &[ForeignKeyInfo],
) -> String {
    let mut lines: Vec<String> = Vec::new();
    for col in columns {
        let mut line = format!("    {} {}", quote_ident(&col.name), col.data_type);
        if !col.nullable {
            line.push_str(" NOT NULL");
        }
        if let Some(default) = &col.default_value {
            line.push_str(&format!(" DEFAULT {default}"));
        }
        lines.push(line);
    }
    if !pk_columns.is_empty() {
        let cols = pk_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("    PRIMARY KEY ({cols})"));
    }
    for fk in foreign_keys {
        let cols = fk
            .columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let ref_cols = fk
            .ref_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let mut line = format!(
            "    FOREIGN KEY ({cols}) REFERENCES {} ({ref_cols})",
            quote_ident(&fk.ref_table)
        );
        if let Some(on_delete) = &fk.on_delete {
            if on_delete != "NO ACTION" {
                line.push_str(&format!(" ON DELETE {on_delete}"));
            }
        }
        if let Some(on_update) = &fk.on_update {
            if on_update != "NO ACTION" {
                line.push_str(&format!(" ON UPDATE {on_update}"));
            }
        }
        lines.push(line);
    }
    format!(
        "CREATE TABLE {} (\n{}\n);",
        qualified(schema, table),
        lines.join(",\n")
    )
}

/// §5 unknown-table message with the schema's available tables.
async fn missing_table_error(pool: &PgPool, schema: &str, table: &str) -> AppError {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    AppError::Database(format!(
        "Table '{table}' does not exist. Available tables: {}.",
        if names.is_empty() {
            "(none)".to_string()
        } else {
            names.join(", ")
        }
    ))
}

// ---------------------------------------------------------------------------
// column_stats
// ---------------------------------------------------------------------------

/// Per-column statistics over the (filtered) set: total/distinct/null counts,
/// min/max, avg (numeric only), top-5. Reuses the same parameterized
/// [`where_clause`] compilation as `fetch_rows`. Numeric detection comes from
/// the catalog type (cleaner than SQLite's value heuristic — module docs).
async fn column_stats(pool: &PgPool, req: &ColumnStatsRequest) -> Result<ColumnStats, AppError> {
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    validate_column(&column_names, &req.table, &req.column)?;

    // The catalog type for numeric detection.
    let udt: String = sqlx::query_scalar(
        "SELECT udt_name FROM information_schema.columns \
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3",
    )
    .bind(&req.schema)
    .bind(&req.table)
    .bind(&req.column)
    .fetch_one(pool)
    .await
    .map_err(map_query_error)?;
    let numeric = is_numeric_type(&udt);

    let qualified = qualified(&req.schema, &req.table);
    let col = quote_ident(&req.column);

    let where_clause = match &req.filter {
        Some(filter) => where_clause(&column_names, &req.table, filter)?,
        None => WhereClause::default(),
    };
    let where_sql = match &where_clause.sql {
        Some(body) => format!(" WHERE {body}"),
        None => String::new(),
    };
    let and = if where_sql.is_empty() {
        " WHERE"
    } else {
        " AND"
    };

    // total / nulls / distinct in one aggregate.
    let agg_sql = format!(
        "SELECT count(*) AS total, count(*) - count({col}) AS nulls, \
            count(DISTINCT {col}) AS distinct_count FROM {qualified}{where_sql}"
    );
    let agg_row = bind_all(sqlx::query(&agg_sql), &where_clause.params)
        .fetch_one(pool)
        .await
        .map_err(map_query_error)?;
    let total: i64 = agg_row.get("total");
    let nulls: i64 = agg_row.get("nulls");
    let distinct: i64 = agg_row.get("distinct_count");

    // min / max as text → JSON (so big-int/numeric map like everywhere else).
    let minmax_sql = format!(
        "SELECT min({col})::text AS lo, max({col})::text AS hi FROM {qualified}{where_sql}"
    );
    let minmax_row = bind_all(sqlx::query(&minmax_sql), &where_clause.params)
        .fetch_one(pool)
        .await
        .map_err(map_query_error)?;
    let min_text: Option<String> = minmax_row.try_get("lo").unwrap_or(None);
    let max_text: Option<String> = minmax_row.try_get("hi").unwrap_or(None);
    let to_value = |text: Option<String>| -> Option<serde_json::Value> {
        text.map(|t| {
            if numeric {
                numeric_text_to_json(&t)
            } else {
                serde_json::Value::String(t)
            }
        })
    };
    let min = to_value(min_text);
    let max = to_value(max_text);

    // avg only when numeric.
    let avg = if numeric {
        let avg_sql = format!("SELECT avg({col})::float8 AS a FROM {qualified}{where_sql}");
        let row = bind_all(sqlx::query(&avg_sql), &where_clause.params)
            .fetch_one(pool)
            .await
            .map_err(map_query_error)?;
        row.try_get::<Option<f64>, _>("a").unwrap_or(None)
    } else {
        None
    };

    // Top-5 most frequent non-NULL values (value rendered as text → JSON).
    let top_sql = format!(
        "SELECT {col}::text AS v, count(*) AS freq FROM {qualified}{where_sql}{and} {col} IS NOT NULL \
         GROUP BY {col} ORDER BY freq DESC, {col} ASC LIMIT 5"
    );
    let top_rows = bind_all(sqlx::query(&top_sql), &where_clause.params)
        .fetch_all(pool)
        .await
        .map_err(map_query_error)?;
    let top = top_rows
        .into_iter()
        .map(|row| {
            let text: Option<String> = row.try_get("v").unwrap_or(None);
            let freq: i64 = row.get("freq");
            let value = match text {
                Some(t) if numeric => numeric_text_to_json(&t),
                Some(t) => serde_json::Value::String(t),
                None => serde_json::Value::Null,
            };
            FreqEntry {
                value,
                count: freq.max(0) as u64,
            }
        })
        .collect();

    Ok(ColumnStats {
        total: total.max(0) as u64,
        distinct: distinct.max(0) as u64,
        nulls: nulls.max(0) as u64,
        min,
        max,
        avg,
        numeric,
        top,
    })
}

/// Bind every [`BoundValue`] (the WHERE params) to a query in order.
fn bind_all<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    params: &'q [BoundValue],
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    for value in params {
        query = bind_value(query, value);
    }
    query
}

// ---------------------------------------------------------------------------
// update_cell
// ---------------------------------------------------------------------------

/// Update a single cell (M11): `SET col = $1 WHERE <full pk>` in a transaction,
/// asserting exactly one affected row. pk-completeness policy + bound values
/// match the SQLite adapter; Postgres uses `$N` placeholders and a real
/// transaction with ROLLBACK on any deviation.
async fn update_cell(pool: &PgPool, req: &UpdateCellRequest) -> Result<UpdateResult, AppError> {
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    validate_column(&column_names, &req.table, &req.column)?;

    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();
    validate_pk_predicates(&pk_columns, &column_names, &req.table, &req.pk)?;

    let qualified = qualified(&req.schema, &req.table);
    let set_col = quote_ident(&req.column);

    // $1 = SET value; $2.. = each pk value in predicate order. Binary columns
    // (req.binary / predicate.binary) bind their `0x`-hex / UUID value as raw
    // bytes (bytea) so the write and the WHERE match the bytes.
    let mut params: Vec<BoundValue> = Vec::with_capacity(1 + req.pk.len());
    params.push(if req.binary {
        BoundValue::from_binary_set(&req.value)?
    } else {
        BoundValue::from_json_set(&req.value)
    });

    let mut where_fragments: Vec<String> = Vec::with_capacity(req.pk.len());
    for (i, predicate) in req.pk.iter().enumerate() {
        if predicate.value.is_null() {
            return Err(no_row_matched_error());
        }
        params.push(if predicate.binary {
            BoundValue::from_binary_operand(&predicate.value)?
        } else {
            BoundValue::from_json_operand(&predicate.value)?
        });
        where_fragments.push(format!("{} = ${}", quote_ident(&predicate.column), i + 2));
    }
    let where_sql = where_fragments.join(" AND ");
    let update_sql = format!("UPDATE {qualified} SET {set_col} = $1 WHERE {where_sql}");

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    let result = bind_all(sqlx::query(&update_sql), &params)
        .execute(&mut *tx)
        .await;
    let affected = match result {
        Ok(done) => done.rows_affected(),
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(map_query_error(err));
        }
    };

    if affected == 0 {
        let _ = tx.rollback().await;
        return Err(no_row_matched_error());
    }
    if affected > 1 {
        let _ = tx.rollback().await;
        return Err(AppError::Database(format!(
            "Update would affect {affected} rows; expected exactly one. \
             No changes were applied."
        )));
    }
    tx.commit().await.map_err(map_query_error)?;

    Ok(UpdateResult {
        affected,
        statement: display_update_statement(&qualified, &req.column, &req.value, &req.pk),
    })
}

fn no_row_matched_error() -> AppError {
    AppError::Database(
        "No row matched (it may have been deleted or changed since you loaded it).".to_string(),
    )
}

/// Empty a table, keeping its structure (M15 truncate). Postgres has a native
/// `TRUNCATE TABLE`, which is faster than `DELETE` but reports no affected-row
/// count, so we `COUNT(*)` first and return that as the number removed (0 for
/// an already-empty table). The table must exist (reuse `table_meta` for the
/// §5 "Table 'x' does not exist…" message).
async fn truncate_table(pool: &PgPool, schema: &str, table: &str) -> Result<u64, AppError> {
    table_meta(pool, schema, table).await?;
    let qualified = qualified(schema, table);

    let prior: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {qualified}"))
        .fetch_one(pool)
        .await
        .map_err(map_query_error)?;

    sqlx::query(&format!("TRUNCATE TABLE {qualified}"))
        .execute(pool)
        .await
        .map_err(map_query_error)?;

    Ok(prior.max(0) as u64)
}

/// Drop every table in `schema` and leave the schema empty (M15 drop-schema).
///
/// Runs `DROP SCHEMA "x" CASCADE; CREATE SCHEMA "x";` inside ONE explicit
/// transaction. Postgres has transactional DDL, so this is atomic: either both
/// statements land (leaving an empty schema, exactly as the prototype's SQL
/// preview promises) or the whole thing rolls back and the schema is untouched.
/// CASCADE drops the tables and everything that depends on them (indexes, views,
/// sequences). The schema must exist (a §5 "does not exist" error otherwise,
/// matching the prototype's plain `DROP SCHEMA` — no `IF EXISTS`).
async fn drop_schema(pool: &PgPool, schema: &str) -> Result<(), AppError> {
    ensure_schema_exists(pool, schema).await?;
    let quoted = quote_ident(schema);

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    if let Err(err) = sqlx::query(&format!("DROP SCHEMA {quoted} CASCADE"))
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        return Err(map_query_error(err));
    }
    if let Err(err) = sqlx::query(&format!("CREATE SCHEMA {quoted}"))
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        return Err(map_query_error(err));
    }
    tx.commit().await.map_err(map_query_error)?;
    Ok(())
}

/// Run a whole multi-statement SQL script (a dump) into `schema` (M15 import).
///
/// Atomicity: the whole dump runs inside one explicit sqlx transaction
/// (`pool.begin()` → COMMIT on success, ROLLBACK on any error), so a mid-script
/// failure rolls ALL statements back and a table is never left half-created
/// (Postgres has transactional DDL). We `SET search_path` first within that
/// transaction so unqualified `CREATE`s land in the target schema, then run the
/// dump statement-by-statement (split with the quote/comment-aware
/// [`split_statements`]) on the one transaction connection. Splitting
/// client-side and using `sqlx::query` per statement mirrors the proven
/// `alter_table` path and binds nothing — the statements come from a file the
/// user chose, exactly like the SQL query editor.
///
/// The schema must exist (a §5 error otherwise — same message vocabulary as the
/// rest of the adapter). Any engine error surfaces §5-style after the rollback.
async fn execute_script(
    pool: &PgPool,
    schema: &str,
    sql: &str,
    on_progress: crate::shared::engine::ProgressCallback<'_>,
) -> Result<ImportResult, AppError> {
    ensure_schema_exists(pool, schema).await?;
    let statements = split_statements(sql);
    let total = statements.len() as u64;

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    // search_path inside the transaction so the dump's unqualified names resolve
    // to the target schema (and shares the one tx connection).
    if let Err(err) = sqlx::query(&format!("SET search_path TO {}", quote_ident(schema)))
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        return Err(map_query_error(err));
    }
    for (i, statement) in statements.iter().enumerate() {
        if let Err(err) = sqlx::query(statement).execute(&mut *tx).await {
            // Roll the whole import back — no table left half-created.
            let _ = tx.rollback().await;
            return Err(map_query_error(err));
        }
        on_progress(i as u64 + 1, total);
    }
    tx.commit().await.map_err(map_query_error)?;

    Ok(ImportResult { statements: total })
}

/// Enforce the full-primary-key policy (mass-update prevention). Identical
/// semantics to the SQLite adapter's `validate_pk_predicates`.
fn validate_pk_predicates(
    pk_columns: &[&str],
    all_columns: &[String],
    table: &str,
    predicates: &[PkPredicate],
) -> Result<(), AppError> {
    if pk_columns.is_empty() {
        return Err(AppError::Database(format!(
            "Cannot update '{table}': it has no primary key, so a single row \
             cannot be safely targeted."
        )));
    }
    if predicates.is_empty() {
        return Err(AppError::Database(format!(
            "Updating a cell in '{table}' requires the full primary key ({}).",
            pk_columns.join(", ")
        )));
    }
    let mut seen: Vec<&str> = Vec::with_capacity(predicates.len());
    for predicate in predicates {
        let column = predicate.column.as_str();
        if !pk_columns.contains(&column) {
            if all_columns.iter().any(|c| c == column) {
                return Err(AppError::Database(format!(
                    "Column '{column}' is not part of the primary key of '{table}' \
                     (primary key: {}); an update must target the row by its primary key.",
                    pk_columns.join(", ")
                )));
            }
            return Err(validate_column(all_columns, table, column).expect_err("unknown pk column"));
        }
        if seen.contains(&column) {
            return Err(AppError::Database(format!(
                "Primary-key column '{column}' is given more than once in the update."
            )));
        }
        seen.push(column);
    }
    if let Some(missing) = pk_columns.iter().find(|c| !seen.contains(*c)) {
        return Err(AppError::Database(format!(
            "Updating a cell in '{table}' requires the full primary key ({}); \
             '{missing}' is missing.",
            pk_columns.join(", ")
        )));
    }
    Ok(())
}

/// Cosmetic, values-inlined UPDATE for the §3.5 toast (the executed query binds
/// every value — see [`UpdateResult`]).
fn display_update_statement(
    qualified: &str,
    column: &str,
    value: &serde_json::Value,
    pk: &[PkPredicate],
) -> String {
    let set = format!("{} = {}", quote_ident(column), sql_literal(value));
    let where_sql = pk
        .iter()
        .map(|p| format!("{} = {}", quote_ident(&p.column), sql_literal(&p.value)))
        .collect::<Vec<_>>()
        .join(" AND ");
    format!("UPDATE {qualified} SET {set} WHERE {where_sql}")
}

/// A JSON scalar as a display SQL literal for the cosmetic toast (NOT executed).
fn sql_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

// ---------------------------------------------------------------------------
// alter_table (native ALTER — no rebuild)
// ---------------------------------------------------------------------------

/// Preview or apply a batch of structure edits via native `ALTER TABLE`
/// statements (module docs). Preview = the real ALTER SQL; apply = run them in
/// a transaction, rolling back on any error. pk-protection per the policy.
async fn alter_table(
    pool: &PgPool,
    schema: &str,
    table: &str,
    ops: &[AlterOp],
    apply: bool,
) -> Result<AlterResult, AppError> {
    ensure_schema_exists(pool, schema).await?;
    let meta = table_meta(pool, schema, table).await?;

    if ops.is_empty() {
        return Err(AppError::Invalid(
            "No structure changes to apply.".to_string(),
        ));
    }
    validate_ops(&meta, table, ops)?;

    let qualified = qualified(schema, table);
    let statements: Vec<String> = ops
        .iter()
        .map(|op| alter_statement(schema, &qualified, op))
        .collect();

    if !apply {
        return Ok(AlterResult {
            statements,
            applied: false,
        });
    }

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    for statement in &statements {
        if let Err(err) = sqlx::query(statement).execute(&mut *tx).await {
            let _ = tx.rollback().await;
            return Err(map_query_error(err));
        }
    }
    tx.commit().await.map_err(map_query_error)?;

    Ok(AlterResult {
        statements,
        applied: true,
    })
}

/// Validate each op against the introspected columns; pk columns are protected
/// from drop/retype (same as the SQLite adapter).
fn validate_ops(meta: &TableMeta, table: &str, ops: &[AlterOp]) -> Result<(), AppError> {
    for op in ops {
        if let Some(column) = op.target_column() {
            let Some(info) = meta.columns.iter().find(|c| c.name == column) else {
                let listing: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
                return Err(AppError::Database(format!(
                    "Column '{column}' does not exist on '{table}' (columns: {}).",
                    listing.join(", ")
                )));
            };
            if info.pk && op.rejected_on_pk() {
                return Err(AppError::Database(format!(
                    "Column '{column}' is part of the primary key of '{table}' and cannot be \
                     dropped or retyped here."
                )));
            }
        }
    }
    Ok(())
}

/// The native `ALTER TABLE` statement for one op. Postgres supports every op
/// directly; `default` expressions are the verbatim SQL text the user supplied
/// (never re-quoted), consistent with `ColumnInfo.default_value`.
fn alter_statement(schema: &str, qualified: &str, op: &AlterOp) -> String {
    match op {
        AlterOp::AddColumn {
            name,
            data_type,
            nullable,
            default_value,
        } => {
            let mut s = format!(
                "ALTER TABLE {qualified} ADD COLUMN {} {data_type}",
                quote_ident(name)
            );
            if !nullable {
                s.push_str(" NOT NULL");
            }
            if let Some(default) = default_value {
                s.push_str(&format!(" DEFAULT {default}"));
            }
            s
        }
        AlterOp::RenameColumn { from, to } => format!(
            "ALTER TABLE {qualified} RENAME COLUMN {} TO {}",
            quote_ident(from),
            quote_ident(to)
        ),
        AlterOp::ChangeType { column, new_type } => format!(
            "ALTER TABLE {qualified} ALTER COLUMN {} TYPE {new_type} USING {}::{new_type}",
            quote_ident(column),
            quote_ident(column)
        ),
        AlterOp::SetNullable { column, nullable } => {
            let action = if *nullable {
                "DROP NOT NULL"
            } else {
                "SET NOT NULL"
            };
            format!(
                "ALTER TABLE {qualified} ALTER COLUMN {} {action}",
                quote_ident(column)
            )
        }
        AlterOp::SetDefault {
            column,
            default_value,
        } => match default_value {
            Some(default) => format!(
                "ALTER TABLE {qualified} ALTER COLUMN {} SET DEFAULT {default}",
                quote_ident(column)
            ),
            None => format!(
                "ALTER TABLE {qualified} ALTER COLUMN {} DROP DEFAULT",
                quote_ident(column)
            ),
        },
        AlterOp::DropColumn { name } => {
            format!("ALTER TABLE {qualified} DROP COLUMN {}", quote_ident(name))
        }
        AlterOp::AddIndex {
            name,
            columns,
            unique,
        } => format!(
            "CREATE {}INDEX {} ON {qualified} ({})",
            if *unique { "UNIQUE " } else { "" },
            quote_ident(name),
            quote_idents(columns)
        ),
        // Postgres indexes live in a schema; drop by schema-qualified name.
        AlterOp::DropIndex { name } => {
            format!("DROP INDEX {}.{}", quote_ident(schema), quote_ident(name))
        }
        AlterOp::AddForeignKey {
            name,
            columns,
            ref_table,
            ref_columns,
            on_delete,
        } => {
            let mut s = format!(
                "ALTER TABLE {qualified} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({})",
                quote_ident(name),
                quote_idents(columns),
                quote_ident(schema),
                quote_ident(ref_table),
                quote_idents(ref_columns)
            );
            if let Some(action) = on_delete {
                s.push_str(&format!(" ON DELETE {action}"));
            }
            s
        }
        AlterOp::DropForeignKey { name, .. } => {
            format!(
                "ALTER TABLE {qualified} DROP CONSTRAINT {}",
                quote_ident(name)
            )
        }
    }
}

/// Quote and comma-join a list of identifiers (index / FK column lists).
fn quote_idents(names: &[String]) -> String {
    names
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/// Map a connect-time sqlx error to a §5-style human message.
fn map_connect_error(err: sqlx::Error) -> AppError {
    AppError::Database(format!(
        "Could not connect to the PostgreSQL server: {}.",
        humanize_driver(&err)
    ))
}

/// Map a query-time sqlx error to a §5-style human message. Database errors
/// carry the server's own message (already a clear sentence); other errors are
/// humanized.
fn map_query_error(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db) = &err {
        return AppError::Database(humanize(db.message()));
    }
    AppError::Database(humanize(&err.to_string()))
}

/// The bare driver message for a connect error (strip sqlx's wrapping).
fn humanize_driver(err: &sqlx::Error) -> String {
    match err {
        sqlx::Error::Database(db) => db.message().to_string(),
        other => other.to_string(),
    }
}

/// Capitalize the first letter and ensure a trailing period (matches the SQLite
/// adapter's `humanize`).
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
    use super::*;

    #[test]
    fn fk_action_decodes_constraint_chars() {
        assert_eq!(fk_action("c"), "CASCADE");
        assert_eq!(fk_action("n"), "SET NULL");
        assert_eq!(fk_action("a"), "NO ACTION");
        assert_eq!(fk_action("r"), "RESTRICT");
        assert_eq!(fk_action("d"), "SET DEFAULT");
        assert_eq!(fk_action("?"), "NO ACTION");
    }

    #[test]
    fn numeric_text_to_json_preserves_precision() {
        // Small integer-valued → number.
        assert_eq!(numeric_text_to_json("42"), serde_json::json!(42));
        // Within JS-safe → number; a clean decimal round-trips.
        assert_eq!(numeric_text_to_json("3.5"), serde_json::json!(3.5));
        // A huge integer beyond 2^53 → string (precision preserved).
        assert_eq!(
            numeric_text_to_json("9007199254740993"),
            serde_json::json!("9007199254740993")
        );
        // A high-precision decimal that f64 cannot represent exactly → string.
        assert_eq!(
            numeric_text_to_json("0.12345678901234567890"),
            serde_json::json!("0.12345678901234567890")
        );
    }

    #[test]
    fn assemble_ddl_includes_columns_pk_and_fks() {
        let columns = vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "integer".into(),
                nullable: false,
                pk: true,
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "author_id".into(),
                data_type: "bigint".into(),
                nullable: false,
                pk: false,
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "price".into(),
                data_type: "numeric".into(),
                nullable: true,
                pk: false,
                default_value: Some("0.0".into()),
                fk: None,
            },
        ];
        let fks = vec![ForeignKeyInfo {
            name: Some("books_author_id_fkey".into()),
            columns: vec!["author_id".into()],
            ref_table: "authors".into(),
            ref_columns: vec!["id".into()],
            on_delete: Some("CASCADE".into()),
            on_update: Some("NO ACTION".into()),
        }];
        let ddl = assemble_ddl("bt", "books", &columns, &["id".to_string()], &fks);
        assert!(ddl.starts_with("CREATE TABLE \"bt\".\"books\" ("));
        assert!(ddl.contains("\"id\" integer NOT NULL"));
        assert!(ddl.contains("\"price\" numeric DEFAULT 0.0"));
        assert!(ddl.contains("PRIMARY KEY (\"id\")"));
        assert!(ddl.contains(
            "FOREIGN KEY (\"author_id\") REFERENCES \"authors\" (\"id\") ON DELETE CASCADE"
        ));
        // NO ACTION on_update is omitted (it is the default).
        assert!(!ddl.contains("ON UPDATE"));
    }

    #[test]
    fn alter_statement_emits_native_postgres_alters() {
        let q = "\"bt\".\"books\"";
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::AddColumn {
                    name: "note".into(),
                    data_type: "text".into(),
                    nullable: false,
                    default_value: Some("'n/a'".into()),
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ADD COLUMN \"note\" text NOT NULL DEFAULT 'n/a'"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::RenameColumn {
                    from: "a".into(),
                    to: "b".into()
                }
            ),
            "ALTER TABLE \"bt\".\"books\" RENAME COLUMN \"a\" TO \"b\""
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::ChangeType {
                    column: "price".into(),
                    new_type: "numeric(10,2)".into()
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"price\" TYPE numeric(10,2) USING \"price\"::numeric(10,2)"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::SetNullable {
                    column: "email".into(),
                    nullable: false
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"email\" SET NOT NULL"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::SetNullable {
                    column: "email".into(),
                    nullable: true
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"email\" DROP NOT NULL"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: Some("'pending'".into())
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"status\" SET DEFAULT 'pending'"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: None
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ALTER COLUMN \"status\" DROP DEFAULT"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::DropColumn {
                    name: "legacy".into()
                }
            ),
            "ALTER TABLE \"bt\".\"books\" DROP COLUMN \"legacy\""
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::AddIndex {
                    name: "idx_books_email".into(),
                    columns: vec!["email".into()],
                    unique: true,
                }
            ),
            "CREATE UNIQUE INDEX \"idx_books_email\" ON \"bt\".\"books\" (\"email\")"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::DropIndex {
                    name: "idx_old".into(),
                }
            ),
            "DROP INDEX \"bt\".\"idx_old\""
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::AddForeignKey {
                    name: "books_author_id_fkey".into(),
                    columns: vec!["author_id".into()],
                    ref_table: "authors".into(),
                    ref_columns: vec!["id".into()],
                    on_delete: Some("CASCADE".into()),
                }
            ),
            "ALTER TABLE \"bt\".\"books\" ADD CONSTRAINT \"books_author_id_fkey\" \
             FOREIGN KEY (\"author_id\") REFERENCES \"bt\".\"authors\" (\"id\") ON DELETE CASCADE"
        );
        assert_eq!(
            alter_statement(
                "bt",
                q,
                &AlterOp::DropForeignKey {
                    name: "books_author_id_fkey".into(),
                    columns: vec!["author_id".into()],
                }
            ),
            "ALTER TABLE \"bt\".\"books\" DROP CONSTRAINT \"books_author_id_fkey\""
        );
    }

    #[test]
    fn validate_pk_predicates_enforces_full_pk() {
        let all = vec!["id".to_string(), "name".to_string()];
        // No pk → rejected.
        assert!(validate_pk_predicates(&[], &all, "t", &[]).is_err());
        // Missing pk value → rejected.
        assert!(validate_pk_predicates(&["id"], &all, "t", &[]).is_err());
        // Non-pk predicate column → rejected.
        let non_pk = vec![PkPredicate {
            column: "name".into(),
            value: serde_json::json!("x"),
            binary: false,
        }];
        assert!(validate_pk_predicates(&["id"], &all, "t", &non_pk).is_err());
        // Complete pk → ok.
        let ok = vec![PkPredicate {
            column: "id".into(),
            value: serde_json::json!(1),
            binary: false,
        }];
        assert!(validate_pk_predicates(&["id"], &all, "t", &ok).is_ok());
    }

    #[test]
    fn sql_literal_renders_display_values() {
        assert_eq!(sql_literal(&serde_json::Value::Null), "NULL");
        assert_eq!(sql_literal(&serde_json::json!(true)), "true");
        assert_eq!(sql_literal(&serde_json::json!(42)), "42");
        assert_eq!(sql_literal(&serde_json::json!("a'b")), "'a''b'");
    }

    #[test]
    fn humanize_capitalizes_and_terminates() {
        assert_eq!(
            humanize("relation does not exist"),
            "Relation does not exist."
        );
        assert_eq!(humanize("Already fine."), "Already fine.");
        assert_eq!(humanize(""), "The database reported an unknown error.");
    }
}

// ===========================================================================
// Live integration tests (gated behind BYTETABLE_TEST_PG_URL)
// ===========================================================================
//
// These exercise the adapter against a REAL PostgreSQL server. They are gated
// behind the `BYTETABLE_TEST_PG_URL` env var so the default `cargo test` (and
// CI without a server) stays green: each test early-returns with an
// `eprintln!` skip notice when the var is unset.
//
// To run them (the M12 dev container):
//
//   BYTETABLE_TEST_PG_URL=postgres://postgres:bytetable@localhost:55432/bytetable \
//     cargo test --lib engines::postgres::integration -- --test-threads=1
//
// `--test-threads=1` is recommended: every test isolates itself in its own
// throwaway schema (`bt_it_<name>`) which it drops on entry, so they do not
// collide, but serial execution keeps the live-server output readable.
#[cfg(test)]
mod integration {
    use super::*;
    use crate::shared::engine::{
        Combinator, Condition, FilterOp, FilterSpec, FilterValue, RowLookupRequest, SortDirection,
        SortSpec,
    };

    /// Parse `postgres://user:password@host:port/db` into params + the transient
    /// secret. Minimal — handles the shape the M12 test container emits.
    fn parse_url(url: &str) -> (ConnectionParams, Option<ConnectSecret>) {
        let rest = url
            .strip_prefix("postgres://")
            .or_else(|| url.strip_prefix("postgresql://"))
            .expect("url scheme");
        let (creds_host, db) = rest.split_once('/').expect("db path");
        let (creds, host_port) = creds_host.split_once('@').expect("@ separator");
        let (user, password) = match creds.split_once(':') {
            Some((u, p)) => (u.to_string(), Some(p.to_string())),
            None => (creds.to_string(), None),
        };
        let (host, port) = match host_port.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().unwrap_or(5432)),
            None => (host_port.to_string(), 5432),
        };
        let params = ConnectionParams::Postgres {
            host,
            port,
            database: Some(db.to_string()),
            user: Some(user),
            tls_mode: crate::shared::engine::TlsMode::Disable,
            ssh: None,
        };
        (params, password.map(ConnectSecret::new))
    }

    /// The gate: `Some((params, secret))` when the env var is set, else `None`
    /// after printing a skip notice.
    fn gate(test: &str) -> Option<(ConnectionParams, Option<ConnectSecret>)> {
        match std::env::var("BYTETABLE_TEST_PG_URL") {
            Ok(url) if !url.is_empty() => Some(parse_url(&url)),
            _ => {
                eprintln!("SKIP {test}: BYTETABLE_TEST_PG_URL not set (live Postgres required)");
                None
            }
        }
    }

    /// Open a pool connection for fixture setup/teardown (raw sqlx), separate
    /// from the adapter under test.
    async fn raw_pool(params: &ConnectionParams, secret: &Option<ConnectSecret>) -> PgPool {
        let options =
            sql::connect_options(params, db_password(secret.as_ref()), None, None).unwrap();
        PgPoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .expect("connect raw pool")
    }

    async fn open_conn(
        params: &ConnectionParams,
        secret: &Option<ConnectSecret>,
    ) -> std::sync::Arc<dyn EngineConnection> {
        PostgresConnector
            .open_with_secret(params, secret.as_ref())
            .await
            .expect("open postgres connection")
            .into_sql()
            .expect("sql connection")
    }

    /// Create a throwaway schema with a rich fixture: pk/fk/indexes, bool,
    /// numeric, int8, text, null columns, plus a second schema. Drops first so
    /// reruns are clean.
    async fn setup_fixture(pool: &PgPool, schema: &str, other: &str) {
        for stmt in [
            format!("DROP SCHEMA IF EXISTS {schema} CASCADE"),
            format!("DROP SCHEMA IF EXISTS {other} CASCADE"),
            format!("CREATE SCHEMA {schema}"),
            format!("CREATE SCHEMA {other}"),
            format!(
                "CREATE TABLE {schema}.authors (\
                   id bigint PRIMARY KEY, name text NOT NULL, bio text)"
            ),
            format!("COMMENT ON TABLE {schema}.authors IS 'people who write'"),
            format!(
                "CREATE TABLE {schema}.books (\
                   id int PRIMARY KEY, \
                   title text NOT NULL, \
                   author_id bigint NOT NULL REFERENCES {schema}.authors(id) ON DELETE CASCADE, \
                   price numeric(10,2) DEFAULT 0.0, \
                   in_print boolean DEFAULT true, \
                   big bigint, \
                   note text)"
            ),
            format!("CREATE INDEX idx_books_title ON {schema}.books(title)"),
            format!(
                "CREATE UNIQUE INDEX idx_books_author_title ON {schema}.books(author_id, title)"
            ),
            // A table in the OTHER schema (multi-schema check).
            format!("CREATE TABLE {other}.tags (id int PRIMARY KEY, label text)"),
            // Seed data: authors.
            format!(
                "INSERT INTO {schema}.authors (id, name, bio) VALUES \
                   (1, 'Ada', 'pioneer'), (2, 'Grace', NULL), (3, 'Linus', 'kernel')"
            ),
            // Seed data: books — bool true/false, numeric, big int8 (> 2^53),
            // a NULL note.
            format!(
                "INSERT INTO {schema}.books (id, title, author_id, price, in_print, big, note) VALUES \
                   (10, 'Notes', 1, 9.50, true, 9007199254740993, 'first'), \
                   (11, 'Essays', 1, 7.25, false, 1, NULL), \
                   (12, 'Letters', 2, 0.00, true, 2, 'third'), \
                   (13, 'Memoir', 3, 12.00, true, 3, 'fourth')"
            ),
        ] {
            sqlx::query(&stmt)
                .execute(pool)
                .await
                .unwrap_or_else(|e| panic!("fixture stmt failed: {stmt}\n{e}"));
        }
    }

    async fn drop_fixture(pool: &PgPool, schema: &str, other: &str) {
        let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
            .execute(pool)
            .await;
        let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {other} CASCADE"))
            .execute(pool)
            .await;
    }

    #[tokio::test]
    async fn connect_and_server_version() {
        let Some((params, secret)) = gate("connect_and_server_version") else {
            return;
        };
        let info = PostgresConnector
            .test_with_secret(&params, secret.as_ref())
            .await
            .expect("test connection");
        assert_eq!(info.engine, Engine::Postgres);
        assert!(
            info.server_version.starts_with("PostgreSQL "),
            "got {:?}",
            info.server_version
        );
        // A wrong password is a §5 database error, not a panic.
        let bad = PostgresConnector
            .test_with_secret(&params, Some(&ConnectSecret::new("definitely-wrong")))
            .await;
        assert!(matches!(bad, Err(AppError::Database(_))));
    }

    #[tokio::test]
    async fn schemas_tables_and_counts() {
        let Some((params, secret)) = gate("schemas_tables_and_counts") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_lists", "bt_it_lists_other");
        setup_fixture(&pool, schema, other).await;
        // ANALYZE so reltuples is populated (else -1 → None).
        let _ = sqlx::query(&format!("ANALYZE {schema}.books"))
            .execute(&pool)
            .await;

        let conn = open_conn(&params, &secret).await;

        let schemas = conn.list_schemas().await.expect("list schemas");
        let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&schema), "user schema present: {names:?}");
        assert!(names.contains(&other), "second schema present");
        assert!(names.contains(&"public"), "public present");
        // System schemas excluded.
        assert!(!names.iter().any(|n| n.starts_with("pg_")));
        assert!(!names.contains(&"information_schema"));

        let tables = conn.list_tables(schema).await.expect("list tables");
        let tnames: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(tnames, vec!["authors", "books"]);
        // The count is an estimate; after ANALYZE it should be Some(4) for books.
        let books = tables.iter().find(|t| t.name == "books").unwrap();
        assert_eq!(books.approx_row_count, Some(4));

        // Unknown schema → §5.
        let err = conn.list_tables("no_such_schema").await.unwrap_err();
        assert!(err.to_string().contains("does not exist"));

        conn.close().await.expect("close");
        drop_fixture(&pool, schema, other).await;
    }

    #[tokio::test]
    async fn run_query_maps_types() {
        let Some((params, secret)) = gate("run_query_maps_types") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_query", "bt_it_query_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        let result = conn
            .run_query(
                &format!("SELECT in_print, big, note, price FROM {schema}.books ORDER BY id"),
                QueryOptions::default(),
            )
            .await
            .expect("run query");
        // bool → JSON true/false.
        assert_eq!(result.rows[0][0], serde_json::json!(true));
        assert_eq!(result.rows[1][0], serde_json::json!(false));
        // int8 beyond 2^53 → string (precision preserved).
        assert_eq!(result.rows[0][1], serde_json::json!("9007199254740993"));
        assert_eq!(result.rows[1][1], serde_json::json!(1));
        // NULL → null.
        assert_eq!(result.rows[1][2], serde_json::Value::Null);
        // numeric → number when it normalizes to a lossless, JS-safe value
        // (numeric(10,2) value 9.50 normalizes to 9.5). High-precision numerics
        // beyond f64 stay exact strings (CellValue precision contract); see
        // `numeric_text_to_json_preserves_precision`.
        assert_eq!(result.rows[0][3], serde_json::json!(9.5));

        conn.close().await.expect("close");
        drop_fixture(&pool, schema, other).await;
    }

    #[tokio::test]
    async fn fetch_rows_paging_sort_filter_and_total() {
        let Some((params, secret)) = gate("fetch_rows_paging_sort_filter_and_total") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_fetch", "bt_it_fetch_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        // Sorted page, no filter → total 4.
        let page = conn
            .fetch_rows(FetchRowsRequest {
                schema: schema.into(),
                table: "books".into(),
                sort: Some(SortSpec {
                    column: "id".into(),
                    direction: SortDirection::Asc,
                }),
                filter: None,
                offset: 1,
                limit: 2,
            })
            .await
            .expect("fetch rows");
        assert_eq!(page.total_rows, Some(4));
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.offset, 1);

        // Filtered: in_print = true → 3 rows; bound boolean value.
        let filtered = conn
            .fetch_rows(FetchRowsRequest {
                schema: schema.into(),
                table: "books".into(),
                sort: None,
                filter: Some(FilterSpec::Conditions {
                    items: vec![Condition {
                        column: "in_print".into(),
                        op: FilterOp::Eq,
                        value: Some(FilterValue::Scalar(serde_json::json!(true))),
                        binary: false,
                    }],
                    combinator: Combinator::And,
                }),
                offset: 0,
                limit: 100,
            })
            .await
            .expect("filtered fetch");
        assert_eq!(filtered.total_rows, Some(3));

        // Each remaining operator compiles + runs without error.
        let ops: Vec<(FilterOp, FilterValue)> = vec![
            (FilterOp::Ne, FilterValue::Scalar(serde_json::json!(10))),
            (FilterOp::Gt, FilterValue::Scalar(serde_json::json!(10))),
            (FilterOp::Gte, FilterValue::Scalar(serde_json::json!(10))),
            (FilterOp::Lt, FilterValue::Scalar(serde_json::json!(13))),
            (FilterOp::Lte, FilterValue::Scalar(serde_json::json!(13))),
            (
                FilterOp::InList,
                FilterValue::List(vec![serde_json::json!(10), serde_json::json!(11)]),
            ),
        ];
        for (op, value) in ops {
            let r = conn
                .fetch_rows(FetchRowsRequest {
                    schema: schema.into(),
                    table: "books".into(),
                    sort: None,
                    filter: Some(FilterSpec::Conditions {
                        items: vec![Condition {
                            column: "id".into(),
                            op,
                            value: Some(value),
                            binary: false,
                        }],
                        combinator: Combinator::And,
                    }),
                    offset: 0,
                    limit: 100,
                })
                .await
                .unwrap_or_else(|e| panic!("op {op:?} failed: {e}"));
            assert!(r.total_rows.is_some(), "op {op:?}");
        }

        // LIKE family on a text column.
        let like = conn
            .fetch_rows(FetchRowsRequest {
                schema: schema.into(),
                table: "books".into(),
                sort: None,
                filter: Some(FilterSpec::Conditions {
                    items: vec![Condition {
                        column: "title".into(),
                        op: FilterOp::Contains,
                        value: Some(FilterValue::Scalar(serde_json::json!("ette"))),
                        binary: false,
                    }],
                    combinator: Combinator::And,
                }),
                offset: 0,
                limit: 100,
            })
            .await
            .expect("contains");
        assert_eq!(like.total_rows, Some(1)); // "Letters"

        // Injection inertness: a payload binds as a literal → matches nothing.
        let inj = conn
            .fetch_rows(FetchRowsRequest {
                schema: schema.into(),
                table: "books".into(),
                sort: None,
                filter: Some(FilterSpec::Conditions {
                    items: vec![Condition {
                        column: "title".into(),
                        op: FilterOp::Eq,
                        value: Some(FilterValue::Scalar(serde_json::json!(
                            "'; DROP TABLE books; --"
                        ))),
                        binary: false,
                    }],
                    combinator: Combinator::And,
                }),
                offset: 0,
                limit: 100,
            })
            .await
            .expect("injection bound");
        assert_eq!(inj.total_rows, Some(0));
        // The table still exists (the payload did not execute).
        assert_eq!(
            conn.list_tables(schema).await.unwrap().len(),
            2,
            "books table survived the injection attempt"
        );

        conn.close().await.expect("close");
        drop_fixture(&pool, schema, other).await;
    }

    #[tokio::test]
    async fn table_meta_full_surface() {
        let Some((params, secret)) = gate("table_meta_full_surface") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_meta", "bt_it_meta_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        let meta = conn.table_meta(schema, "books").await.expect("meta");
        // Columns, types, nullability, defaults.
        let by_name = |n: &str| meta.columns.iter().find(|c| c.name == n).unwrap();
        assert!(by_name("id").pk);
        assert!(!by_name("title").nullable);
        assert!(by_name("note").nullable);
        assert_eq!(by_name("in_print").data_type, "boolean");
        assert!(by_name("price").default_value.is_some());
        // fk on author_id.
        let author_fk = by_name("author_id").fk.as_ref().expect("fk");
        assert_eq!(author_fk.table, "authors");
        assert_eq!(author_fk.column, "id");
        // Table-level foreign keys.
        assert_eq!(meta.foreign_keys.len(), 1);
        assert_eq!(meta.foreign_keys[0].ref_table, "authors");
        assert_eq!(meta.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
        // Indexes incl. the primary-key index.
        assert!(meta.indexes.iter().any(|i| i.primary));
        assert!(meta
            .indexes
            .iter()
            .any(|i| i.name == "idx_books_author_title" && i.unique && i.columns.len() == 2));
        // referenced_by on authors: books references it.
        let authors_meta = conn
            .table_meta(schema, "authors")
            .await
            .expect("authors meta");
        assert_eq!(authors_meta.comment.as_deref(), Some("people who write"));
        assert!(authors_meta
            .referenced_by
            .iter()
            .any(|r| r.table == "books" && r.columns == vec!["author_id".to_string()]));
        // DDL is a valid-ish CREATE TABLE.
        let ddl = meta.ddl.as_ref().expect("ddl");
        assert!(ddl.contains("CREATE TABLE"));
        assert!(ddl.contains("PRIMARY KEY (\"id\")"));
        assert!(ddl.contains("FOREIGN KEY"));

        // Unknown table → §5.
        let err = conn.table_meta(schema, "ghost").await.unwrap_err();
        assert!(err.to_string().contains("does not exist"));

        conn.close().await.expect("close");
        drop_fixture(&pool, schema, other).await;
    }

    #[tokio::test]
    async fn fetch_row_by_key_and_column_stats() {
        let Some((params, secret)) = gate("fetch_row_by_key_and_column_stats") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_peek", "bt_it_peek_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        let hit = conn
            .fetch_row_by_key(RowLookupRequest {
                schema: schema.into(),
                table: "authors".into(),
                column: "id".into(),
                value: serde_json::json!(1),
                binary: false,
            })
            .await
            .expect("lookup");
        assert_eq!(hit.match_count, 1);
        assert!(hit.row.is_some());

        let miss = conn
            .fetch_row_by_key(RowLookupRequest {
                schema: schema.into(),
                table: "authors".into(),
                column: "id".into(),
                value: serde_json::json!(999),
                binary: false,
            })
            .await
            .expect("lookup miss");
        assert_eq!(miss.match_count, 0);
        assert!(miss.row.is_none());
        assert!(!miss.columns.is_empty(), "columns returned even on a miss");

        // Column stats: numeric column with avg, distinct, top.
        let stats = conn
            .column_stats(ColumnStatsRequest {
                schema: schema.into(),
                table: "books".into(),
                column: "price".into(),
                filter: None,
            })
            .await
            .expect("stats");
        assert_eq!(stats.total, 4);
        assert!(stats.numeric);
        assert!(stats.avg.is_some());
        assert!(stats.min.is_some() && stats.max.is_some());

        // Filtered stats: only in_print = true rows.
        let filtered = conn
            .column_stats(ColumnStatsRequest {
                schema: schema.into(),
                table: "books".into(),
                column: "price".into(),
                filter: Some(FilterSpec::Conditions {
                    items: vec![Condition {
                        column: "in_print".into(),
                        op: FilterOp::Eq,
                        value: Some(FilterValue::Scalar(serde_json::json!(true))),
                        binary: false,
                    }],
                    combinator: Combinator::And,
                }),
            })
            .await
            .expect("filtered stats");
        assert_eq!(filtered.total, 3);

        conn.close().await.expect("close");
        drop_fixture(&pool, schema, other).await;
    }

    #[tokio::test]
    async fn update_cell_persists_and_is_pk_gated() {
        let Some((params, secret)) = gate("update_cell_persists_and_is_pk_gated") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_update", "bt_it_update_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        // Successful update of a non-pk column, targeted by full pk.
        let result = conn
            .update_cell(UpdateCellRequest {
                schema: schema.into(),
                table: "books".into(),
                column: "note".into(),
                value: serde_json::json!("updated"),
                pk: vec![PkPredicate {
                    column: "id".into(),
                    value: serde_json::json!(10),
                    binary: false,
                }],
                binary: false,
            })
            .await
            .expect("update");
        assert_eq!(result.affected, 1);
        // Verify it persisted.
        let check: String =
            sqlx::query_scalar(&format!("SELECT note FROM {schema}.books WHERE id = 10"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(check, "updated");

        // pk-gating: missing pk is rejected.
        let no_pk = conn
            .update_cell(UpdateCellRequest {
                schema: schema.into(),
                table: "books".into(),
                column: "note".into(),
                value: serde_json::json!("x"),
                pk: vec![],
                binary: false,
            })
            .await;
        assert!(matches!(no_pk, Err(AppError::Database(_))));

        // Stale pk → no row matched, nothing changes.
        let stale = conn
            .update_cell(UpdateCellRequest {
                schema: schema.into(),
                table: "books".into(),
                column: "note".into(),
                value: serde_json::json!("x"),
                pk: vec![PkPredicate {
                    column: "id".into(),
                    value: serde_json::json!(99999),
                    binary: false,
                }],
                binary: false,
            })
            .await;
        assert!(matches!(stale, Err(AppError::Database(_))));

        // Constraint failure rolls back (NOT NULL on title).
        let rollback = conn
            .update_cell(UpdateCellRequest {
                schema: schema.into(),
                table: "books".into(),
                column: "title".into(),
                value: serde_json::Value::Null,
                pk: vec![PkPredicate {
                    column: "id".into(),
                    value: serde_json::json!(10),
                    binary: false,
                }],
                binary: false,
            })
            .await;
        assert!(matches!(rollback, Err(AppError::Database(_))));
        // Title unchanged after the rolled-back NOT NULL violation.
        let title: String =
            sqlx::query_scalar(&format!("SELECT title FROM {schema}.books WHERE id = 10"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "Notes");

        conn.close().await.expect("close");
        drop_fixture(&pool, schema, other).await;
    }

    #[tokio::test]
    async fn alter_table_native_ops_preserve_data() {
        let Some((params, secret)) = gate("alter_table_native_ops_preserve_data") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_alter", "bt_it_alter_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        // Preview does not mutate.
        let preview = conn
            .alter_table(
                schema,
                "books",
                &[AlterOp::AddColumn {
                    name: "rating".into(),
                    data_type: "integer".into(),
                    nullable: true,
                    default_value: Some("5".into()),
                }],
                false,
            )
            .await
            .expect("preview");
        assert!(!preview.applied);
        assert_eq!(preview.statements.len(), 1);
        assert!(preview.statements[0].contains("ADD COLUMN"));

        // A batch that references a non-existent column is rejected before any
        // statement runs (validation matches the SQLite adapter: each op's
        // target is checked against the original column set). Confirm it rolls
        // back cleanly — no partial 'rating' column afterwards.
        let bad = vec![
            AlterOp::AddColumn {
                name: "rating".into(),
                data_type: "integer".into(),
                nullable: true,
                default_value: Some("5".into()),
            },
            AlterOp::DropColumn {
                name: "bio_legacy".into(),
            },
        ];
        let bad_result = conn.alter_table(schema, "books", &bad, true).await;
        assert!(matches!(bad_result, Err(AppError::Database(_))));
        let meta = conn.table_meta(schema, "books").await.unwrap();
        assert!(
            !meta.columns.iter().any(|c| c.name == "rating"),
            "failed batch rolled back: no partial 'rating' column"
        );

        // A valid batch — add, rename, retype, set-nullable, set-default — each
        // targeting an original column. All apply in one transaction and
        // preserve data.
        let good = vec![
            AlterOp::AddColumn {
                name: "rating".into(),
                data_type: "integer".into(),
                nullable: false,
                default_value: Some("5".into()),
            },
            AlterOp::RenameColumn {
                from: "note".into(),
                to: "remark".into(),
            },
            AlterOp::ChangeType {
                column: "price".into(),
                new_type: "numeric(12,3)".into(),
            },
            AlterOp::SetNullable {
                column: "title".into(),
                nullable: true,
            },
            AlterOp::SetDefault {
                column: "big".into(),
                default_value: Some("0".into()),
            },
        ];
        let applied = conn
            .alter_table(schema, "books", &good, true)
            .await
            .expect("apply");
        assert!(applied.applied);
        // Re-introspect: changes landed, row count preserved.
        let meta = conn.table_meta(schema, "books").await.unwrap();
        let names: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"rating"));
        assert!(names.contains(&"remark"));
        assert!(!names.contains(&"note"));
        assert!(!meta.columns.iter().find(|c| c.name == "rating").unwrap().pk);
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {schema}.books"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 4, "data preserved across native ALTERs");

        // pk-protection: dropping the pk column is rejected.
        let drop_pk = conn
            .alter_table(
                schema,
                "books",
                &[AlterOp::DropColumn { name: "id".into() }],
                true,
            )
            .await;
        assert!(matches!(drop_pk, Err(AppError::Database(_))));

        conn.close().await.expect("close");
        drop_fixture(&pool, schema, other).await;
    }

    // -- SSH tunnel (M12 Task 3) ---------------------------------------------
    //
    // Gated behind `BYTETABLE_TEST_SSH=1`. Connects the Postgres adapter to
    // `bt-pg:5432` THROUGH the live bastion at localhost:2222 (user `tunnel`),
    // using both private-key auth (`/tmp/bt_ssh_key`, overridable via
    // `BYTETABLE_TEST_SSH_KEY`) and password auth ("bytetable"), then runs a
    // real query. Also asserts a bad key path / password is a clean §5 error.
    //
    // Run: `BYTETABLE_TEST_SSH=1 cargo test --lib
    //   engines::postgres::integration::ssh -- --test-threads=1`

    /// `(bastion_host, bastion_port, user, target_host, target_port, db, db_user,
    /// db_password, key_path, ssh_password)` for the SSH test, or `None` (skip).
    #[allow(clippy::type_complexity)]
    fn ssh_gate(
        test: &str,
    ) -> Option<(
        String,
        u16,
        String,
        String,
        u16,
        String,
        String,
        String,
        String,
        String,
    )> {
        if std::env::var("BYTETABLE_TEST_SSH").as_deref() != Ok("1") {
            eprintln!("SKIP {test}: BYTETABLE_TEST_SSH=1 not set (live bastion required)");
            return None;
        }
        let key_path =
            std::env::var("BYTETABLE_TEST_SSH_KEY").unwrap_or_else(|_| "/tmp/bt_ssh_key".into());
        Some((
            std::env::var("BYTETABLE_TEST_SSH_HOST").unwrap_or_else(|_| "localhost".into()),
            std::env::var("BYTETABLE_TEST_SSH_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(2222),
            std::env::var("BYTETABLE_TEST_SSH_USER").unwrap_or_else(|_| "tunnel".into()),
            std::env::var("BYTETABLE_TEST_SSH_TARGET_HOST").unwrap_or_else(|_| "bt-pg".into()),
            5432,
            "bytetable".into(),
            "postgres".into(),
            "bytetable".into(),
            key_path,
            "bytetable".into(),
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn tunnelled_params(
        bastion_host: &str,
        bastion_port: u16,
        user: &str,
        target_host: &str,
        target_port: u16,
        db: &str,
        db_user: &str,
        auth: crate::shared::engine::SshAuth,
    ) -> ConnectionParams {
        ConnectionParams::Postgres {
            host: target_host.to_string(),
            port: target_port,
            database: Some(db.to_string()),
            user: Some(db_user.to_string()),
            tls_mode: crate::shared::engine::TlsMode::Disable,
            ssh: Some(crate::shared::engine::SshConfig {
                host: bastion_host.to_string(),
                port: bastion_port,
                user: user.to_string(),
                auth,
            }),
        }
    }

    // ---- M15: truncate + export against live Postgres ----

    #[tokio::test]
    async fn truncate_empties_table_and_reports_prior_count() {
        let Some((params, secret)) = gate("truncate_empties_table_and_reports_prior_count") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_truncate", "bt_it_truncate_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        // books has 4 seeded rows.
        let affected = conn
            .truncate_table(schema, "books")
            .await
            .expect("truncate books");
        assert_eq!(affected, 4);
        let after: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {schema}.books"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after, 0);

        // Truncating an already-empty table reports 0.
        let again = conn
            .truncate_table(schema, "books")
            .await
            .expect("re-truncate");
        assert_eq!(again, 0);

        // Unknown table is a §5 error.
        let err = conn.truncate_table(schema, "ghost").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));

        drop_fixture(&pool, schema, other).await;
    }

    /// drop_schema empties a THROWAWAY schema (never `public`/`byteshop`):
    /// the schema still exists afterward but holds 0 tables, and the seeded
    /// rows are gone. A nonexistent schema is a §5 error.
    #[tokio::test]
    async fn drop_schema_empties_throwaway_schema_and_leaves_it() {
        let Some((params, secret)) = gate("drop_schema_empties_throwaway_schema_and_leaves_it")
        else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_dropschema", "bt_it_dropschema_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        // Sanity: the fixture seeded tables in the throwaway schema.
        let before: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = $1",
        )
        .bind(schema)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(before >= 2, "fixture should seed tables, got {before}");

        conn.drop_schema(schema).await.expect("drop schema");

        // The schema still exists…
        let schema_exists: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM pg_namespace WHERE nspname = $1")
                .bind(schema)
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(schema_exists.is_some(), "schema must be recreated empty");

        // …but it is empty.
        let after: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = $1",
        )
        .bind(schema)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0, "dropped schema must hold 0 tables");

        // The OTHER throwaway schema is untouched.
        let other_tables: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = $1",
        )
        .bind(other)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(other_tables, 1, "drop must not touch other schemas");

        // A nonexistent schema is a §5 error (plain DROP, no IF EXISTS).
        let err = conn.drop_schema("bt_it_nope_xyz").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));

        drop_fixture(&pool, schema, other).await;
    }

    #[tokio::test]
    async fn export_csv_and_sql_against_live_postgres() {
        use crate::features::connections::application::ConnectionManager;
        use crate::features::export::application::{export_schema_sql, export_table};
        use crate::features::export::domain::{ExportFormat, ExportScope};

        let Some((params, secret)) = gate("export_csv_and_sql_against_live_postgres") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_export", "bt_it_export_other");
        setup_fixture(&pool, schema, other).await;

        let open = PostgresConnector
            .open_with_secret(&params, secret.as_ref())
            .await
            .expect("open");
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;

        // CSV: header + every authors row (3), NULL bio → empty field.
        let csv = export_table(
            &manager,
            &handle,
            schema,
            "authors",
            ExportFormat::Csv,
            ExportScope::Both,
            &|_: u64, _: u64| {},
        )
        .await
        .expect("export csv");
        assert_eq!(csv.lines().next().unwrap(), "id,name,bio");
        assert_eq!(csv.lines().count(), 4);
        assert!(csv.contains("2,Grace,")); // null bio → trailing empty field

        // SQL: DDL + one INSERT per row, backtick-free double-quoted idents.
        let sql = export_table(
            &manager,
            &handle,
            schema,
            "books",
            ExportFormat::Sql,
            ExportScope::Both,
            &|_: u64, _: u64| {},
        )
        .await
        .expect("export sql");
        assert!(sql.contains(&format!("INSERT INTO \"{schema}\".\"books\"")));
        assert_eq!(sql.matches("INSERT INTO").count(), 4);
        assert!(sql.contains("NULL")); // the null note book

        // Schema dump touches both base tables.
        let dump = export_schema_sql(
            &manager,
            &handle,
            schema,
            ExportScope::Both,
            &|_: u64, _: u64| {},
        )
        .await
        .expect("export schema");
        assert!(dump.contains("-- ByteTable schema dump"));
        assert!(dump.contains("authors"));
        assert!(dump.contains("books"));

        // Empty table after a truncate exports the no-rows marker.
        conn_truncate(&manager, &handle, schema, "books").await;
        let empty_sql = export_table(
            &manager,
            &handle,
            schema,
            "books",
            ExportFormat::Sql,
            ExportScope::Both,
            &|_: u64, _: u64| {},
        )
        .await
        .expect("export empty");
        assert!(empty_sql.contains("-- (no rows)"));

        drop_fixture(&pool, schema, other).await;
    }

    #[tokio::test]
    async fn import_round_trip_multi_statement_and_error_rollback_against_live_postgres() {
        use crate::features::connections::application::ConnectionManager;
        use crate::features::export::application::{export_table, import_sql};
        use crate::features::export::domain::{ExportFormat, ExportScope};

        let Some((params, secret)) =
            gate("import_round_trip_multi_statement_and_error_rollback_against_live_postgres")
        else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_import", "bt_it_import_other");
        setup_fixture(&pool, schema, other).await;
        // A fresh, empty target schema for the round-trip + hand-written imports.
        let fresh = "bt_it_import_fresh";
        let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {fresh} CASCADE"))
            .execute(&pool)
            .await;
        sqlx::query(&format!("CREATE SCHEMA {fresh}"))
            .execute(&pool)
            .await
            .expect("create fresh schema");

        let open = PostgresConnector
            .open_with_secret(&params, secret.as_ref())
            .await
            .expect("open");
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;
        let dir = tempfile::tempdir().expect("tempdir");

        // --- ROUND-TRIP: export authors (qualified dump) → rewrite it to target
        // the FRESH schema → import → verify the table + 3 rows landed there.
        let dump = export_table(
            &manager,
            &handle,
            schema,
            "authors",
            ExportFormat::Sql,
            ExportScope::Both,
            &|_: u64, _: u64| {},
        )
        .await
        .expect("export sql");
        let retargeted = dump.replace(
            &format!("\"{schema}\".\"authors\""),
            &format!("\"{fresh}\".\"authors\""),
        );
        let rt_path = dir.path().join("authors.sql");
        std::fs::write(&rt_path, &retargeted).expect("write dump");
        let result = import_sql(
            &manager,
            &handle,
            fresh,
            &rt_path.to_string_lossy(),
            &|_: u64, _: u64| {},
        )
        .await
        .expect("import round-trip");
        // DDL + 3 INSERTs.
        assert_eq!(result.statements, 4);
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {fresh}.authors"))
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(n, 3, "all rows round-tripped into the fresh schema");

        // --- MULTI-STATEMENT: a hand-written CREATE + 2 INSERTs (unqualified, so
        // search_path lands them in the target schema).
        let script = "CREATE TABLE gadgets (id INT PRIMARY KEY, label TEXT);\n\
                      INSERT INTO gadgets (id, label) VALUES (1, 'one');\n\
                      INSERT INTO gadgets (id, label) VALUES (2, 'two');\n";
        let ms_path = dir.path().join("gadgets.sql");
        std::fs::write(&ms_path, script).expect("write script");
        let result = import_sql(
            &manager,
            &handle,
            fresh,
            &ms_path.to_string_lossy(),
            &|_: u64, _: u64| {},
        )
        .await
        .expect("import multi-statement");
        assert_eq!(result.statements, 3);
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {fresh}.gadgets"))
            .fetch_one(&pool)
            .await
            .expect("count gadgets");
        assert_eq!(n, 2);

        // --- ERROR ROLLBACK: statement 1 creates a table, statement 2 fails →
        // Postgres has transactional DDL, so the whole import rolls back and the
        // table from statement 1 is NOT created.
        let bad = "CREATE TABLE rollback_me (id INT);\n\
                   INSERT INTO no_such_table (id) VALUES (1);\n";
        let bad_path = dir.path().join("bad.sql");
        std::fs::write(&bad_path, bad).expect("write bad");
        let err = import_sql(
            &manager,
            &handle,
            fresh,
            &bad_path.to_string_lossy(),
            &|_: u64, _: u64| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)), "got {err:?}");
        let exists: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = 'rollback_me'",
        )
        .bind(fresh)
        .fetch_optional(&pool)
        .await
        .expect("existence");
        assert!(exists.is_none(), "statement 1 must have rolled back");

        // --- BAD PATH: a missing file is a §5 IO error naming the path.
        let err = import_sql(
            &manager,
            &handle,
            fresh,
            "/tmp/bytetable-nonexistent.sql",
            &|_: u64, _: u64| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Io(_)), "got {err:?}");
        assert!(err.to_string().contains("Could not read"));

        // --- EXECUTE_SCRIPT_TEXT: run generated SQL directly (no temp file),
        // the way ImportModal applies CSV-derived INSERTs.
        {
            use crate::features::export::application::execute_script_text;
            let text = "CREATE TABLE from_text (id INT PRIMARY KEY, label TEXT);\n\
                        INSERT INTO from_text (id, label) VALUES (1, 'O''Brien');\n";
            let result = execute_script_text(&manager, &handle, fresh, text, &|_: u64, _: u64| {})
                .await
                .expect("execute_script_text");
            assert_eq!(result.statements, 2);
            let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {fresh}.from_text"))
                .fetch_one(&pool)
                .await
                .expect("count from_text");
            assert_eq!(n, 1);
        }

        let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {fresh} CASCADE"))
            .execute(&pool)
            .await;
        drop_fixture(&pool, schema, other).await;
    }

    /// Truncate via the open connection (helper to keep the export test tidy).
    async fn conn_truncate(
        manager: &crate::features::connections::application::ConnectionManager,
        handle: &crate::features::connections::application::ConnectionHandleId,
        schema: &str,
        table: &str,
    ) {
        manager
            .get_sql(handle)
            .await
            .expect("handle")
            .truncate_table(schema, table)
            .await
            .expect("truncate");
    }

    #[tokio::test]
    async fn ssh_tunnel_key_auth_connects_and_queries() {
        let Some((bh, bp, user, th, tp, db, du, dpw, key, _sshpw)) =
            ssh_gate("ssh_tunnel_key_auth_connects_and_queries")
        else {
            return;
        };
        let params = tunnelled_params(
            &bh,
            bp,
            &user,
            &th,
            tp,
            &db,
            &du,
            crate::shared::engine::SshAuth::Key { key_path: key },
        );
        // No SSH passphrase on the test key; db password is the only secret.
        let secret = ConnectSecret::new(dpw);

        // test_with_secret opens the tunnel, connects, reads the version, drops.
        let info = PostgresConnector
            .test_with_secret(&params, Some(&secret))
            .await
            .expect("tunnelled test connection (key auth)");
        assert!(info.server_version.starts_with("PostgreSQL "));

        // open_with_secret keeps the tunnel alive on the connection; query it.
        let conn = PostgresConnector
            .open_with_secret(&params, Some(&secret))
            .await
            .expect("tunnelled open (key auth)")
            .into_sql()
            .expect("sql connection");
        let result = conn
            .run_query("SELECT 1 AS one", QueryOptions::default())
            .await
            .expect("query through tunnel");
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!(1));
        // list_schemas works through the tunnel too.
        let schemas = conn.list_schemas().await.expect("schemas through tunnel");
        assert!(schemas.iter().any(|s| s.name == "public"));
        conn.close().await.expect("close tunnelled conn");
    }

    #[tokio::test]
    async fn ssh_tunnel_password_auth_connects() {
        let Some((bh, bp, user, th, tp, db, du, dpw, _key, sshpw)) =
            ssh_gate("ssh_tunnel_password_auth_connects")
        else {
            return;
        };
        let params = tunnelled_params(
            &bh,
            bp,
            &user,
            &th,
            tp,
            &db,
            &du,
            crate::shared::engine::SshAuth::Password,
        );
        // Both secrets: the bastion password (ssh) and the db password.
        let secret = ConnectSecret::with_ssh(Some(dpw), Some(sshpw));
        let info = PostgresConnector
            .test_with_secret(&params, Some(&secret))
            .await
            .expect("tunnelled test connection (password auth)");
        assert!(info.server_version.starts_with("PostgreSQL "));
    }

    #[tokio::test]
    async fn ssh_tunnel_bad_auth_is_a_clean_error() {
        let Some((bh, bp, user, th, tp, db, du, dpw, _key, _sshpw)) =
            ssh_gate("ssh_tunnel_bad_auth_is_a_clean_error")
        else {
            return;
        };
        // Wrong SSH password → a §5 Database error from the tunnel, not a panic.
        let params = tunnelled_params(
            &bh,
            bp,
            &user,
            &th,
            tp,
            &db,
            &du,
            crate::shared::engine::SshAuth::Password,
        );
        let secret = ConnectSecret::with_ssh(Some(dpw), Some("definitely-wrong".into()));
        let err = PostgresConnector
            .test_with_secret(&params, Some(&secret))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)), "got {err:?}");
        assert!(err.to_string().contains("SSH authentication"), "got {err}");

        // A bad key PATH is also a clean §5 error (key auth, missing file).
        let bad_key = tunnelled_params(
            &bh,
            bp,
            &user,
            &th,
            tp,
            &db,
            &du,
            crate::shared::engine::SshAuth::Key {
                key_path: "/tmp/bytetable-nonexistent-key".into(),
            },
        );
        let err = PostgresConnector
            .test_with_secret(&bad_key, Some(&ConnectSecret::new("bytetable")))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)), "got {err:?}");
    }
}
