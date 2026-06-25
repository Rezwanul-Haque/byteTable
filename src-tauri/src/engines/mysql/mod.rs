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

mod objects;
mod sql;

use std::time::Instant;

use async_trait::async_trait;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::{Column, Row, TypeInfo};

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{
    split_statements, AlterResult, ColumnInfo, ColumnMeta, ColumnStats, ColumnStatsRequest,
    ConnectSecret, ConnectionParams, Connector, DbObjectDefinition, DbObjectInfo, DbObjectKind,
    DeleteRowsRequest, DeleteRowsResult, Engine, EngineConnection, EngineInfo, FetchRowsRequest,
    FkRef, ForeignKeyInfo, FreqEntry, ImportResult, InboundFkInfo, IndexInfo, OpenConnection,
    PkPredicate, QueryOptions, QueryResult, RowLookup, RowLookupRequest, RowsPage, SchemaInfo,
    TableInfo, TableMeta, UpdateCellRequest, UpdateResult,
};
use crate::shared::error::AppError;

use crate::engines::ssh::{db_password, open_tunnel_if_needed, tunnel_override};

use sql::{
    is_numeric_type, order_by_clause, qualified, quote_ident, validate_column, where_clause,
    BoundValue, WhereClause, JS_MAX_SAFE_INTEGER,
};

/// Page-size ceiling for `fetch_rows` (mirrors the SQLite/Postgres adapters and
/// the connections slice's `MAX_ROW_LIMIT`).
const MAX_PAGE_ROWS: u32 = 10_000;

/// Max connections in one ByteTable connection's pool. Small: a desktop client
/// drives a few short introspection/grid queries at a time.
const POOL_MAX_CONNECTIONS: u32 = 4;

/// The MySQL system databases excluded from `list_schemas` and the
/// available-schemas listing (they are server internals, not user data).
const SYSTEM_SCHEMAS: [&str; 4] = ["mysql", "information_schema", "performance_schema", "sys"];

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
        // User databases only (system DBs excluded), each with a cheap table
        // count from the catalog. `?`-bound exclusion list keeps it parameterized.
        // information_schema string columns are VARBINARY-flavoured in MySQL 8
        // and their labels come back UPPERCASE; CAST(... AS CHAR) makes them
        // decodable as String and the lowercase alias fixes the label.
        let placeholders = vec!["?"; SYSTEM_SCHEMAS.len()].join(", ");
        let listing_sql = format!(
            "SELECT CAST(s.schema_name AS CHAR) AS name, \
                (SELECT count(*) FROM information_schema.tables t \
                 WHERE t.table_schema = s.schema_name AND t.table_type = 'BASE TABLE') AS table_count \
             FROM information_schema.schemata s \
             WHERE s.schema_name NOT IN ({placeholders}) \
             ORDER BY s.schema_name"
        );
        let mut query = sqlx::query(&listing_sql);
        for sys in SYSTEM_SCHEMAS {
            query = query.bind(sys);
        }
        let rows = query.fetch_all(&self.pool).await.map_err(map_query_error)?;

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
        // Base tables in the database, with the storage engine's row ESTIMATE
        // (table_rows — approximate for InnoDB; module docs).
        let rows = sqlx::query(
            "SELECT CAST(table_name AS CHAR) AS name, table_rows AS est \
             FROM information_schema.tables \
             WHERE table_schema = ? AND table_type = 'BASE TABLE' \
             ORDER BY table_name",
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await
        .map_err(map_query_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let name: String = row.get("name");
                // table_rows is BIGINT UNSIGNED, decoded as u64; NULL for some
                // engines/views → None.
                let est: Option<u64> = row.try_get("est").unwrap_or(None);
                TableInfo {
                    name,
                    approx_row_count: est,
                }
            })
            .collect())
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
        let started = Instant::now();

        // One acquired connection so a `USE` and the query share a session.
        // A `USE` on the pool surface lands on a random pooled connection, so
        // the query — which may grab a DIFFERENT pooled connection — would not
        // see the selected database. With an empty default database (the
        // connection's database field is optional) an unqualified query then
        // fails with MySQL ERROR 1046 "No database selected". Pinning the
        // session is the same fix `execute_script` uses for imports.
        let mut conn = self.pool.acquire().await.map_err(map_query_error)?;

        // Apply the schema as the default database for unqualified names, when
        // given. Best effort: a bad schema simply leaves the current default.
        if let Some(schema) = &options.schema {
            use sqlx::Executor as _;
            let _ = conn
                .execute(format!("USE {}", quote_ident(schema)).as_str())
                .await;
        }

        // MySQL refuses some commands in the prepared-statement protocol
        // (error 1295) — notably CREATE/DROP FUNCTION/PROCEDURE/TRIGGER. On that
        // error, re-run via the unprepared TEXT protocol (`raw_sql`), which
        // accepts them; such DDL returns no result rows.
        let rows = match sqlx::query(sql).fetch_all(&mut *conn).await {
            Ok(rows) => rows,
            Err(err) if is_unpreparable(&err) => {
                use sqlx::Executor as _;
                conn.execute(sqlx::raw_sql(sql))
                    .await
                    .map_err(map_query_error)?;
                Vec::new()
            }
            Err(err) => return Err(map_query_error(err)),
        };

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

        // Page query: WHERE params first (in order), then LIMIT/OFFSET as the
        // trailing `?` binds.
        let mut page_sql = format!("SELECT * FROM {qualified}{where_sql}");
        if let Some(clause) = &order_by {
            page_sql.push_str(&format!(" ORDER BY {clause}"));
        }
        page_sql.push_str(" LIMIT ? OFFSET ?");

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

        let row_sql = format!("SELECT * FROM {qualified} WHERE {col} = ? LIMIT 1");
        let row = bind_value(sqlx::query(&row_sql), &bound)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_query_error)?
            .map(|r| decode_row(&r));

        let match_count = if row.is_none() {
            0
        } else {
            let count_sql = format!("SELECT count(*) AS n FROM {qualified} WHERE {col} = ?");
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

/// Append pre-generated rows to a table (M16 generate). All rows go in one
/// transaction; within it, rows are split into statements that stay under
/// MySQL's 65535 bind-parameter ceiling. Any error rolls the whole call back.
/// NULL JSON binds as SQL NULL (`BoundValue::from_json_set`).
async fn bulk_insert(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
    columns: &[String],
    binary: &[bool],
    rows: &[Vec<serde_json::Value>],
) -> Result<u64, AppError> {
    if rows.is_empty() || columns.is_empty() {
        return Ok(0);
    }
    let width = columns.len();
    let max_rows_per_stmt = (60_000 / width).max(1);
    let bind_one = |i: usize, v: &serde_json::Value| -> Result<BoundValue, AppError> {
        if binary.get(i).copied().unwrap_or(false) {
            BoundValue::from_binary_set(v)
        } else {
            Ok(BoundValue::from_json_set(v))
        }
    };

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    let mut affected = 0u64;
    for chunk in rows.chunks(max_rows_per_stmt) {
        let stmt = sql::build_multi_insert_sql(schema, table, columns, chunk.len());
        let bounds: Vec<BoundValue> = chunk
            .iter()
            .flat_map(|row| row.iter().enumerate().map(|(i, v)| bind_one(i, v)))
            .collect::<Result<Vec<_>, _>>()?;
        let mut query = sqlx::query(&stmt);
        for b in &bounds {
            query = bind_value(query, b);
        }
        let res = query.execute(&mut *tx).await.map_err(map_query_error)?;
        affected += res.rows_affected();
    }
    tx.commit().await.map_err(map_query_error)?;
    Ok(affected)
}

/// Read up to `cap` tuples of `columns` for FK sourcing / append baselining.
async fn fetch_pk_pool(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
    columns: &[String],
    cap: u64,
) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let cols_sql = columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let stmt = format!(
        "SELECT {cols_sql} FROM {} LIMIT {cap}",
        qualified(schema, table)
    );
    let rows = sqlx::query(&stmt)
        .fetch_all(pool)
        .await
        .map_err(map_query_error)?;
    Ok(rows
        .iter()
        .map(|r| (0..columns.len()).map(|i| decode_value(r, i)).collect())
        .collect())
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

/// §5 "Schema 'x' does not exist…" unless `schema` is a visible user database.
async fn ensure_schema_exists(pool: &MySqlPool, schema: &str) -> Result<(), AppError> {
    let exists: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM information_schema.schemata WHERE schema_name = ?")
            .bind(schema)
            .fetch_optional(pool)
            .await
            .map_err(map_query_error)?;
    if exists.is_some() {
        return Ok(());
    }
    let placeholders = vec!["?"; SYSTEM_SCHEMAS.len()].join(", ");
    let names_sql = format!(
        "SELECT CAST(schema_name AS CHAR) FROM information_schema.schemata \
         WHERE schema_name NOT IN ({placeholders}) ORDER BY schema_name"
    );
    let mut query = sqlx::query_scalar(&names_sql);
    for sys in SYSTEM_SCHEMAS {
        query = query.bind(sys);
    }
    let names: Vec<String> = query.fetch_all(pool).await.unwrap_or_default();
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

/// Bind a [`BoundValue`] to a sqlx query with its native MySQL type. The caller
/// has already emitted the matching `?` placeholder. Binding natively
/// (bool→bool, int→i64, float→f64, text→text) lets the common grid/filter cases
/// compare correctly.
fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    value: &'q BoundValue,
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    match value {
        BoundValue::Null => query.bind(Option::<String>::None),
        BoundValue::Bool(b) => query.bind(*b),
        BoundValue::Int(i) => query.bind(*i),
        BoundValue::Float(f) => query.bind(*f),
        BoundValue::Text(s) => query.bind(s.as_str()),
        BoundValue::Bytes(b) => query.bind(b.as_slice()),
    }
}

/// Bind every [`BoundValue`] (the WHERE params) to a query in order.
fn bind_all<'q>(
    mut query: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    params: &'q [BoundValue],
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    for value in params {
        query = bind_value(query, value);
    }
    query
}

/// Column metadata for a result row: name + the MySQL type name as the display
/// type hint.
fn column_meta(row: &MySqlRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|col| ColumnMeta {
            name: col.name().to_string(),
            type_hint: col.type_info().name().to_string(),
        })
        .collect()
}

/// Decode every column of a row to JSON (module docs for the mapping).
fn decode_row(row: &MySqlRow) -> Vec<serde_json::Value> {
    (0..row.columns().len())
        .map(|i| decode_value(row, i))
        .collect()
}

/// Decode one column of a [`MySqlRow`] to JSON, dispatching on the MySQL type
/// name (`col.type_info().name()`, uppercase, e.g. `INT`, `BIGINT`, `DECIMAL`,
/// `VARCHAR`). See the module docs for the full mapping. Unknown types fall
/// back to the column's text form; a decode error degrades to null rather than
/// failing the whole row.
fn decode_value(row: &MySqlRow, index: usize) -> serde_json::Value {
    use serde_json::Value;

    let col = &row.columns()[index];
    // sqlx reports MySQL type names uppercase, with an UNSIGNED suffix for
    // unsigned integers (e.g. "INT UNSIGNED", "BIGINT UNSIGNED").
    let type_name = col.type_info().name().to_ascii_uppercase();
    let unsigned = type_name.contains("UNSIGNED");
    let base = type_name
        .split_whitespace()
        .next()
        .unwrap_or(&type_name)
        .to_string();

    match base.as_str() {
        // sqlx reports a `tinyint(1)` / `BOOL` / `BOOLEAN` column with the type
        // name "BOOLEAN" and decodes it to a Rust `bool`. MySQL has no native
        // boolean — it is stored as TINYINT(1) and conceptually an integer — so
        // we surface it as the number 0/1, NOT a JSON bool (module docs; only
        // Postgres emits native JSON bool). A wider tinyint (e.g. tinyint(4))
        // keeps the "TINYINT" type name and flows through the integer arm below.
        "BOOLEAN" | "BOOL" => match row.try_get::<Option<bool>, _>(index) {
            Ok(Some(b)) => Value::from(i64::from(b)),
            Ok(None) => Value::Null,
            // Fall back to a narrow signed-int read if the bool decode fails.
            Err(_) => decode_signed_width(row, index, unsigned, IntWidth::I8),
        },
        // Small integers — always fit i64 (and the JS-safe range). sqlx decodes
        // each MySQL integer width to a specific Rust type (TINYINT → i8,
        // SMALLINT → i16, MEDIUMINT/INT → i32, BIGINT → i64), and a `try_get`
        // for the wrong width fails — so we read the native width and widen.
        // TINYINT(1)/BOOL is a TINYINT here and surfaces as 0/1 (module docs:
        // MySQL has no native bool).
        "TINYINT" => decode_signed_width(row, index, unsigned, IntWidth::I8),
        "SMALLINT" => decode_signed_width(row, index, unsigned, IntWidth::I16),
        "MEDIUMINT" | "INT" | "INTEGER" => decode_signed_width(row, index, unsigned, IntWidth::I32),
        // BIGINT: signed via i64; unsigned via u64 (so the full range decodes,
        // then the ±2^53 / >2^53 string-fallback applies).
        "BIGINT" => decode_signed_width(row, index, unsigned, IntWidth::I64),
        "FLOAT" => match row.try_get::<Option<f32>, _>(index) {
            Ok(Some(f)) => number_or_null(f64::from(f)),
            _ => Value::Null,
        },
        "DOUBLE" => match row.try_get::<Option<f64>, _>(index) {
            Ok(Some(f)) => number_or_null(f),
            _ => Value::Null,
        },
        // decimal/numeric: decode to arbitrary-precision BigDecimal (the
        // `bigdecimal` sqlx feature) and stringify, then map: a lossless JS-safe
        // value becomes a JSON number, otherwise the exact decimal string (the
        // CellValue precision contract — module docs).
        "DECIMAL" | "NEWDECIMAL" => {
            match row.try_get::<Option<sqlx::types::BigDecimal>, _>(index) {
                Ok(Some(d)) => numeric_text_to_json(&d.normalized().to_string()),
                Ok(None) => Value::Null,
                Err(_) => get_as_text(row, index)
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            }
        }
        // bit: a bit-field. Decode the raw bytes to an unsigned integer (big-
        // endian), mapping to number-or-string by the same ±2^53 rule. BIT(1)
        // is the common "boolean-ish" case and yields 0/1.
        "BIT" => match row.try_get::<Option<Vec<u8>>, _>(index) {
            Ok(Some(bytes)) => bit_to_json(&bytes),
            Ok(None) => Value::Null,
            Err(_) => Value::Null,
        },
        // json → the JSON text (kept a string so the grid renders it as text,
        // consistent with other engines). Over sqlx's binary protocol a JSON
        // column does NOT satisfy the checked `String` decode (distinct type
        // code), so `get_as_text` returns NULL — that was the "JSON column shows
        // NULL" bug. `try_get_unchecked` decodes the raw bytes as a String
        // regardless of the type code; MySQL stores JSON as UTF-8 text, so this
        // yields the JSON document, with no `json` sqlx feature needed.
        "JSON" => row
            .try_get_unchecked::<Option<String>, _>(index)
            .ok()
            .flatten()
            .map(Value::String)
            .unwrap_or(Value::Null),
        // Binary families → hex when small (UUID/key), placeholder when large;
        // shared with SQLite/Postgres so binary renders identically everywhere.
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" | "GEOMETRY" => {
            match row.try_get::<Option<Vec<u8>>, _>(index) {
                Ok(Some(bytes)) => crate::shared::engine::binary_to_json(&bytes),
                _ => Value::Null,
            }
        }
        // Temporal types decode to chrono values, not String — format them to a
        // display string (the "timestamps don't show" fix). YEAR stays in the
        // text/numeric fallback below.
        "DATE" | "DATETIME" | "TIMESTAMP" | "TIME" => get_temporal(row, index, base.as_str())
            .or_else(|| get_as_text(row, index))
            .map(Value::String)
            .unwrap_or(Value::Null),
        // Text-like and everything else (char/varchar/text families, enum, set,
        // year, …): the column's string form. sqlx decodes these as String.
        _ => get_as_text(row, index)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

/// The native Rust integer width sqlx decodes a given MySQL integer type to.
#[derive(Clone, Copy)]
enum IntWidth {
    I8,
    I16,
    I32,
    I64,
}

/// Decode an integer column to JSON, reading the native signed/unsigned width
/// sqlx uses for the MySQL type, widening to i64/u64, and applying the
/// magnitude string-fallback above 2^53 (the `CellValue` precision contract).
/// Reading the wrong width fails in sqlx, so the width must match the type.
fn decode_signed_width(
    row: &MySqlRow,
    index: usize,
    unsigned: bool,
    width: IntWidth,
) -> serde_json::Value {
    if unsigned {
        let value: Result<Option<u64>, _> = match width {
            IntWidth::I8 => row
                .try_get::<Option<u8>, _>(index)
                .map(|o| o.map(u64::from)),
            IntWidth::I16 => row
                .try_get::<Option<u16>, _>(index)
                .map(|o| o.map(u64::from)),
            IntWidth::I32 => row
                .try_get::<Option<u32>, _>(index)
                .map(|o| o.map(u64::from)),
            IntWidth::I64 => row.try_get::<Option<u64>, _>(index),
        };
        return match value {
            Ok(Some(u)) if u <= JS_MAX_SAFE_INTEGER as u64 => serde_json::Value::from(u),
            Ok(Some(u)) => serde_json::Value::String(u.to_string()),
            _ => serde_json::Value::Null,
        };
    }
    let value: Result<Option<i64>, _> = match width {
        IntWidth::I8 => row
            .try_get::<Option<i8>, _>(index)
            .map(|o| o.map(i64::from)),
        IntWidth::I16 => row
            .try_get::<Option<i16>, _>(index)
            .map(|o| o.map(i64::from)),
        IntWidth::I32 => row
            .try_get::<Option<i32>, _>(index)
            .map(|o| o.map(i64::from)),
        IntWidth::I64 => row.try_get::<Option<i64>, _>(index),
    };
    match value {
        Ok(Some(i)) if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 => serde_json::Value::from(i),
        Ok(Some(i)) => serde_json::Value::String(i.to_string()),
        _ => serde_json::Value::Null,
    }
}

/// Decode a BIT column's big-endian bytes to JSON: a number when it fits the
/// JS-safe range, else the decimal string (a BIT can be up to 64 bits).
fn bit_to_json(bytes: &[u8]) -> serde_json::Value {
    let mut acc: u64 = 0;
    for &b in bytes.iter().take(8) {
        acc = (acc << 8) | u64::from(b);
    }
    if acc <= JS_MAX_SAFE_INTEGER as u64 {
        serde_json::Value::from(acc)
    } else {
        serde_json::Value::String(acc.to_string())
    }
}

/// A finite f64 as a JSON number; non-finite (NaN/Inf — JSON has neither) → null.
fn number_or_null(f: f64) -> serde_json::Value {
    serde_json::Number::from_f64(f)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// Map a DECIMAL's exact decimal text to JSON: a lossless, JS-safe number when
/// possible, else the exact string (preserve precision — module docs).
fn numeric_text_to_json(text: &str) -> serde_json::Value {
    if let Ok(i) = text.parse::<i64>() {
        if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 {
            return serde_json::Value::from(i);
        }
        return serde_json::Value::String(text.to_string());
    }
    if let Ok(f) = text.parse::<f64>() {
        if f.is_finite() {
            let round_trip = format!("{f}");
            if round_trip == text {
                return number_or_null(f);
            }
        }
    }
    serde_json::Value::String(text.to_string())
}

/// Read a column as its MySQL string representation. sqlx returns most types as
/// `String`; `None` on NULL or decode failure.
fn get_as_text(row: &MySqlRow, index: usize) -> Option<String> {
    row.try_get::<Option<String>, _>(index).ok().flatten()
}

/// Decode a MySQL temporal column (DATE/DATETIME/TIMESTAMP/TIME) to a display
/// string. These arrive over the binary protocol as chrono types (the `chrono`
/// sqlx feature), NOT as `String`, so a plain text read returns NULL — that was
/// the "timestamps don't show" bug. DATETIME/TIMESTAMP format to
/// `YYYY-MM-DD HH:MM:SS[.ffffff]` (fractional shown only when present).
fn get_temporal(row: &MySqlRow, index: usize, base: &str) -> Option<String> {
    use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
    const DT_FMT: &str = "%Y-%m-%d %H:%M:%S%.f";
    match base {
        "DATE" => row
            .try_get::<Option<NaiveDate>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format("%Y-%m-%d").to_string()),
        "DATETIME" => row
            .try_get::<Option<NaiveDateTime>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format(DT_FMT).to_string()),
        // TIMESTAMP is UTC-backed; try the tz-aware decode first, then fall back
        // to a naive read for servers/drivers that hand it back naive.
        "TIMESTAMP" => row
            .try_get::<Option<DateTime<Utc>>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.naive_utc().format(DT_FMT).to_string())
            .or_else(|| {
                row.try_get::<Option<NaiveDateTime>, _>(index)
                    .ok()
                    .flatten()
                    .map(|d| d.format(DT_FMT).to_string())
            }),
        "TIME" => row
            .try_get::<Option<NaiveTime>, _>(index)
            .ok()
            .flatten()
            .map(|t| t.format("%H:%M:%S%.f").to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// table_meta (introspection)
// ---------------------------------------------------------------------------

/// Column-level + structure metadata for one table (module docs for sources).
async fn table_meta(pool: &MySqlPool, schema: &str, table: &str) -> Result<TableMeta, AppError> {
    ensure_schema_exists(pool, schema).await?;

    // Existence: a base table or view in the database.
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM information_schema.tables \
         WHERE table_schema = ? AND table_name = ? \
           AND table_type IN ('BASE TABLE', 'VIEW')",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(map_query_error)?;
    if exists.is_none() {
        return Err(missing_table_error(pool, schema, table).await);
    }

    let foreign_keys = foreign_keys(pool, schema, table).await?;
    let fk_by_column = fk_by_first_column(&foreign_keys);

    // Columns from information_schema.columns. COLUMN_TYPE is the full type with
    // length/unsigned (e.g. "int unsigned", "tinyint(1)", "varchar(255)"),
    // preferred for display; DATA_TYPE is the base name used for numeric
    // detection. COLUMN_KEY = 'PRI' marks pk columns.
    let col_rows = sqlx::query(
        "SELECT CAST(column_name AS CHAR) AS column_name, \
            CAST(column_type AS CHAR) AS column_type, \
            CAST(data_type AS CHAR) AS data_type, \
            CAST(is_nullable AS CHAR) AS is_nullable, \
            CAST(column_default AS CHAR) AS column_default, \
            CAST(column_key AS CHAR) AS column_key \
         FROM information_schema.columns \
         WHERE table_schema = ? AND table_name = ? \
         ORDER BY ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    // pk membership comes straight from COLUMN_KEY = 'PRI' per column — no
    // separate key-order query is needed (unlike the Postgres adapter, whose
    // assembled DDL wanted ordered pk columns; here the DDL is verbatim from
    // SHOW CREATE TABLE, and update_cell only needs the pk *set*).
    let mut columns = Vec::with_capacity(col_rows.len());
    for row in &col_rows {
        let name: String = row.get("column_name");
        let column_type: String = row.try_get("column_type").unwrap_or_default();
        let data_type: String = row.try_get("data_type").unwrap_or_default();
        let is_nullable: String = row.get("is_nullable");
        let default_value: Option<String> = row.try_get("column_default").unwrap_or(None);
        let column_key: String = row.try_get("column_key").unwrap_or_default();
        columns.push(ColumnInfo {
            fk: fk_by_column.get(&name).cloned(),
            pk: column_key == "PRI",
            name,
            // Display the full COLUMN_TYPE; fall back to DATA_TYPE if absent.
            data_type: if column_type.is_empty() {
                data_type
            } else {
                column_type
            },
            nullable: is_nullable.eq_ignore_ascii_case("YES"),
            default_value,
        });
    }

    let indexes = table_indexes(pool, schema, table).await?;
    let referenced_by = inbound_foreign_keys(pool, schema, table).await?;
    let comment = table_comment(pool, schema, table).await?;
    let ddl = show_create_table(pool, schema, table).await?;

    Ok(TableMeta {
        columns,
        comment,
        indexes,
        foreign_keys,
        referenced_by,
        ddl,
    })
}

/// Outbound foreign keys, grouped per constraint with ordered column lists and
/// on_delete/on_update actions from referential_constraints.
async fn foreign_keys(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
    // key_column_usage gives the local→referenced column pairs (ordered by
    // ORDINAL_POSITION); referential_constraints gives the ON DELETE/UPDATE
    // rules and the referenced table. Join on constraint_name.
    let rows = sqlx::query(
        "SELECT CAST(k.constraint_name AS CHAR) AS name, CAST(k.column_name AS CHAR) AS col, \
            CAST(k.referenced_table_name AS CHAR) AS ref_table, \
            CAST(k.referenced_column_name AS CHAR) AS ref_col, \
            CAST(rc.delete_rule AS CHAR) AS on_delete, CAST(rc.update_rule AS CHAR) AS on_update \
         FROM information_schema.key_column_usage k \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_schema = k.table_schema \
          AND rc.constraint_name = k.constraint_name \
          AND rc.table_name = k.table_name \
         WHERE k.table_schema = ? AND k.table_name = ? \
           AND k.referenced_table_name IS NOT NULL \
         ORDER BY k.constraint_name, k.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    // Group consecutive rows by constraint name into one ForeignKeyInfo.
    let mut grouped: Vec<ForeignKeyInfo> = Vec::new();
    for row in &rows {
        let name: String = row.get("name");
        let col: String = row.get("col");
        let ref_table: String = row.try_get("ref_table").unwrap_or_default();
        let ref_col: String = row.try_get("ref_col").unwrap_or_default();
        let on_delete: String = row.try_get("on_delete").unwrap_or_default();
        let on_update: String = row.try_get("on_update").unwrap_or_default();
        if let Some(last) = grouped.last_mut() {
            if last.name.as_deref() == Some(name.as_str()) {
                last.columns.push(col);
                last.ref_columns.push(ref_col);
                continue;
            }
        }
        grouped.push(ForeignKeyInfo {
            name: Some(name),
            columns: vec![col],
            ref_table,
            ref_columns: vec![ref_col],
            on_delete: Some(normalize_fk_action(&on_delete)),
            on_update: Some(normalize_fk_action(&on_update)),
        });
    }
    Ok(grouped)
}

/// Normalize a MySQL referential action string to the shared vocabulary.
/// MySQL's `referential_constraints` already reports them as readable text
/// (`NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`, `SET DEFAULT`); uppercase
/// and default empties to `NO ACTION`.
fn normalize_fk_action(action: &str) -> String {
    let upper = action.trim().to_ascii_uppercase();
    if upper.is_empty() {
        "NO ACTION".to_string()
    } else {
        upper
    }
}

/// Per-column fk map for `ColumnInfo.fk` (sidebar icon): the first fk a column
/// participates in, target = the parallel referenced column.
fn fk_by_first_column(foreign_keys: &[ForeignKeyInfo]) -> std::collections::HashMap<String, FkRef> {
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

/// Indexes on the table (name, member columns in order, unique, primary), from
/// information_schema.statistics grouped by INDEX_NAME (columns ordered by
/// SEQ_IN_INDEX, uniqueness from NON_UNIQUE).
async fn table_indexes(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT CAST(index_name AS CHAR) AS name, non_unique AS non_unique, \
            seq_in_index AS seq_in_index, CAST(column_name AS CHAR) AS column_name \
         FROM information_schema.statistics \
         WHERE table_schema = ? AND table_name = ? \
         ORDER BY index_name, seq_in_index",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    let mut grouped: Vec<IndexInfo> = Vec::new();
    for row in &rows {
        let name: String = row.get("name");
        // NON_UNIQUE is 0/1; unique == NON_UNIQUE == 0. MySQL 8 types this
        // catalog column as BIGINT UNSIGNED, so read u64 first, then fall back
        // to narrower signed widths, before defaulting to 1 (treat-as-non-
        // unique) — never silently mark a true unique index wrong.
        let non_unique: u64 = row
            .try_get::<u64, _>("non_unique")
            .or_else(|_| row.try_get::<i64, _>("non_unique").map(|v| v.max(0) as u64))
            .or_else(|_| row.try_get::<i32, _>("non_unique").map(|v| v.max(0) as u64))
            .unwrap_or(1);
        let column_name: Option<String> = row.try_get("column_name").unwrap_or(None);
        let is_primary = name == "PRIMARY";
        if let Some(last) = grouped.last_mut() {
            if last.name == name {
                if let Some(col) = column_name.clone() {
                    last.columns.push(col);
                }
                continue;
            }
        }
        grouped.push(IndexInfo {
            name: name.clone(),
            columns: column_name.into_iter().collect(),
            unique: non_unique == 0,
            // (unique = NON_UNIQUE == 0)
            primary: is_primary,
            origin: if is_primary {
                Some("pk".to_string())
            } else {
                None
            },
        });
    }
    Ok(grouped)
}

/// Inbound foreign keys (§3.6 "referenced by"): constraints in the same schema
/// whose referenced table is this one.
async fn inbound_foreign_keys(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Vec<InboundFkInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT CAST(k.table_name AS CHAR) AS child_table, \
            CAST(k.constraint_name AS CHAR) AS name, \
            CAST(k.column_name AS CHAR) AS col, \
            CAST(k.referenced_column_name AS CHAR) AS ref_col, \
            CAST(rc.delete_rule AS CHAR) AS on_delete \
         FROM information_schema.key_column_usage k \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_schema = k.table_schema \
          AND rc.constraint_name = k.constraint_name \
          AND rc.table_name = k.table_name \
         WHERE k.referenced_table_schema = ? AND k.referenced_table_name = ? \
         ORDER BY k.table_name, k.constraint_name, k.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    let mut grouped: Vec<(String, InboundFkInfo)> = Vec::new();
    for row in &rows {
        let child_table: String = row.get("child_table");
        let name: String = row.get("name");
        let col: String = row.get("col");
        let ref_col: String = row.try_get("ref_col").unwrap_or_default();
        let on_delete: String = row.try_get("on_delete").unwrap_or_default();
        if let Some((last_name, last)) = grouped.last_mut() {
            if *last_name == name && last.table == child_table {
                last.columns.push(col);
                last.ref_columns.push(ref_col);
                continue;
            }
        }
        grouped.push((
            name,
            InboundFkInfo {
                table: child_table,
                columns: vec![col],
                ref_columns: vec![ref_col],
                on_delete: Some(normalize_fk_action(&on_delete)),
            },
        ));
    }
    Ok(grouped.into_iter().map(|(_, fk)| fk).collect())
}

/// The table's comment (information_schema.tables.TABLE_COMMENT).
async fn table_comment(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Option<String>, AppError> {
    let comment: Option<String> = sqlx::query_scalar(
        "SELECT CAST(table_comment AS CHAR) FROM information_schema.tables \
         WHERE table_schema = ? AND table_name = ?",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(map_query_error)?
    .flatten();
    Ok(comment.filter(|s| !s.is_empty()))
}

/// The exact `CREATE TABLE` via MySQL's `SHOW CREATE TABLE` (module docs:
/// faithful, unlike the Postgres catalog reconstruction). The statement is
/// schema-qualified so it runs against any visible database. Returns the second
/// column of the single result row ("Create Table").
async fn show_create_table(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Option<String>, AppError> {
    let sql = format!("SHOW CREATE TABLE {}", qualified(schema, table));
    let row = sqlx::query(&sql)
        .fetch_optional(pool)
        .await
        .map_err(map_query_error)?;
    // The result has columns ("Table", "Create Table"); read by index 1 since
    // the second column name differs for views ("Create View").
    Ok(row.and_then(|r| r.try_get::<String, _>(1).ok()))
}

/// §5 unknown-table message with the schema's available tables.
async fn missing_table_error(pool: &MySqlPool, schema: &str, table: &str) -> AppError {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT CAST(table_name AS CHAR) FROM information_schema.tables \
         WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name",
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
/// the catalog DATA_TYPE.
async fn column_stats(pool: &MySqlPool, req: &ColumnStatsRequest) -> Result<ColumnStats, AppError> {
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    validate_column(&column_names, &req.table, &req.column)?;

    // The catalog DATA_TYPE for numeric detection.
    let data_type: String = sqlx::query_scalar(
        "SELECT CAST(data_type AS CHAR) FROM information_schema.columns \
         WHERE table_schema = ? AND table_name = ? AND column_name = ?",
    )
    .bind(&req.schema)
    .bind(&req.table)
    .bind(&req.column)
    .fetch_one(pool)
    .await
    .map_err(map_query_error)?;
    let numeric = is_numeric_type(&data_type);

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

    // min / max as text → JSON (so big-int/decimal map like everywhere else).
    let minmax_sql = format!(
        "SELECT CAST(min({col}) AS CHAR) AS lo, CAST(max({col}) AS CHAR) AS hi \
         FROM {qualified}{where_sql}"
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

    // avg only when numeric. MySQL's avg() over an integer/decimal column
    // returns a DECIMAL, which sqlx cannot decode straight to f64 — cast it to a
    // DOUBLE in SQL so the f64 decode succeeds.
    let avg = if numeric {
        let avg_sql = format!("SELECT CAST(avg({col}) AS DOUBLE) AS a FROM {qualified}{where_sql}");
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
        "SELECT CAST({col} AS CHAR) AS v, count(*) AS freq FROM {qualified}{where_sql}{and} \
         {col} IS NOT NULL GROUP BY {col} ORDER BY freq DESC, {col} ASC LIMIT 5"
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

// ---------------------------------------------------------------------------
// update_cell
// ---------------------------------------------------------------------------

/// Update a single cell (M11): `SET col = ? WHERE <full pk>` in a transaction,
/// asserting exactly one affected row. pk-completeness policy + bound values
/// match the SQLite/Postgres adapters; MySQL uses `?` placeholders and a real
/// transaction with ROLLBACK on any deviation. (DML — not DDL — IS transactional
/// on InnoDB, so the rollback here is genuine, unlike the alter_table caveat.)
async fn update_cell(pool: &MySqlPool, req: &UpdateCellRequest) -> Result<UpdateResult, AppError> {
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

    // ?1 = SET value; ?2.. = each pk value in predicate order. Binary columns
    // (req.binary / predicate.binary) bind their `0x`-hex / UUID value as raw
    // bytes so `SET col = ?` writes — and `WHERE pk = ?` matches — the bytes.
    let mut params: Vec<BoundValue> = Vec::with_capacity(1 + req.pk.len());
    params.push(if req.binary {
        BoundValue::from_binary_set(&req.value)?
    } else {
        BoundValue::from_json_set(&req.value)
    });

    let mut where_fragments: Vec<String> = Vec::with_capacity(req.pk.len());
    for predicate in &req.pk {
        if predicate.value.is_null() {
            return Err(no_row_matched_error());
        }
        params.push(if predicate.binary {
            BoundValue::from_binary_operand(&predicate.value)?
        } else {
            BoundValue::from_json_operand(&predicate.value)?
        });
        where_fragments.push(format!("{} = ?", quote_ident(&predicate.column)));
    }
    let where_sql = where_fragments.join(" AND ");
    let update_sql = format!("UPDATE {qualified} SET {set_col} = ? WHERE {where_sql}");

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

/// Delete a set of whole rows by primary key (grid multi-select bulk delete).
/// Validates the pk columns once, then runs one guarded `DELETE` per row in a
/// single transaction. A vanished row (affected 0) is skipped; a DELETE hitting
/// more than one row aborts the batch. Returns the count deleted.
async fn delete_rows(
    pool: &MySqlPool,
    req: &DeleteRowsRequest,
) -> Result<DeleteRowsResult, AppError> {
    if req.rows.is_empty() {
        return Ok(DeleteRowsResult { deleted: 0 });
    }
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();
    let qualified = qualified(&req.schema, &req.table);

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    let mut deleted: u64 = 0;
    for pk in &req.rows {
        validate_pk_predicates(&pk_columns, &column_names, &req.table, pk)?;
        let mut params: Vec<BoundValue> = Vec::with_capacity(pk.len());
        let mut where_fragments: Vec<String> = Vec::with_capacity(pk.len());
        for predicate in pk {
            if predicate.value.is_null() {
                let _ = tx.rollback().await;
                return Err(no_row_matched_error());
            }
            params.push(if predicate.binary {
                BoundValue::from_binary_operand(&predicate.value)?
            } else {
                BoundValue::from_json_operand(&predicate.value)?
            });
            where_fragments.push(format!("{} = ?", quote_ident(&predicate.column)));
        }
        let where_sql = where_fragments.join(" AND ");
        let delete_sql = format!("DELETE FROM {qualified} WHERE {where_sql}");
        let result = bind_all(sqlx::query(&delete_sql), &params)
            .execute(&mut *tx)
            .await;
        match result {
            Ok(done) => {
                let affected = done.rows_affected();
                if affected > 1 {
                    let _ = tx.rollback().await;
                    return Err(AppError::Database(format!(
                        "A delete would affect {affected} rows; expected at most one. \
                         No rows were deleted."
                    )));
                }
                deleted += affected;
            }
            Err(err) => {
                let _ = tx.rollback().await;
                return Err(map_query_error(err));
            }
        }
    }
    tx.commit().await.map_err(map_query_error)?;
    Ok(DeleteRowsResult { deleted })
}

fn no_row_matched_error() -> AppError {
    AppError::Database(
        "No row matched (it may have been deleted or changed since you loaded it).".to_string(),
    )
}

/// Empty a table, keeping its structure (M15 truncate). MySQL has a native
/// `TRUNCATE TABLE`, which reports no affected-row count, so we `COUNT(*)`
/// first and return that as the number removed (0 for an already-empty table).
/// The table must exist (reuse `table_meta` for the §5 "Table 'x' does not
/// exist…" message).
async fn truncate_table(pool: &MySqlPool, schema: &str, table: &str) -> Result<u64, AppError> {
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
/// In MySQL a schema IS a database, so this runs `DROP DATABASE \`x\`;
/// CREATE DATABASE \`x\`;`. **NOT atomic:** MySQL implicitly commits each DDL
/// statement, so the drop commits before the recreate runs — there is no
/// rolling it back. We recreate immediately so a successful call always leaves
/// an empty database; if the recreate itself fails the §5 error says the drop
/// already committed (the database is gone). The schema must exist first
/// (a §5 "does not exist" error otherwise).
///
/// We do NOT re-`USE` afterward: every other adapter operation fully qualifies
/// names (`` `db`.`table` ``) and does not depend on the connection's default
/// database, and the pool may hand out a different session anyway. The pool's
/// configured default database (if it was this one) is simply recreated empty.
async fn drop_schema(pool: &MySqlPool, schema: &str) -> Result<(), AppError> {
    ensure_schema_exists(pool, schema).await?;
    let quoted = quote_ident(schema);

    use sqlx::Executor as _;
    // One acquired connection so the drop + recreate run on the same session,
    // back to back, minimizing the window where the database does not exist.
    let mut conn = pool.acquire().await.map_err(map_query_error)?;

    conn.execute(format!("DROP DATABASE {quoted}").as_str())
        .await
        .map_err(map_query_error)?;

    if let Err(err) = conn
        .execute(format!("CREATE DATABASE {quoted}").as_str())
        .await
    {
        let engine_msg = map_query_error(err);
        return Err(AppError::Database(format!(
            "Schema '{schema}' was dropped, but recreating the empty database \
             failed: {engine_msg} MySQL commits each DDL statement, so the drop \
             was NOT rolled back — the schema is gone. Recreate it manually."
        )));
    }
    Ok(())
}

/// Run a whole multi-statement SQL script (a dump) into `schema` (M15 import).
///
/// **NOT atomic.** MySQL implicitly commits each DDL statement, so a
/// multi-statement import cannot be rolled back: if statement N fails,
/// statements 1..N-1 have already landed. We surface that honestly — the §5
/// error names how many statements ran before the failure so the user can
/// recover. (Postgres/SQLite roll the whole import back; MySQL is the
/// documented exception, the same caveat the `alter_table` batch carries.)
///
/// Mechanism: we set the target database with `USE` and run the dump
/// statement-by-statement on the SAME acquired connection (so `USE` and every
/// statement share one session — a `USE` on the pool surface could land on a
/// different pooled connection). We split the script client-side with the
/// quote/comment-aware [`split_statements`] and execute each in order, so a
/// mid-script failure tells us exactly how many statements committed before the
/// error.
///
/// The schema must exist (a §5 error otherwise).
async fn execute_script(
    pool: &MySqlPool,
    schema: &str,
    sql: &str,
    on_progress: crate::shared::engine::ProgressCallback<'_>,
) -> Result<ImportResult, AppError> {
    ensure_schema_exists(pool, schema).await?;
    let statements = split_statements(sql);
    let total = statements.len() as u64;

    use sqlx::Executor as _;

    // One acquired connection so `USE` and every statement share a session (a
    // `USE` on the pool surface could land on a different pooled connection).
    let mut conn = pool.acquire().await.map_err(map_query_error)?;

    // We execute each statement as a bare `&str`, which carries NO bound
    // arguments — so the MySQL driver runs it over the TEXT protocol, not the
    // prepared-statement protocol. That matters: dump statements include DDL
    // (e.g. `SHOW CREATE TABLE` output) that MySQL rejects over the prepared
    // protocol ("This command is not supported in the prepared statement
    // protocol yet."). `&str` also avoids the `raw_sql` executor's higher-ranked
    // lifetime bound, which does not unify inside an async-trait method.
    conn.execute(format!("USE {}", quote_ident(schema)).as_str())
        .await
        .map_err(map_query_error)?;

    // Disable FK checks for this import session. A schema dump lists tables in
    // listing order, NOT foreign-key order, so a `CREATE TABLE` with a forward
    // FK (referencing a table dumped later) fails with "Failed to open the
    // referenced table" — and INSERTs can likewise arrive parent-after-child.
    // This is exactly what `mysqldump` does (`SET FOREIGN_KEY_CHECKS=0` around
    // the dump). It is session-scoped on this one acquired connection; we
    // restore it before the connection returns to the pool (below), regardless
    // of outcome, so no other query inherits the relaxed setting.
    conn.execute("SET FOREIGN_KEY_CHECKS = 0")
        .await
        .map_err(map_query_error)?;

    let mut outcome: Result<(), AppError> = Ok(());
    for (applied, statement) in statements.iter().enumerate() {
        let applied = applied as u64;
        if let Err(err) = conn.execute(statement.as_str()).await {
            let engine_msg = map_query_error(err);
            outcome = Err(AppError::Database(format!(
                "Import failed at statement {} of {total}: {engine_msg} \
                 MySQL commits each statement as it runs, so the {applied} statement(s) \
                 before the failure were applied and were NOT rolled back.",
                applied + 1,
            )));
            break;
        }
        on_progress(applied + 1, total);
    }

    // Restore FK enforcement on this pooled connection before returning (on the
    // happy path AND after a mid-script failure), so a later borrower of the
    // same connection isn't left with checks disabled.
    let _ = conn.execute("SET FOREIGN_KEY_CHECKS = 1").await;

    outcome?;
    Ok(ImportResult { statements: total })
}

/// Enforce the full-primary-key policy (mass-update prevention). Identical
/// semantics to the SQLite/Postgres adapters' `validate_pk_predicates`.
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
// alter_table (native ALTER — NOT atomic across statements; see module docs)
// ---------------------------------------------------------------------------

/// Preview or apply a batch of structure edits via native `ALTER TABLE`
/// statements. Preview = the real ALTER SQL; apply = run them sequentially.
///
/// **Non-atomic caveat (module docs):** MySQL implicitly commits each DDL
/// statement, so a multi-statement batch is NOT rolled back on a mid-batch
/// failure. We validate ALL ops first (so a structurally-bad batch never
/// starts), then run each statement in order; on failure we report exactly
/// which statements already applied. pk-protection per the policy.
async fn alter_table(
    pool: &MySqlPool,
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
    // Build each statement up front (so preview == apply). `SetNullable` needs
    // the column's current type (MySQL's MODIFY couples type + nullability), so
    // pass the introspected meta to the builder.
    let statements: Vec<String> = ops
        .iter()
        .map(|op| alter_statement(schema, &qualified, op, &meta))
        .collect::<Result<Vec<_>, _>>()?;

    if !apply {
        return Ok(AlterResult {
            statements,
            applied: false,
        });
    }

    // Run sequentially. No transaction wraps DDL (MySQL auto-commits each), so
    // on a mid-batch failure we surface which statements already landed.
    for (i, statement) in statements.iter().enumerate() {
        if let Err(err) = sqlx::query(statement).execute(pool).await {
            let applied_so_far = &statements[..i];
            let detail = if applied_so_far.is_empty() {
                "No statements were applied.".to_string()
            } else {
                format!(
                    "These statements already applied and were NOT rolled back \
                     (MySQL commits each DDL statement): {}.",
                    applied_so_far.join("; ")
                )
            };
            return Err(AppError::Database(format!(
                "{} The change failed at: {}. {}",
                humanize(&driver_message(&err)),
                statement,
                detail
            )));
        }
    }

    Ok(AlterResult {
        statements,
        applied: true,
    })
}

/// Validate each op against the introspected columns; pk columns are protected
/// from drop/retype (same as the SQLite/Postgres adapters).
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

/// The native `ALTER TABLE` statement for one op. MySQL specifics (module docs):
/// rename uses `RENAME COLUMN old TO new` (8.0+); type change uses `MODIFY
/// COLUMN col <newtype>`; nullable uses `MODIFY COLUMN col <currenttype>
/// [NOT NULL]` (MySQL couples type + nullability in MODIFY, so we read the
/// current type from `meta`); default uses `ALTER COLUMN col SET/DROP DEFAULT`.
/// `default` and type expressions are the verbatim SQL text the user supplied.
fn alter_statement(
    schema: &str,
    qualified: &str,
    op: &AlterOp,
    meta: &TableMeta,
) -> Result<String, AppError> {
    let stmt = match op {
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
            "ALTER TABLE {qualified} MODIFY COLUMN {} {new_type}",
            quote_ident(column)
        ),
        AlterOp::SetNullable { column, nullable } => {
            // MODIFY rewrites the whole column definition, so we must repeat the
            // current type (else MySQL would default it). Read it from the meta.
            let current_type = meta
                .columns
                .iter()
                .find(|c| &c.name == column)
                .map(|c| c.data_type.clone())
                .ok_or_else(|| {
                    AppError::Database(format!(
                        "Cannot change nullability of '{column}': its current type is unknown."
                    ))
                })?;
            let null_clause = if *nullable { "NULL" } else { "NOT NULL" };
            format!(
                "ALTER TABLE {qualified} MODIFY COLUMN {} {current_type} {null_clause}",
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
        // MySQL drops indexes with ALTER TABLE … DROP INDEX (index names are
        // table-local).
        AlterOp::DropIndex { name } => {
            format!("ALTER TABLE {qualified} DROP INDEX {}", quote_ident(name))
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
        // MySQL drops FK constraints with DROP FOREIGN KEY (by constraint name).
        AlterOp::DropForeignKey { name, .. } => {
            format!(
                "ALTER TABLE {qualified} DROP FOREIGN KEY {}",
                quote_ident(name)
            )
        }
    };
    Ok(stmt)
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
        "Could not connect to the MySQL server: {}.",
        driver_message(&err)
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

/// True for MySQL error 1295 — a command the prepared-statement protocol does
/// not support (CREATE/DROP FUNCTION/PROCEDURE/TRIGGER, etc.). Such statements
/// must run via the text protocol instead.
fn is_unpreparable(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.message().contains("prepared statement protocol"))
}

/// The bare driver message for an error (strip sqlx's wrapping).
fn driver_message(err: &sqlx::Error) -> String {
    match err {
        sqlx::Error::Database(db) => db.message().to_string(),
        other => other.to_string(),
    }
}

/// Capitalize the first letter and ensure a trailing period (matches the
/// SQLite/Postgres adapters' `humanize`).
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

    fn meta_with(columns: Vec<ColumnInfo>) -> TableMeta {
        TableMeta {
            columns,
            ..Default::default()
        }
    }

    #[test]
    fn normalize_fk_action_uppercases_and_defaults() {
        assert_eq!(normalize_fk_action("cascade"), "CASCADE");
        assert_eq!(normalize_fk_action("SET NULL"), "SET NULL");
        assert_eq!(normalize_fk_action("no action"), "NO ACTION");
        assert_eq!(normalize_fk_action(""), "NO ACTION");
        assert_eq!(normalize_fk_action("RESTRICT"), "RESTRICT");
    }

    #[test]
    fn numeric_text_to_json_preserves_precision() {
        assert_eq!(numeric_text_to_json("42"), serde_json::json!(42));
        assert_eq!(numeric_text_to_json("3.5"), serde_json::json!(3.5));
        assert_eq!(
            numeric_text_to_json("9007199254740993"),
            serde_json::json!("9007199254740993")
        );
        assert_eq!(
            numeric_text_to_json("0.12345678901234567890"),
            serde_json::json!("0.12345678901234567890")
        );
    }

    #[test]
    fn bit_to_json_decodes_big_endian_with_precision_guard() {
        assert_eq!(bit_to_json(&[0x01]), serde_json::json!(1));
        assert_eq!(bit_to_json(&[0x00]), serde_json::json!(0));
        assert_eq!(bit_to_json(&[0x01, 0x00]), serde_json::json!(256));
        // 8 bytes all 0xFF = u64::MAX → beyond 2^53 → string.
        assert_eq!(
            bit_to_json(&[0xFF; 8]),
            serde_json::json!(u64::MAX.to_string())
        );
    }

    #[test]
    fn alter_statement_emits_native_mysql_alters() {
        let q = "`bytetable`.`books`";
        let meta = meta_with(vec![
            ColumnInfo {
                name: "price".into(),
                data_type: "decimal(10,2)".into(),
                nullable: true,
                pk: false,
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "title".into(),
                data_type: "varchar(255)".into(),
                nullable: false,
                pk: false,
                default_value: None,
                fk: None,
            },
        ]);

        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::AddColumn {
                    name: "note".into(),
                    data_type: "text".into(),
                    nullable: false,
                    default_value: Some("'n/a'".into()),
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` ADD COLUMN `note` text NOT NULL DEFAULT 'n/a'"
        );
        // RENAME COLUMN (MySQL 8.0+), not CHANGE.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::RenameColumn {
                    from: "a".into(),
                    to: "b".into()
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` RENAME COLUMN `a` TO `b`"
        );
        // Type change uses MODIFY COLUMN.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::ChangeType {
                    column: "price".into(),
                    new_type: "decimal(12,3)".into()
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` MODIFY COLUMN `price` decimal(12,3)"
        );
        // SetNullable couples the CURRENT type into MODIFY (SET NOT NULL).
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetNullable {
                    column: "title".into(),
                    nullable: false
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` MODIFY COLUMN `title` varchar(255) NOT NULL"
        );
        // SetNullable → NULL also repeats the current type.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetNullable {
                    column: "title".into(),
                    nullable: true
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` MODIFY COLUMN `title` varchar(255) NULL"
        );
        // SetNullable on an unknown column is a §5 error (type unknown).
        assert!(matches!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetNullable {
                    column: "ghost".into(),
                    nullable: true
                },
                &meta
            ),
            Err(AppError::Database(_))
        ));
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: Some("'pending'".into())
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` ALTER COLUMN `status` SET DEFAULT 'pending'"
        );
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::SetDefault {
                    column: "status".into(),
                    default_value: None
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` ALTER COLUMN `status` DROP DEFAULT"
        );
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::DropColumn {
                    name: "legacy".into()
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` DROP COLUMN `legacy`"
        );
        // CREATE INDEX (unique).
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::AddIndex {
                    name: "idx_books_title".into(),
                    columns: vec!["title".into()],
                    unique: true,
                },
                &meta
            )
            .unwrap(),
            "CREATE UNIQUE INDEX `idx_books_title` ON `bytetable`.`books` (`title`)"
        );
        // DROP INDEX via ALTER TABLE.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::DropIndex {
                    name: "idx_old".into(),
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` DROP INDEX `idx_old`"
        );
        // ADD CONSTRAINT … FOREIGN KEY, ref table qualified with the schema.
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::AddForeignKey {
                    name: "books_author_id_fkey".into(),
                    columns: vec!["author_id".into()],
                    ref_table: "authors".into(),
                    ref_columns: vec!["id".into()],
                    on_delete: Some("CASCADE".into()),
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` ADD CONSTRAINT `books_author_id_fkey` \
             FOREIGN KEY (`author_id`) REFERENCES `bytetable`.`authors` (`id`) ON DELETE CASCADE"
        );
        // DROP FOREIGN KEY (by constraint name).
        assert_eq!(
            alter_statement(
                "bytetable",
                q,
                &AlterOp::DropForeignKey {
                    name: "books_author_id_fkey".into(),
                    columns: vec!["author_id".into()],
                },
                &meta
            )
            .unwrap(),
            "ALTER TABLE `bytetable`.`books` DROP FOREIGN KEY `books_author_id_fkey`"
        );
    }

    #[test]
    fn validate_ops_protects_pk_and_unknown_columns() {
        let meta = meta_with(vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "int".into(),
                nullable: false,
                pk: true,
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "name".into(),
                data_type: "varchar(50)".into(),
                nullable: true,
                pk: false,
                default_value: None,
                fk: None,
            },
        ]);
        // Dropping the pk → rejected.
        assert!(matches!(
            validate_ops(&meta, "t", &[AlterOp::DropColumn { name: "id".into() }]),
            Err(AppError::Database(_))
        ));
        // Retyping the pk → rejected.
        assert!(matches!(
            validate_ops(
                &meta,
                "t",
                &[AlterOp::ChangeType {
                    column: "id".into(),
                    new_type: "bigint".into()
                }]
            ),
            Err(AppError::Database(_))
        ));
        // Unknown target column → rejected.
        assert!(matches!(
            validate_ops(
                &meta,
                "t",
                &[AlterOp::DropColumn {
                    name: "ghost".into()
                }]
            ),
            Err(AppError::Database(_))
        ));
        // Renaming the pk is allowed (not drop/retype).
        assert!(validate_ops(
            &meta,
            "t",
            &[AlterOp::RenameColumn {
                from: "id".into(),
                to: "pk".into()
            }]
        )
        .is_ok());
        // Dropping a non-pk column is fine.
        assert!(validate_ops(
            &meta,
            "t",
            &[AlterOp::DropColumn {
                name: "name".into()
            }]
        )
        .is_ok());
    }

    #[test]
    fn validate_pk_predicates_enforces_full_pk() {
        let all = vec!["id".to_string(), "name".to_string()];
        assert!(validate_pk_predicates(&[], &all, "t", &[]).is_err());
        assert!(validate_pk_predicates(&["id"], &all, "t", &[]).is_err());
        let non_pk = vec![PkPredicate {
            column: "name".into(),
            value: serde_json::json!("x"),
            binary: false,
        }];
        assert!(validate_pk_predicates(&["id"], &all, "t", &non_pk).is_err());
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
        assert_eq!(humanize("table doesn't exist"), "Table doesn't exist.");
        assert_eq!(humanize("Already fine."), "Already fine.");
        assert_eq!(humanize(""), "The database reported an unknown error.");
    }
}

// ===========================================================================
// Live integration tests (gated behind BYTETABLE_TEST_MYSQL_URL)
// ===========================================================================
//
// These exercise the adapter against a REAL MySQL server. They are gated behind
// the `BYTETABLE_TEST_MYSQL_URL` env var so the default `cargo test` (and CI
// without a server) stays green: each test early-returns with an `eprintln!`
// skip notice when the var is unset.
//
// To run them (the M12 dev container):
//
//   BYTETABLE_TEST_MYSQL_URL=mysql://root:bytetable@127.0.0.1:33306/bytetable \
//     cargo test --lib engines::mysql::integration -- --test-threads=1
//
// `--test-threads=1` is recommended: every test isolates itself in its own
// throwaway database (`bt_it_<name>`) which it drops on entry, so they do not
// collide, but serial execution keeps the live-server output readable.
#[cfg(test)]
mod integration {
    use super::*;
    use crate::shared::engine::{
        Combinator, Condition, FilterOp, FilterSpec, FilterValue, RowLookupRequest, SortDirection,
        SortSpec,
    };

    /// Parse `mysql://user:password@host:port/db` into params + the transient
    /// secret. Minimal — handles the shape the M12 test container emits.
    fn parse_url(url: &str) -> (ConnectionParams, Option<ConnectSecret>) {
        let rest = url
            .strip_prefix("mysql://")
            .or_else(|| url.strip_prefix("mariadb://"))
            .expect("url scheme");
        let (creds_host, db) = rest.split_once('/').expect("db path");
        let (creds, host_port) = creds_host.split_once('@').expect("@ separator");
        let (user, password) = match creds.split_once(':') {
            Some((u, p)) => (u.to_string(), Some(p.to_string())),
            None => (creds.to_string(), None),
        };
        let (host, port) = match host_port.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().unwrap_or(3306)),
            None => (host_port.to_string(), 3306),
        };
        let params = ConnectionParams::Mysql {
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
        match std::env::var("BYTETABLE_TEST_MYSQL_URL") {
            Ok(url) if !url.is_empty() => Some(parse_url(&url)),
            _ => {
                eprintln!("SKIP {test}: BYTETABLE_TEST_MYSQL_URL not set (live MySQL required)");
                None
            }
        }
    }

    /// Open a pool connection for fixture setup/teardown (raw sqlx), separate
    /// from the adapter under test. Points at the default DB; fixtures create
    /// and use their own databases via fully-qualified names.
    async fn raw_pool(params: &ConnectionParams, secret: &Option<ConnectSecret>) -> MySqlPool {
        let options =
            sql::connect_options(params, db_password(secret.as_ref()), None, None).unwrap();
        MySqlPoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .expect("connect raw pool")
    }

    async fn open_conn(
        params: &ConnectionParams,
        secret: &Option<ConnectSecret>,
    ) -> std::sync::Arc<dyn EngineConnection> {
        MysqlConnector
            .open_with_secret(params, secret.as_ref())
            .await
            .expect("open mysql connection")
            .into_sql()
            .expect("sql connection")
    }

    /// Create a throwaway database with a rich fixture: pk/fk/indexes,
    /// tinyint(1) bool, decimal, bigint, text, null columns, plus a second
    /// database. Drops first so reruns are clean.
    async fn setup_fixture(pool: &MySqlPool, schema: &str, other: &str) {
        for stmt in [
            format!("DROP DATABASE IF EXISTS `{schema}`"),
            format!("DROP DATABASE IF EXISTS `{other}`"),
            format!("CREATE DATABASE `{schema}`"),
            format!("CREATE DATABASE `{other}`"),
            format!(
                "CREATE TABLE `{schema}`.`authors` (\
                   id bigint PRIMARY KEY, name varchar(100) NOT NULL, bio text) \
                 COMMENT 'people who write'"
            ),
            format!(
                "CREATE TABLE `{schema}`.`books` (\
                   id int PRIMARY KEY, \
                   title varchar(200) NOT NULL, \
                   author_id bigint NOT NULL, \
                   price decimal(10,2) DEFAULT 0.00, \
                   in_print tinyint(1) DEFAULT 1, \
                   big bigint, \
                   note text, \
                   INDEX idx_books_title (title), \
                   UNIQUE INDEX idx_books_author_title (author_id, title), \
                   CONSTRAINT fk_books_author FOREIGN KEY (author_id) \
                     REFERENCES `{schema}`.`authors`(id) ON DELETE CASCADE)"
            ),
            format!("CREATE TABLE `{other}`.`tags` (id int PRIMARY KEY, label varchar(50))"),
            format!(
                "INSERT INTO `{schema}`.`authors` (id, name, bio) VALUES \
                   (1, 'Ada', 'pioneer'), (2, 'Grace', NULL), (3, 'Linus', 'kernel')"
            ),
            // bool 1/0, decimal, big bigint (> 2^53), a NULL note.
            format!(
                "INSERT INTO `{schema}`.`books` (id, title, author_id, price, in_print, big, note) VALUES \
                   (10, 'Notes', 1, 9.50, 1, 9007199254740993, 'first'), \
                   (11, 'Essays', 1, 7.25, 0, 1, NULL), \
                   (12, 'Letters', 2, 0.00, 1, 2, 'third'), \
                   (13, 'Memoir', 3, 12.00, 1, 3, 'fourth')"
            ),
        ] {
            sqlx::query(&stmt)
                .execute(pool)
                .await
                .unwrap_or_else(|e| panic!("fixture stmt failed: {stmt}\n{e}"));
        }
    }

    async fn drop_fixture(pool: &MySqlPool, schema: &str, other: &str) {
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS `{schema}`"))
            .execute(pool)
            .await;
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS `{other}`"))
            .execute(pool)
            .await;
    }

    #[tokio::test]
    async fn connect_and_server_version() {
        let Some((params, secret)) = gate("connect_and_server_version") else {
            return;
        };
        let info = MysqlConnector
            .test_with_secret(&params, secret.as_ref())
            .await
            .expect("test connection");
        assert_eq!(info.engine, Engine::Mysql);
        assert!(
            info.server_version.starts_with("MySQL "),
            "got {:?}",
            info.server_version
        );
        // A wrong password is a §5 database error, not a panic.
        let bad = MysqlConnector
            .test_with_secret(&params, Some(&ConnectSecret::new("definitely-wrong")))
            .await;
        assert!(matches!(bad, Err(AppError::Database(_))));
    }

    /// M16: generate fake data across a schema with the type/constraint shapes
    /// that broke on MySQL (datetime format, varchar length, tinyint range,
    /// decimal, a non-FK sized-string id) and FK ordering. Every table must
    /// succeed (no per-table error) and FK rows must be valid.
    #[tokio::test]
    async fn generate_data_respects_mysql_types_and_constraints() {
        use crate::features::connections::application::ConnectionManager;
        use crate::features::generate::application::{run_generation, GenProgress, RunCtx};
        use crate::features::generate::domain::GenerateSize;

        let Some((params, secret)) = gate("generate_data_respects_mysql_types_and_constraints")
        else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let schema = "bt_it_generate";
        for stmt in [
            format!("DROP DATABASE IF EXISTS `{schema}`"),
            format!("CREATE DATABASE `{schema}`"),
            // Binary(16) UUID pk + binary FK — the byteshop shape that broke.
            format!(
                "CREATE TABLE `{schema}`.`accounts` (\
                   id binary(16) NOT NULL PRIMARY KEY, name varchar(50) NOT NULL)"
            ),
            format!(
                "CREATE TABLE `{schema}`.`documents` (\
                   id binary(16) NOT NULL PRIMARY KEY, \
                   account_id binary(16) NOT NULL, \
                   country varchar(2) NOT NULL, \
                   created_at datetime NOT NULL, \
                   CONSTRAINT fk_docs_account FOREIGN KEY (account_id) \
                     REFERENCES `{schema}`.`accounts`(id))"
            ),
            format!(
                "CREATE TABLE `{schema}`.`users` (\
                   id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, \
                   country varchar(2) NOT NULL, \
                   created_at datetime NOT NULL)"
            ),
            format!(
                "CREATE TABLE `{schema}`.`orders` (\
                   id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, \
                   user_id bigint NOT NULL, \
                   paid tinyint NOT NULL, \
                   amount decimal(6,2) NOT NULL, \
                   CONSTRAINT fk_orders_user FOREIGN KEY (user_id) \
                     REFERENCES `{schema}`.`users`(id))"
            ),
        ] {
            sqlx::query(&stmt).execute(&pool).await.expect("ddl");
        }

        let open = MysqlConnector
            .open_with_secret(&params, secret.as_ref())
            .await
            .expect("open mysql");
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;

        let cancel = std::sync::atomic::AtomicBool::new(false);
        let noop = |_p: GenProgress| {};
        let summary = run_generation(
            &manager,
            &handle,
            schema,
            GenerateSize::OneK,
            RunCtx {
                cancel: &cancel,
                on_progress: &noop,
                seed: 1,
            },
        )
        .await
        .expect("run");

        for r in &summary.tables {
            assert!(r.error.is_none(), "table {} failed: {:?}", r.table, r.error);
        }
        assert!(summary.total_inserted > 0, "rows inserted");

        let conn = manager.get_sql(&handle).await.expect("sql");
        let orphans = conn
            .run_query(
                &format!(
                    "SELECT count(*) FROM `{schema}`.`orders` o \
                     LEFT JOIN `{schema}`.`users` u ON o.user_id = u.id WHERE u.id IS NULL"
                ),
                QueryOptions::default(),
            )
            .await
            .expect("orphan query");
        assert_eq!(orphans.rows[0][0].as_i64().unwrap(), 0, "no orphan FKs");

        sqlx::query(&format!("DROP DATABASE IF EXISTS `{schema}`"))
            .execute(&pool)
            .await
            .expect("drop db");
    }

    #[tokio::test]
    async fn schemas_tables_and_counts() {
        let Some((params, secret)) = gate("schemas_tables_and_counts") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_lists", "bt_it_lists_other");
        setup_fixture(&pool, schema, other).await;
        // ANALYZE so table_rows is populated.
        let _ = sqlx::query(&format!("ANALYZE TABLE `{schema}`.`books`"))
            .execute(&pool)
            .await;

        let conn = open_conn(&params, &secret).await;

        let schemas = conn.list_schemas().await.expect("list schemas");
        let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&schema), "user schema present: {names:?}");
        assert!(names.contains(&other), "second schema present");
        // System DBs excluded.
        for sys in SYSTEM_SCHEMAS {
            assert!(!names.contains(&sys), "system db {sys} excluded");
        }

        let tables = conn.list_tables(schema).await.expect("list tables");
        let tnames: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(tnames, vec!["authors", "books"]);

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
                &format!("SELECT in_print, big, note, price FROM `{schema}`.`books` ORDER BY id"),
                QueryOptions::default(),
            )
            .await
            .expect("run query");
        // tinyint(1)/bool → integer 0/1 (NOT JSON bool — MySQL has no native
        // bool; module docs).
        assert_eq!(result.rows[0][0], serde_json::json!(1));
        assert_eq!(result.rows[1][0], serde_json::json!(0));
        // bigint beyond 2^53 → string (precision preserved).
        assert_eq!(result.rows[0][1], serde_json::json!("9007199254740993"));
        assert_eq!(result.rows[1][1], serde_json::json!(1));
        // NULL → null.
        assert_eq!(result.rows[1][2], serde_json::Value::Null);
        // decimal 9.50 normalizes to a lossless 9.5 → number.
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

        // Filtered: in_print = 1 → 3 rows; bound integer value (bool-as-0/1).
        let filtered = conn
            .fetch_rows(FetchRowsRequest {
                schema: schema.into(),
                table: "books".into(),
                sort: None,
                filter: Some(FilterSpec::Conditions {
                    items: vec![Condition {
                        column: "in_print".into(),
                        op: FilterOp::Eq,
                        value: Some(FilterValue::Scalar(serde_json::json!(1))),
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
        let by_name = |n: &str| meta.columns.iter().find(|c| c.name == n).unwrap();
        assert!(by_name("id").pk);
        assert!(!by_name("title").nullable);
        assert!(by_name("note").nullable);
        // tinyint(1) surfaces its full column type.
        assert!(by_name("in_print").data_type.contains("tinyint"));
        assert!(by_name("price").default_value.is_some());
        // fk on author_id.
        let author_fk = by_name("author_id").fk.as_ref().expect("fk");
        assert_eq!(author_fk.table, "authors");
        assert_eq!(author_fk.column, "id");
        // Table-level foreign keys.
        assert_eq!(meta.foreign_keys.len(), 1);
        assert_eq!(meta.foreign_keys[0].ref_table, "authors");
        assert_eq!(meta.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
        // Indexes incl. the primary-key index (named PRIMARY).
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
        // DDL via SHOW CREATE TABLE — faithful CREATE TABLE.
        let ddl = meta.ddl.as_ref().expect("ddl");
        assert!(ddl.contains("CREATE TABLE"));
        assert!(ddl.to_uppercase().contains("PRIMARY KEY"));
        assert!(ddl.to_uppercase().contains("FOREIGN KEY"));

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

        // Column stats: numeric (decimal) column with avg, distinct, top.
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

        // Filtered stats: only in_print = 1 rows.
        let filtered = conn
            .column_stats(ColumnStatsRequest {
                schema: schema.into(),
                table: "books".into(),
                column: "price".into(),
                filter: Some(FilterSpec::Conditions {
                    items: vec![Condition {
                        column: "in_print".into(),
                        op: FilterOp::Eq,
                        value: Some(FilterValue::Scalar(serde_json::json!(1))),
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
        let check: String = sqlx::query_scalar(&format!(
            "SELECT note FROM `{schema}`.`books` WHERE id = 10"
        ))
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

        // Stale pk → no row matched.
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

        // Constraint failure rolls back (NOT NULL on title — DML is
        // transactional on InnoDB).
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
        let title: String = sqlx::query_scalar(&format!(
            "SELECT title FROM `{schema}`.`books` WHERE id = 10"
        ))
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
                    data_type: "int".into(),
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
        // Preview did not add the column.
        let meta = conn.table_meta(schema, "books").await.unwrap();
        assert!(!meta.columns.iter().any(|c| c.name == "rating"));

        // A batch referencing a non-existent column is rejected before any
        // statement runs (validate_ops up front).
        let bad = vec![
            AlterOp::AddColumn {
                name: "rating".into(),
                data_type: "int".into(),
                nullable: true,
                default_value: Some("5".into()),
            },
            AlterOp::DropColumn {
                name: "ghost_col".into(),
            },
        ];
        let bad_result = conn.alter_table(schema, "books", &bad, true).await;
        assert!(matches!(bad_result, Err(AppError::Database(_))));
        let meta = conn.table_meta(schema, "books").await.unwrap();
        assert!(
            !meta.columns.iter().any(|c| c.name == "rating"),
            "bad batch rejected up front: no partial 'rating' column"
        );

        // A valid batch — add, rename, modify-type, set-nullable, set-default.
        let good = vec![
            AlterOp::AddColumn {
                name: "rating".into(),
                data_type: "int".into(),
                nullable: false,
                default_value: Some("5".into()),
            },
            AlterOp::RenameColumn {
                from: "note".into(),
                to: "remark".into(),
            },
            AlterOp::ChangeType {
                column: "price".into(),
                new_type: "decimal(12,3)".into(),
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
        // title is now nullable after MODIFY.
        assert!(
            meta.columns
                .iter()
                .find(|c| c.name == "title")
                .unwrap()
                .nullable
        );
        // price retyped.
        assert!(meta
            .columns
            .iter()
            .find(|c| c.name == "price")
            .unwrap()
            .data_type
            .contains("decimal(12,3)"));
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{schema}`.`books`"))
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

    // ---- M15: truncate + export against live MySQL ----

    #[tokio::test]
    async fn truncate_empties_table_and_reports_prior_count() {
        let Some((params, secret)) = gate("truncate_empties_table_and_reports_prior_count") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_truncate", "bt_it_truncate_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        // books (the child of the FK) has 4 rows; truncating the child is safe.
        let affected = conn
            .truncate_table(schema, "books")
            .await
            .expect("truncate books");
        assert_eq!(affected, 4);
        let after: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{schema}`.`books`"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after, 0);

        let again = conn
            .truncate_table(schema, "books")
            .await
            .expect("re-truncate");
        assert_eq!(again, 0);

        let err = conn.truncate_table(schema, "ghost").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));

        conn.close().await.expect("close");
        drop_fixture(&pool, schema, other).await;
    }

    /// drop_schema drops + recreates a THROWAWAY database empty (never
    /// `byteshop`): the database still exists afterward but holds 0 tables. A
    /// nonexistent schema is a §5 error.
    #[tokio::test]
    async fn drop_schema_recreates_throwaway_database_empty() {
        let Some((params, secret)) = gate("drop_schema_recreates_throwaway_database_empty") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_dropschema", "bt_it_dropschema_other");
        setup_fixture(&pool, schema, other).await;
        let conn = open_conn(&params, &secret).await;

        let before: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = ?",
        )
        .bind(schema)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(before >= 2, "fixture should seed tables, got {before}");

        conn.drop_schema(schema).await.expect("drop schema");

        // The database still exists…
        let db_exists: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM information_schema.schemata WHERE schema_name = ?")
                .bind(schema)
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(db_exists.is_some(), "database must be recreated empty");

        // …but it is empty.
        let after: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = ?",
        )
        .bind(schema)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0, "dropped database must hold 0 tables");

        // The OTHER throwaway database is untouched.
        let other_tables: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = ?",
        )
        .bind(other)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(other_tables, 1, "drop must not touch other databases");

        let err = conn.drop_schema("bt_it_nope_xyz").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));

        conn.close().await.expect("close");
        drop_fixture(&pool, schema, other).await;
    }

    #[tokio::test]
    async fn export_csv_and_sql_against_live_mysql() {
        use crate::features::connections::application::ConnectionManager;
        use crate::features::export::application::{export_schema_sql, export_table};
        use crate::features::export::domain::{ExportFormat, ExportScope};

        let Some((params, secret)) = gate("export_csv_and_sql_against_live_mysql") else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_export", "bt_it_export_other");
        setup_fixture(&pool, schema, other).await;

        let open = MysqlConnector
            .open_with_secret(&params, secret.as_ref())
            .await
            .expect("open");
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;

        // CSV: header + every authors row (3); NULL bio → empty field.
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
        assert!(csv.contains("2,Grace,"));

        // SQL: DDL + one INSERT per row, MySQL backtick identifiers.
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
        assert!(sql.contains(&format!("INSERT INTO `{schema}`.`books`")));
        assert_eq!(sql.matches("INSERT INTO").count(), 4);
        assert!(sql.contains("NULL"));

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

        // Empty table after truncate exports the no-rows marker.
        manager
            .get_sql(&handle)
            .await
            .unwrap()
            .truncate_table(schema, "books")
            .await
            .expect("truncate");
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
    async fn import_round_trip_multi_statement_and_nonatomic_error_against_live_mysql() {
        use crate::features::connections::application::ConnectionManager;
        use crate::features::export::application::{export_table, import_sql};
        use crate::features::export::domain::{ExportFormat, ExportScope};

        let Some((params, secret)) =
            gate("import_round_trip_multi_statement_and_nonatomic_error_against_live_mysql")
        else {
            return;
        };
        let pool = raw_pool(&params, &secret).await;
        let (schema, other) = ("bt_it_import", "bt_it_import_other");
        setup_fixture(&pool, schema, other).await;
        // A fresh, empty target database for the imports.
        let fresh = "bt_it_import_fresh";
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS `{fresh}`"))
            .execute(&pool)
            .await;
        sqlx::query(&format!("CREATE DATABASE `{fresh}`"))
            .execute(&pool)
            .await
            .expect("create fresh db");

        let open = MysqlConnector
            .open_with_secret(&params, secret.as_ref())
            .await
            .expect("open");
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;
        let dir = tempfile::tempdir().expect("tempdir");

        // --- ROUND-TRIP: export authors → retarget the qualified names to the
        // FRESH db → import → verify the table + 3 rows landed there.
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
        // The INSERTs are `schema`.`authors`; the SHOW CREATE TABLE DDL names the
        // table unqualified, so it lands in the USEd (fresh) db. Retarget the
        // qualified INSERT prefix to the fresh db.
        let retargeted = dump.replace(
            &format!("`{schema}`.`authors`"),
            &format!("`{fresh}`.`authors`"),
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
        assert_eq!(result.statements, 4); // DDL + 3 INSERTs
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{fresh}`.`authors`"))
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(n, 3);

        // --- MULTI-STATEMENT: hand-written CREATE + 2 INSERTs (unqualified → USE).
        let script = "CREATE TABLE gadgets (id INT PRIMARY KEY, label VARCHAR(20));\n\
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
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{fresh}`.`gadgets`"))
            .fetch_one(&pool)
            .await
            .expect("count gadgets");
        assert_eq!(n, 2);

        // --- NON-ATOMIC ERROR: statement 1 (CREATE) auto-commits, statement 2
        // fails. MySQL cannot roll back the committed DDL, so the table from
        // statement 1 SURVIVES and the §5 error names how far it got.
        let bad = "CREATE TABLE survives_me (id INT);\n\
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
        let msg = err.to_string();
        assert!(
            msg.contains("statement 2 of 2"),
            "names the failing stmt: {msg}"
        );
        assert!(
            msg.contains("were applied and were NOT rolled back"),
            "surfaces the non-atomic caveat: {msg}"
        );
        // The auto-committed table 1 is still there.
        let exists: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM information_schema.tables \
             WHERE table_schema = ? AND table_name = 'survives_me'",
        )
        .bind(fresh)
        .fetch_optional(&pool)
        .await
        .expect("existence");
        assert!(
            exists.is_some(),
            "statement 1's table auto-committed (MySQL DDL)"
        );

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
            let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{fresh}`.`from_text`"))
                .fetch_one(&pool)
                .await
                .expect("count from_text");
            assert_eq!(n, 1);
        }

        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS `{fresh}`"))
            .execute(&pool)
            .await;
        drop_fixture(&pool, schema, other).await;
    }
}
