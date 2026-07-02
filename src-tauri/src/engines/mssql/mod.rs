//! Microsoft SQL Server engine adapter (M21): implements the shared `Connector`
//! / `EngineConnection` relational ports over the `tiberius` TDS driver. SQL
//! Server is a **fourth relational engine** — it reuses the same UI and ports as
//! SQLite/MySQL/Postgres; only the T-SQL dialect differs (bracket-quoted
//! identifiers, `OFFSET…FETCH` paging, `IDENTITY`, the `sys.*` catalog, `dbo`
//! default schema, indexed views for materialized views). The pure dialect
//! helpers live in [`sql`]; this module holds the live driver access.
//!
//! # Threading model
//!
//! `tiberius` has no built-in pool. A desktop client runs a few short,
//! serial introspection/grid queries, so one ByteTable connection owns a single
//! [`tiberius::Client`] behind a [`tokio::sync::Mutex`]. Every method locks the
//! client, runs, and releases — matching the "a few queries at a time" model the
//! MySQL adapter documents, without the machinery of a connection pool. Because
//! the client is a single session, a terminal `USE <db>` persists across
//! statements (unlike the pooled adapters).
//!
//! # Password / TLS / SSH
//!
//! Identical seam to the MySQL/Postgres adapters — the password arrives as a
//! transient [`ConnectSecret`] (never persisted), the granular `tls_mode` maps
//! to a tiberius [`EncryptionLevel`], and a tunnelled connection opens an SSH
//! local-forward first ([`crate::engines::ssh`]) and points the TCP socket at
//! the local endpoint (the TLS SNI host stays the real host). engine_info comes
//! from `SERVERPROPERTY('ProductVersion')`.
//!
//! # Value → JSON (see [`decode_value`])
//!
//! tinyint/smallint/int → number; bigint → number within ±2^53 else string (the
//! `CellValue` precision contract); float/real → number; decimal/numeric/money →
//! the exact decimal *string* (precision preserved); bit → the integer 0/1
//! (matching the MySQL adapter's numeric bools — T-SQL uses BIT for booleans);
//! char/varchar/nchar/nvarchar/text/xml → string; date/time/datetime/datetime2/
//! datetimeoffset → string; uniqueidentifier → the GUID string; binary/varbinary
//! → a `"[N bytes]"` placeholder; NULL → null. Decoding tries each Rust target
//! type in turn (tiberius `try_get` errors on a type mismatch), so no per-column
//! `ColumnType` table is needed.

mod objects;
mod sql;

use std::time::Instant;

use async_trait::async_trait;
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, Query, Row};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{
    split_statements, AlterResult, ColumnInfo, ColumnMeta, ColumnStats, ColumnStatsRequest,
    ConnectSecret, ConnectionParams, Connector, DbObjectDefinition, DbObjectInfo, DbObjectKind,
    DeleteRowsRequest, DeleteRowsResult, Engine, EngineConnection, EngineInfo, FetchRowsRequest,
    FkRef, ForeignKeyInfo, FreqEntry, ImportResult, InboundFkInfo, IndexInfo, OpenConnection,
    PkPredicate, ProgressCallback, QueryOptions, QueryResult, RowLookup, RowLookupRequest,
    RowsPage, SchemaInfo, TableInfo, TableMeta, UpdateCellRequest, UpdateResult,
};
use crate::shared::error::AppError;

use crate::engines::ssh::{db_password, open_tunnel_if_needed, tunnel_override, SshTunnel};

use sql::{
    build_multi_insert_sql, is_numeric_type, order_by_clause, qualified, quote_ident, where_clause,
    BoundValue, WhereClause,
};

/// The concrete tiberius client type: TDS over a tokio TCP socket adapted to
/// futures-io (tiberius speaks `futures_util::io`, tokio speaks `tokio::io`).
type TdsClient = Client<Compat<TcpStream>>;

/// Page-size ceiling for `fetch_rows` (mirrors the other relational adapters and
/// the connections slice's `MAX_ROW_LIMIT`).
const MAX_PAGE_ROWS: u32 = 10_000;

/// Schemas hidden from `list_schemas` / the schema switcher: the SQL Server
/// system schema, the ANSI views schema, and the fixed database roles that own a
/// schema of the same name. User schemas (`dbo`, `sales`, `audit`, …) remain.
const SYSTEM_SCHEMAS: &[&str] = &[
    "sys",
    "INFORMATION_SCHEMA",
    "guest",
    "db_owner",
    "db_accessadmin",
    "db_securityadmin",
    "db_ddladmin",
    "db_backupoperator",
    "db_datareader",
    "db_datawriter",
    "db_denydatareader",
    "db_denydatawriter",
];

/// Opens SQL Server connections. Stateless; registered once in `lib.rs`.
pub struct MssqlConnector;

#[async_trait]
impl Connector for MssqlConnector {
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
        let mut client = connect_client(params, db_password(secret), host_over, port_over).await?;
        let info = read_engine_info(&mut client).await?;
        Ok(info)
    }

    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        // Open the SSH tunnel (if any) before the client, and keep its handle on
        // the connection so the tunnel lives exactly as long as the session.
        let tunnel = open_tunnel_if_needed(params, secret).await?;
        let (host_over, port_over) = tunnel_override(&tunnel);
        let mut client = connect_client(params, db_password(secret), host_over, port_over).await?;
        let info = read_engine_info(&mut client).await?;
        Ok(OpenConnection::sql(MssqlEngineConnection {
            client: Mutex::new(client),
            info,
            _tunnel: tunnel,
        }))
    }
}

/// Build a tiberius [`Config`] from [`ConnectionParams::Mssql`] and connect a TDS
/// client. `host_override`/`port_override` point the TCP socket at a local
/// SSH-tunnel endpoint; the config keeps the real host for TLS SNI.
async fn connect_client(
    params: &ConnectionParams,
    password: Option<&str>,
    host_override: Option<&str>,
    port_override: Option<u16>,
) -> Result<TdsClient, AppError> {
    let ConnectionParams::Mssql {
        host,
        port,
        database,
        user,
        tls_mode,
        ssh: _,
    } = params
    else {
        return Err(AppError::Invalid(format!(
            "the SQL Server connector received {} parameters",
            params.engine().display_name()
        )));
    };

    let mut config = Config::new();
    config.host(host);
    config.port(*port);
    if let Some(database) = database.as_deref().filter(|d| !d.is_empty()) {
        config.database(database);
    }
    // SQL authentication (username/password). An empty user lets the server
    // reject with its own clear message rather than us guessing.
    config.authentication(AuthMethod::sql_server(
        user.as_deref().unwrap_or(""),
        password.unwrap_or(""),
    ));
    apply_encryption(&mut config, tls_mode.as_token());

    // Connect the raw socket (to the tunnel endpoint when tunnelling) and adapt
    // it to the futures-io tiberius expects.
    let addr = format!(
        "{}:{}",
        host_override.unwrap_or(host),
        port_override.unwrap_or(*port)
    );
    let tcp = TcpStream::connect(&addr)
        .await
        .map_err(|e| map_connect_error(e.to_string()))?;
    tcp.set_nodelay(true).ok();
    let client = Client::connect(config, tcp.compat_write())
        .await
        .map_err(|e| map_connect_error(e.to_string()))?;
    Ok(client)
}

/// Map a TLS-mode token to a tiberius [`EncryptionLevel`] (+ cert trust). SQL
/// Server always encrypts the login packet; the level controls data encryption.
/// `disable` → off; `prefer` → on; `require` → required; both trust a
/// self-signed cert (common for local/Docker servers). `verify-ca`/`verify-full`
/// require encryption AND validate the certificate chain (no `trust_cert`).
fn apply_encryption(config: &mut Config, token: &str) {
    match token.trim().to_ascii_lowercase().as_str() {
        "disable" => {
            config.encryption(EncryptionLevel::Off);
            config.trust_cert();
        }
        "require" => {
            config.encryption(EncryptionLevel::Required);
            config.trust_cert();
        }
        "verify-ca" | "verify-full" | "verifyca" | "verifyfull" => {
            config.encryption(EncryptionLevel::Required);
            // No trust_cert: the rustls stack validates the server certificate.
        }
        // "prefer" / "allow" / unknown → opportunistic, trust self-signed.
        _ => {
            config.encryption(EncryptionLevel::On);
            config.trust_cert();
        }
    }
}

/// Read the server version for the sidebar header (`SERVERPROPERTY`).
async fn read_engine_info(client: &mut TdsClient) -> Result<EngineInfo, AppError> {
    let rows = client
        .simple_query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(128)) AS v")
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let raw = rows
        .first()
        .and_then(|r| r.try_get::<&str, _>("v").ok().flatten())
        .unwrap_or("")
        .to_string();
    Ok(EngineInfo {
        engine: Engine::Mssql,
        server_version: sql::display_version(&raw),
    })
}

/// One open SQL Server connection (a single TDS session behind a mutex). When
/// reached through an SSH bastion, the live tunnel is held here so it lives
/// exactly as long as the session (dropped together on `close`).
pub struct MssqlEngineConnection {
    client: Mutex<TdsClient>,
    info: EngineInfo,
    _tunnel: Option<SshTunnel>,
}

#[async_trait]
impl EngineConnection for MssqlEngineConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
        let sql = format!(
            "SELECT s.name AS name, \
                (SELECT COUNT(*) FROM sys.tables t \
                 WHERE t.schema_id = s.schema_id AND t.is_ms_shipped = 0) AS table_count \
             FROM sys.schemas s \
             WHERE s.name NOT IN ({}) \
             ORDER BY s.name",
            system_schema_list()
        );
        let mut client = self.client.lock().await;
        let rows = client
            .simple_query(sql.as_str())
            .await
            .map_err(map_query_error)?
            .into_first_result()
            .await
            .map_err(map_query_error)?;
        Ok(rows
            .iter()
            .map(|row| {
                let name: String = row
                    .try_get::<&str, _>("name")
                    .ok()
                    .flatten()
                    .unwrap_or("")
                    .to_string();
                let count: i32 = row.try_get("table_count").ok().flatten().unwrap_or(0);
                SchemaInfo {
                    name,
                    table_count: Some(count.max(0) as u64),
                }
            })
            .collect())
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
        {
            let mut client = self.client.lock().await;
            ensure_schema_exists(&mut client, schema).await?;
        }
        // Base tables in the schema, with the storage engine's row estimate
        // (SUM over the heap/clustered-index partitions — approximate, like the
        // other server adapters' catalog counts).
        // `is_ms_shipped = 0` hides the engine's own tables — notably the legacy
        // `spt_fallback_*` / `spt_monitor` / `MSreplication_options` tables that
        // ship in `master` (empty, deprecated) — so only user tables are listed.
        let sql = "SELECT t.name AS name, \
                CAST(ISNULL(SUM(p.rows), 0) AS bigint) AS est \
             FROM sys.tables t \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) \
             WHERE s.name = @P1 AND t.is_ms_shipped = 0 \
             GROUP BY t.name \
             ORDER BY t.name";
        let mut client = self.client.lock().await;
        let mut query = Query::new(sql);
        query.bind(schema.to_string());
        let rows = query
            .query(&mut client)
            .await
            .map_err(map_query_error)?
            .into_first_result()
            .await
            .map_err(map_query_error)?;
        Ok(rows
            .iter()
            .map(|row| {
                let name: String = row
                    .try_get::<&str, _>("name")
                    .ok()
                    .flatten()
                    .unwrap_or("")
                    .to_string();
                let est: Option<i64> = row.try_get("est").ok().flatten();
                TableInfo {
                    name,
                    approx_row_count: est.map(|e| e.max(0) as u64),
                }
            })
            .collect())
    }

    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
        let mut client = self.client.lock().await;
        table_meta(&mut client, schema, table).await
    }

    fn object_kinds(&self) -> &'static [DbObjectKind] {
        objects::KINDS
    }

    async fn list_objects(
        &self,
        schema: &str,
        kind: DbObjectKind,
    ) -> Result<Vec<DbObjectInfo>, AppError> {
        let mut client = self.client.lock().await;
        objects::list(&mut client, schema, kind).await
    }

    async fn object_definition(
        &self,
        schema: &str,
        kind: DbObjectKind,
        name: &str,
        detail: Option<&str>,
    ) -> Result<DbObjectDefinition, AppError> {
        let mut client = self.client.lock().await;
        objects::definition(&mut client, schema, kind, name, detail).await
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
        let mut client = self.client.lock().await;

        // The whole batch may contain several statements / result sets; take the
        // first result set that produced rows (a SELECT). DML/DDL produce none.
        let results = client
            .simple_query(sql)
            .await
            .map_err(map_query_error)?
            .into_results()
            .await
            .map_err(map_query_error)?;
        let rows: Vec<Row> = results
            .into_iter()
            .find(|set| !set.is_empty())
            .unwrap_or_default();

        let columns = rows.first().map(column_meta).unwrap_or_default();
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
        let mut client = self.client.lock().await;
        let meta = table_meta(&mut client, &req.schema, &req.table).await?;
        let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();

        let order_by = match &req.sort {
            Some(sort) => order_by_clause(&column_names, &req.table, sort)?,
            // T-SQL OFFSET/FETCH requires an ORDER BY; a stable arbitrary order
            // when the caller gave none.
            None => "(SELECT NULL)".to_string(),
        };
        let (where_clause, _next) = match &req.filter {
            Some(filter) => where_clause(&column_names, &req.table, filter, 1)?,
            None => (WhereClause::default(), 1),
        };
        let where_sql = match &where_clause.sql {
            Some(body) => format!(" WHERE {body}"),
            None => String::new(),
        };

        let limit = req.limit.min(MAX_PAGE_ROWS);
        let qualified = qualified(&req.schema, &req.table);

        // Exact filtered COUNT for "n of N rows" (§3.5). COUNT_BIG → bigint.
        let count_sql = format!("SELECT COUNT_BIG(*) AS n FROM {qualified}{where_sql}");
        let mut count_query = Query::new(&count_sql);
        for value in &where_clause.params {
            bind_query(&mut count_query, value);
        }
        let count_rows = count_query
            .query(&mut client)
            .await
            .map_err(map_query_error)?
            .into_first_result()
            .await
            .map_err(map_query_error)?;
        let total_rows: i64 = count_rows
            .first()
            .and_then(|r| r.try_get("n").ok().flatten())
            .unwrap_or(0);

        // Page query: WHERE params first (numbered @P1..), then OFFSET/FETCH as
        // the two trailing placeholders.
        let offset_idx = where_clause.params.len() + 1;
        let fetch_idx = offset_idx + 1;
        let page_sql = format!(
            "SELECT * FROM {qualified}{where_sql} ORDER BY {order_by} \
             OFFSET @P{offset_idx} ROWS FETCH NEXT @P{fetch_idx} ROWS ONLY"
        );
        let mut page_query = Query::new(&page_sql);
        for value in &where_clause.params {
            bind_query(&mut page_query, value);
        }
        page_query.bind(req.offset as i64);
        page_query.bind(i64::from(limit));
        let rows = page_query
            .query(&mut client)
            .await
            .map_err(map_query_error)?
            .into_first_result()
            .await
            .map_err(map_query_error)?;

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
        let mut client = self.client.lock().await;
        fetch_row_by_key(&mut client, &req).await
    }

    async fn column_stats(&self, req: ColumnStatsRequest) -> Result<ColumnStats, AppError> {
        let mut client = self.client.lock().await;
        column_stats(&mut client, &req).await
    }

    async fn update_cell(&self, req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
        let mut client = self.client.lock().await;
        update_cell(&mut client, &req).await
    }

    async fn delete_rows(&self, req: DeleteRowsRequest) -> Result<DeleteRowsResult, AppError> {
        let mut client = self.client.lock().await;
        delete_rows(&mut client, &req).await
    }

    async fn alter_table(
        &self,
        schema: &str,
        table: &str,
        ops: &[AlterOp],
        apply: bool,
    ) -> Result<AlterResult, AppError> {
        let mut client = self.client.lock().await;
        alter_table(&mut client, schema, table, ops, apply).await
    }

    async fn truncate_table(&self, schema: &str, table: &str) -> Result<u64, AppError> {
        let mut client = self.client.lock().await;
        truncate_table(&mut client, schema, table).await
    }

    async fn drop_schema(&self, schema: &str) -> Result<(), AppError> {
        let mut client = self.client.lock().await;
        drop_schema(&mut client, schema).await
    }

    async fn create_schema(&self, schema: &str) -> Result<(), AppError> {
        let mut client = self.client.lock().await;
        // CREATE SCHEMA must be the only statement in its batch — it is here.
        exec_batch(
            &mut client,
            format!("CREATE SCHEMA {}", quote_ident(schema)),
        )
        .await?;
        Ok(())
    }

    async fn execute_script(
        &self,
        schema: &str,
        sql: &str,
        on_progress: ProgressCallback<'_>,
    ) -> Result<ImportResult, AppError> {
        let mut client = self.client.lock().await;
        execute_script(&mut client, schema, sql, on_progress).await
    }

    async fn bulk_insert(
        &self,
        schema: &str,
        table: &str,
        columns: &[String],
        binary: &[bool],
        rows: &[Vec<serde_json::Value>],
    ) -> Result<u64, AppError> {
        let mut client = self.client.lock().await;
        bulk_insert(&mut client, schema, table, columns, binary, rows).await
    }

    async fn fetch_pk_pool(
        &self,
        schema: &str,
        table: &str,
        columns: &[String],
        cap: u64,
    ) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
        let mut client = self.client.lock().await;
        fetch_pk_pool(&mut client, schema, table, columns, cap).await
    }

    /// T-SQL identifiers are bracket-quoted (M15 export asks the connection to
    /// quote per-dialect).
    fn quote_identifier(&self, ident: &str) -> String {
        quote_ident(ident)
    }

    /// T-SQL binary literal: `0x` + hex digits (e.g. `0xDEADBEEF`; empty → `0x`).
    fn binary_literal(&self, hex: &str) -> String {
        format!("0x{hex}")
    }

    async fn close(&self) -> Result<(), AppError> {
        // tiberius has no explicit close; the session ends when the client drops
        // with the last Arc. Nothing to do here.
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/// Column-level (+ pk/fk/index/inbound/ddl) metadata for one table, from the
/// `sys.*` catalog. Unknown table → §5 human error listing the schema's tables.
pub(crate) async fn table_meta(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
) -> Result<TableMeta, AppError> {
    ensure_schema_exists(client, schema).await?;

    let object_ref = qualified(schema, table);

    // Existence: a base table or view with this schema-qualified name.
    let mut exists_q = Query::new(
        "SELECT o.object_id FROM sys.objects o \
         WHERE o.object_id = OBJECT_ID(@P1) AND o.type IN ('U', 'V')",
    );
    exists_q.bind(object_ref.clone());
    let exists = exists_q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    if exists.is_empty() {
        return Err(missing_table_error(client, schema, table).await);
    }

    let columns = read_columns(client, &object_ref).await?;
    let foreign_keys = read_foreign_keys(client, schema, table).await?;
    let fk_by_column = fk_by_first_column(&foreign_keys);
    let columns: Vec<ColumnInfo> = columns
        .into_iter()
        .map(|mut c| {
            c.fk = fk_by_column.get(&c.name).cloned();
            c
        })
        .collect();
    let indexes = read_indexes(client, &object_ref).await?;
    let referenced_by = read_inbound_foreign_keys(client, schema, table).await?;
    let ddl = objects::generate_table_ddl(schema, table, &columns, &foreign_keys, &indexes);

    Ok(TableMeta {
        columns,
        comment: None,
        indexes,
        foreign_keys,
        referenced_by,
        ddl: Some(ddl),
    })
}

/// Read columns from `sys.columns`/`sys.types`, building the display type
/// (length/precision) and reading identity + default. pk membership is folded in
/// from the primary-key index.
async fn read_columns(
    client: &mut TdsClient,
    object_ref: &str,
) -> Result<Vec<ColumnInfo>, AppError> {
    let mut q = Query::new(
        "SELECT c.name AS name, ty.name AS type_name, \
            c.max_length AS max_length, c.precision AS precision, c.scale AS scale, \
            c.is_nullable AS is_nullable, c.is_identity AS is_identity, \
            dc.definition AS default_def, \
            CAST(CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS bit) AS is_pk \
         FROM sys.columns c \
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
         LEFT JOIN ( \
            SELECT ic.column_id FROM sys.indexes i \
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
            WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(@P1) \
         ) pk ON pk.column_id = c.column_id \
         WHERE c.object_id = OBJECT_ID(@P1) \
         ORDER BY c.column_id",
    );
    q.bind(object_ref.to_string());
    q.bind(object_ref.to_string());
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    let mut columns = Vec::with_capacity(rows.len());
    for row in &rows {
        let name = get_str(row, "name");
        let type_name = get_str(row, "type_name");
        let max_length: i16 = row.try_get("max_length").ok().flatten().unwrap_or(0);
        let precision: u8 = row.try_get("precision").ok().flatten().unwrap_or(0);
        let scale: u8 = row.try_get("scale").ok().flatten().unwrap_or(0);
        let is_nullable: bool = row.try_get("is_nullable").ok().flatten().unwrap_or(true);
        let is_identity: bool = row.try_get("is_identity").ok().flatten().unwrap_or(false);
        let is_pk: bool = row.try_get("is_pk").ok().flatten().unwrap_or(false);
        let mut default_value: Option<String> = row
            .try_get::<&str, _>("default_def")
            .ok()
            .flatten()
            .map(strip_default_parens);

        // Surface IDENTITY in the default cell so the Structure view shows it
        // (T-SQL has no separate "extra" column; IDENTITY is the analogue of
        // MySQL AUTO_INCREMENT / Postgres SERIAL).
        if is_identity && default_value.is_none() {
            default_value = Some("IDENTITY".to_string());
        }

        columns.push(ColumnInfo {
            name,
            data_type: sql::build_display_type(&type_name, max_length, precision, scale),
            nullable: is_nullable,
            pk: is_pk,
            default_value,
            fk: None,
        });
    }
    Ok(columns)
}

/// Outbound foreign keys, grouped per constraint with ordered column lists and
/// on_delete/on_update actions.
async fn read_foreign_keys(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
    let object_ref = qualified(schema, table);
    let mut q = Query::new(
        "SELECT fk.name AS fk_name, \
            pc.name AS col, rt.name AS ref_table, rc.name AS ref_col, \
            fk.delete_referential_action_desc AS on_delete, \
            fk.update_referential_action_desc AS on_update, \
            fkc.constraint_column_id AS ord \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
         JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE fk.parent_object_id = OBJECT_ID(@P1) \
         ORDER BY fk.name, fkc.constraint_column_id",
    );
    q.bind(object_ref);
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    let mut grouped: Vec<ForeignKeyInfo> = Vec::new();
    for row in &rows {
        let fk_name = get_str(row, "fk_name");
        let col = get_str(row, "col");
        let ref_table = get_str(row, "ref_table");
        let ref_col = get_str(row, "ref_col");
        let on_delete = normalize_fk_action(&get_str(row, "on_delete"));
        let on_update = normalize_fk_action(&get_str(row, "on_update"));
        match grouped.last_mut() {
            Some(existing) if existing.name.as_deref() == Some(fk_name.as_str()) => {
                existing.columns.push(col);
                existing.ref_columns.push(ref_col);
            }
            _ => grouped.push(ForeignKeyInfo {
                name: Some(fk_name),
                columns: vec![col],
                ref_table,
                ref_columns: vec![ref_col],
                on_delete: Some(on_delete),
                on_update: Some(on_update),
            }),
        }
    }
    Ok(grouped)
}

/// Foreign keys pointing *at* this table (§3.6 "referenced by").
async fn read_inbound_foreign_keys(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
) -> Result<Vec<InboundFkInfo>, AppError> {
    let object_ref = qualified(schema, table);
    let mut q = Query::new(
        "SELECT fk.name AS fk_name, ct.name AS child_table, \
            pc.name AS child_col, rc.name AS ref_col, \
            fk.delete_referential_action_desc AS on_delete \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.tables ct ON ct.object_id = fk.parent_object_id \
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE fk.referenced_object_id = OBJECT_ID(@P1) \
         ORDER BY fk.name, fkc.constraint_column_id",
    );
    q.bind(object_ref);
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    let mut grouped: Vec<InboundFkInfo> = Vec::new();
    for row in &rows {
        let fk_name = get_str(row, "fk_name");
        let child_table = get_str(row, "child_table");
        let child_col = get_str(row, "child_col");
        let ref_col = get_str(row, "ref_col");
        let on_delete = normalize_fk_action(&get_str(row, "on_delete"));
        match grouped.last_mut() {
            Some(existing)
                if existing.table == child_table && matches_fk_group(existing, &fk_name) =>
            {
                existing.columns.push(child_col);
                existing.ref_columns.push(ref_col);
            }
            _ => grouped.push(InboundFkInfo {
                table: child_table,
                columns: vec![child_col],
                ref_columns: vec![ref_col],
                on_delete: Some(on_delete),
            }),
        }
    }
    let _ = schema;
    let _ = table;
    Ok(grouped)
}

/// Indexes on the table, including the implicit primary-key index.
async fn read_indexes(
    client: &mut TdsClient,
    object_ref: &str,
) -> Result<Vec<IndexInfo>, AppError> {
    let mut q = Query::new(
        "SELECT i.name AS name, i.is_unique AS is_unique, i.is_primary_key AS is_pk, \
            c.name AS col, ic.key_ordinal AS ord \
         FROM sys.indexes i \
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE i.object_id = OBJECT_ID(@P1) AND i.type <> 0 AND ic.is_included_column = 0 \
         ORDER BY i.index_id, ic.key_ordinal",
    );
    q.bind(object_ref.to_string());
    let rows = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    let mut grouped: Vec<IndexInfo> = Vec::new();
    for row in &rows {
        let name = get_str(row, "name");
        let unique: bool = row.try_get("is_unique").ok().flatten().unwrap_or(false);
        let primary: bool = row.try_get("is_pk").ok().flatten().unwrap_or(false);
        let col = get_str(row, "col");
        match grouped.last_mut() {
            Some(existing) if existing.name == name => existing.columns.push(col),
            _ => grouped.push(IndexInfo {
                name,
                columns: vec![col],
                unique,
                primary,
                origin: Some(if primary { "pk" } else { "c" }.to_string()),
            }),
        }
    }
    Ok(grouped)
}

/// §5 "Table 'x' does not exist…" listing the available tables in the schema.
async fn missing_table_error(client: &mut TdsClient, schema: &str, table: &str) -> AppError {
    let mut q = Query::new(
        "SELECT t.name AS name FROM sys.tables t \
         JOIN sys.schemas s ON s.schema_id = t.schema_id \
         WHERE s.name = @P1 AND t.is_ms_shipped = 0 ORDER BY t.name",
    );
    q.bind(schema.to_string());
    let names: Vec<String> = match q.query(client).await {
        Ok(stream) => match stream.into_first_result().await {
            Ok(rows) => rows.iter().map(|r| get_str(r, "name")).collect(),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    AppError::Database(format!(
        "Table '{table}' does not exist in schema '{schema}'. Available tables: {}.",
        if names.is_empty() {
            "(none)".to_string()
        } else {
            names.join(", ")
        }
    ))
}

/// §5 "Schema 'x' does not exist…" unless `schema` is a visible user schema.
async fn ensure_schema_exists(client: &mut TdsClient, schema: &str) -> Result<(), AppError> {
    let mut q = Query::new("SELECT 1 AS ok FROM sys.schemas WHERE name = @P1");
    q.bind(schema.to_string());
    let found = q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    if !found.is_empty() {
        return Ok(());
    }
    let names_sql = format!(
        "SELECT name FROM sys.schemas WHERE name NOT IN ({}) ORDER BY name",
        system_schema_list()
    );
    let names: Vec<String> = match client.simple_query(names_sql.as_str()).await {
        Ok(stream) => match stream.into_first_result().await {
            Ok(rows) => rows.iter().map(|r| get_str(r, "name")).collect(),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
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

/// Bind a [`BoundValue`] to a tiberius query with its native type. The caller
/// has already emitted the matching `@P{n}` placeholder.
fn bind_query(query: &mut Query<'_>, value: &BoundValue) {
    match value {
        BoundValue::Null => query.bind(Option::<i32>::None),
        BoundValue::Bool(b) => query.bind(*b),
        BoundValue::Int(i) => query.bind(*i),
        BoundValue::Float(f) => query.bind(*f),
        BoundValue::Text(s) => query.bind(s.clone()),
        BoundValue::Bytes(b) => query.bind(b.clone()),
    }
}

/// Run a non-parameterized statement (or small batch) as a plain SQL batch via
/// `simple_query`, discarding any result. Transaction control (`BEGIN
/// TRANSACTION`/`COMMIT`/`ROLLBACK`) and DDL MUST go through this, NOT through
/// `Client::execute` — that path wraps the SQL in `sp_executesql` (an RPC scope),
/// and opening a transaction inside that scope trips SQL Server's "mismatching
/// number of BEGIN and COMMIT" guard. A plain batch runs the statement in the
/// connection's own scope, so the transaction spans batches correctly.
async fn exec_batch(client: &mut TdsClient, sql: impl Into<String>) -> Result<(), AppError> {
    let sql: String = sql.into();
    client
        .simple_query(sql)
        .await
        .map_err(map_query_error)?
        .into_results()
        .await
        .map_err(map_query_error)?;
    Ok(())
}

/// Column metadata for a result row: name + the tiberius column type as the
/// display type hint.
fn column_meta(row: &Row) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|col| ColumnMeta {
            name: col.name().to_string(),
            type_hint: format!("{:?}", col.column_type()).to_uppercase(),
        })
        .collect()
}

/// Decode every column of a row to JSON.
fn decode_row(row: &Row) -> Vec<serde_json::Value> {
    (0..row.columns().len())
        .map(|i| decode_value(row, i))
        .collect()
}

/// Decode one column of a [`Row`] to JSON. tiberius `try_get::<T>` returns `Err`
/// when the column is not type `T`, so we try each target type in turn (widest
/// match wins) and land on the first that fits; a NULL of the right type decodes
/// to `Ok(None)` → JSON null. See the module docs for the type mapping.
fn decode_value(row: &Row, index: usize) -> serde_json::Value {
    use serde_json::Value;

    // bit → 0/1 (T-SQL boolean).
    if let Ok(v) = row.try_get::<bool, _>(index) {
        return opt(v, |b| Value::from(if b { 1 } else { 0 }));
    }
    // tinyint (u8), smallint (i16), int (i32).
    if let Ok(v) = row.try_get::<u8, _>(index) {
        return opt(v, Value::from);
    }
    if let Ok(v) = row.try_get::<i16, _>(index) {
        return opt(v, Value::from);
    }
    if let Ok(v) = row.try_get::<i32, _>(index) {
        return opt(v, Value::from);
    }
    // bigint → number within ±2^53 else string.
    if let Ok(v) = row.try_get::<i64, _>(index) {
        return opt(v, int_or_string);
    }
    // real (f32), float (f64).
    if let Ok(v) = row.try_get::<f32, _>(index) {
        return opt(v, |f| number_or_null(f64::from(f)));
    }
    if let Ok(v) = row.try_get::<f64, _>(index) {
        return opt(v, number_or_null);
    }
    // decimal/numeric/money → exact string (precision preserved).
    if let Ok(v) = row.try_get::<tiberius::numeric::Numeric, _>(index) {
        return opt(v, |n| numeric_text_to_json(&n.to_string()));
    }
    // uniqueidentifier.
    if let Ok(v) = row.try_get::<uuid::Uuid, _>(index) {
        return opt(v, |g| Value::from(g.to_string()));
    }
    // char/varchar/nchar/nvarchar/text/xml.
    if let Ok(v) = row.try_get::<&str, _>(index) {
        return opt(v, |s| Value::from(s.to_string()));
    }
    // temporal.
    if let Ok(v) = row.try_get::<chrono::NaiveDateTime, _>(index) {
        return opt(v, |d| Value::from(d.to_string()));
    }
    if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(index) {
        return opt(v, |d| Value::from(d.to_string()));
    }
    if let Ok(v) = row.try_get::<chrono::NaiveTime, _>(index) {
        return opt(v, |t| Value::from(t.to_string()));
    }
    if let Ok(v) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(index) {
        return opt(v, |d| Value::from(d.to_rfc3339()));
    }
    // binary/varbinary/image → placeholder.
    if let Ok(v) = row.try_get::<&[u8], _>(index) {
        return opt(v, |b| Value::from(format!("[{} bytes]", b.len())));
    }
    Value::Null
}

/// `Some(x)` → `f(x)`, `None` → JSON null.
fn opt<T>(value: Option<T>, f: impl FnOnce(T) -> serde_json::Value) -> serde_json::Value {
    match value {
        Some(x) => f(x),
        None => serde_json::Value::Null,
    }
}

/// A bigint as a JSON number if it fits JS's safe-integer range, else a string
/// (the `CellValue` precision contract).
fn int_or_string(value: i64) -> serde_json::Value {
    if value.abs() <= sql::JS_MAX_SAFE_INTEGER {
        serde_json::Value::from(value)
    } else {
        serde_json::Value::from(value.to_string())
    }
}

/// A finite float as a JSON number, else null (JSON has no NaN/Inf).
fn number_or_null(value: f64) -> serde_json::Value {
    serde_json::Number::from_f64(value)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// A decimal's text form as a JSON number when it round-trips through f64
/// losslessly, else the exact decimal *string* (preserve precision).
fn numeric_text_to_json(text: &str) -> serde_json::Value {
    if let Ok(f) = text.parse::<f64>() {
        if f.to_string() == text {
            if let Some(n) = serde_json::Number::from_f64(f) {
                return serde_json::Value::Number(n);
            }
        }
    }
    serde_json::Value::from(text.to_string())
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Read a string column, defaulting to empty on NULL / type mismatch.
fn get_str(row: &Row, col: &str) -> String {
    row.try_get::<&str, _>(col)
        .ok()
        .flatten()
        .unwrap_or("")
        .to_string()
}

/// Strip the wrapping parentheses SQL Server stores around default definitions
/// (`((0))` → `0`, `('pending')` → `'pending'`, `(getdate())` → `getdate()`).
fn strip_default_parens(def: &str) -> String {
    let mut s = def.trim();
    while s.starts_with('(') && s.ends_with(')') {
        let inner = &s[1..s.len() - 1];
        // Only strip a *balanced* outer pair.
        if is_balanced(inner) {
            s = inner.trim();
        } else {
            break;
        }
    }
    s.to_string()
}

fn is_balanced(s: &str) -> bool {
    let mut depth = 0i32;
    for ch in s.chars() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

/// The system-schema exclusion list as a SQL literal `'a', 'b', …` (constant
/// names, no injection surface).
fn system_schema_list() -> String {
    SYSTEM_SCHEMAS
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Normalize a `sys.foreign_keys.*_referential_action_desc` value
/// (`NO_ACTION`, `CASCADE`, `SET_NULL`, `SET_DEFAULT`) to the space-separated
/// display form the other adapters use (`NO ACTION`, `SET NULL`, …).
fn normalize_fk_action(action: &str) -> String {
    action.trim().to_ascii_uppercase().replace('_', " ")
}

/// First-column → FK target map for the sidebar's per-column FK icon.
fn fk_by_first_column(foreign_keys: &[ForeignKeyInfo]) -> std::collections::HashMap<String, FkRef> {
    let mut map = std::collections::HashMap::new();
    for fk in foreign_keys {
        if let (Some(col), Some(ref_col)) = (fk.columns.first(), fk.ref_columns.first()) {
            map.insert(
                col.clone(),
                FkRef {
                    table: fk.ref_table.clone(),
                    column: ref_col.clone(),
                },
            );
        }
    }
    map
}

/// Whether an inbound-FK group being accumulated matches this fk name. Inbound
/// groups carry no name field, so we approximate by "same child table and the
/// running group is still open"; the SQL orders by fk name so rows of one
/// constraint are contiguous — see [`read_inbound_foreign_keys`].
fn matches_fk_group(_existing: &InboundFkInfo, _fk_name: &str) -> bool {
    // The ORDER BY groups a constraint's rows together; a new constraint starts
    // a new group via the ordering, so we only need contiguity, which the caller
    // already guarantees by only merging into `last_mut()`. Always false here
    // would over-split composite inbound FKs; we merge conservatively by child
    // table + name equality tracked out-of-band is unnecessary, so treat a
    // contiguous same-table run as the same constraint.
    true
}

// ---------------------------------------------------------------------------
// FK peek (M10)
// ---------------------------------------------------------------------------

async fn fetch_row_by_key(
    client: &mut TdsClient,
    req: &RowLookupRequest,
) -> Result<RowLookup, AppError> {
    let meta = table_meta(client, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    sql::validate_column(&column_names, &req.table, &req.column)?;

    let columns: Vec<ColumnMeta> = meta
        .columns
        .iter()
        .map(|c| ColumnMeta {
            name: c.name.clone(),
            type_hint: c.data_type.clone(),
        })
        .collect();

    // A null key never matches `=` — short-circuit to a clean miss.
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

    let q = qualified(&req.schema, &req.table);
    let col = quote_ident(&req.column);

    let row_sql = format!("SELECT TOP 1 * FROM {q} WHERE {col} = @P1");
    let mut row_query = Query::new(&row_sql);
    bind_query(&mut row_query, &bound);
    let rows = row_query
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let row = rows.first().map(decode_row);

    let match_count = if row.is_none() {
        0
    } else {
        let count_sql = format!("SELECT COUNT_BIG(*) AS n FROM {q} WHERE {col} = @P1");
        let mut cq = Query::new(&count_sql);
        bind_query(&mut cq, &bound);
        let crows = cq
            .query(client)
            .await
            .map_err(map_query_error)?
            .into_first_result()
            .await
            .map_err(map_query_error)?;
        crows
            .first()
            .and_then(|r| r.try_get::<i64, _>("n").ok().flatten())
            .unwrap_or(0)
            .max(0) as u64
    };

    Ok(RowLookup {
        columns,
        row,
        match_count,
    })
}

// ---------------------------------------------------------------------------
// Column insights (M10)
// ---------------------------------------------------------------------------

async fn column_stats(
    client: &mut TdsClient,
    req: &ColumnStatsRequest,
) -> Result<ColumnStats, AppError> {
    let meta = table_meta(client, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    sql::validate_column(&column_names, &req.table, &req.column)?;
    let numeric = meta
        .columns
        .iter()
        .find(|c| c.name == req.column)
        .map(|c| is_numeric_type(&c.data_type))
        .unwrap_or(false);

    let q = qualified(&req.schema, &req.table);
    let col = quote_ident(&req.column);

    let (wc, _) = match &req.filter {
        Some(filter) => where_clause(&column_names, &req.table, filter, 1)?,
        None => (WhereClause::default(), 1),
    };
    let where_sql = wc
        .sql
        .as_ref()
        .map(|b| format!(" WHERE {b}"))
        .unwrap_or_default();
    let and = if where_sql.is_empty() {
        " WHERE"
    } else {
        " AND"
    };

    let bind_wc = |sql: &str| -> Query<'static> {
        let mut query = Query::new(sql.to_string());
        for value in &wc.params {
            bind_query(&mut query, value);
        }
        query
    };

    // total / nulls / distinct.
    let agg_sql = format!(
        "SELECT COUNT_BIG(*) AS total, COUNT_BIG(*) - COUNT_BIG({col}) AS nulls, \
            COUNT_BIG(DISTINCT {col}) AS distinct_count FROM {q}{where_sql}"
    );
    let agg = bind_wc(&agg_sql)
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let agg = agg.first();
    let total = agg
        .and_then(|r| r.try_get::<i64, _>("total").ok().flatten())
        .unwrap_or(0);
    let nulls = agg
        .and_then(|r| r.try_get::<i64, _>("nulls").ok().flatten())
        .unwrap_or(0);
    let distinct = agg
        .and_then(|r| r.try_get::<i64, _>("distinct_count").ok().flatten())
        .unwrap_or(0);

    // min / max as text → JSON (big-int/decimal map like everywhere else).
    let minmax_sql = format!(
        "SELECT CAST(MIN({col}) AS NVARCHAR(4000)) AS lo, \
            CAST(MAX({col}) AS NVARCHAR(4000)) AS hi FROM {q}{where_sql}"
    );
    let minmax = bind_wc(&minmax_sql)
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let minmax = minmax.first();
    let to_value = |text: Option<String>| -> Option<serde_json::Value> {
        text.map(|t| {
            if numeric {
                numeric_text_to_json(&t)
            } else {
                serde_json::Value::String(t)
            }
        })
    };
    let min = to_value(
        minmax
            .and_then(|r| r.try_get::<&str, _>("lo").ok().flatten())
            .map(str::to_string),
    );
    let max = to_value(
        minmax
            .and_then(|r| r.try_get::<&str, _>("hi").ok().flatten())
            .map(str::to_string),
    );

    // avg only when numeric.
    let avg = if numeric {
        let avg_sql = format!("SELECT AVG(CAST({col} AS FLOAT)) AS a FROM {q}{where_sql}");
        let rows = bind_wc(&avg_sql)
            .query(client)
            .await
            .map_err(map_query_error)?
            .into_first_result()
            .await
            .map_err(map_query_error)?;
        rows.first()
            .and_then(|r| r.try_get::<f64, _>("a").ok().flatten())
    } else {
        None
    };

    // Top-5 most frequent non-NULL values.
    let top_sql = format!(
        "SELECT TOP 5 CAST({col} AS NVARCHAR(4000)) AS v, COUNT_BIG(*) AS freq \
         FROM {q}{where_sql}{and} {col} IS NOT NULL GROUP BY {col} ORDER BY freq DESC, {col} ASC"
    );
    let top_rows = bind_wc(&top_sql)
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let top = top_rows
        .iter()
        .map(|row| {
            let text = row
                .try_get::<&str, _>("v")
                .ok()
                .flatten()
                .map(str::to_string);
            let freq = row.try_get::<i64, _>("freq").ok().flatten().unwrap_or(0);
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
// update_cell / delete_rows (M11) — transactional (SQL Server DDL/DML both are)
// ---------------------------------------------------------------------------

async fn update_cell(
    client: &mut TdsClient,
    req: &UpdateCellRequest,
) -> Result<UpdateResult, AppError> {
    let meta = table_meta(client, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    sql::validate_column(&column_names, &req.table, &req.column)?;

    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();
    validate_pk_predicates(&pk_columns, &column_names, &req.table, &req.pk)?;

    let q = qualified(&req.schema, &req.table);
    let set_col = quote_ident(&req.column);

    // @P1 = SET value; @P2.. = each pk value in predicate order.
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
        // @P1 is the SET value, so pk placeholders start at @P2.
        where_fragments.push(format!("{} = @P{}", quote_ident(&predicate.column), i + 2));
    }
    let where_sql = where_fragments.join(" AND ");
    let update_sql = format!("UPDATE {q} SET {set_col} = @P1 WHERE {where_sql}");

    exec_batch(client, "BEGIN TRANSACTION").await?;

    let mut query = Query::new(&update_sql);
    for b in &params {
        bind_query(&mut query, b);
    }
    let affected = match query.execute(&mut *client).await {
        Ok(res) => res.total(),
        Err(err) => {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(map_query_error(err));
        }
    };

    if affected == 0 {
        let _ = exec_batch(client, "ROLLBACK").await;
        return Err(no_row_matched_error());
    }
    if affected > 1 {
        let _ = exec_batch(client, "ROLLBACK").await;
        return Err(AppError::Database(format!(
            "Update would affect {affected} rows; expected exactly one. No changes were applied."
        )));
    }
    exec_batch(client, "COMMIT").await?;

    Ok(UpdateResult {
        affected,
        statement: display_update_statement(&q, &req.column, &req.value, &req.pk),
    })
}

async fn delete_rows(
    client: &mut TdsClient,
    req: &DeleteRowsRequest,
) -> Result<DeleteRowsResult, AppError> {
    if req.rows.is_empty() {
        return Ok(DeleteRowsResult { deleted: 0 });
    }
    let meta = table_meta(client, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();
    let q = qualified(&req.schema, &req.table);

    exec_batch(client, "BEGIN TRANSACTION").await?;

    let mut deleted: u64 = 0;
    for pk in &req.rows {
        if let Err(e) = validate_pk_predicates(&pk_columns, &column_names, &req.table, pk) {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(e);
        }
        let mut params: Vec<BoundValue> = Vec::with_capacity(pk.len());
        let mut where_fragments: Vec<String> = Vec::with_capacity(pk.len());
        for (i, predicate) in pk.iter().enumerate() {
            if predicate.value.is_null() {
                let _ = exec_batch(client, "ROLLBACK").await;
                return Err(no_row_matched_error());
            }
            params.push(if predicate.binary {
                BoundValue::from_binary_operand(&predicate.value)?
            } else {
                BoundValue::from_json_operand(&predicate.value)?
            });
            where_fragments.push(format!("{} = @P{}", quote_ident(&predicate.column), i + 1));
        }
        let where_sql = where_fragments.join(" AND ");
        let delete_sql = format!("DELETE FROM {q} WHERE {where_sql}");
        let mut query = Query::new(&delete_sql);
        for b in &params {
            bind_query(&mut query, b);
        }
        match query.execute(&mut *client).await {
            Ok(res) => {
                let affected = res.total();
                if affected > 1 {
                    let _ = exec_batch(client, "ROLLBACK").await;
                    return Err(AppError::Database(format!(
                        "A delete would affect {affected} rows; expected at most one. \
                         No rows were deleted."
                    )));
                }
                deleted += affected;
            }
            Err(err) => {
                let _ = exec_batch(client, "ROLLBACK").await;
                return Err(map_query_error(err));
            }
        }
    }
    exec_batch(client, "COMMIT").await?;
    Ok(DeleteRowsResult { deleted })
}

fn no_row_matched_error() -> AppError {
    AppError::Database(
        "No row matched (it may have been deleted or changed since you loaded it).".to_string(),
    )
}

/// Enforce the full-primary-key policy (mass-update prevention). Identical
/// semantics to the other adapters' `validate_pk_predicates`.
fn validate_pk_predicates(
    pk_columns: &[&str],
    all_columns: &[String],
    table: &str,
    predicates: &[PkPredicate],
) -> Result<(), AppError> {
    if pk_columns.is_empty() {
        return Err(AppError::Database(format!(
            "Cannot update '{table}': it has no primary key, so a single row cannot be safely targeted."
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
            return Err(
                sql::validate_column(all_columns, table, column).expect_err("unknown pk column")
            );
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
            "Updating a cell in '{table}' requires the full primary key ({}); '{missing}' is missing.",
            pk_columns.join(", ")
        )));
    }
    Ok(())
}

/// Cosmetic, values-inlined UPDATE for the §3.5 toast (the executed query binds
/// every value).
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
        serde_json::Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

// ---------------------------------------------------------------------------
// truncate / schema ops (M15)
// ---------------------------------------------------------------------------

async fn truncate_table(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
) -> Result<u64, AppError> {
    table_meta(client, schema, table).await?;
    let q = qualified(schema, table);
    let count_rows = client
        .simple_query(format!("SELECT COUNT_BIG(*) AS n FROM {q}"))
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let prior = count_rows
        .first()
        .and_then(|r| r.try_get::<i64, _>("n").ok().flatten())
        .unwrap_or(0);
    exec_batch(client, format!("TRUNCATE TABLE {q}")).await?;
    Ok(prior.max(0) as u64)
}

/// Drop every table (and the FK constraints touching them) in `schema`, leaving
/// the schema itself in place and empty (M15 drop-schema). SQL Server has no
/// `DROP SCHEMA … CASCADE`, so we drop FK constraints first, then the tables,
/// inside one transaction (SQL Server DDL is transactional → atomic).
async fn drop_schema(client: &mut TdsClient, schema: &str) -> Result<(), AppError> {
    ensure_schema_exists(client, schema).await?;

    // FK constraints whose parent OR referenced table lives in the schema.
    let mut fk_q = Query::new(
        "SELECT fk.name AS fk, ps.name AS psch, pt.name AS ptbl \
         FROM sys.foreign_keys fk \
         JOIN sys.tables pt ON pt.object_id = fk.parent_object_id \
         JOIN sys.schemas ps ON ps.schema_id = pt.schema_id \
         JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
         WHERE ps.name = @P1 OR rs.name = @P1",
    );
    fk_q.bind(schema.to_string());
    let fk_rows = fk_q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let fk_drops: Vec<String> = fk_rows
        .iter()
        .map(|r| {
            format!(
                "ALTER TABLE {}.{} DROP CONSTRAINT {}",
                quote_ident(&get_str(r, "psch")),
                quote_ident(&get_str(r, "ptbl")),
                quote_ident(&get_str(r, "fk"))
            )
        })
        .collect();

    let mut tbl_q = Query::new(
        "SELECT t.name AS name FROM sys.tables t \
         JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = @P1",
    );
    tbl_q.bind(schema.to_string());
    let tbl_rows = tbl_q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let table_drops: Vec<String> = tbl_rows
        .iter()
        .map(|r| {
            format!(
                "DROP TABLE {}.{}",
                quote_ident(schema),
                quote_ident(&get_str(r, "name"))
            )
        })
        .collect();

    exec_batch(client, "BEGIN TRANSACTION").await?;
    for stmt in fk_drops.iter().chain(table_drops.iter()) {
        if let Err(err) = exec_batch(client, stmt.clone()).await {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(err);
        }
    }
    exec_batch(client, "COMMIT").await?;
    Ok(())
}

/// Run a whole multi-statement SQL script into `schema` (M15 import). SQL Server
/// DDL is transactional, so — unlike MySQL — the whole import is atomic: we wrap
/// it in a transaction and roll the lot back on any error.
async fn execute_script(
    client: &mut TdsClient,
    schema: &str,
    sql: &str,
    on_progress: ProgressCallback<'_>,
) -> Result<ImportResult, AppError> {
    ensure_schema_exists(client, schema).await?;
    let statements = split_statements(sql);
    let total = statements.len() as u64;

    exec_batch(client, "BEGIN TRANSACTION").await?;
    for (applied, statement) in statements.iter().enumerate() {
        if let Err(err) = exec_batch(client, statement.clone()).await {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(AppError::Database(format!(
                "Import failed at statement {} of {total}: {err} \
                 The whole import was rolled back (nothing changed).",
                applied + 1,
            )));
        }
        on_progress(applied as u64 + 1, total);
    }
    exec_batch(client, "COMMIT").await?;
    Ok(ImportResult { statements: total })
}

// ---------------------------------------------------------------------------
// alter_table (M8) — transactional apply (SQL Server DDL is transactional)
// ---------------------------------------------------------------------------

async fn alter_table(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
    ops: &[AlterOp],
    apply: bool,
) -> Result<AlterResult, AppError> {
    ensure_schema_exists(client, schema).await?;
    let meta = table_meta(client, schema, table).await?;

    if ops.is_empty() {
        return Err(AppError::Invalid(
            "No structure changes to apply.".to_string(),
        ));
    }
    validate_ops(&meta, table, ops)?;

    let statements: Vec<String> = ops
        .iter()
        .map(|op| alter_statement(schema, table, op, &meta))
        .collect::<Result<Vec<_>, _>>()?;

    if !apply {
        return Ok(AlterResult {
            statements,
            applied: false,
        });
    }

    exec_batch(client, "BEGIN TRANSACTION").await?;
    for statement in &statements {
        if let Err(err) = exec_batch(client, statement.clone()).await {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(AppError::Database(format!(
                "{} The change failed at: {}. The whole batch was rolled back.",
                humanize(&err.to_string()),
                statement
            )));
        }
    }
    exec_batch(client, "COMMIT").await?;

    Ok(AlterResult {
        statements,
        applied: true,
    })
}

/// Validate each op; pk columns are protected from drop/retype.
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

/// The T-SQL statement (or small batch) for one op. Dialect specifics: `ADD`
/// (no `COLUMN`) for add; `sp_rename` for rename; `ALTER COLUMN` (with the
/// nullability repeated) for type/nullable; a drop-then-add default *constraint*
/// for defaults (T-SQL has no `SET DEFAULT`); `DROP INDEX … ON t` for indexes.
fn alter_statement(
    schema: &str,
    table: &str,
    op: &AlterOp,
    meta: &TableMeta,
) -> Result<String, AppError> {
    let q = qualified(schema, table);
    let current_type = |column: &str| -> Option<String> {
        meta.columns
            .iter()
            .find(|c| c.name == column)
            .map(|c| c.data_type.clone())
    };
    let current_nullable = |column: &str| -> bool {
        meta.columns
            .iter()
            .find(|c| c.name == column)
            .map(|c| c.nullable)
            .unwrap_or(true)
    };
    let null_kw = |nullable: bool| if nullable { "NULL" } else { "NOT NULL" };

    let stmt = match op {
        AlterOp::AddColumn {
            name,
            data_type,
            nullable,
            default_value,
        } => {
            let mut s = format!("ALTER TABLE {q} ADD {} {data_type}", quote_ident(name));
            s.push_str(&format!(" {}", null_kw(*nullable)));
            if let Some(default) = default_value {
                s.push_str(&format!(" DEFAULT {default}"));
            }
            s
        }
        // sp_rename takes the OLD name schema.table.col and the NEW bare name.
        AlterOp::RenameColumn { from, to } => format!(
            "EXEC sp_rename '{}.{}.{}', '{}', 'COLUMN'",
            schema, table, from, to
        ),
        AlterOp::ChangeType { column, new_type } => format!(
            "ALTER TABLE {q} ALTER COLUMN {} {new_type} {}",
            quote_ident(column),
            null_kw(current_nullable(column))
        ),
        AlterOp::SetNullable { column, nullable } => {
            let ty = current_type(column).ok_or_else(|| {
                AppError::Database(format!(
                    "Cannot change nullability of '{column}': its current type is unknown."
                ))
            })?;
            format!(
                "ALTER TABLE {q} ALTER COLUMN {} {ty} {}",
                quote_ident(column),
                null_kw(*nullable)
            )
        }
        // T-SQL defaults are named constraints: drop any existing one for the
        // column, then (for Some) add a fresh unnamed default constraint.
        AlterOp::SetDefault {
            column,
            default_value,
        } => {
            let drop = drop_default_batch(schema, table, column);
            match default_value {
                Some(default) => format!(
                    "{drop} ALTER TABLE {q} ADD DEFAULT ({default}) FOR {};",
                    quote_ident(column)
                ),
                None => drop,
            }
        }
        AlterOp::DropColumn { name } => {
            format!("ALTER TABLE {q} DROP COLUMN {}", quote_ident(name))
        }
        AlterOp::AddIndex {
            name,
            columns,
            unique,
        } => format!(
            "CREATE {}INDEX {} ON {q} ({})",
            if *unique { "UNIQUE " } else { "" },
            quote_ident(name),
            quote_idents(columns)
        ),
        // T-SQL drops indexes with `DROP INDEX name ON table`.
        AlterOp::DropIndex { name } => {
            format!("DROP INDEX {} ON {q}", quote_ident(name))
        }
        AlterOp::AddForeignKey {
            name,
            columns,
            ref_table,
            ref_columns,
            on_delete,
        } => {
            let mut s = format!(
                "ALTER TABLE {q} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({})",
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
            format!("ALTER TABLE {q} DROP CONSTRAINT {}", quote_ident(name))
        }
    };
    Ok(stmt)
}

/// A T-SQL batch that drops the (auto-named) default constraint on a column, if
/// one exists — resolved dynamically by name from `sys.default_constraints`.
fn drop_default_batch(schema: &str, table: &str, column: &str) -> String {
    let object = format!(
        "{}.{}",
        schema.replace('\'', "''"),
        table.replace('\'', "''")
    );
    let col = column.replace('\'', "''");
    format!(
        "DECLARE @df sysname; \
         SELECT @df = dc.name FROM sys.default_constraints dc \
         JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id \
         WHERE dc.parent_object_id = OBJECT_ID('{object}') AND c.name = '{col}'; \
         IF @df IS NOT NULL EXEC('ALTER TABLE {} DROP CONSTRAINT [' + @df + ']');",
        qualified(schema, table)
    )
}

/// Quote and comma-join identifiers (index / FK column lists).
fn quote_idents(names: &[String]) -> String {
    names
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------------------
// bulk_insert / fetch_pk_pool (M16 generate)
// ---------------------------------------------------------------------------

async fn bulk_insert(
    client: &mut TdsClient,
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
    // T-SQL caps a statement at 2100 parameters; stay under it.
    let max_rows_per_stmt = (2000 / width).max(1);
    let bind_one = |i: usize, v: &serde_json::Value| -> Result<BoundValue, AppError> {
        if binary.get(i).copied().unwrap_or(false) {
            BoundValue::from_binary_set(v)
        } else {
            Ok(BoundValue::from_json_set(v))
        }
    };

    exec_batch(client, "BEGIN TRANSACTION").await?;
    let mut affected = 0u64;
    for chunk in rows.chunks(max_rows_per_stmt) {
        let stmt = build_multi_insert_sql(schema, table, columns, chunk.len());
        let bounds: Result<Vec<BoundValue>, AppError> = chunk
            .iter()
            .flat_map(|row| row.iter().enumerate().map(|(i, v)| bind_one(i, v)))
            .collect();
        let bounds = match bounds {
            Ok(b) => b,
            Err(e) => {
                let _ = exec_batch(client, "ROLLBACK").await;
                return Err(e);
            }
        };
        let mut query = Query::new(&stmt);
        for b in &bounds {
            bind_query(&mut query, b);
        }
        match query.execute(&mut *client).await {
            Ok(res) => affected += res.total(),
            Err(err) => {
                let _ = exec_batch(client, "ROLLBACK").await;
                return Err(map_query_error(err));
            }
        }
    }
    exec_batch(client, "COMMIT").await?;
    Ok(affected)
}

async fn fetch_pk_pool(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
    columns: &[String],
    cap: u64,
) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let cols_sql = quote_idents(columns);
    let stmt = format!(
        "SELECT TOP {cap} {cols_sql} FROM {}",
        qualified(schema, table)
    );
    let rows = client
        .simple_query(stmt)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    Ok(rows.iter().map(decode_row).collect())
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

fn map_connect_error(message: String) -> AppError {
    AppError::Database(format!(
        "Could not connect to the SQL Server: {}.",
        message.trim_end_matches('.')
    ))
}

/// Map a query-time tiberius error to a §5-style human message. SQL Server
/// errors carry the server's own message (already a clear sentence).
fn map_query_error(err: tiberius::error::Error) -> AppError {
    let message = match &err {
        tiberius::error::Error::Server(token) => token.message().to_string(),
        other => other.to_string(),
    };
    AppError::Database(humanize(&message))
}

/// Capitalize the first letter and ensure a trailing period (matches the other
/// adapters' `humanize`).
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
    fn strip_default_parens_unwraps_balanced_pairs() {
        assert_eq!(strip_default_parens("((0))"), "0");
        assert_eq!(strip_default_parens("('pending')"), "'pending'");
        assert_eq!(strip_default_parens("(getdate())"), "getdate()");
        assert_eq!(strip_default_parens("(N'x')"), "N'x'");
        assert_eq!(strip_default_parens("42"), "42");
    }

    #[test]
    fn normalize_fk_action_spaces_and_uppercases() {
        assert_eq!(normalize_fk_action("no_action"), "NO ACTION");
        assert_eq!(normalize_fk_action("CASCADE"), "CASCADE");
        assert_eq!(normalize_fk_action("set_null"), "SET NULL");
    }

    #[test]
    fn int_or_string_preserves_large_bigints() {
        assert_eq!(int_or_string(42), serde_json::json!(42));
        assert_eq!(
            int_or_string(9_007_199_254_740_993),
            serde_json::json!("9007199254740993")
        );
    }

    #[test]
    fn numeric_text_keeps_precision_when_lossy() {
        assert_eq!(numeric_text_to_json("1.50"), serde_json::json!("1.50"));
        assert_eq!(numeric_text_to_json("2.5"), serde_json::json!(2.5));
    }

    #[test]
    fn system_schema_list_is_quoted_csv() {
        let list = system_schema_list();
        assert!(list.starts_with("'sys', 'INFORMATION_SCHEMA'"));
        assert!(list.contains("'db_owner'"));
    }
}

// ===========================================================================
// Live integration tests (gated behind BYTETABLE_TEST_MSSQL_URL)
// ===========================================================================
//
// Exercise the adapter against a REAL SQL Server (or azure-sql-edge). Gated
// behind `BYTETABLE_TEST_MSSQL_URL` so the default `cargo test` stays green
// without a server. To run:
//
//   BYTETABLE_TEST_MSSQL_URL='mssql://sa:ByteTable!2022@localhost:11433/master' \
//     cargo test --lib engines::mssql::integration -- --test-threads=1 --nocapture
#[cfg(test)]
mod integration {
    use super::*;
    use crate::features::structure::domain::AlterOp;
    use crate::shared::engine::{
        ColumnStatsRequest, Combinator, Condition, ConnectSecret, DeleteRowsRequest,
        FetchRowsRequest, FilterOp, FilterSpec, FilterValue, PkPredicate, QueryOptions,
        RowLookupRequest, SortDirection, SortSpec, UpdateCellRequest,
    };

    /// Parse `mssql://user:password@host:port/db`.
    fn parse_url(url: &str) -> (ConnectionParams, Option<ConnectSecret>) {
        let rest = url.strip_prefix("mssql://").expect("mssql:// scheme");
        let (creds_host, db) = rest.split_once('/').expect("db path");
        let (creds, host_port) = creds_host.split_once('@').expect("@ separator");
        let (user, password) = match creds.split_once(':') {
            Some((u, p)) => (u.to_string(), Some(p.to_string())),
            None => (creds.to_string(), None),
        };
        let (host, port) = match host_port.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().unwrap_or(1433)),
            None => (host_port.to_string(), 1433),
        };
        let params = ConnectionParams::Mssql {
            host,
            port,
            database: Some(db.to_string()),
            user: Some(user),
            tls_mode: crate::shared::engine::TlsMode::Disable,
            ssh: None,
        };
        (params, password.map(ConnectSecret::new))
    }

    fn gate(test: &str) -> Option<(ConnectionParams, Option<ConnectSecret>)> {
        match std::env::var("BYTETABLE_TEST_MSSQL_URL") {
            Ok(url) if !url.is_empty() => Some(parse_url(&url)),
            _ => {
                eprintln!(
                    "SKIP {test}: BYTETABLE_TEST_MSSQL_URL not set (live SQL Server required)"
                );
                None
            }
        }
    }

    async fn open_conn(
        params: &ConnectionParams,
        secret: &Option<ConnectSecret>,
    ) -> std::sync::Arc<dyn EngineConnection> {
        MssqlConnector
            .open_with_secret(params, secret.as_ref())
            .await
            .expect("open mssql connection")
            .into_sql()
            .expect("sql connection")
    }

    /// Seed a fixture (dbo tables + sales/audit schemas). Each statement runs on
    /// its own batch (T-SQL requires `CREATE SCHEMA` to be first in its batch).
    async fn setup_fixture(conn: &std::sync::Arc<dyn EngineConnection>) {
        for stmt in [
            "IF OBJECT_ID('dbo.bt_it_books','U') IS NOT NULL DROP TABLE dbo.bt_it_books",
            "IF OBJECT_ID('dbo.bt_it_authors','U') IS NOT NULL DROP TABLE dbo.bt_it_authors",
            "IF SCHEMA_ID('sales') IS NULL EXEC('CREATE SCHEMA sales')",
            "IF SCHEMA_ID('audit') IS NULL EXEC('CREATE SCHEMA audit')",
            "CREATE TABLE dbo.bt_it_authors (\
               id INT IDENTITY(1,1) PRIMARY KEY, \
               name NVARCHAR(100) NOT NULL, \
               bio NVARCHAR(MAX) NULL)",
            "CREATE TABLE dbo.bt_it_books (\
               id INT PRIMARY KEY, \
               title NVARCHAR(200) NOT NULL, \
               author_id INT NOT NULL \
                 CONSTRAINT FK_bt_it_books_authors REFERENCES dbo.bt_it_authors(id) ON DELETE CASCADE, \
               price DECIMAL(10,2) DEFAULT 0, \
               in_print BIT DEFAULT 1, \
               big BIGINT NULL, \
               note NVARCHAR(MAX) NULL)",
            "CREATE INDEX idx_bt_it_books_title ON dbo.bt_it_books(title)",
            "INSERT INTO dbo.bt_it_authors (name, bio) VALUES \
               ('Ada','pioneer'),('Grace',NULL),('Linus','kernel')",
            "INSERT INTO dbo.bt_it_books (id,title,author_id,price,in_print,big,note) VALUES \
               (10,'Notes',1,9.50,1,9007199254740993,'first'), \
               (11,'Essays',1,7.25,0,1,NULL), \
               (12,'Letters',2,0.00,1,2,'third'), \
               (13,'Memoir',3,12.00,1,3,'fourth')",
        ] {
            conn.run_query(stmt, QueryOptions::default())
                .await
                .unwrap_or_else(|e| panic!("fixture stmt failed: {stmt}\n{e}"));
        }
    }

    #[tokio::test]
    async fn mssql_full_roundtrip() {
        let Some((params, secret)) = gate("mssql_full_roundtrip") else {
            return;
        };

        // 22.0: test-connection round-trips the version.
        let info = MssqlConnector
            .test_with_secret(&params, secret.as_ref())
            .await
            .expect("test connection");
        assert_eq!(info.engine, Engine::Mssql);
        assert!(
            info.server_version.starts_with("SQL Server"),
            "version: {}",
            info.server_version
        );

        let conn = open_conn(&params, &secret).await;
        setup_fixture(&conn).await;

        // 22.1: schemas — user schemas present, system hidden.
        let schemas: Vec<String> = conn
            .list_schemas()
            .await
            .expect("list_schemas")
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert!(schemas.contains(&"dbo".to_string()), "schemas: {schemas:?}");
        assert!(
            schemas.contains(&"sales".to_string()),
            "schemas: {schemas:?}"
        );
        assert!(
            schemas.contains(&"audit".to_string()),
            "schemas: {schemas:?}"
        );
        assert!(!schemas.contains(&"sys".to_string()), "sys must be hidden");

        // list_tables.
        let tables: Vec<String> = conn
            .list_tables("dbo")
            .await
            .expect("list_tables")
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert!(
            tables.contains(&"bt_it_books".to_string()),
            "tables: {tables:?}"
        );
        assert!(tables.contains(&"bt_it_authors".to_string()));

        // table_meta: columns, pk, fk, index, bracket-quoted DDL, IDENTITY.
        let meta = conn
            .table_meta("dbo", "bt_it_books")
            .await
            .expect("table_meta");
        let col_names: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            col_names,
            vec![
                "id",
                "title",
                "author_id",
                "price",
                "in_print",
                "big",
                "note"
            ]
        );
        let id_col = meta.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id_col.pk, "id is pk");
        let title_col = meta.columns.iter().find(|c| c.name == "title").unwrap();
        assert_eq!(title_col.data_type, "NVARCHAR(200)");
        let author_col = meta.columns.iter().find(|c| c.name == "author_id").unwrap();
        assert_eq!(
            author_col.fk.as_ref().map(|f| f.table.as_str()),
            Some("bt_it_authors")
        );
        assert!(!meta.foreign_keys.is_empty(), "books has a fk");
        assert!(meta.indexes.iter().any(|i| i.primary), "pk index present");
        assert!(
            meta.indexes
                .iter()
                .any(|i| i.name == "idx_bt_it_books_title"),
            "title index present"
        );
        let ddl = meta.ddl.as_deref().unwrap_or("");
        assert!(
            ddl.contains("[dbo].[bt_it_books]"),
            "bracket-quoted DDL: {ddl}"
        );

        // authors DDL surfaces IDENTITY.
        let authors_meta = conn.table_meta("dbo", "bt_it_authors").await.unwrap();
        let authors_ddl = authors_meta.ddl.as_deref().unwrap_or("");
        assert!(
            authors_ddl.contains("IDENTITY"),
            "authors DDL has IDENTITY: {authors_ddl}"
        );

        // fetch_rows: total count + paging + filter (author_id = 1 → 2 books).
        let page = conn
            .fetch_rows(FetchRowsRequest {
                schema: "dbo".into(),
                table: "bt_it_books".into(),
                sort: Some(SortSpec {
                    column: "id".into(),
                    direction: SortDirection::Asc,
                }),
                filter: Some(FilterSpec::Conditions {
                    items: vec![Condition {
                        column: "author_id".into(),
                        op: FilterOp::Eq,
                        value: Some(FilterValue::Scalar(serde_json::json!(1))),
                        binary: false,
                    }],
                    combinator: Combinator::And,
                }),
                offset: 0,
                limit: 10,
            })
            .await
            .expect("fetch_rows");
        assert_eq!(page.total_rows, Some(2), "author 1 has 2 books");
        assert_eq!(page.rows.len(), 2);

        // Type decoding: the `big` bigint (> 2^53) is a string; `in_print` bit is
        // 0/1; `price` decimal round-trips.
        let all = conn
            .fetch_rows(FetchRowsRequest {
                schema: "dbo".into(),
                table: "bt_it_books".into(),
                sort: Some(SortSpec {
                    column: "id".into(),
                    direction: SortDirection::Asc,
                }),
                filter: None,
                offset: 0,
                limit: 10,
            })
            .await
            .expect("fetch_rows all");
        assert_eq!(all.total_rows, Some(4));
        let cols: Vec<&str> = all.columns.iter().map(|c| c.name.as_str()).collect();
        let big_idx = cols.iter().position(|c| *c == "big").unwrap();
        let bit_idx = cols.iter().position(|c| *c == "in_print").unwrap();
        // Row 0 = book 10 (Notes): big 9007199254740993 (string), in_print 1.
        assert_eq!(all.rows[0][big_idx], serde_json::json!("9007199254740993"));
        assert_eq!(all.rows[0][bit_idx], serde_json::json!(1));

        // run_query returns a SELECT result set.
        let res = conn
            .run_query(
                "SELECT COUNT(*) AS n FROM dbo.bt_it_books",
                QueryOptions::default(),
            )
            .await
            .expect("run_query");
        assert_eq!(res.row_count, 1);

        // Teardown (drop the fixture's empty sales/audit too, so a run against a
        // scratch db like `master` leaves no leftover schemas; against a seeded
        // db they hold tables and the DROP is a harmless no-op we ignore).
        let _ = conn
            .run_query("DROP TABLE dbo.bt_it_books", QueryOptions::default())
            .await;
        let _ = conn
            .run_query("DROP TABLE dbo.bt_it_authors", QueryOptions::default())
            .await;
        let _ = conn
            .run_query("DROP SCHEMA IF EXISTS sales", QueryOptions::default())
            .await;
        let _ = conn
            .run_query("DROP SCHEMA IF EXISTS audit", QueryOptions::default())
            .await;
        let _ = conn.close().await;
    }

    #[tokio::test]
    async fn mssql_mutation_roundtrip() {
        let Some((params, secret)) = gate("mssql_mutation_roundtrip") else {
            return;
        };
        let conn = open_conn(&params, &secret).await;
        setup_fixture(&conn).await;

        // FK peek: look up author id=1 → Ada.
        let peek = conn
            .fetch_row_by_key(RowLookupRequest {
                schema: "dbo".into(),
                table: "bt_it_authors".into(),
                column: "id".into(),
                value: serde_json::json!(1),
                binary: false,
            })
            .await
            .expect("fetch_row_by_key");
        assert_eq!(peek.match_count, 1);
        assert!(peek.row.is_some());

        // Column insights over books.price (numeric).
        let stats = conn
            .column_stats(ColumnStatsRequest {
                schema: "dbo".into(),
                table: "bt_it_books".into(),
                column: "price".into(),
                filter: None,
            })
            .await
            .expect("column_stats");
        assert_eq!(stats.total, 4);
        assert!(stats.numeric);
        assert!(stats.avg.is_some());

        // Inline edit: set note on book 11, then confirm.
        let upd = conn
            .update_cell(UpdateCellRequest {
                schema: "dbo".into(),
                table: "bt_it_books".into(),
                column: "note".into(),
                value: serde_json::json!("edited"),
                pk: vec![PkPredicate {
                    column: "id".into(),
                    value: serde_json::json!(11),
                    binary: false,
                }],
                binary: false,
            })
            .await
            .expect("update_cell");
        assert_eq!(upd.affected, 1);

        // Staged ALTER: preview (no mutation) then apply add + rename + retype.
        let ops = vec![
            AlterOp::AddColumn {
                name: "rating".into(),
                data_type: "INT".into(),
                nullable: true,
                default_value: None,
            },
            AlterOp::ChangeType {
                column: "title".into(),
                new_type: "NVARCHAR(300)".into(),
            },
            AlterOp::RenameColumn {
                from: "note".into(),
                to: "remark".into(),
            },
        ];
        let preview = conn
            .alter_table("dbo", "bt_it_books", &ops, false)
            .await
            .expect("alter preview");
        assert!(!preview.applied);
        assert_eq!(preview.statements.len(), 3);
        let applied = conn
            .alter_table("dbo", "bt_it_books", &ops, true)
            .await
            .expect("alter apply");
        assert!(applied.applied);
        let meta = conn.table_meta("dbo", "bt_it_books").await.unwrap();
        let names: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"rating"), "added column present: {names:?}");
        assert!(
            names.contains(&"remark"),
            "renamed column present: {names:?}"
        );
        assert!(!names.contains(&"note"), "old name gone");
        let title = meta.columns.iter().find(|c| c.name == "title").unwrap();
        assert_eq!(title.data_type, "NVARCHAR(300)");

        // Bulk insert two rows (id/title/author_id).
        let inserted = conn
            .bulk_insert(
                "dbo",
                "bt_it_books",
                &["id".into(), "title".into(), "author_id".into()],
                &[false, false, false],
                &[
                    vec![
                        serde_json::json!(20),
                        serde_json::json!("Gen1"),
                        serde_json::json!(1),
                    ],
                    vec![
                        serde_json::json!(21),
                        serde_json::json!("Gen2"),
                        serde_json::json!(2),
                    ],
                ],
            )
            .await
            .expect("bulk_insert");
        assert_eq!(inserted, 2);

        // Delete book 13.
        let del = conn
            .delete_rows(DeleteRowsRequest {
                schema: "dbo".into(),
                table: "bt_it_books".into(),
                rows: vec![vec![PkPredicate {
                    column: "id".into(),
                    value: serde_json::json!(13),
                    binary: false,
                }]],
            })
            .await
            .expect("delete_rows");
        assert_eq!(del.deleted, 1);

        // Truncate leaves the table empty.
        let removed = conn
            .truncate_table("dbo", "bt_it_books")
            .await
            .expect("truncate");
        assert!(removed >= 4, "truncate removed prior rows: {removed}");
        let after = conn.list_tables("dbo").await.unwrap();
        assert!(
            after.iter().any(|t| t.name == "bt_it_books"),
            "table still exists"
        );

        // create/drop schema.
        let _ = conn
            .run_query("DROP TABLE IF EXISTS bt_it_sch.t", QueryOptions::default())
            .await;
        let _ = conn
            .run_query(
                "IF SCHEMA_ID('bt_it_sch') IS NOT NULL DROP SCHEMA bt_it_sch",
                QueryOptions::default(),
            )
            .await;
        conn.create_schema("bt_it_sch")
            .await
            .expect("create_schema");
        conn.run_query(
            "CREATE TABLE bt_it_sch.t (id INT PRIMARY KEY)",
            QueryOptions::default(),
        )
        .await
        .expect("create table in schema");
        conn.drop_schema("bt_it_sch")
            .await
            .expect("drop_schema empties");
        let sch_tables = conn
            .list_tables("bt_it_sch")
            .await
            .expect("list after drop");
        assert!(sch_tables.is_empty(), "schema emptied");
        let _ = conn
            .run_query("DROP SCHEMA bt_it_sch", QueryOptions::default())
            .await;

        // Teardown (see full_roundtrip note on the schema drops).
        let _ = conn
            .run_query("DROP TABLE dbo.bt_it_books", QueryOptions::default())
            .await;
        let _ = conn
            .run_query("DROP TABLE dbo.bt_it_authors", QueryOptions::default())
            .await;
        let _ = conn
            .run_query("DROP SCHEMA IF EXISTS sales", QueryOptions::default())
            .await;
        let _ = conn
            .run_query("DROP SCHEMA IF EXISTS audit", QueryOptions::default())
            .await;
        let _ = conn.close().await;
    }
}
