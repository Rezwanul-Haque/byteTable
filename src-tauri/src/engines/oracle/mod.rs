//! Oracle Database engine adapter (M23): a **fifth relational engine** behind the
//! shared `Connector` / `EngineConnection` SQL ports — it reuses the same UI and
//! ports as SQLite/MySQL/Postgres/SQL Server; only the Oracle SQL / PL/SQL
//! dialect differs (double-quoted UPPERCASE identifiers, `:N` binds,
//! `OFFSET…FETCH` paging, `GENERATED … AS IDENTITY`, the `ALL_*` catalog,
//! user-schemas, real materialized views, `SYSTIMESTAMP`/`SYS_GUID()` defaults,
//! the `sqlplus` terminal).
//!
//! # Module layout — dialect vs. driver
//!
//! Follows the canonical relational-adapter split (see `engines/mod.rs`), with
//! one twist: the split is by *compilation condition* as well as responsibility.
//!
//! - [`sql`] — the **pure Oracle dialect** (identifier quoting, `:N` WHERE
//!   compilation, type/default mapping, column DDL, paging, banner-version
//!   formatting). It has **no dependency on the `oracle` crate** and is compiled
//!   UNCONDITIONALLY, so its unit tests run in the default pure-Rust build.
//! - `introspect` / `query` / `objects` / `error` — the **live OCI access**
//!   (`ALL_*` introspection, run/fetch/decode, the object browser, driver-error
//!   mapping). Together with the connector + `EngineConnection` dispatch in this
//!   file, they are gated behind the **`engine-oracle`** Cargo feature and only
//!   compile when it is enabled (a host with the Oracle Instant Client at
//!   runtime).
//!
//! # Threading model (driver)
//!
//! rust-`oracle` is a **blocking** driver (no async). A ByteTable connection owns
//! one [`oracle::Connection`] behind a [`std::sync::Mutex`] inside an [`Arc`];
//! every async port method hops onto the blocking pool via
//! [`tokio::task::spawn_blocking`] ([`with_conn`]), locks the connection, runs
//! the OCI calls, and releases — mirroring how the SQLite adapter bridges the
//! blocking `rusqlite`.
//!
//! # Scope (first increment)
//!
//! Read path + object listing: connect/test, `v$version`, `ALL_*` introspection,
//! arbitrary query, paged browse, and the object browser. The write path (inline
//! edit, structure ALTER, bulk insert, import) keeps the trait's default
//! `Unsupported` for now — a later subtask fills it in, exactly as the other
//! engines were built up across milestones.
//!
//! # Why the OCI driver is optional
//!
//! Oracle has no viable pure-Rust driver: the mature `oracle` crate wraps ODPI-C
//! and dlopen's the **Oracle Instant Client** (`libclntsh`) at runtime, and the
//! pure-protocol `oracledb` crate forces nightly Rust + a `pyo3` build dependency
//! and is brand-new/experimental. Feature-gating the driver keeps the default
//! build (CI + release) pure-Rust, stable, and free of any Oracle system
//! dependency. See `Cargo.toml` and `docs/M23-oracle-engine.md`.
//!
//! # TLS
//!
//! Plain TCP and SSH-tunnelled TCP are supported now. Oracle native TLS (TCPS)
//! needs a wallet/`ewallet.pem` configuration; `tls_mode: require`/`verify-*` is
//! accepted but currently connects over TCP — wallet support is a follow-up.

pub mod sql;

#[cfg(feature = "engine-oracle")]
mod error;
#[cfg(feature = "engine-oracle")]
mod introspect;
#[cfg(feature = "engine-oracle")]
mod objects;
#[cfg(feature = "engine-oracle")]
mod query;

#[cfg(feature = "engine-oracle")]
mod driver {
    //! Connector + `EngineConnection` dispatch: open/connect only. The SQL for
    //! each concern lives in the sibling `introspect`/`query`/`objects` modules;
    //! this dispatch locks the blocking connection and delegates (the canonical
    //! adapter layout, adapted for a sync driver behind a mutex).

    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use oracle::Connection;

    use crate::shared::engine::{
        ConnectSecret, ConnectionParams, Connector, DbObjectDefinition, DbObjectInfo, DbObjectKind,
        Engine, EngineConnection, EngineInfo, FetchRowsRequest, OpenConnection, QueryOptions,
        QueryResult, RowsPage, SchemaInfo, TableInfo, TableMeta,
    };
    use crate::shared::error::AppError;

    use crate::engines::ssh::{db_password, open_tunnel_if_needed, tunnel_override, SshTunnel};

    use super::error::{join_err, map_ora_connect_err, map_ora_query_err};
    use super::sql::quote_ident;
    use super::{introspect, objects, query};

    /// The shared, blocking connection handle. `std::sync::Mutex<Connection>` is
    /// `Send + Sync` (Connection is `Send`), so it is safe to move a clone into
    /// `spawn_blocking` and lock it there.
    type SharedConn = Arc<Mutex<Connection>>;

    /// Opens Oracle connections. Stateless; registered once in `lib.rs` when the
    /// `engine-oracle` feature is on.
    pub struct OracleConnector;

    #[async_trait]
    impl Connector for OracleConnector {
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
            let conn = connect_client(params, db_password(secret), host_over, port_over).await?;
            let info = read_engine_info(&conn).await?;
            // Drop the connection (and tunnel) at scope end — test keeps nothing.
            let _ = conn;
            Ok(info)
        }

        async fn open_with_secret(
            &self,
            params: &ConnectionParams,
            secret: Option<&ConnectSecret>,
        ) -> Result<OpenConnection, AppError> {
            let tunnel = open_tunnel_if_needed(params, secret).await?;
            let (host_over, port_over) = tunnel_override(&tunnel);
            let conn = connect_client(params, db_password(secret), host_over, port_over).await?;
            let info = read_engine_info(&conn).await?;
            Ok(OpenConnection::sql(OracleEngineConnection {
                conn,
                info,
                _tunnel: tunnel,
            }))
        }
    }

    /// Build an easy-connect DSN and open a blocking [`oracle::Connection`] on the
    /// blocking pool. `host_override`/`port_override` point the TCP socket at a
    /// local SSH-tunnel endpoint when tunnelling.
    async fn connect_client(
        params: &ConnectionParams,
        password: Option<&str>,
        host_override: Option<&str>,
        port_override: Option<u16>,
    ) -> Result<SharedConn, AppError> {
        let ConnectionParams::Oracle {
            host,
            port,
            service_name,
            sid,
            user,
            ..
        } = params
        else {
            return Err(AppError::Invalid(format!(
                "the Oracle connector received {} parameters",
                params.engine().display_name()
            )));
        };

        let target_host = host_override.unwrap_or(host).to_string();
        let target_port = port_override.unwrap_or(*port);
        // Easy-connect: `//host:port/service` (service name preferred) or
        // `//host:port:sid` (legacy SID). A bare host uses the listener default.
        let connect_string = match (service_name.as_deref(), sid.as_deref()) {
            (Some(svc), _) if !svc.is_empty() => format!("//{target_host}:{target_port}/{svc}"),
            (_, Some(sid)) if !sid.is_empty() => format!("//{target_host}:{target_port}:{sid}"),
            _ => format!("//{target_host}:{target_port}"),
        };
        let username = user.clone().unwrap_or_default();
        let password = password.unwrap_or("").to_string();

        let conn = tokio::task::spawn_blocking(move || {
            Connection::connect(&username, &password, &connect_string)
        })
        .await
        .map_err(join_err)?
        .map_err(map_ora_connect_err)?;

        Ok(Arc::new(Mutex::new(conn)))
    }

    /// Read the server banner (`v$version`) for the sidebar header.
    async fn read_engine_info(conn: &SharedConn) -> Result<EngineInfo, AppError> {
        let banner = with_conn(conn, |c| {
            let row = c
                .query_row("SELECT banner FROM v$version WHERE ROWNUM = 1", &[])
                .map_err(map_ora_query_err)?;
            let banner: Option<String> = row.get(0).map_err(map_ora_query_err)?;
            Ok(banner.unwrap_or_default())
        })
        .await?;
        Ok(EngineInfo {
            engine: Engine::Oracle,
            server_version: super::sql::display_version(&banner),
        })
    }

    /// Run a blocking closure with the locked connection on the blocking pool.
    async fn with_conn<T, F>(conn: &SharedConn, f: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, AppError> + Send + 'static,
    {
        let conn = Arc::clone(conn);
        tokio::task::spawn_blocking(move || {
            let guard = conn
                .lock()
                .map_err(|_| AppError::Database("the Oracle connection is poisoned".into()))?;
            f(&guard)
        })
        .await
        .map_err(join_err)?
    }

    /// One open Oracle connection (a single blocking session behind a mutex). The
    /// live SSH tunnel (if any) is held here so it lives exactly as long as the
    /// session.
    pub struct OracleEngineConnection {
        conn: SharedConn,
        info: EngineInfo,
        _tunnel: Option<SshTunnel>,
    }

    #[async_trait]
    impl EngineConnection for OracleEngineConnection {
        fn engine_info(&self) -> EngineInfo {
            self.info.clone()
        }

        async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
            with_conn(&self.conn, introspect::list_schemas).await
        }

        async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
            let schema = schema.to_string();
            with_conn(&self.conn, move |c| introspect::list_tables(c, &schema)).await
        }

        async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
            let (schema, table) = (schema.to_string(), table.to_string());
            with_conn(&self.conn, move |c| {
                introspect::table_meta(c, &schema, &table)
            })
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
            with_conn(&self.conn, move |c| objects::list(c, &schema, kind)).await
        }

        async fn object_definition(
            &self,
            schema: &str,
            kind: DbObjectKind,
            name: &str,
            _detail: Option<&str>,
        ) -> Result<DbObjectDefinition, AppError> {
            let (schema, name) = (schema.to_string(), name.to_string());
            with_conn(&self.conn, move |c| {
                objects::definition(c, &schema, kind, &name)
            })
            .await
        }

        fn drop_object_sql(
            &self,
            schema: &str,
            kind: DbObjectKind,
            name: &str,
            _detail: Option<&str>,
        ) -> Result<String, AppError> {
            Ok(objects::drop_sql(schema, kind, name))
        }

        async fn run_query(
            &self,
            sql: &str,
            options: QueryOptions,
        ) -> Result<QueryResult, AppError> {
            let sql = sql.to_string();
            with_conn(&self.conn, move |c| query::run_query(c, &sql, options)).await
        }

        async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
            with_conn(&self.conn, move |c| query::fetch_rows(c, req)).await
        }

        /// Oracle identifiers are double-quoted (M15 export asks the connection to
        /// quote per-dialect).
        fn quote_identifier(&self, ident: &str) -> String {
            quote_ident(ident)
        }

        /// Oracle raw literal: `HEXTORAW('DEADBEEF')` (empty → `HEXTORAW('')`).
        fn binary_literal(&self, hex: &str) -> String {
            format!("HEXTORAW('{hex}')")
        }

        async fn close(&self) -> Result<(), AppError> {
            // Best-effort explicit close; dropping the Arc ends the session anyway.
            with_conn(&self.conn, |c| {
                let _ = c.close();
                Ok(())
            })
            .await
        }
    }
}

#[cfg(feature = "engine-oracle")]
pub use driver::OracleConnector;
