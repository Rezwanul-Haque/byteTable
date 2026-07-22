//! ClickHouse engine adapter (M25): implements the shared `Connector` /
//! `EngineConnection` relational ports over the ClickHouse **HTTP interface**
//! (`reqwest` + `FORMAT JSONCompact`). ClickHouse is a **columnar OLAP** store —
//! SQL, but not OLTP: no transactions, no foreign keys, no per-row primary key.
//! Tables use a table ENGINE (MergeTree family) with an `ORDER BY` sort key (the
//! sparse primary index) and an optional `PARTITION BY`. It is relational enough
//! to reuse the same UI + ports as SQLite/MySQL/Postgres/SQL Server; only the
//! dialect differs (backtick identifiers, `system.*` catalog, ENGINE + ORDER BY
//! DDL, `ALTER TABLE … UPDATE/DELETE` mutations, `clickhouse-client` terminal).
//! Pure dialect helpers live in [`sql`]; this module holds the live HTTP access.
//!
//! # Threading model
//!
//! Unlike the pooled/mutex'd driver adapters, the transport is a
//! `reqwest::Client` (internally an `Arc` connection pool), so it is `Send +
//! Sync` and needs no mutex — every method borrows [`ClickHouseHttp`] and awaits
//! an HTTP round-trip directly.
//!
//! # Password / TLS / SSH
//!
//! Identical seam to the other server adapters: the password arrives as a
//! transient [`ConnectSecret`] (never persisted), the granular `tls_mode`
//! selects the HTTP/HTTPS scheme + cert trust ([`http`]), and a tunnelled
//! connection opens an SSH local-forward first ([`crate::engines::ssh`]) and
//! points the socket at the local endpoint. engine_info comes from
//! `SELECT version()`.
//!
//! # Value → JSON
//!
//! `FORMAT JSONCompact` already maps ClickHouse values onto the
//! [`QueryResult`](crate::shared::engine::QueryResult) JSON contract: 64-bit
//! ints/decimals arrive as JSON *strings* (precision-safe), `Nullable` NULL as
//! JSON null, arrays/maps/tuples as JSON arrays/objects — so decoding is
//! near-identity (see [`http`]).

mod error;
mod http;
mod introspect;
mod mutate;
mod objects;
mod query;
mod sql;
mod structure;
mod value;

use async_trait::async_trait;

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

use http::ClickHouseHttp;

/// Opens ClickHouse connections. Stateless; registered once in `lib.rs`.
pub struct ClickhouseConnector;

#[async_trait]
impl Connector for ClickhouseConnector {
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
        let tunnel = open_tunnel_if_needed(params, secret).await?;
        let (host_over, port_over) = tunnel_override(&tunnel);
        let http = connect_http(params, db_password(secret), host_over, port_over)?;
        read_engine_info(&http).await
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
        let http = connect_http(params, db_password(secret), host_over, port_over)?;
        let info = read_engine_info(&http).await?;
        Ok(OpenConnection::sql(ClickhouseEngineConnection {
            http,
            info,
            _tunnel: tunnel,
        }))
    }
}

/// Build the ClickHouse HTTP transport from [`ConnectionParams::Clickhouse`].
/// `host_override`/`port_override` point the socket at a local SSH-tunnel
/// endpoint; the DSN keeps the real host for the URL host + error messages.
fn connect_http(
    params: &ConnectionParams,
    password: Option<&str>,
    host_override: Option<&str>,
    port_override: Option<u16>,
) -> Result<ClickHouseHttp, AppError> {
    let ConnectionParams::Clickhouse {
        host,
        port,
        database,
        user,
        tls_mode,
        ssh: _,
    } = params
    else {
        return Err(AppError::Invalid(format!(
            "the ClickHouse connector received {} parameters",
            params.engine().display_name()
        )));
    };

    let database = database
        .as_deref()
        .filter(|d| !d.is_empty())
        .unwrap_or("default");
    let user = user
        .as_deref()
        .filter(|u| !u.is_empty())
        .unwrap_or("default");

    // Both tunnel overrides are Some together (or both None); pair them.
    let socket_override = host_override.zip(port_override);
    ClickHouseHttp::new(
        host,
        *port,
        user,
        password.unwrap_or(""),
        database,
        tls_mode.as_token(),
        socket_override,
    )
}

/// Read the server version for the sidebar header (`SELECT version()`).
async fn read_engine_info(http: &ClickHouseHttp) -> Result<EngineInfo, AppError> {
    let raw = http
        .scalar("SELECT version()")
        .await?
        .map(|v| value::as_string(&v))
        .unwrap_or_default();
    Ok(EngineInfo {
        engine: Engine::Clickhouse,
        server_version: sql::display_version(&raw),
    })
}

/// One open ClickHouse connection (an HTTP transport + the discovered engine
/// info). When reached through an SSH bastion, the live tunnel is held here so it
/// lives exactly as long as the session.
pub struct ClickhouseEngineConnection {
    http: ClickHouseHttp,
    info: EngineInfo,
    _tunnel: Option<SshTunnel>,
}

#[async_trait]
impl EngineConnection for ClickhouseEngineConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
        introspect::list_schemas(&self.http).await
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
        introspect::list_tables(&self.http, schema).await
    }

    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
        introspect::table_meta(&self.http, schema, table).await
    }

    fn object_kinds(&self) -> &'static [DbObjectKind] {
        objects::KINDS
    }

    async fn list_objects(
        &self,
        schema: &str,
        kind: DbObjectKind,
    ) -> Result<Vec<DbObjectInfo>, AppError> {
        objects::list(&self.http, schema, kind).await
    }

    async fn object_definition(
        &self,
        schema: &str,
        kind: DbObjectKind,
        name: &str,
        detail: Option<&str>,
    ) -> Result<DbObjectDefinition, AppError> {
        objects::definition(&self.http, schema, kind, name, detail).await
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
        query::run_query(&self.http, sql, options).await
    }

    async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
        query::fetch_rows(&self.http, req).await
    }

    async fn fetch_row_by_key(&self, req: RowLookupRequest) -> Result<RowLookup, AppError> {
        query::fetch_row_by_key(&self.http, &req).await
    }

    async fn column_stats(&self, req: ColumnStatsRequest) -> Result<ColumnStats, AppError> {
        query::column_stats(&self.http, &req).await
    }

    async fn alter_table(
        &self,
        schema: &str,
        table: &str,
        ops: &[AlterOp],
        apply: bool,
    ) -> Result<AlterResult, AppError> {
        structure::alter_table(&self.http, schema, table, ops, apply).await
    }

    async fn update_cell(&self, req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
        mutate::update_cell(&self.http, &req).await
    }

    async fn delete_rows(&self, req: DeleteRowsRequest) -> Result<DeleteRowsResult, AppError> {
        mutate::delete_rows(&self.http, &req).await
    }

    async fn truncate_table(&self, schema: &str, table: &str) -> Result<u64, AppError> {
        mutate::truncate_table(&self.http, schema, table).await
    }

    async fn drop_schema(&self, schema: &str) -> Result<(), AppError> {
        mutate::drop_schema(&self.http, schema).await
    }

    async fn create_schema(&self, schema: &str) -> Result<(), AppError> {
        mutate::create_schema(&self.http, schema).await
    }

    async fn execute_script(
        &self,
        schema: &str,
        sql: &str,
        on_progress: ProgressCallback<'_>,
    ) -> Result<ImportResult, AppError> {
        mutate::execute_script(&self.http, schema, sql, on_progress).await
    }

    /// ClickHouse identifiers are backtick-quoted (M15 export asks the connection
    /// to quote per-dialect).
    fn quote_identifier(&self, ident: &str) -> String {
        sql::quote_ident(ident)
    }

    /// ClickHouse binary literal for a SQL dump: `unhex('..')` yields the bytes
    /// into a String/FixedString column (empty → `unhex('')`).
    fn binary_literal(&self, hex: &str) -> String {
        format!("unhex('{hex}')")
    }

    async fn close(&self) -> Result<(), AppError> {
        // reqwest has no explicit close; the connection pool drops with the
        // client. Nothing to do here.
        Ok(())
    }
}
