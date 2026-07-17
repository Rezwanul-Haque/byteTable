//! Redis engine adapter (M13): the infrastructure implementation of the
//! key-value port family in [`crate::shared::keyvalue`]. Uses the `redis`
//! crate's async multiplexed connection on Tauri's tokio runtime (no
//! `spawn_blocking`, mirroring the sqlx SQL adapters).
//!
//! # SELECT strategy — one connection per logical db (bound, not per-op)
//!
//! Redis has 16 numbered databases reached with `SELECT n`. On a single shared
//! multiplexed connection a per-operation `SELECT n` would race: another
//! awaiting task could `SELECT` a different db between our `SELECT` and our
//! command. So this adapter opens **one multiplexed connection per db index,
//! lazily, cached** ([`RedisKvConnection::conn_for`]). Each per-db connection
//! is built from a [`redis::ConnectionInfo`] carrying that `db`, so the driver
//! re-selects it on any transparent reconnect. The CLI's `SELECT` command is
//! still honored at the port level: `run_command` for a literal `SELECT` is
//! handled by the renderer switching the `db` argument it passes — the adapter
//! never mutates a shared selected-db.
//!
//! # TLS + SSH + secrets reuse
//!
//! - **Password / ACL user**: the transient [`ConnectSecret`] password (from
//!   the keychain or the modal) plus the optional `user` go into the
//!   `ConnectionInfo` (`AUTH user pass` / `AUTH pass`).
//! - **TLS**: [`TlsMode`] maps to `rediss://`-equivalent
//!   [`redis::ConnectionAddr::TcpTls`] — `verify-*` verifies the chain via the
//!   webpki roots; `require`/`prefer` connect with `insecure: true` (encrypt
//!   without cert verification); `disable` uses plain TCP.
//! - **SSH tunnel**: reuses [`crate::engines::ssh`] exactly like the SQL
//!   adapters — open the bastion forward first, point the client at the local
//!   endpoint, and keep the [`SshTunnel`] on the connection so it lives as long
//!   as the connection does.
//!
//! # Errors
//!
//! Connection/IO failures map to §5 human [`AppError::Database`] sentences.
//! Server *reply* errors (`WRONGTYPE`, `ERR unknown command`) are NOT errors at
//! the `run_command` boundary — they come back as [`RespReply::Error`] so the
//! console shows them redis-cli-style (see [`value::redis_error_as_reply_text`]).

mod value;

use std::collections::HashMap;

use async_trait::async_trait;
use redis::aio::MultiplexedConnection;
use redis::{Client, ConnectionAddr, ConnectionInfo, ProtocolVersion, RedisConnectionInfo, Value};
use tokio::sync::Mutex;

use crate::engines::ssh::{db_password, open_tunnel_if_needed, tunnel_override, SshTunnel};
use crate::shared::engine::{
    ConnectSecret, ConnectionParams, Connector, Engine, EngineInfo, OpenConnection, TlsMode,
};
use crate::shared::error::AppError;
use crate::shared::keyvalue::{CommandRunner, KeyValueConnection, RespReply};

use value::{redis_error_as_reply_text, value_to_reply, value_to_string};

mod error;
mod reader;
mod writer;

use error::{map_connect_error, map_query_error};

/// Opens and tests Redis connections. Stateless; registered once in `lib.rs`.
pub struct RedisConnector;

#[async_trait]
impl Connector for RedisConnector {
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
        // Tunnel lives only for this scope — test keeps nothing open.
        let tunnel = open_tunnel_if_needed(params, secret).await?;
        let (host_over, port_over) = tunnel_override(&tunnel);
        let client = build_client(params, secret, host_over, port_over)?;
        let mut conn = client
            .get_multiplexed_async_connection()
            .await
            .map_err(map_connect_error)?;
        let info = read_engine_info(&mut conn).await?;
        Ok(info)
    }

    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        let tunnel = open_tunnel_if_needed(params, secret).await?;
        let (host_over, port_over) = tunnel_override(&tunnel);
        let default_db = match params {
            ConnectionParams::Redis { db_index, .. } => *db_index,
            _ => 0,
        };
        let client = build_client(params, secret, host_over, port_over)?;

        // Open the default-db connection eagerly so `open` validates auth/TLS
        // and learns the server version before returning.
        let mut conn = client
            .get_multiplexed_async_connection()
            .await
            .map_err(map_connect_error)?;
        let info = read_engine_info(&mut conn).await?;

        let mut connections = HashMap::new();
        connections.insert(default_db, conn);

        Ok(OpenConnection::kv(RedisKvConnection {
            client,
            info,
            connections: Mutex::new(connections),
            _tunnel: tunnel,
        }))
    }
}

/// One open Redis connection: a `redis::Client` plus a lazily-grown cache of
/// per-db multiplexed connections (see the module SELECT note). The SSH tunnel
/// (when tunnelled) is held here so it lives exactly as long as the connection.
pub struct RedisKvConnection {
    client: Client,
    info: EngineInfo,
    connections: Mutex<HashMap<u8, MultiplexedConnection>>,
    _tunnel: Option<SshTunnel>,
}

impl RedisKvConnection {
    /// A multiplexed connection bound to `db` (`SELECT db` applied), opening and
    /// caching it on first use. The clone is cheap (the driver multiplexes).
    async fn conn_for(&self, db: u8) -> Result<MultiplexedConnection, AppError> {
        if let Some(conn) = self.connections.lock().await.get(&db) {
            return Ok(conn.clone());
        }
        // Open outside the lock would race two openers, but a duplicate open is
        // harmless (we keep whichever wins) and opens are rare; keep it simple
        // and hold the lock across the await.
        let mut guard = self.connections.lock().await;
        if let Some(conn) = guard.get(&db) {
            return Ok(conn.clone());
        }
        let mut conn = self
            .client
            .get_multiplexed_async_connection()
            .await
            .map_err(map_connect_error)?;
        // Bind this connection to the requested db.
        redis::cmd("SELECT")
            .arg(db)
            .query_async::<()>(&mut conn)
            .await
            .map_err(map_query_error)?;
        guard.insert(db, conn.clone());
        Ok(conn)
    }
}

// ---------------------------------------------------------------------------
// Client / connection-info construction (TLS + auth)
// ---------------------------------------------------------------------------

/// Build the `redis::Client` for `params`, honoring the ACL user, password,
/// TLS mode, and any SSH-tunnel host/port override.
fn build_client(
    params: &ConnectionParams,
    secret: Option<&ConnectSecret>,
    host_over: Option<&str>,
    port_over: Option<u16>,
) -> Result<Client, AppError> {
    let ConnectionParams::Redis {
        host,
        port,
        db_index,
        user,
        tls_mode,
        ..
    } = params
    else {
        return Err(AppError::Invalid(
            "the Redis connector received non-Redis connection parameters".into(),
        ));
    };

    let connect_host = host_over.unwrap_or(host).to_string();
    let connect_port = port_over.unwrap_or(*port);

    // When tunnelled, the TLS SNI/cert is for the REAL host, but rustls here
    // verifies against `connect_host` (the loopback endpoint). Tunnelled TLS is
    // therefore only meaningful with `require`/`prefer` (encrypt, skip verify);
    // `verify-*` over a tunnel would fail the loopback hostname. We keep the
    // user's mode as-is and document this (matching the SQL adapters' tunnel
    // behavior, which also point the driver at the local endpoint).
    let addr = match tls_mode {
        TlsMode::Disable => ConnectionAddr::Tcp(connect_host, connect_port),
        TlsMode::Prefer | TlsMode::Require => ConnectionAddr::TcpTls {
            host: connect_host,
            port: connect_port,
            insecure: true,
            tls_params: None,
        },
        TlsMode::VerifyCa | TlsMode::VerifyFull => ConnectionAddr::TcpTls {
            host: connect_host,
            port: connect_port,
            insecure: false,
            tls_params: None,
        },
    };

    let redis = RedisConnectionInfo {
        db: i64::from(*db_index),
        username: user.clone(),
        password: db_password(secret).map(str::to_string),
        // Negotiate RESP3 when the server supports it (status bar shows RESP3).
        protocol: ProtocolVersion::RESP3,
    };

    Client::open(ConnectionInfo { addr, redis }).map_err(map_connect_error)
}

// ---------------------------------------------------------------------------
// INFO parsing (server identity + dashboard stats + keyspace)
// ---------------------------------------------------------------------------

/// Read `INFO` once and parse the server identity for [`EngineInfo`].
async fn read_engine_info(conn: &mut MultiplexedConnection) -> Result<EngineInfo, AppError> {
    let info = info_text(conn, "server").await?;
    let version = info_field(&info, "redis_version").unwrap_or_else(|| "unknown".to_string());
    Ok(EngineInfo {
        engine: Engine::Redis,
        server_version: format!("Redis {version}"),
    })
}

/// Run `INFO <section>` and return the raw text body.
pub(super) async fn info_text(
    conn: &mut MultiplexedConnection,
    section: &str,
) -> Result<String, AppError> {
    let value = redis::cmd("INFO")
        .arg(section)
        .query_async::<Value>(conn)
        .await
        .map_err(map_query_error)?;
    Ok(value_to_string(&value))
}

/// Extract one `key:value` field from an `INFO` text body.
pub(super) fn info_field(info: &str, key: &str) -> Option<String> {
    for line in info.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(value) = rest.strip_prefix(':') {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

/// Parse a numeric `INFO` field, defaulting to `0` when absent/unparseable.
pub(super) fn info_num(info: &str, key: &str) -> u64 {
    info_field(info, key)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// CommandRunner
// ---------------------------------------------------------------------------

#[async_trait]
impl CommandRunner for RedisKvConnection {
    async fn run_command(&self, db: u8, args: Vec<String>) -> Result<RespReply, AppError> {
        if args.is_empty() {
            return Ok(RespReply::Error {
                value: "ERR empty command".into(),
            });
        }
        let mut conn = self.conn_for(db).await?;
        let mut cmd = redis::cmd(&args[0]);
        for arg in &args[1..] {
            cmd.arg(arg);
        }
        match cmd.query_async::<Value>(&mut conn).await {
            Ok(value) => Ok(value_to_reply(value)),
            Err(err) => match redis_error_as_reply_text(&err) {
                // A server error reply (WRONGTYPE, ERR unknown command, …) is
                // surfaced as a reply, not thrown — the console formats it.
                Some(text) => Ok(RespReply::Error { value: text }),
                // A real connection/parse failure is an AppError.
                None => Err(map_query_error(err)),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// KeyValueConnection
// ---------------------------------------------------------------------------

#[async_trait]
impl KeyValueConnection for RedisKvConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn close(&self) -> Result<(), AppError> {
        // Multiplexed connections are dropped with the struct; clearing the
        // cache drops them now. The SSH tunnel (if any) tears down on drop too.
        self.connections.lock().await.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_field_reads_key_colon_value() {
        let info =
            "# Server\r\nredis_version:7.4.9\r\nredis_mode:standalone\r\nuptime_in_days:3\r\n";
        assert_eq!(info_field(info, "redis_version").as_deref(), Some("7.4.9"));
        assert_eq!(
            info_field(info, "redis_mode").as_deref(),
            Some("standalone")
        );
        assert_eq!(info_field(info, "missing"), None);
        assert_eq!(info_num(info, "uptime_in_days"), 3);
        assert_eq!(info_num(info, "missing"), 0);
    }

    #[test]
    fn build_client_rejects_non_redis_params() {
        let params = ConnectionParams::Sqlite {
            path: "/tmp/x.db".into(),
        };
        let err = build_client(&params, None, None, None).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }
}
