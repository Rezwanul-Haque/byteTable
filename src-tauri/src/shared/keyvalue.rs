//! Key-value engine port family (M13 Redis).
//!
//! Redis is **key-value, not relational** — it has no schemas, tables,
//! columns, or SQL. Forcing it through the SQL [`EngineConnection`] surface
//! (`crate::shared::engine`) would litter that trait with `Unsupported` stubs
//! and lie about its shape, so the two engine families are kept as distinct
//! port families per REDIS_SPEC §11. This module is the key-value side: a
//! keyspace reader, a keyspace writer, and a raw command runner, bundled as
//! the [`KeyValueConnection`] super-trait the `engines::redis` adapter
//! implements.
//!
//! The [`crate::shared::engine::OpenConnection`] kind enum is the single seam
//! that lets one `ConnectionManager` store either a SQL connection or a
//! key-value one behind one handle id; `get_sql` / `get_kv` enforce the kind.
//!
//! # Wire shapes
//!
//! All DTOs are camelCase on the wire (matching the renderer's
//! `src/features/redis_browse/api.ts`); the [`KeyType`] enum is **lowercase**
//! to match Redis's own `TYPE` output (`string`/`hash`/`list`/`set`/`zset`/
//! `stream`). [`RespReply`] is an internally-tagged discriminated union the
//! renderer formats per REDIS_SPEC §7 — the backend never formats replies.
//!
//! # Async commands rule
//!
//! Like [`crate::shared::engine::EngineConnection`], every trait method here is
//! `async` (`async_trait`). The redis adapter awaits the driver's multiplexed
//! tokio connection directly — no `spawn_blocking`.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::shared::engine::EngineInfo;
use crate::shared::error::AppError;

/// The Redis value type of a key, exactly as `TYPE` reports it. Lowercase on
/// the wire so it round-trips with both the renderer and the raw `TYPE`
/// command output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyType {
    String,
    Hash,
    List,
    Set,
    Zset,
    Stream,
}

impl KeyType {
    /// The lowercase token Redis uses for this type (the `TYPE` reply and the
    /// `SCAN … TYPE <t>` filter argument).
    pub fn as_token(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Hash => "hash",
            Self::List => "list",
            Self::Set => "set",
            Self::Zset => "zset",
            Self::Stream => "stream",
        }
    }

    /// Parse a `TYPE` reply token into a [`KeyType`]. Returns `None` for
    /// `none` (a missing key) or any unrecognized token.
    pub fn from_token(token: &str) -> Option<Self> {
        match token {
            "string" => Some(Self::String),
            "hash" => Some(Self::Hash),
            "list" => Some(Self::List),
            "set" => Some(Self::Set),
            "zset" => Some(Self::Zset),
            "stream" => Some(Self::Stream),
            _ => None,
        }
    }
}

/// A typed Redis value, discriminated by `type` on the wire so the renderer
/// gets a single tagged union per REDIS_SPEC §2/§6. `Missing` models a key
/// that does not exist (TTL `-2`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum KvValue {
    /// A scalar string (may itself be an int or JSON — display only).
    Str { value: String },
    /// An ordered list (`LRANGE`).
    List { items: Vec<String> },
    /// A set's members (`SMEMBERS`), order unspecified.
    Set { members: Vec<String> },
    /// A hash's ordered `{field,value}` pairs (`HGETALL`).
    Hash { fields: Vec<KvField> },
    /// A sorted set's `{member,score}` entries (`ZRANGE … WITHSCORES`),
    /// returned in ascending score order.
    Zset { entries: Vec<KvScored> },
    /// A stream's entries (`XRANGE`), each with an id and ordered fields.
    Stream { entries: Vec<KvStreamEntry> },
    /// The key does not exist.
    Missing {},
}

/// One `{field, value}` pair of a hash (and of a stream entry's fields).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvField {
    pub field: String,
    pub value: String,
}

/// One `{member, score}` entry of a sorted set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvScored {
    pub member: String,
    pub score: f64,
}

/// One entry of a stream: its id plus the flattened `{field,value}` pairs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvStreamEntry {
    pub id: String,
    pub fields: Vec<KvField>,
}

/// One key in a scan page: its name, type, and TTL (seconds; `-1` = no
/// expiry, `-2` = the key vanished between SCAN and the TTL pipeline).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub name: String,
    pub key_type: KeyType,
    pub ttl: i64,
}

/// A cursor-based scan request (REDIS_SPEC §2: never a blocking `KEYS *`).
/// `cursor` is Redis's opaque SCAN cursor as a string (`"0"` starts a fresh
/// scan); `pattern` is a glob (`MATCH`); `type_filter` adds `TYPE <t>` so the
/// server filters server-side; `count` is the `COUNT` hint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    /// The glob pattern for `MATCH`. Defaults to `*`.
    #[serde(default = "default_pattern")]
    pub pattern: String,
    /// Optional server-side `TYPE` filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_filter: Option<KeyType>,
    /// The opaque SCAN cursor (`"0"` to start). Stringly-typed because Redis
    /// cursors can exceed JavaScript's safe-integer range.
    #[serde(default = "default_cursor")]
    pub cursor: String,
    /// The `COUNT` hint (work per SCAN round-trip, not a result-size cap).
    #[serde(default = "default_count")]
    pub count: u32,
}

fn default_pattern() -> String {
    "*".into()
}
fn default_cursor() -> String {
    "0".into()
}
fn default_count() -> u32 {
    100
}

impl Default for ScanRequest {
    fn default() -> Self {
        Self {
            pattern: default_pattern(),
            type_filter: None,
            cursor: default_cursor(),
            count: default_count(),
        }
    }
}

/// One page of a [`KeyspaceReader::scan`]: the next cursor (`"0"` when the
/// scan is complete) and the keys found this round, each already enriched with
/// its type and TTL (the adapter batches `TYPE`+`TTL` via a pipeline).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPage {
    /// The cursor to pass to the next `scan` call; `"0"` means the scan is
    /// complete.
    pub cursor: String,
    pub keys: Vec<KeyEntry>,
}

/// Everything the key tab's Info mode shows for one key (REDIS_SPEC §6): the
/// type, TTL, `OBJECT ENCODING`, `MEMORY USAGE` bytes, `OBJECT IDLETIME`
/// seconds, plus the typed value itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyView {
    pub key_type: KeyType,
    /// TTL in seconds; `-1` = no expiry, `-2` = missing.
    pub ttl: i64,
    /// `OBJECT ENCODING` (e.g. `embstr`/`listpack`/`skiplist`), or `None` when
    /// the key is missing / the server declined to report it.
    pub encoding: Option<String>,
    /// `MEMORY USAGE` in bytes, or `None` when unavailable.
    pub memory: Option<u64>,
    /// `OBJECT IDLETIME` in seconds, or `None` when unavailable (e.g. an
    /// LFU-eviction server reports frequency instead).
    pub idle: Option<u64>,
    pub value: KvValue,
}

/// Server-wide identity for the dashboard header (REDIS_SPEC §8) — the parsed
/// `INFO server`/`replication` fields the UI shows as `{mode} · {role} ·
/// Redis {version}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvServerInfo {
    pub server_version: String,
    /// `redis_mode` — `standalone` / `sentinel` / `cluster`.
    pub mode: String,
    /// `role` — `master` / `slave`.
    pub role: String,
    /// The negotiated RESP protocol version (`2` or `3`).
    pub resp_version: u8,
}

/// The dashboard stat-grid fields parsed from `INFO` (REDIS_SPEC §8). All are
/// best-effort: a field the server omits is `0` (counters) or `None`
/// (`maxmemory: 0` already means "unbounded", so it stays a plain `u64`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvServerStats {
    pub keyspace_hits: u64,
    pub keyspace_misses: u64,
    pub instantaneous_ops_per_sec: u64,
    pub connected_clients: u64,
    pub used_memory: u64,
    /// `maxmemory` in bytes; `0` means no configured limit.
    pub maxmemory: u64,
    pub uptime_in_days: u64,
    pub expired_keys: u64,
    pub evicted_keys: u64,
}

/// Per-database key counts from `INFO keyspace` (the `db0..db15` rows). Only
/// databases the server reports (non-empty ones) appear; the renderer fills
/// the rest in as empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvDbInfo {
    pub index: u8,
    pub key_count: u64,
}

/// A typed RESP reply for the raw CLI console (REDIS_SPEC §7). Internally
/// tagged by `kind` so the renderer can format each shape exactly like
/// `redis-cli` (`formatReply`): status as plain text, error as `(error) …`,
/// integer as `(integer) N`, bulk as a quoted string (or `(nil)` when
/// `None`), array as the numbered list (nested arrays indented). The backend
/// **never** formats — it maps the driver's reply into this union verbatim,
/// including real `WRONGTYPE` / `ERR unknown command` errors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RespReply {
    /// A simple string reply (`+OK`, `+PONG`).
    Status { value: String },
    /// An error reply (`-WRONGTYPE …`, `-ERR …`) — surfaced, never thrown.
    Error { value: String },
    /// An integer reply (`:42`).
    Int { value: i64 },
    /// A bulk string (`$…`); `None` is the RESP nil bulk (`(nil)`).
    Bulk { value: Option<String> },
    /// An array reply (`*…`), possibly nested.
    Array { items: Vec<RespReply> },
}

// ---------------------------------------------------------------------------
// Port traits
// ---------------------------------------------------------------------------

/// Read side of a keyspace (REDIS_SPEC §11 `KeyspaceReader`): server identity
/// + stats, per-db key counts, cursor-based scanning, and a typed single-key
/// read. All errors are §5 human sentences (the adapter maps driver errors).
#[async_trait]
pub trait KeyspaceReader: Send + Sync {
    /// Server identity for the dashboard header (`INFO server`/`replication`).
    async fn server_info(&self) -> Result<KvServerInfo, AppError>;

    /// Dashboard stat-grid counters (`INFO stats`/`memory`/`clients`).
    async fn server_stats(&self) -> Result<KvServerStats, AppError>;

    /// Per-database key counts (`INFO keyspace`).
    async fn keyspace(&self) -> Result<Vec<KvDbInfo>, AppError>;

    /// One cursor page of keys in `db`, each enriched with type + TTL.
    async fn scan(&self, db: u8, req: ScanRequest) -> Result<ScanPage, AppError>;

    /// The full typed view of one key in `db` (type, ttl, encoding, memory,
    /// idle, value). A missing key returns `value: Missing`, `ttl: -2`.
    async fn get_key(&self, db: u8, key: &str) -> Result<KeyView, AppError>;
}

/// Write side of a keyspace (REDIS_SPEC §11 `KeyspaceWriter`): the targeted
/// type-aware mutations the key tabs issue (REDIS_SPEC §6/§7). Every method
/// **mutates the live keyspace**.
#[async_trait]
pub trait KeyspaceWriter: Send + Sync {
    /// `SET key value` (string create/overwrite).
    async fn set_string(&self, db: u8, key: &str, value: &str) -> Result<(), AppError>;

    /// `HSET key field value` (create or update one hash field).
    async fn hash_set(&self, db: u8, key: &str, field: &str, value: &str) -> Result<(), AppError>;

    /// `HDEL key field` (returns whether a field was removed).
    async fn hash_del(&self, db: u8, key: &str, field: &str) -> Result<bool, AppError>;

    /// `LSET key index value` (overwrite a list element by index).
    async fn list_set(&self, db: u8, key: &str, index: i64, value: &str) -> Result<(), AppError>;

    /// `SADD key member` (returns whether the member was newly added).
    async fn set_add(&self, db: u8, key: &str, member: &str) -> Result<bool, AppError>;

    /// `SREM key member` (returns whether the member was removed).
    async fn set_remove(&self, db: u8, key: &str, member: &str) -> Result<bool, AppError>;

    /// `ZADD key score member` (create or re-score one member).
    async fn zset_add(&self, db: u8, key: &str, member: &str, score: f64) -> Result<(), AppError>;

    /// `ZREM key member` (returns whether the member was removed).
    async fn zset_remove(&self, db: u8, key: &str, member: &str) -> Result<bool, AppError>;

    /// `DEL key` (returns whether the key existed).
    async fn delete_key(&self, db: u8, key: &str) -> Result<bool, AppError>;

    /// `RENAME key newkey`. A missing source key is a §5 error.
    async fn rename_key(&self, db: u8, key: &str, new_key: &str) -> Result<(), AppError>;

    /// `EXPIRE key seconds` (returns whether the timeout was set — `false`
    /// when the key does not exist).
    async fn expire(&self, db: u8, key: &str, seconds: i64) -> Result<bool, AppError>;

    /// `PERSIST key` (returns whether a timeout was removed).
    async fn persist(&self, db: u8, key: &str) -> Result<bool, AppError>;

    /// Create a fresh key of `key_type` with an optional initial value
    /// (REDIS_SPEC §6 "New key"). `initial` is the seed string: the value for
    /// a string, the first element/member/field-value for the collections (the
    /// adapter documents the exact mapping). A type/empty seed the type cannot
    /// represent is a §5 error.
    async fn create_key(
        &self,
        db: u8,
        key: &str,
        key_type: KeyType,
        initial: Option<&str>,
    ) -> Result<(), AppError>;
}

/// Raw command runner (REDIS_SPEC §11 `CommandRunner`): run an arbitrary
/// command in `db` and return its reply as a typed [`RespReply`] — the CLI
/// console (REDIS_SPEC §7). The adapter does **not** format the reply and does
/// **not** translate a server error reply into an `AppError`: a `WRONGTYPE` or
/// `ERR unknown command` comes back as [`RespReply::Error`] so the console can
/// show it `redis-cli`-style. An `AppError` is reserved for the connection
/// itself failing (dropped socket, etc.).
#[async_trait]
pub trait CommandRunner: Send + Sync {
    /// Run `args` (the command name plus its arguments, already tokenized) in
    /// `db`. Returns the typed reply, including error replies.
    async fn run_command(&self, db: u8, args: Vec<String>) -> Result<RespReply, AppError>;
}

/// A live key-value connection: the three port traits bundled, plus the shared
/// [`EngineInfo`] accessor and an orderly `close`. The `engines::redis`
/// adapter implements all four; the [`crate::shared::engine::OpenConnection`]
/// `Kv` arm holds an `Arc<dyn KeyValueConnection>`.
#[async_trait]
pub trait KeyValueConnection: KeyspaceReader + KeyspaceWriter + CommandRunner {
    /// Engine + version of this connection (`Redis 7.4.1`).
    fn engine_info(&self) -> EngineInfo;

    /// Release the driver resources / tear down any SSH tunnel. Like the SQL
    /// side, the manager hands out `Arc` clones, so `close` may race in-flight
    /// work and must tolerate it.
    async fn close(&self) -> Result<(), AppError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_type_round_trips_lowercase_on_the_wire() {
        for (kt, token) in [
            (KeyType::String, "string"),
            (KeyType::Hash, "hash"),
            (KeyType::List, "list"),
            (KeyType::Set, "set"),
            (KeyType::Zset, "zset"),
            (KeyType::Stream, "stream"),
        ] {
            // serde lowercases the wire token.
            let json = serde_json::to_string(&kt).unwrap();
            assert_eq!(json, format!("\"{token}\""));
            // and the helpers agree with serde.
            assert_eq!(kt.as_token(), token);
            assert_eq!(KeyType::from_token(token), Some(kt));
            assert_eq!(serde_json::from_str::<KeyType>(&json).unwrap(), kt);
        }
        // `none` and junk are not key types.
        assert_eq!(KeyType::from_token("none"), None);
        assert_eq!(KeyType::from_token("bitmap"), None);
    }

    #[test]
    fn kv_value_is_tagged_by_type() {
        let v = KvValue::Hash {
            fields: vec![KvField {
                field: "a".into(),
                value: "1".into(),
            }],
        };
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["type"], "hash");
        assert_eq!(json["fields"][0]["field"], "a");
        assert_eq!(json["fields"][0]["value"], "1");

        // Missing is a tagged empty object, round-trips.
        let missing = KvValue::Missing {};
        let mj = serde_json::to_value(&missing).unwrap();
        assert_eq!(mj["type"], "missing");
        assert_eq!(
            serde_json::from_value::<KvValue>(mj).unwrap(),
            KvValue::Missing {}
        );

        // Zset scores survive as numbers.
        let z = KvValue::Zset {
            entries: vec![KvScored {
                member: "m".into(),
                score: 12.5,
            }],
        };
        let zj = serde_json::to_value(&z).unwrap();
        assert_eq!(zj["type"], "zset");
        assert_eq!(zj["entries"][0]["score"], 12.5);
        assert_eq!(serde_json::from_value::<KvValue>(zj).unwrap(), z);
    }

    #[test]
    fn resp_reply_is_tagged_by_kind_and_nests() {
        // Nested array with each scalar shape, mirroring a redis-cli reply.
        let reply = RespReply::Array {
            items: vec![
                RespReply::Status { value: "OK".into() },
                RespReply::Int { value: 7 },
                RespReply::Bulk {
                    value: Some("hi".into()),
                },
                RespReply::Bulk { value: None },
                RespReply::Array {
                    items: vec![RespReply::Error {
                        value: "WRONGTYPE x".into(),
                    }],
                },
            ],
        };
        let json = serde_json::to_value(&reply).unwrap();
        assert_eq!(json["kind"], "array");
        assert_eq!(json["items"][0]["kind"], "status");
        assert_eq!(json["items"][0]["value"], "OK");
        assert_eq!(json["items"][1]["kind"], "int");
        assert_eq!(json["items"][1]["value"], 7);
        assert_eq!(json["items"][2]["kind"], "bulk");
        assert_eq!(json["items"][2]["value"], "hi");
        assert_eq!(json["items"][3]["kind"], "bulk");
        assert!(json["items"][3]["value"].is_null());
        assert_eq!(json["items"][4]["items"][0]["kind"], "error");
        // Round-trips back to the same value.
        assert_eq!(serde_json::from_value::<RespReply>(json).unwrap(), reply);
    }

    #[test]
    fn scan_request_defaults_match_a_fresh_cursor_scan() {
        // An empty object fills every default (pattern `*`, cursor `0`, …).
        let req: ScanRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(req, ScanRequest::default());
        assert_eq!(req.pattern, "*");
        assert_eq!(req.cursor, "0");
        assert_eq!(req.count, 100);
        assert!(req.type_filter.is_none());

        // A partial object keeps the rest at defaults and reads the type filter
        // as the lowercase token.
        let req: ScanRequest =
            serde_json::from_str(r#"{"pattern":"user:*","typeFilter":"hash"}"#).unwrap();
        assert_eq!(req.pattern, "user:*");
        assert_eq!(req.type_filter, Some(KeyType::Hash));
        assert_eq!(req.cursor, "0");
    }

    #[test]
    fn key_entry_and_scan_page_are_camel_case() {
        let page = ScanPage {
            cursor: "12".into(),
            keys: vec![KeyEntry {
                name: "user:1".into(),
                key_type: KeyType::Hash,
                ttl: -1,
            }],
        };
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json["cursor"], "12");
        assert_eq!(json["keys"][0]["name"], "user:1");
        assert_eq!(json["keys"][0]["keyType"], "hash");
        assert_eq!(json["keys"][0]["ttl"], -1);
    }
}
