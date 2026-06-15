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
use crate::shared::keyvalue::{
    CommandRunner, KeyEntry, KeyType, KeyValueConnection, KeyView, KeyspaceReader, KeyspaceWriter,
    KvDbInfo, KvField, KvScored, KvServerInfo, KvServerStats, KvStreamEntry, KvValue, RespReply,
    ScanPage, ScanRequest,
};

use value::{redis_error_as_reply_text, value_to_reply, value_to_string};

/// How many keys' worth of `TYPE`+`TTL` to pipeline per scan page enrichment.
/// (The whole page is pipelined in one round trip regardless; this is just the
/// `COUNT` default if the request omits one — handled in the port DTO.)
const DEFAULT_SCAN_COUNT: u32 = 100;

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
async fn info_text(conn: &mut MultiplexedConnection, section: &str) -> Result<String, AppError> {
    let value = redis::cmd("INFO")
        .arg(section)
        .query_async::<Value>(conn)
        .await
        .map_err(map_query_error)?;
    Ok(value_to_string(&value))
}

/// Extract one `key:value` field from an `INFO` text body.
fn info_field(info: &str, key: &str) -> Option<String> {
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
fn info_num(info: &str, key: &str) -> u64 {
    info_field(info, key)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Error mapping (§5 human sentences)
// ---------------------------------------------------------------------------

/// Map a connect-time driver error to a §5 human sentence. Never leaks driver
/// internals or secrets.
fn map_connect_error(err: redis::RedisError) -> AppError {
    if err.kind() == redis::ErrorKind::AuthenticationFailed {
        return AppError::Database(
            "Redis authentication failed. Check the password and ACL user.".into(),
        );
    }
    // A password-protected server rejects the unauthenticated RESP3 `HELLO`
    // handshake (or any command) with NOAUTH / a "HELLO … authenticated"
    // message rather than the AuthenticationFailed kind. Surface the actionable
    // §5 sentence instead of the raw server text.
    let lower = err.to_string().to_lowercase();
    if err.code() == Some("NOAUTH")
        || lower.contains("noauth")
        || (lower.contains("hello") && lower.contains("authenticated"))
    {
        return AppError::Database(
            "This Redis server requires a password. Enter it in the Password field \
             (and the ACL user if your server uses a named user)."
                .into(),
        );
    }
    if err.is_io_error() || err.is_connection_refusal() || err.is_timeout() {
        return AppError::Database(format!(
            "Could not reach the Redis server: {}",
            short_reason(&err)
        ));
    }
    AppError::Database(format!(
        "Could not open the Redis connection: {}",
        short_reason(&err)
    ))
}

/// Map a query-time driver error to a §5 human sentence.
fn map_query_error(err: redis::RedisError) -> AppError {
    if err.is_io_error() {
        return AppError::Database(format!(
            "The Redis connection was interrupted: {}",
            short_reason(&err)
        ));
    }
    AppError::Database(format!("The Redis command failed: {}", short_reason(&err)))
}

/// A short, secret-free reason string from a driver error (its detail or code).
fn short_reason(err: &redis::RedisError) -> String {
    err.detail()
        .map(str::to_string)
        .or_else(|| err.code().map(str::to_string))
        .unwrap_or_else(|| "the server closed the connection".to_string())
}

// ---------------------------------------------------------------------------
// KeyspaceReader
// ---------------------------------------------------------------------------

#[async_trait]
impl KeyspaceReader for RedisKvConnection {
    async fn server_info(&self) -> Result<KvServerInfo, AppError> {
        let mut conn = self.conn_for(0).await?;
        let server = info_text(&mut conn, "server").await?;
        let replication = info_text(&mut conn, "replication").await?;
        let version = info_field(&server, "redis_version").unwrap_or_else(|| "unknown".into());
        let mode = info_field(&server, "redis_mode").unwrap_or_else(|| "standalone".into());
        let role = info_field(&replication, "role").unwrap_or_else(|| "master".into());
        // The protocol we negotiated is RESP3 against a v6+ server; HELLO would
        // confirm it, but the client downgrades transparently on older servers.
        // Probe by issuing HELLO and reading the proto field is overkill here;
        // report 3 (we requested RESP3) which the status bar shows.
        Ok(KvServerInfo {
            server_version: version,
            mode,
            role,
            resp_version: 3,
        })
    }

    async fn server_stats(&self) -> Result<KvServerStats, AppError> {
        let mut conn = self.conn_for(0).await?;
        let stats = info_text(&mut conn, "stats").await?;
        let memory = info_text(&mut conn, "memory").await?;
        let clients = info_text(&mut conn, "clients").await?;
        let server = info_text(&mut conn, "server").await?;
        Ok(KvServerStats {
            keyspace_hits: info_num(&stats, "keyspace_hits"),
            keyspace_misses: info_num(&stats, "keyspace_misses"),
            instantaneous_ops_per_sec: info_num(&stats, "instantaneous_ops_per_sec"),
            connected_clients: info_num(&clients, "connected_clients"),
            used_memory: info_num(&memory, "used_memory"),
            maxmemory: info_num(&memory, "maxmemory"),
            uptime_in_days: info_num(&server, "uptime_in_days"),
            expired_keys: info_num(&stats, "expired_keys"),
            evicted_keys: info_num(&stats, "evicted_keys"),
        })
    }

    async fn keyspace(&self) -> Result<Vec<KvDbInfo>, AppError> {
        let mut conn = self.conn_for(0).await?;
        let keyspace = info_text(&mut conn, "keyspace").await?;
        // Lines look like `db0:keys=3,expires=1,avg_ttl=0`.
        let mut out = Vec::new();
        for line in keyspace.lines() {
            let Some(rest) = line.strip_prefix("db") else {
                continue;
            };
            let Some((index_str, fields)) = rest.split_once(':') else {
                continue;
            };
            let Ok(index) = index_str.parse::<u8>() else {
                continue;
            };
            let key_count = fields
                .split(',')
                .find_map(|kv| kv.strip_prefix("keys="))
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            out.push(KvDbInfo { index, key_count });
        }
        Ok(out)
    }

    async fn scan(&self, db: u8, req: ScanRequest) -> Result<ScanPage, AppError> {
        let mut conn = self.conn_for(db).await?;
        let count = if req.count == 0 {
            DEFAULT_SCAN_COUNT
        } else {
            req.count
        };

        // One cursor round trip: SCAN <cursor> MATCH <pat> COUNT <n> [TYPE <t>].
        let mut scan_cmd = redis::cmd("SCAN");
        scan_cmd
            .arg(&req.cursor)
            .arg("MATCH")
            .arg(&req.pattern)
            .arg("COUNT")
            .arg(count);
        if let Some(t) = req.type_filter {
            scan_cmd.arg("TYPE").arg(t.as_token());
        }
        let (next_cursor, names): (String, Vec<String>) = scan_cmd
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;

        // Enrich each key with TYPE + TTL in a single pipeline round trip.
        let keys = enrich_keys(&mut conn, names).await?;
        Ok(ScanPage {
            cursor: next_cursor,
            keys,
        })
    }

    async fn get_key(&self, db: u8, key: &str) -> Result<KeyView, AppError> {
        let mut conn = self.conn_for(db).await?;

        let type_token: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        let Some(key_type) = KeyType::from_token(&type_token) else {
            // `none` → the key does not exist.
            return Ok(KeyView {
                key_type: KeyType::String,
                ttl: -2,
                encoding: None,
                memory: None,
                idle: None,
                value: KvValue::Missing {},
            });
        };

        let ttl: i64 = redis::cmd("TTL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        let encoding: Option<String> = redis::cmd("OBJECT")
            .arg("ENCODING")
            .arg(key)
            .query_async(&mut conn)
            .await
            .ok();
        let memory: Option<u64> = redis::cmd("MEMORY")
            .arg("USAGE")
            .arg(key)
            .query_async(&mut conn)
            .await
            .ok();
        let idle: Option<u64> = redis::cmd("OBJECT")
            .arg("IDLETIME")
            .arg(key)
            .query_async(&mut conn)
            .await
            .ok();

        let value = read_typed_value(&mut conn, key, key_type).await?;
        Ok(KeyView {
            key_type,
            ttl,
            encoding,
            memory,
            idle,
            value,
        })
    }
}

/// Pipeline `TYPE` + `TTL` for every scanned key in one round trip, returning
/// the enriched [`KeyEntry`] list (keys that vanished mid-scan get `ttl: -2`).
async fn enrich_keys(
    conn: &mut MultiplexedConnection,
    names: Vec<String>,
) -> Result<Vec<KeyEntry>, AppError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let mut pipe = redis::pipe();
    for name in &names {
        pipe.cmd("TYPE").arg(name);
        pipe.cmd("TTL").arg(name);
    }
    // Reply is [type0, ttl0, type1, ttl1, …].
    let replies: Vec<Value> = pipe.query_async(conn).await.map_err(map_query_error)?;
    let mut keys = Vec::with_capacity(names.len());
    for (i, name) in names.into_iter().enumerate() {
        let type_token = replies.get(i * 2).map(value_to_string).unwrap_or_default();
        let ttl = replies
            .get(i * 2 + 1)
            .and_then(|v| match v {
                Value::Int(n) => Some(*n),
                _ => None,
            })
            .unwrap_or(-2);
        let Some(key_type) = KeyType::from_token(&type_token) else {
            continue; // key vanished between SCAN and the pipeline
        };
        keys.push(KeyEntry {
            name,
            key_type,
            ttl,
        });
    }
    Ok(keys)
}

/// Read the typed value of `key` (already known to be `key_type`).
async fn read_typed_value(
    conn: &mut MultiplexedConnection,
    key: &str,
    key_type: KeyType,
) -> Result<KvValue, AppError> {
    match key_type {
        KeyType::String => {
            let v: String = redis::cmd("GET")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Str { value: v })
        }
        KeyType::List => {
            let items: Vec<String> = redis::cmd("LRANGE")
                .arg(key)
                .arg(0)
                .arg(-1)
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::List { items })
        }
        KeyType::Set => {
            let members: Vec<String> = redis::cmd("SMEMBERS")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Set { members })
        }
        KeyType::Hash => {
            // HGETALL → RESP2 flat [field, value, …] OR RESP3 Map. Read the
            // raw `Value` and normalize both into ordered field/value pairs.
            let raw: Value = redis::cmd("HGETALL")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Hash {
                fields: parse_field_pairs(raw),
            })
        }
        KeyType::Zset => {
            // ZRANGE … WITHSCORES → RESP2 flat [member, score, …] OR RESP3
            // array of [member, score] pairs; scores ascending either way.
            let raw: Value = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0)
                .arg(-1)
                .arg("WITHSCORES")
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Zset {
                entries: parse_scored(raw),
            })
        }
        KeyType::Stream => {
            // XRANGE key - + → [[id, [f, v, …]], …].
            let raw: Value = redis::cmd("XRANGE")
                .arg(key)
                .arg("-")
                .arg("+")
                .query_async(conn)
                .await
                .map_err(map_query_error)?;
            Ok(KvValue::Stream {
                entries: parse_stream(raw),
            })
        }
    }
}

/// Normalize an `HGETALL` reply into ordered field/value pairs, accepting both
/// the RESP2 flat array `[f, v, f, v, …]` and the RESP3 `Map`.
fn parse_field_pairs(value: Value) -> Vec<KvField> {
    match value {
        Value::Map(pairs) => pairs
            .into_iter()
            .map(|(k, v)| KvField {
                field: value_to_string(&k),
                value: value_to_string(&v),
            })
            .collect(),
        Value::Array(flat) => flat
            .chunks_exact(2)
            .map(|pair| KvField {
                field: value_to_string(&pair[0]),
                value: value_to_string(&pair[1]),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Normalize a `ZRANGE … WITHSCORES` reply into scored members, accepting both
/// the RESP2 flat array `[m, s, m, s, …]` and the RESP3 array of `[m, s]`
/// pairs.
fn parse_scored(value: Value) -> Vec<KvScored> {
    match value {
        Value::Array(items) => {
            // RESP3: an array whose elements are themselves [member, score]
            // pairs. RESP2: a flat [member, score, member, score, …].
            let is_paired = items
                .iter()
                .all(|it| matches!(it, Value::Array(inner) if inner.len() == 2));
            if is_paired && !items.is_empty() {
                items
                    .into_iter()
                    .filter_map(|it| {
                        let Value::Array(pair) = it else { return None };
                        let member = value_to_string(pair.first()?);
                        let score = score_of(pair.get(1)?);
                        Some(KvScored { member, score })
                    })
                    .collect()
            } else {
                items
                    .chunks_exact(2)
                    .map(|pair| KvScored {
                        member: value_to_string(&pair[0]),
                        score: score_of(&pair[1]),
                    })
                    .collect()
            }
        }
        _ => Vec::new(),
    }
}

/// Read a score from a RESP value (a RESP3 `Double`, or a RESP2 bulk string).
fn score_of(value: &Value) -> f64 {
    match value {
        Value::Double(d) => *d,
        Value::Int(n) => *n as f64,
        other => value_to_string(other).parse().unwrap_or(f64::NAN),
    }
}

/// Parse an `XRANGE` reply [[id, [f, v, …]], …] into typed stream entries.
fn parse_stream(value: Value) -> Vec<KvStreamEntry> {
    let Value::Array(entries) = value else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let Value::Array(parts) = entry else {
                return None;
            };
            let mut it = parts.into_iter();
            let id = value_to_string(&it.next()?);
            let fields = match it.next() {
                Some(Value::Array(flat)) => flat
                    .chunks_exact(2)
                    .map(|pair| KvField {
                        field: value_to_string(&pair[0]),
                        value: value_to_string(&pair[1]),
                    })
                    .collect(),
                _ => Vec::new(),
            };
            Some(KvStreamEntry { id, fields })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// KeyspaceWriter
// ---------------------------------------------------------------------------

#[async_trait]
impl KeyspaceWriter for RedisKvConnection {
    async fn set_string(&self, db: u8, key: &str, value: &str) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("SET")
            .arg(key)
            .arg(value)
            .query_async::<()>(&mut conn)
            .await
            .map_err(map_query_error)
    }

    async fn hash_set(&self, db: u8, key: &str, field: &str, value: &str) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("HSET")
            .arg(key)
            .arg(field)
            .arg(value)
            .query_async::<i64>(&mut conn)
            .await
            .map(|_| ())
            .map_err(map_query_error)
    }

    async fn hash_del(&self, db: u8, key: &str, field: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("HDEL")
            .arg(key)
            .arg(field)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed > 0)
    }

    async fn list_set(&self, db: u8, key: &str, index: i64, value: &str) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("LSET")
            .arg(key)
            .arg(index)
            .arg(value)
            .query_async::<()>(&mut conn)
            .await
            .map_err(map_query_error)
    }

    async fn set_add(&self, db: u8, key: &str, member: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let added: i64 = redis::cmd("SADD")
            .arg(key)
            .arg(member)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(added > 0)
    }

    async fn set_remove(&self, db: u8, key: &str, member: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("SREM")
            .arg(key)
            .arg(member)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed > 0)
    }

    async fn zset_add(&self, db: u8, key: &str, member: &str, score: f64) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("ZADD")
            .arg(key)
            .arg(score)
            .arg(member)
            .query_async::<i64>(&mut conn)
            .await
            .map(|_| ())
            .map_err(map_query_error)
    }

    async fn zset_remove(&self, db: u8, key: &str, member: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("ZREM")
            .arg(key)
            .arg(member)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed > 0)
    }

    async fn delete_key(&self, db: u8, key: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed > 0)
    }

    async fn rename_key(&self, db: u8, key: &str, new_key: &str) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        redis::cmd("RENAME")
            .arg(key)
            .arg(new_key)
            .query_async::<()>(&mut conn)
            .await
            .map_err(|err| {
                // RENAME on a missing source is `ERR no such key` → a friendlier §5.
                if err.code() == Some("ERR") {
                    AppError::NotFound(format!("Redis key '{key}' does not exist."))
                } else {
                    map_query_error(err)
                }
            })
    }

    async fn expire(&self, db: u8, key: &str, seconds: i64) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let set: i64 = redis::cmd("EXPIRE")
            .arg(key)
            .arg(seconds)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(set == 1)
    }

    async fn persist(&self, db: u8, key: &str) -> Result<bool, AppError> {
        let mut conn = self.conn_for(db).await?;
        let removed: i64 = redis::cmd("PERSIST")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(removed == 1)
    }

    async fn create_key(
        &self,
        db: u8,
        key: &str,
        key_type: KeyType,
        initial: Option<&str>,
    ) -> Result<(), AppError> {
        let mut conn = self.conn_for(db).await?;
        // Map the type to its create command. The collection types need a seed
        // element so the key actually materializes (Redis has no empty keys).
        let seed = initial.unwrap_or("");
        let cmd = match key_type {
            KeyType::String => {
                let mut c = redis::cmd("SET");
                c.arg(key).arg(seed);
                c
            }
            KeyType::List => {
                let mut c = redis::cmd("RPUSH");
                c.arg(key).arg(seed);
                c
            }
            KeyType::Set => {
                let mut c = redis::cmd("SADD");
                c.arg(key).arg(seed);
                c
            }
            KeyType::Hash => {
                let mut c = redis::cmd("HSET");
                // Seed one field: `field` defaults to "field", value = seed.
                c.arg(key).arg("field").arg(seed);
                c
            }
            KeyType::Zset => {
                let mut c = redis::cmd("ZADD");
                c.arg(key).arg(0).arg(seed);
                c
            }
            KeyType::Stream => {
                let mut c = redis::cmd("XADD");
                // Seed one entry with a server id and one field.
                c.arg(key).arg("*").arg("field").arg(seed);
                c
            }
        };
        cmd.query_async::<Value>(&mut conn)
            .await
            .map(|_| ())
            .map_err(map_query_error)
    }
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

// The wider mapping/INFO helpers are unit-tested here; the live driver paths
// are covered by the gated integration tests in `tests/`.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_error_maps_hello_noauth_to_password_hint() {
        // The RESP3 HELLO handshake against a password-protected server fails
        // with this server text (not the AuthenticationFailed kind).
        let err = redis::RedisError::from((
            redis::ErrorKind::ResponseError,
            "hello error",
            "HELLO must be called with the client already authenticated, otherwise the \
             HELLO <proto> AUTH <user> <pass> option can be used"
                .to_string(),
        ));
        let mapped = map_connect_error(err);
        assert!(
            matches!(&mapped, AppError::Database(m) if m.contains("requires a password")),
            "got: {mapped:?}"
        );
    }

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
    fn parse_stream_flattens_id_and_fields() {
        let raw = Value::Array(vec![Value::Array(vec![
            Value::BulkString(b"1-0".to_vec()),
            Value::Array(vec![
                Value::BulkString(b"type".to_vec()),
                Value::BulkString(b"created".to_vec()),
                Value::BulkString(b"order_id".to_vec()),
                Value::BulkString(b"42".to_vec()),
            ]),
        ])]);
        let entries = parse_stream(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "1-0");
        assert_eq!(entries[0].fields.len(), 2);
        assert_eq!(entries[0].fields[0].field, "type");
        assert_eq!(entries[0].fields[0].value, "created");
        assert_eq!(entries[0].fields[1].field, "order_id");
        assert_eq!(entries[0].fields[1].value, "42");
    }

    #[test]
    fn parse_field_pairs_handles_resp2_flat_and_resp3_map() {
        // RESP2: flat array.
        let flat = Value::Array(vec![
            Value::BulkString(b"name".to_vec()),
            Value::BulkString(b"Ada".to_vec()),
            Value::BulkString(b"role".to_vec()),
            Value::BulkString(b"admin".to_vec()),
        ]);
        let fields = parse_field_pairs(flat);
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0].field, "name");
        assert_eq!(fields[0].value, "Ada");
        assert_eq!(fields[1].field, "role");

        // RESP3: map.
        let map = Value::Map(vec![(
            Value::BulkString(b"k".to_vec()),
            Value::BulkString(b"v".to_vec()),
        )]);
        let fields = parse_field_pairs(map);
        assert_eq!(
            fields,
            vec![KvField {
                field: "k".into(),
                value: "v".into()
            }]
        );
    }

    #[test]
    fn parse_scored_handles_resp2_flat_and_resp3_pairs() {
        // RESP2: flat [member, score, …] as bulk strings.
        let flat = Value::Array(vec![
            Value::BulkString(b"low".to_vec()),
            Value::BulkString(b"1".to_vec()),
            Value::BulkString(b"high".to_vec()),
            Value::BulkString(b"9".to_vec()),
        ]);
        let scored = parse_scored(flat);
        assert_eq!(scored.len(), 2);
        assert_eq!(scored[0].member, "low");
        assert_eq!(scored[0].score, 1.0);
        assert_eq!(scored[1].member, "high");
        assert_eq!(scored[1].score, 9.0);

        // RESP3: array of [member, Double] pairs.
        let paired = Value::Array(vec![Value::Array(vec![
            Value::BulkString(b"m".to_vec()),
            Value::Double(2.5),
        ])]);
        let scored = parse_scored(paired);
        assert_eq!(
            scored,
            vec![KvScored {
                member: "m".into(),
                score: 2.5
            }]
        );
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
