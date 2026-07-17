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

mod bulk;
mod error;
mod introspect;
mod mutate;
mod objects;
mod query;
mod sql;
mod structure;

use async_trait::async_trait;
use tiberius::{AuthMethod, Client, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{
    AlterResult, ColumnStats, ColumnStatsRequest, ConnectSecret, ConnectionParams, Connector,
    DbObjectDefinition, DbObjectInfo, DbObjectKind, DeleteRowsRequest, DeleteRowsResult, Engine,
    EngineConnection, EngineInfo, FetchRowsRequest, ImportResult, OpenConnection, ProgressCallback,
    QueryOptions, QueryResult, RowLookup, RowLookupRequest, RowsPage, SchemaInfo, TableInfo,
    TableMeta, UpdateCellRequest, UpdateResult,
};
use crate::shared::error::AppError;

use crate::engines::ssh::{db_password, open_tunnel_if_needed, tunnel_override, SshTunnel};

use sql::quote_ident;

use bulk::{bulk_insert, fetch_pk_pool};
use error::{map_connect_error, map_query_error};
use introspect::{list_schemas, list_tables, table_meta};
use mutate::{delete_rows, drop_schema, execute_script, truncate_table, update_cell};
use query::{column_stats, fetch_row_by_key, fetch_rows, run_query};
use structure::alter_table;

pub(super) type TdsClient = Client<Compat<TcpStream>>;

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
        let mut client = self.client.lock().await;
        list_schemas(&mut client).await
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
        let mut client = self.client.lock().await;
        list_tables(&mut client, schema).await
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
        let mut client = self.client.lock().await;
        run_query(&mut client, sql, options).await
    }

    async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
        let mut client = self.client.lock().await;
        fetch_rows(&mut client, req).await
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

/// Run a non-parameterized statement (or small batch) as a plain SQL batch via
/// `simple_query`, discarding any result. Transaction control (`BEGIN
/// TRANSACTION`/`COMMIT`/`ROLLBACK`) and DDL MUST go through this, NOT through
/// `Client::execute` — that path wraps the SQL in `sp_executesql` (an RPC scope),
/// and opening a transaction inside that scope trips SQL Server's "mismatching
/// number of BEGIN and COMMIT" guard. A plain batch runs the statement in the
/// connection's own scope, so the transaction spans batches correctly.
pub(super) async fn exec_batch(
    client: &mut TdsClient,
    sql: impl Into<String>,
) -> Result<(), AppError> {
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

#[cfg(test)]
mod integration;
