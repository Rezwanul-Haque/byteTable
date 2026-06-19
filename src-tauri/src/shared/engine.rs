//! Engine abstraction: the port traits every database engine adapter
//! implements. Slices depend only on these traits; engine-specific SQL and
//! drivers live exclusively in adapter modules under `crate::engines`
//! (`engines::sqlite` today; `engines::mysql` / `engines::postgres` in M12).
//!
//! M2 note: the original `SchemaReader` / `QueryExecutor` stub traits were
//! folded into [`EngineConnection`] — introspection and query execution are
//! operations *on an open connection*, so one object owning the driver
//! handle is the natural seam. [`DdlDialect`] remains a stub until M8/M14.
//!
//! # Async commands rule
//!
//! Any slice that touches a database MUST expose `async fn` Tauri commands
//! and these port traits are async (`async_trait`). Sync commands run on the
//! main thread, so a slow query or connection attempt would freeze the
//! entire UI for its duration.
//!
//! Driver caveats:
//! - `rusqlite` is synchronous and its `Connection` is `!Sync` — the SQLite
//!   adapter wraps it in `Arc<std::sync::Mutex<…>>` and hops every operation
//!   through `tokio::task::spawn_blocking` so async executor threads never
//!   block (Tauri's async runtime *is* tokio).
//! - `sqlx` (MySQL/Postgres, M12) is natively async and can be awaited
//!   directly.
//!
//! The preferences slice is the one deliberate exception: it stays sync
//! because it only reads/writes a tiny local JSON file (see
//! `features::preferences`). Do not copy its sync commands into DB-touching
//! slices.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::features::structure::domain::AlterOp;
use crate::shared::document::DocumentStoreConnection;
use crate::shared::error::AppError;
use crate::shared::keyvalue::KeyValueConnection;

/// Database engines ByteTable supports. Lowercase on the wire, matching the
/// renderer's `Engine` type in `src/shared/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Sqlite,
    Mysql,
    Postgres,
    /// Redis (M13) — a key-value store, NOT relational. It does not implement
    /// the SQL [`EngineConnection`] surface; instead it implements the separate
    /// key-value port family in [`crate::shared::keyvalue`]. See the
    /// [`OpenConnection`] kind seam for how the manager keeps the two apart.
    Redis,
    /// DynamoDB (M17) — a NoSQL key/value + single-table-design store, NOT
    /// relational and NOT the Redis keyspace. It implements its own document
    /// port family in [`crate::shared::document`]; the [`OpenConnection`] kind
    /// seam keeps SQL / key-value / document connections apart.
    Dynamodb,
}

impl Engine {
    /// Human display name for error messages and UI copy.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Sqlite => "SQLite",
            Self::Mysql => "MySQL",
            Self::Postgres => "PostgreSQL",
            Self::Redis => "Redis",
            Self::Dynamodb => "DynamoDB",
        }
    }
}

/// The granular TLS mode for a server connection (M12 Task 3). Mirrors the
/// renderer's connect-modal dropdown (`disable` / `prefer` / `require` /
/// `verify-ca` / `verify-full`) and is threaded all the way to the sqlx
/// adapters' `ssl_mode_from_token`, replacing the M12-Task-1/2 `tls: bool`.
///
/// Lowercase-with-dashes on the wire (matching the modal's option values and
/// libpq's `sslmode` vocabulary). [`Default`] is `Prefer` — opportunistic TLS,
/// libpq's own default, and the safe choice when migrating an old saved
/// connection whose `tls: true` boolean carried no finer intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    /// No TLS — plaintext only.
    Disable,
    /// Use TLS if the server offers it, else plaintext (libpq default).
    #[default]
    Prefer,
    /// Require TLS, but do not verify the server certificate.
    Require,
    /// Require TLS and verify the certificate chain (not the hostname).
    VerifyCa,
    /// Require TLS and verify both the chain and the hostname.
    VerifyFull,
}

impl TlsMode {
    /// The wire/CLI token for this mode — the exact string the adapters'
    /// `ssl_mode_from_token` accepts and the renderer's `<select>` emits.
    pub fn as_token(self) -> &'static str {
        match self {
            Self::Disable => "disable",
            Self::Prefer => "prefer",
            Self::Require => "require",
            Self::VerifyCa => "verify-ca",
            Self::VerifyFull => "verify-full",
        }
    }
}

/// How to authenticate to an SSH bastion when tunnelling (M12 Task 3).
///
/// Security: the variants carry NO secret material. The private-key
/// *passphrase* and the SSH *password* are secrets and live in the OS keychain
/// (account `{connection_id}:ssh`), never on the wire or on disk — exactly like
/// the database password. The key *path* and the choice of method are not
/// secret, so they live here.
///
/// Tagged with `method` (lowercase) on the wire:
/// `{ "method": "key", "keyPath": "~/.ssh/id_ed25519" }`,
/// `{ "method": "password" }`, `{ "method": "agent" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "method",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum SshAuth {
    /// A private key on disk. The optional passphrase is a keychain secret.
    Key { key_path: String },
    /// Password auth — the password is a keychain secret.
    Password,
    /// Delegate to the local ssh-agent (no secret stored by ByteTable).
    Agent,
}

impl SshAuth {
    /// Which auth method this is, for friendly messages.
    pub fn method_name(&self) -> &'static str {
        match self {
            Self::Key { .. } => "private key",
            Self::Password => "password",
            Self::Agent => "ssh-agent",
        }
    }
}

/// An SSH tunnel ("jump host" / bastion) a server connection is reached
/// through (M12 Task 3). When present on a server [`ConnectionParams`], the
/// connector opens a local-forward tunnel to the bastion FIRST and points the
/// driver at the local tunnel endpoint instead of the real `host`/`port`.
///
/// Security: no secrets here — see [`SshAuth`]. The bastion host/port/user and
/// the auth *method* are non-secret connection metadata stored in the JSON
/// registry; the SSH password / key passphrase go to the keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

/// How to authenticate to AWS DynamoDB (M17). Tagged with `mode` (lowercase)
/// on the wire, mirroring the connect modal's credential picker:
/// `{ "mode": "profile", "profile": "default" }` or
/// `{ "mode": "keys", "accessKeyId": "AKIA…" }`.
///
/// Security: the `Keys` variant carries only the NON-secret access-key id. The
/// secret access key is a secret and lives in the OS keychain (account `{id}`),
/// threaded transiently exactly like a database password — never here, never in
/// the JSON registry. `Profile` resolves credentials from `~/.aws/credentials`
/// at connect time; nothing secret is stored by ByteTable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum DynamoAuth {
    /// A named profile from the shared AWS credentials file.
    Profile { profile: String },
    /// Static access keys — the secret access key is a keychain secret.
    Keys { access_key_id: String },
}

/// Everything needed to reach a database, per engine.
///
/// Internally tagged with `engine` (lowercase) so the wire shape is
/// `{ "engine": "sqlite", "path": "…" }` — the tag doubles as the engine
/// discriminant the renderer already uses.
///
/// Security: server variants intentionally have NO password field, and the
/// [`SshConfig`] they may carry holds no SSH secret either. Both the database
/// password and the SSH password/passphrase live in the OS keychain (M12 Task
/// 3), keyed by the saved-connection id; only non-secret metadata is stored
/// here and in the JSON registry.
///
/// # TLS wire shape + old-bool migration (M12 Task 3)
///
/// Server variants carry a granular [`TlsMode`] (`tlsMode` on the wire). The
/// custom [`Deserialize`] also accepts the M12-Task-1/2 `tls: bool` shape for
/// connections saved before this task: `true` → [`TlsMode::Prefer`], `false`
/// → [`TlsMode::Disable`]. New saves always emit `tlsMode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "engine",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionParams {
    /// A SQLite database file on disk. No secrets, no TLS, no tunnel.
    Sqlite { path: String },
    /// A MySQL server (M12). Password + SSH secrets live in the keychain.
    /// `database` and `user` are optional: omitted, the driver connects with no
    /// default schema / the server's default user (passwordless/socket auth).
    Mysql {
        host: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        database: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
        tls_mode: TlsMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ssh: Option<SshConfig>,
    },
    /// A PostgreSQL server (M12). Password + SSH secrets live in the keychain.
    /// `database` and `user` are optional: omitted, libpq defaults the database
    /// to the user name and the user to the OS role.
    Postgres {
        host: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        database: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
        tls_mode: TlsMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ssh: Option<SshConfig>,
    },
    /// A Redis server (M13). Like the SQL server engines, the password and any
    /// SSH secret live in the OS keychain — never here. Redis has no relational
    /// "database" name; instead it has 16 numbered logical databases (db0–db15),
    /// so this variant carries a `db_index` (the default/initial db) rather than
    /// a `database`. The ACL `user` is optional — `None` means the Redis
    /// `default` user (the common single-password setup). `db_index` defaults to
    /// 0 and `port` to 6379 on the wire (see the custom [`Deserialize`]).
    Redis {
        host: String,
        port: u16,
        /// The initial logical database (0–15). Default 0. The renderer can
        /// switch dbs per-operation via the key-value commands.
        db_index: u8,
        /// The ACL username, when the server uses a named user. `None` → the
        /// Redis `default` user.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
        tls_mode: TlsMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ssh: Option<SshConfig>,
    },
    /// AWS DynamoDB (M17) — a NoSQL document store. No relational `database`,
    /// no SSH tunnel, no TLS knob (the AWS SDK manages HTTPS). Carries the AWS
    /// `region`, an optional custom `endpoint` (set for DynamoDB Local /
    /// LocalStack; `None` = real AWS), and the credential mode ([`DynamoAuth`]).
    /// The secret access key (for `Keys` auth) lives in the OS keychain.
    Dynamodb {
        region: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        endpoint: Option<String>,
        auth: DynamoAuth,
    },
}

impl ConnectionParams {
    /// The engine these parameters target.
    pub fn engine(&self) -> Engine {
        match self {
            Self::Sqlite { .. } => Engine::Sqlite,
            Self::Mysql { .. } => Engine::Mysql,
            Self::Postgres { .. } => Engine::Postgres,
            Self::Redis { .. } => Engine::Redis,
            Self::Dynamodb { .. } => Engine::Dynamodb,
        }
    }

    /// The SSH tunnel config, when this is a server connection reached through
    /// a bastion. `None` for SQLite and for direct server connections.
    pub fn ssh(&self) -> Option<&SshConfig> {
        match self {
            Self::Sqlite { .. } | Self::Dynamodb { .. } => None,
            Self::Mysql { ssh, .. } | Self::Postgres { ssh, .. } | Self::Redis { ssh, .. } => {
                ssh.as_ref()
            }
        }
    }

    /// Whether this engine authenticates with a password/secret kept in the OS
    /// keychain. Server engines do; SQLite does not. DynamoDB only does for
    /// `Keys` auth (the secret access key) — `Profile` auth resolves from the
    /// shared credentials file, so it must NOT read the keychain (skipping the
    /// needless OS access prompt, exactly like SQLite).
    pub fn uses_password(&self) -> bool {
        match self {
            Self::Sqlite { .. } => false,
            Self::Dynamodb { auth, .. } => matches!(auth, DynamoAuth::Keys { .. }),
            _ => true,
        }
    }
}

/// Custom deserialize for [`ConnectionParams`] that accepts BOTH the current
/// `tlsMode` shape and the legacy `tls: bool` shape (old saved connections),
/// mapping `true` → [`TlsMode::Prefer`], `false` → [`TlsMode::Disable`]. SSH
/// is always optional. Implemented by hand (rather than `#[derive]`) so the
/// migration lives in one place and the rest of the file keeps deriving
/// `Serialize` for the canonical `tlsMode` output.
impl<'de> Deserialize<'de> for ConnectionParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;

        // Intermediate shape: deserialize the tagged enum into a JSON value,
        // then read fields tolerantly so both `tlsMode` and legacy `tls` work.
        let value = serde_json::Value::deserialize(deserializer)?;
        let engine = value
            .get("engine")
            .and_then(|e| e.as_str())
            .ok_or_else(|| D::Error::custom("connection params missing 'engine' tag"))?;

        match engine {
            "sqlite" => {
                let path = value
                    .get("path")
                    .and_then(|p| p.as_str())
                    .ok_or_else(|| D::Error::custom("sqlite params missing 'path'"))?
                    .to_string();
                Ok(ConnectionParams::Sqlite { path })
            }
            "mysql" | "postgres" => {
                let str_field = |k: &str| -> Result<String, D::Error> {
                    value
                        .get(k)
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .ok_or_else(|| D::Error::custom(format!("server params missing '{k}'")))
                };
                // database / user are optional (absent or blank → None).
                let opt_str_field = |k: &str| -> Option<String> {
                    value
                        .get(k)
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .filter(|s| !s.is_empty())
                };
                let host = str_field("host")?;
                let database = opt_str_field("database");
                let user = opt_str_field("user");
                let port = value
                    .get("port")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|p| u16::try_from(p).ok())
                    .ok_or_else(|| D::Error::custom("server params missing/invalid 'port'"))?;
                // Granular mode first; fall back to the legacy bool.
                let tls_mode = match value.get("tlsMode") {
                    Some(m) => TlsMode::deserialize(m.clone()).map_err(D::Error::custom)?,
                    None => match value.get("tls").and_then(serde_json::Value::as_bool) {
                        Some(true) => TlsMode::Prefer,
                        Some(false) => TlsMode::Disable,
                        None => TlsMode::default(),
                    },
                };
                let ssh = match value.get("ssh") {
                    Some(serde_json::Value::Null) | None => None,
                    Some(s) => Some(SshConfig::deserialize(s.clone()).map_err(D::Error::custom)?),
                };
                if engine == "mysql" {
                    Ok(ConnectionParams::Mysql {
                        host,
                        port,
                        database,
                        user,
                        tls_mode,
                        ssh,
                    })
                } else {
                    Ok(ConnectionParams::Postgres {
                        host,
                        port,
                        database,
                        user,
                        tls_mode,
                        ssh,
                    })
                }
            }
            "redis" => {
                // Redis differs from the SQL server engines: no `database` name
                // (it has numbered logical dbs via `dbIndex`), `user` is
                // optional (ACL user; absent → the `default` user), `port`
                // defaults to 6379 and `dbIndex` to 0. TLS + SSH are read
                // exactly like the SQL engines (granular `tlsMode`, with the
                // legacy `tls` bool tolerated).
                let host = value
                    .get("host")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .ok_or_else(|| D::Error::custom("redis params missing 'host'"))?;
                let port = value
                    .get("port")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|p| u16::try_from(p).ok())
                    .unwrap_or(6379);
                let db_index = value
                    .get("dbIndex")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|d| u8::try_from(d).ok())
                    .unwrap_or(0);
                let user = value
                    .get("user")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let tls_mode = match value.get("tlsMode") {
                    Some(m) => TlsMode::deserialize(m.clone()).map_err(D::Error::custom)?,
                    None => match value.get("tls").and_then(serde_json::Value::as_bool) {
                        Some(true) => TlsMode::Prefer,
                        Some(false) => TlsMode::Disable,
                        None => TlsMode::default(),
                    },
                };
                let ssh = match value.get("ssh") {
                    Some(serde_json::Value::Null) | None => None,
                    Some(s) => Some(SshConfig::deserialize(s.clone()).map_err(D::Error::custom)?),
                };
                Ok(ConnectionParams::Redis {
                    host,
                    port,
                    db_index,
                    user,
                    tls_mode,
                    ssh,
                })
            }
            "dynamodb" => {
                // DynamoDB carries a `region`, an optional custom `endpoint`
                // (DynamoDB Local), and a tagged `auth` ({mode:"profile"|"keys"}).
                // No TLS/SSH/database fields. The serde-derived `DynamoAuth`
                // deserializer reads the tagged auth object directly.
                let region = value
                    .get("region")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .ok_or_else(|| D::Error::custom("dynamodb params missing 'region'"))?;
                let endpoint = value
                    .get("endpoint")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let auth = value
                    .get("auth")
                    .ok_or_else(|| D::Error::custom("dynamodb params missing 'auth'"))?;
                let auth = DynamoAuth::deserialize(auth.clone()).map_err(D::Error::custom)?;
                Ok(ConnectionParams::Dynamodb {
                    region,
                    endpoint,
                    auth,
                })
            }
            other => Err(D::Error::custom(format!("unknown engine tag '{other}'"))),
        }
    }
}

/// What a successful test/open learned about the target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine: Engine,
    /// Display version string, e.g. "SQLite 3.46.0" (sidebar header, M3).
    pub server_version: String,
}

/// A schema (SQLite: `main` + attached databases; server engines: schemas).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    /// Number of user tables, when cheaply known.
    pub table_count: Option<u64>,
}

/// A table within a schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    /// Approximate row count, when cheaply known (may be an estimate for
    /// server engines; exact `COUNT(*)` for SQLite in M2).
    pub approx_row_count: Option<u64>,
}

/// Metadata for one table. Powers the M3 sidebar (`columns` with pk/fk icons
/// and type labels) and, since M7, the structure view's 348px rail
/// (DESIGN_SPEC §3.6): indexes, table-level and inbound foreign keys, plus the
/// `CREATE TABLE` DDL.
///
/// M7 additions (everything past `columns`) are additive — `columns` keeps
/// its M3 shape so the sidebar and the M4 grid headers, which read only
/// `columns`, are unaffected. New `Vec` fields are always present (empty when
/// none); `comment`/`ddl` are `Option` (always present on the wire, `null`
/// when absent). `Default` is derived so test fakes can build a bare
/// `TableMeta { columns, ..Default::default() }` without enumerating M7
/// fields, and so future additive fields do not break them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub columns: Vec<ColumnInfo>,
    /// The table's comment/description, when the engine has one. SQLite has
    /// no table comments, so this is always `None` there; it is modelled now
    /// for the §3.6 header's "table comment" slot and for server engines
    /// (MySQL `COMMENT`, Postgres `COMMENT ON TABLE`) in M12.
    pub comment: Option<String>,
    /// Indexes declared on the table, including the implicit primary-key
    /// index (`primary == true`). Empty when the table has none.
    pub indexes: Vec<IndexInfo>,
    /// Foreign keys declared *on this table* (outbound), grouped per
    /// constraint so a composite fk is one entry with ordered column lists.
    /// `ColumnInfo.fk` carries the same targets per-column for the sidebar
    /// icon; this is the table-level view §3.6 renders.
    pub foreign_keys: Vec<ForeignKeyInfo>,
    /// Foreign keys *pointing at this table* (inbound) from other tables in
    /// the same schema — §3.6's "referenced by". Empty when nothing
    /// references it. See the SQLite adapter for the per-table scan cost note.
    pub referenced_by: Vec<InboundFkInfo>,
    /// The `CREATE TABLE` statement, verbatim, for the §3.6 DDL modal
    /// (rendered syntax-highlighted — verbatim is truthful). `None` when the
    /// engine cannot supply it.
    pub ddl: Option<String>,
}

/// One index on a table (§3.6 structure view).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// Indexed columns, in index order. May be empty for an expression index
    /// (SQLite reports expression members as unnamed).
    pub columns: Vec<String>,
    /// True for a UNIQUE index (includes the implicit primary-key index).
    pub unique: bool,
    /// True for the implicit primary-key index (SQLite `origin == "pk"`).
    pub primary: bool,
    /// How the index came to exist, when the engine reports it. SQLite uses
    /// `"c"` (CREATE INDEX), `"u"` (a UNIQUE constraint), or `"pk"` (the
    /// primary key); other engines leave this `None`.
    pub origin: Option<String>,
}

/// One foreign key declared on a table (outbound), grouped per constraint so
/// composite keys are a single entry with parallel, ordered column lists
/// (`columns[i]` references `ref_columns[i]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    /// The constraint name, when the engine exposes one. SQLite's
    /// `foreign_key_list` has no name, so this is always `None` there; server
    /// engines populate it.
    pub name: Option<String>,
    /// Local columns of this table, in constraint order.
    pub columns: Vec<String>,
    pub ref_table: String,
    /// Referenced columns of `ref_table`, parallel to `columns`.
    pub ref_columns: Vec<String>,
    /// The `ON DELETE` action (e.g. `"CASCADE"`, `"SET NULL"`,
    /// `"NO ACTION"`), as the engine reports it; `None` if unknown.
    pub on_delete: Option<String>,
    /// The `ON UPDATE` action, as the engine reports it; `None` if unknown.
    pub on_update: Option<String>,
}

/// A foreign key from another table pointing *at* this table (§3.6
/// "referenced by"). Grouped per constraint like [`ForeignKeyInfo`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundFkInfo {
    /// The child table that holds the foreign key.
    pub table: String,
    /// The child table's foreign-key columns, in constraint order.
    pub columns: Vec<String>,
    /// This table's referenced columns, parallel to `columns`.
    pub ref_columns: Vec<String>,
    /// The `ON DELETE` action on the child's constraint; `None` if unknown.
    pub on_delete: Option<String>,
}

/// One column of a table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// Declared type as written in the DDL (may be empty — SQLite allows
    /// untyped columns). A display label, never for logic.
    pub data_type: String,
    /// True when the column has no NOT NULL constraint declared.
    pub nullable: bool,
    /// True when the column is part of the primary key (composite pks mark
    /// every member column).
    pub pk: bool,
    /// The column's DEFAULT expression, verbatim as the engine reports it
    /// (SQLite's `PRAGMA table_info.dflt_value`), or `None` when the column
    /// has no default. The value is the literal SQL text of the default
    /// (e.g. `"0"`, `"'pending'"`, `"CURRENT_TIMESTAMP"`) — a display/round-trip
    /// value, never re-quoted. M8's structure editor reads this for the
    /// "Default" cell and rebuilds preserve it. Field is named `default_value`
    /// because `default` is a Rust keyword; the wire name is `default`.
    #[serde(rename = "default")]
    pub default_value: Option<String>,
    /// The foreign-key target, when this column references another table.
    pub fk: Option<FkRef>,
}

/// The target of a foreign-key reference: a column in another table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FkRef {
    pub table: String,
    pub column: String,
}

/// Column metadata accompanying a query result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// Best-effort type label (declared type for SQLite; may be empty for
    /// computed expressions). A hint for display, never for logic.
    pub type_hint: String,
}

/// Options for a single query execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueryOptions {
    /// Maximum rows to return; the adapter reads one extra row to set
    /// `QueryResult::truncated`.
    pub row_limit: usize,
    /// Schema context for unqualified names. Server engines apply it
    /// (search_path / USE) in M12; for SQLite it is advisory — unqualified
    /// names resolve per SQLite's own rules (`main` first, then attached).
    pub schema: Option<String>,
}

impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            row_limit: 500,
            schema: None,
        }
    }
}

/// The outcome of a query: column metadata, JSON-mapped rows, and timing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    /// Row-major values. Engine values map to JSON: NULL → null,
    /// integers/reals → numbers, text → strings; integers beyond ±2^53
    /// (JavaScript's safe-integer range) arrive as strings to preserve
    /// precision. Engine-specific types (e.g. blobs) are mapped by the
    /// adapter and documented there.
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    /// True when `row_limit` cut the result short.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// Sort direction for a single column. Lowercase on the wire ("asc" /
/// "desc"), matching the renderer's `SortDirection` in
/// `src/shared/api/engine.ts`.
///
/// Security: this enum is the *only* thing that drives the ORDER BY
/// direction in [`EngineConnection::fetch_rows`] — adapters emit the literal
/// `ASC`/`DESC` keyword per variant and never interpolate any caller string
/// into the direction, so the sort clause carries no SQL-injection surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

impl SortDirection {
    /// The SQL keyword for this direction — a fixed string literal, never
    /// caller-derived (see the type docs on the injection guarantee).
    pub fn sql_keyword(self) -> &'static str {
        match self {
            Self::Asc => "ASC",
            Self::Desc => "DESC",
        }
    }
}

/// A single-column sort applied to a browsed table. `column` is a real
/// column name the adapter MUST validate against the table's columns before
/// quoting it into the SQL (an unknown column is a §5 error); `direction`
/// is enum-driven and never interpolated as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub direction: SortDirection,
}

/// The comparison applied by a single structured [`Condition`]. The wire
/// tokens are explicit camelCase strings the renderer's filter builder sends
/// — they map to (but are *not* identical to) the prototype's internal op ids
/// in `bytetable/filters.jsx`. The mapping the renderer must honour:
///
/// | prototype id (filters.jsx) | label        | wire token (this enum) | SQLite |
/// |----------------------------|--------------|------------------------|--------|
/// | `eq`                       | `=`          | `eq`                   | `"c" = ?` |
/// | `neq`                      | `≠`          | `ne`                   | `"c" <> ?` |
/// | `gt`                       | `>`          | `gt`                   | `"c" > ?` |
/// | `gte`                      | `≥`          | `gte`                  | `"c" >= ?` |
/// | `lt`                       | `<`          | `lt`                   | `"c" < ?` |
/// | `lte`                      | `≤`          | `lte`                  | `"c" <= ?` |
/// | `contains`                 | `contains`   | `contains`             | `"c" LIKE ? ESCAPE '\'` (`%v%`) |
/// | `ncontains`                | `not contains` | `notContains`        | `"c" NOT LIKE ? ESCAPE '\'` (`%v%`) |
/// | `begins`                   | `begins with` | `beginsWith`          | `"c" LIKE ? ESCAPE '\'` (`v%`) |
/// | `ends`                     | `ends with`  | `endsWith`             | `"c" LIKE ? ESCAPE '\'` (`%v`) |
/// | `in`                       | `in list`    | `inList`               | `"c" IN (?, ?, …)` |
/// | `null`                     | `is null`    | `isNull`               | `"c" IS NULL` |
/// | `nnull`                    | `is not null` | `isNotNull`           | `"c" IS NOT NULL` |
///
/// Security: this enum is the *only* thing that selects a comparison operator
/// in [`EngineConnection::fetch_rows`] — adapters emit fixed SQL fragments per
/// variant and bind the user's value as a parameter (`?`), never interpolating
/// it. The LIKE family escapes `%`/`_`/`\` in the bound value so user wildcards
/// match literally (see the SQLite adapter).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    NotContains,
    BeginsWith,
    EndsWith,
    InList,
    IsNull,
    IsNotNull,
}

impl FilterOp {
    /// Whether this operator takes a value. The null checks do not; every
    /// other operator requires a non-null [`FilterValue`] (a §5 error
    /// otherwise — see the adapter).
    pub fn needs_value(self) -> bool {
        !matches!(self, Self::IsNull | Self::IsNotNull)
    }
}

/// The value a [`Condition`] compares against. Either a single JSON scalar
/// (string / number / bool) for the comparison and LIKE operators, or a list
/// of scalars for `inList`. `null` values inside are rejected by the adapter
/// with the §5 "use IS NULL / IS NOT NULL" message — SQL `= NULL` never
/// matches, so a NULL comparison is always a mistake.
///
/// Untagged on the wire: a JSON array deserializes to [`FilterValue::List`],
/// anything else (string/number/bool) to [`FilterValue::Scalar`]. Security:
/// every contained value is *bound* as a parameter, never interpolated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    /// A list of scalars for `inList` (`IN (?, ?, …)`).
    List(Vec<serde_json::Value>),
    /// A single scalar for the comparison / LIKE operators.
    Scalar(serde_json::Value),
}

/// One structured filter row: a column, an operator, and (unless the operator
/// is a null check) a value. `column` is a real column name the adapter MUST
/// validate against the table's columns before quoting it — an unknown column
/// is a §5 error, identical to the sort-column check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub column: String,
    pub op: FilterOp,
    /// `None` for `isNull` / `isNotNull`; required for every other operator.
    pub value: Option<FilterValue>,
    /// True when `column` is a binary type (BINARY/VARBINARY/BLOB/BYTEA). The
    /// renderer sets this from the column's type so the value (a `0x`-hex or
    /// UUID string) is bound as raw bytes — comparing bytes-to-bytes — instead
    /// of as a text literal that would never match. Defaults false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
}

/// How structured [`Condition`]s combine into one WHERE clause. Lowercase on
/// the wire ("and" / "or"). The prototype's builder only renders `WHERE … AND
/// …` between rows, so the renderer defaults to `And`; `Or` is supported here
/// so the builder can offer it without a backend change. (Mixed/nested
/// boolean logic is the job of the raw "Edit as SQL" escape hatch.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Combinator {
    And,
    Or,
}

impl Combinator {
    /// The SQL keyword joining conditions — a fixed literal, never
    /// caller-derived.
    pub fn sql_keyword(self) -> &'static str {
        match self {
            Self::And => "AND",
            Self::Or => "OR",
        }
    }
}

/// The filter applied to a browsed table (M5 stackable filter builder). Two
/// mutually exclusive modes, discriminated by `mode` on the wire:
///
/// - `{ "mode": "conditions", "items": [...], "combinator": "and" }` — the
///   structured builder. Every condition compiles to **bound-parameter** SQL;
///   there is no SQL-injection surface (operators are enum-driven, values are
///   bound).
/// - `{ "mode": "raw", "sql": "status = 'paid' AND total > 100" }` — the
///   "Edit as SQL" escape hatch. The string is the body of the WHERE clause
///   and is **interpolated verbatim** (wrapped in parentheses). See the
///   adapter for the explicit threat model: this is an intentional power-user
///   feature on a local-first single-user tool that already grants full SQL
///   access via the query editor (M6), so the only "validation" is execution
///   — a bad clause surfaces as a §5 error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum FilterSpec {
    /// The structured builder: parameterized conditions joined by one
    /// top-level combinator.
    Conditions {
        items: Vec<Condition>,
        combinator: Combinator,
    },
    /// The raw "Edit as SQL" WHERE body, interpolated verbatim (escape hatch).
    Raw { sql: String },
}

/// A request for one page of rows from a table, powering the M4 data grid and
/// the M5 filter builder.
///
/// Scope: paging (`offset`/`limit`), an optional single-column sort, and an
/// optional [`FilterSpec`] (M5). When a filter is present it applies to BOTH
/// the page query and the `COUNT(*)`, so `RowsPage::total_rows` is the
/// *filtered* row count (the "n of N rows" status shows the filtered total).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRowsRequest {
    pub schema: String,
    pub table: String,
    /// Optional single-column sort; `None` leaves row order to the engine.
    pub sort: Option<SortSpec>,
    /// Optional row filter (M5); `None` returns the whole table. Structured
    /// conditions are fully parameterized; the raw mode is a documented
    /// escape hatch (see [`FilterSpec`]).
    #[serde(default)]
    pub filter: Option<FilterSpec>,
    /// Zero-based row offset of the page (bound as a parameter, never
    /// interpolated).
    pub offset: u64,
    /// Maximum rows in the page. Adapters clamp this to their page ceiling.
    pub limit: u32,
}

/// One page of rows from a table: column metadata, JSON-mapped values, the
/// page window, and timing — the data-grid counterpart of [`QueryResult`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsPage {
    pub columns: Vec<ColumnMeta>,
    /// Row-major values, mapped to JSON exactly as [`QueryResult::rows`]
    /// (NULL → null, big integers → strings, blobs → placeholder, …).
    pub rows: Vec<Vec<serde_json::Value>>,
    /// The offset this page was fetched at (echoes the request after any
    /// clamping).
    pub offset: u64,
    /// The effective page size after clamping (echoes the request).
    pub limit: u32,
    /// Exact `COUNT(*)` matching the request: the whole table when the
    /// request carries no filter, the *filtered* count when
    /// [`FetchRowsRequest::filter`] is present (so the renderer's "n of N
    /// rows" status reflects the filter, §3.5).
    ///
    /// Computed per fetch for correctness and simplicity; a later milestone
    /// may cache it or fall back to an engine estimate for very large tables,
    /// at which point this becomes `None` when unknown. `None` today means the
    /// count could not be obtained.
    pub total_rows: Option<u64>,
    pub elapsed_ms: u64,
}

/// A single-row lookup by key (M10 "FK peek", DESIGN_SPEC §3.5): find the
/// row(s) in `table` where `column = value`. The driving use-case is clicking
/// a foreign-key cell to peek at the referenced row — `column` is the
/// *referenced* column (usually the parent's primary key or a unique key), so
/// the match is normally 0 or 1 row.
///
/// Security: `column` is a real column name the adapter MUST validate against
/// the table's columns before quoting it (an unknown column is a §5 error,
/// identical to the sort/filter column check). `value` is *bound as a
/// parameter*, never interpolated — an injection payload binds as a literal
/// that simply matches nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowLookupRequest {
    pub schema: String,
    pub table: String,
    /// The column to match on (the referenced column for an FK peek).
    pub column: String,
    /// The key value to look up, as a JSON scalar. Bound as a parameter.
    /// A `null` value never matches a `=` comparison in SQL, so the adapter
    /// treats a null key as "no match" (`matchCount: 0`) rather than emitting
    /// `IS NULL` — FK keys are non-null in normal use (see the adapter).
    pub value: serde_json::Value,
    /// True when `column` is a binary type — the value (a `0x`-hex / UUID string)
    /// is bound as raw bytes so the FK peek on a binary key matches. Defaults
    /// false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
}

/// The result of a [`RowLookupRequest`] (M10 "FK peek"): the matching row (if
/// any) plus the columns for field labels and the total match count.
///
/// `columns` is ALWAYS returned (even when `row` is `None`) so the UI can show
/// labelled field placeholders for a missing reference. `row` is `None` when
/// nothing matched; otherwise it is the first matching row, mapped to JSON
/// exactly like [`RowsPage::rows`]. `match_count` is the total number of
/// matching rows so the UI can say "1 of N" when the key is not unique.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowLookup {
    pub columns: Vec<ColumnMeta>,
    /// The first matching row, or `None` when nothing matched.
    pub row: Option<Vec<serde_json::Value>>,
    /// Total rows matching `column = value` (so the UI can flag a non-unique
    /// key as "1 of N"). `0` when nothing matched (including a null key).
    pub match_count: u64,
}

/// One value/frequency pair in a column's top-values list ([`ColumnStats`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreqEntry {
    /// The value, mapped to JSON exactly like [`RowsPage::rows`].
    pub value: serde_json::Value,
    /// How many rows (within the filtered set) hold this value.
    pub count: u64,
}

/// A request for per-column statistics (M10 "column insights", DESIGN_SPEC
/// §3.5), computed over the grid's CURRENT FILTERED SET so the insights match
/// what the user sees.
///
/// Security: `column` is validated against the table's columns before quoting
/// (a §5 error otherwise). `filter` reuses the same parameterized
/// [`FilterSpec`] compilation as [`FetchRowsRequest`] — structured-condition
/// values are bound, the raw mode is the documented escape hatch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStatsRequest {
    pub schema: String,
    pub table: String,
    pub column: String,
    /// The grid's current filter; `None` (or absent) computes stats over the
    /// whole table.
    #[serde(default)]
    pub filter: Option<FilterSpec>,
}

/// Per-column statistics over a (possibly filtered) row set (M10 "column
/// insights"). All counts respect the request's filter, so they match the
/// grid's visible set.
///
/// `min`/`max` are always returned (lexicographic for text — the UI decides
/// how to display them); `avg` is only meaningful for numeric columns and is
/// `None` otherwise. `numeric` tells the UI whether to render min/max/avg as
/// numbers (see the adapter for the detection heuristic).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStats {
    /// Total rows in the (filtered) set, including NULLs.
    pub total: u64,
    /// Distinct non-NULL values (`count(DISTINCT col)`).
    pub distinct: u64,
    /// Rows whose value is NULL.
    pub nulls: u64,
    /// The minimum value, or `None` when the set has no non-NULL values.
    pub min: Option<serde_json::Value>,
    /// The maximum value, or `None` when the set has no non-NULL values.
    pub max: Option<serde_json::Value>,
    /// The average, only when `numeric` (else `None`).
    pub avg: Option<f64>,
    /// Whether the column holds numeric data (drives numeric display of
    /// min/max/avg). See the adapter for the heuristic.
    pub numeric: bool,
    /// The up-to-five most frequent non-NULL values, most frequent first.
    pub top: Vec<FreqEntry>,
}

/// One primary-key predicate in an [`UpdateCellRequest`]: a pk column and the
/// value identifying the target row. A composite primary key needs one
/// [`PkPredicate`] per pk column; the adapter ANDs them all so the WHERE clause
/// matches exactly one row.
///
/// Security: `column` is a real column name the adapter MUST validate — both
/// that it exists AND that it is part of the table's real primary key (a §5
/// error otherwise). `value` is *bound* as a parameter, never interpolated, so
/// an injection payload binds as an inert literal that simply matches nothing.
/// A `null` pk value is a no-match (`= NULL` is never true in SQL) — pks are
/// non-null in normal use (see the SQLite adapter).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PkPredicate {
    pub column: String,
    /// The pk value identifying the row, as a JSON scalar. Bound as a parameter.
    pub value: serde_json::Value,
    /// True when this pk column is a binary type — the value (a `0x`-hex or UUID
    /// string) is then bound as raw bytes so the `WHERE pk = ?` matches a binary
    /// key. Defaults false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
}

/// A request to update a single cell (M11 inline edit, DESIGN_SPEC §3.5): set
/// `column` to `value` on the one row identified by the primary key.
///
/// **This MUTATES user data.** The safety contract (enforced by the adapter):
///
/// - `pk` must cover the table's FULL primary key — every pk column, no more,
///   no fewer. A table with no pk, a partial pk, or a `pk` predicate naming a
///   non-pk column is a §5 error. This guarantees the WHERE clause targets at
///   most one row (mass-update prevention).
/// - `value` is the new cell value and is *bound* as a parameter (`SET col =
///   ?`), so it can be `null` (→ `SET col = NULL`, which a bound NULL handles
///   correctly) and any string — including SQL syntax — is stored as a literal,
///   never executed.
/// - Every pk value is likewise *bound*. Nothing the caller supplies is
///   interpolated; only validated, quoted identifiers are.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCellRequest {
    pub schema: String,
    pub table: String,
    /// The column whose cell is updated (validated against the table).
    pub column: String,
    /// The new value. Bound as a parameter; `null` sets the cell to NULL.
    pub value: serde_json::Value,
    /// True when `column` is a binary type — `value` (a `0x`-hex or UUID string)
    /// is then bound as raw bytes so `SET col = ?` writes the right bytes.
    /// Defaults false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
    /// The full primary key of the target row, one predicate per pk column.
    pub pk: Vec<PkPredicate>,
}

/// The outcome of an [`EngineConnection::update_cell`] call (M11 inline edit):
/// the number of rows changed and a cosmetic statement string for the §3.5
/// "toast with the executed statement".
///
/// `statement` is a **display** rendering of the UPDATE with its values shown
/// inline (e.g. `UPDATE "main"."users" SET "name" = 'Ada' WHERE "id" = 42`) so
/// the toast reads naturally. It is NOT the verbatim string sent to the engine:
/// the real query is fully parameterized (`SET "name" = ? WHERE "id" = ?`) with
/// every value bound. The two are equivalent in effect, never in form — the
/// executed query never interpolates a value (see [`UpdateCellRequest`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    /// Rows changed by the UPDATE. The adapter guarantees this is exactly `1`
    /// on success (0 → "no row matched" §5 error; >1 → rolled back §5 error).
    pub affected: u64,
    /// A human-readable, values-inlined rendering of the statement for the
    /// toast. Cosmetic only — the executed query binds every value (see the
    /// type docs).
    pub statement: String,
}

/// The outcome of an `alter_table` call (M8 structure editor). Carries the
/// SQL statements the batch implies (for the "Review SQL" panel) and whether
/// they were actually executed.
///
/// Preview (`apply == false`) and apply (`apply == true`) return the SAME
/// `statements` list so the user reviews exactly what apply will do — with one
/// documented caveat for SQLite (see [`EngineConnection::alter_table`]): the
/// statements are the *logical* intent (e.g. `ALTER TABLE … ALTER COLUMN …
/// TYPE …`), which SQLite cannot run natively for type/nullable/default
/// changes; apply realizes those via a table rebuild. The preview SQL is the
/// engine-agnostic display the prototype shows, not necessarily the verbatim
/// SQL the engine runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterResult {
    /// The statement strings the batch implies, in order — the "Review SQL"
    /// list. Always populated (preview and apply alike).
    pub statements: Vec<String>,
    /// True when the statements were executed (`apply == true` and the whole
    /// batch committed); false for a preview.
    pub applied: bool,
}

/// Transient connection secrets that the command layer carries to
/// `test`/`open` *without persisting them*. [`ConnectionParams`] is
/// deliberately secret-free for storage; server engines need secrets only at
/// connect time, so they travel separately as this short-lived value.
///
/// Two distinct secrets, both optional:
/// - `password` — the database password (Postgres/MySQL `connect_options`).
/// - `ssh` — the SSH secret for a tunnelled connection: the private-key
///   *passphrase* (key auth) or the bastion *password* (password auth). `None`
///   for agent auth or a direct (non-tunnelled) connection.
///
/// # M12 secret-threading seam (Task 1 → Task 3)
///
/// In Task 1/2 only `password` existed, originating as an optional `password`
/// argument on the commands and threaded through the use-cases into
/// [`Connector::open_with_secret`] / [`Connector::test_with_secret`]. Task 3
/// adds the `ssh` arm and replaces the *source* of both with the OS keychain
/// (looked up by saved-connection id: account `{id}` for the db password,
/// `{id}:ssh` for the SSH secret). The connector seam is unchanged in shape;
/// only where the values come from changed. Secrets are never written to disk
/// and never put on [`ConnectionParams`].
#[derive(Clone, Default)]
pub struct ConnectSecret {
    password: Option<String>,
    ssh: Option<String>,
}

impl std::fmt::Debug for ConnectSecret {
    /// Never leak the secrets in logs / panic messages.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectSecret")
            .field("password", &self.password.as_ref().map(|_| "***"))
            .field("ssh", &self.ssh.as_ref().map(|_| "***"))
            .finish()
    }
}

impl ConnectSecret {
    /// A secret carrying only a database password (the common server case,
    /// and the Task 1/2 shape — `ConnectSecret::new(p)` mirrors the old
    /// tuple-struct constructor).
    pub fn new(password: impl Into<String>) -> Self {
        Self {
            password: Some(password.into()),
            ssh: None,
        }
    }

    /// A secret carrying a database password and/or an SSH secret. Either may
    /// be `None` (e.g. SSH-agent auth needs no SSH secret).
    pub fn with_ssh(password: Option<String>, ssh: Option<String>) -> Self {
        Self { password, ssh }
    }

    /// The database password, if any. Only the connector at connect time
    /// should read this.
    pub fn password(&self) -> Option<&str> {
        self.password.as_deref()
    }

    /// The SSH secret (key passphrase or bastion password), if any.
    pub fn ssh(&self) -> Option<&str> {
        self.ssh.as_deref()
    }
}

/// What a [`Connector::open`] yields: a live connection of one of the two
/// engine *kinds* ByteTable supports (M13 connection-kind seam).
///
/// ByteTable has two fundamentally different engine families that do NOT share
/// an operation surface:
/// - **SQL** (`Sqlite`/`Mysql`/`Postgres`) — relational; implements
///   [`EngineConnection`] (schemas, tables, queries, rows, ALTERs, …).
/// - **Key-value** (`Redis`, M13) — a keyspace; implements
///   [`KeyValueConnection`] (scan, typed reads/writes, raw commands).
///
/// Forcing Redis into [`EngineConnection`] would litter it with `Unsupported`
/// stubs and lie about its shape, so the two are distinct traits. This enum is
/// the single seam that lets the [`crate::features::connections::application::ConnectionManager`]
/// store either behind one [`crate::features::connections::application::ConnectionHandleId`].
/// The manager's `get_sql` / `get_kv` accessors return a §5 "not available for
/// this engine" error on a kind mismatch, so a SQL command can never reach a
/// Redis connection or vice-versa.
///
/// Both arms hold an `Arc` so the manager hands out cheap clones and drops its
/// lock before awaiting driver work (matching the M2 manager contract).
pub enum OpenConnection {
    /// A relational SQL connection (`Sqlite`/`Mysql`/`Postgres`).
    Sql(Arc<dyn EngineConnection>),
    /// A key-value connection (`Redis`, M13).
    Kv(Arc<dyn KeyValueConnection>),
    /// A document-store connection (`Dynamodb`, M17).
    Document(Arc<dyn DocumentStoreConnection>),
}

impl OpenConnection {
    /// The engine family discriminator (`"sql"` / `"kv"` / `"document"`) —
    /// surfaced to the renderer in the open-result so it can route to the right
    /// workspace.
    pub fn kind(&self) -> ConnectionKind {
        match self {
            Self::Sql(_) => ConnectionKind::Sql,
            Self::Kv(_) => ConnectionKind::Kv,
            Self::Document(_) => ConnectionKind::Document,
        }
    }

    /// The engine + version of the open connection, whichever kind it is.
    pub fn engine_info(&self) -> EngineInfo {
        match self {
            Self::Sql(c) => c.engine_info(),
            Self::Kv(c) => c.engine_info(),
            Self::Document(c) => c.engine_info(),
        }
    }

    /// Wrap a SQL connection. Connectors and tests use this so the `Arc`
    /// boxing of a concrete [`EngineConnection`] lives in one place.
    pub fn sql(connection: impl EngineConnection + 'static) -> Self {
        Self::Sql(Arc::new(connection))
    }

    /// Wrap a key-value connection (the `engines::redis` adapter).
    pub fn kv(connection: impl KeyValueConnection + 'static) -> Self {
        Self::Kv(Arc::new(connection))
    }

    /// Wrap a document-store connection (the `engines::dynamo` adapter).
    pub fn document(connection: impl DocumentStoreConnection + 'static) -> Self {
        Self::Document(Arc::new(connection))
    }

    /// The SQL connection, consuming the enum, or `None` for a key-value one.
    /// Used by the SQL adapters' own tests, which open a connector and then
    /// exercise the [`EngineConnection`] surface directly.
    pub fn into_sql(self) -> Option<Arc<dyn EngineConnection>> {
        match self {
            Self::Sql(c) => Some(c),
            Self::Kv(_) | Self::Document(_) => None,
        }
    }

    /// The key-value connection, consuming the enum, or `None` otherwise. Used
    /// by the `engines::redis` integration tests.
    pub fn into_kv(self) -> Option<Arc<dyn KeyValueConnection>> {
        match self {
            Self::Kv(c) => Some(c),
            Self::Sql(_) | Self::Document(_) => None,
        }
    }

    /// The document-store connection, consuming the enum, or `None` otherwise.
    /// Used by the `engines::dynamo` integration tests.
    pub fn into_document(self) -> Option<Arc<dyn DocumentStoreConnection>> {
        match self {
            Self::Document(c) => Some(c),
            Self::Sql(_) | Self::Kv(_) => None,
        }
    }
}

/// The engine *family* of an open connection — the discriminator the renderer
/// routes on (`redis` → the key-value workspace, the rest → the relational
/// one). Lowercase on the wire (`"sql"` / `"kv"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    Sql,
    Kv,
    /// A document store (`Dynamodb`, M17) → the DynamoDB workspace.
    Document,
}

/// Opens and tests connections for one engine. One implementation per
/// engine, registered by `Engine` in the composition root; the renderer
/// only ever sees opaque handle ids, never driver handles.
///
/// Progress callback for long-running operations — `(done, total)`. Export
/// reports rows (per table) or tables (per schema dump) written; import reports
/// statements executed. The command layer forwards each call to a Tauri
/// `Channel` so the renderer can drive a progress bar. `Send + Sync` so it can
/// be held across `await` points in the async command future.
pub type ProgressCallback<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

/// M13: `open` now yields an [`OpenConnection`] (the SQL/KV kind seam) rather
/// than a bare `Box<dyn EngineConnection>`. SQL connectors wrap their
/// connection in [`OpenConnection::Sql`]; the Redis connector returns
/// [`OpenConnection::Kv`].
#[async_trait]
pub trait Connector: Send + Sync {
    /// Verify the target is reachable and really is this engine, without
    /// keeping a connection open. The secretless form — used by engines with
    /// no password (SQLite) and by callers that have no secret. Server engines
    /// override [`Self::test_with_secret`] and route this through it with no
    /// secret.
    async fn test(&self, params: &ConnectionParams) -> Result<EngineInfo, AppError>;

    /// Open a live connection (secretless form — see [`Self::test`]). Returns
    /// the [`OpenConnection`] kind enum so a SQL or key-value connection can
    /// flow through the same manager.
    async fn open(&self, params: &ConnectionParams) -> Result<OpenConnection, AppError>;

    /// Verify the target, carrying an optional transient [`ConnectSecret`]
    /// (a password for server engines). Default impl ignores the secret and
    /// delegates to [`Self::test`], so SQLite and every existing test fake are
    /// unaffected; the Postgres connector overrides it to use the password.
    /// See [`ConnectSecret`] for the M12 password-threading seam.
    async fn test_with_secret(
        &self,
        params: &ConnectionParams,
        _secret: Option<&ConnectSecret>,
    ) -> Result<EngineInfo, AppError> {
        self.test(params).await
    }

    /// Open a live connection, carrying an optional transient [`ConnectSecret`].
    /// Default impl ignores the secret and delegates to [`Self::open`].
    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        _secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        self.open(params).await
    }
}

/// A live connection to one database: introspection + query execution.
///
/// All errors carry human messages per DESIGN_SPEC §5 — adapters map driver
/// errors before they cross this boundary.
#[async_trait]
pub trait EngineConnection: Send + Sync {
    /// What `open` learned about the target (engine + version).
    fn engine_info(&self) -> EngineInfo;

    /// Schemas visible on this connection (SQLite: `main` + attached).
    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError>;

    /// User tables in the given schema.
    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError>;

    /// Column-level metadata for one table (M3 sidebar). Unknown tables are
    /// a §5 human error ("Table 'x' does not exist. Available tables: …").
    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError>;

    /// Execute SQL verbatim with a row limit and timing. Read/write context
    /// enforcement is a higher-level concern (M6); the adapter runs what it
    /// is given but always enforces `row_limit`.
    async fn run_query(&self, sql: &str, options: QueryOptions) -> Result<QueryResult, AppError>;

    /// Fetch one page of rows from a table for the data grid (M4 + M5): paged
    /// (`offset`/`limit`), optionally sorted by a single column, and
    /// optionally filtered (M5), with an exact `COUNT(*)` for the row-count
    /// status — the *filtered* count when a filter applies (§3.5 "n of N
    /// rows"). The adapter validates `sort.column` and every filter column
    /// against the table's columns, quotes every identifier, binds
    /// offset/limit and structured filter values as parameters, and emits the
    /// ORDER BY direction only as the enum-driven `ASC`/`DESC` keyword — see
    /// [`SortDirection`] for the no-injection guarantee. The raw filter mode
    /// is a documented "Edit as SQL" escape hatch (see [`FilterSpec`]).
    /// Unknown schema/table/sort-column/filter-column are §5 human errors.
    async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError>;

    /// Look up the row(s) where `column = value` (M10 "FK peek", §3.5): click
    /// a foreign-key cell to peek at the referenced row. The adapter validates
    /// `column` against the table's columns (a §5 error otherwise), quotes the
    /// identifier, and *binds* `value` as a parameter — never interpolated, so
    /// an injection payload simply matches nothing. Returns the first matching
    /// row (the key is usually unique → 0 or 1) plus `match_count` so the UI
    /// can flag a non-unique key. A null key matches nothing (FK keys are
    /// non-null in normal use — see [`RowLookupRequest::value`]). Columns are
    /// always returned, even when nothing matched. Unknown schema/table/column
    /// are §5 human errors.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override
    /// it (SQLite in M10; server engines later).
    async fn fetch_row_by_key(&self, _req: RowLookupRequest) -> Result<RowLookup, AppError> {
        Err(AppError::Unsupported(
            "Row lookup is not supported for this engine yet.".into(),
        ))
    }

    /// Compute per-column statistics over the current filtered set (M10
    /// "column insights", §3.5): total/distinct/null counts, min/max, avg (for
    /// numeric columns), and the top-5 most frequent values. The adapter
    /// validates `column` (a §5 error otherwise), quotes the identifier, and
    /// reuses the same parameterized [`FilterSpec`] compilation as
    /// [`fetch_rows`] so the stats reflect the grid's visible filtered set.
    /// Unknown schema/table/column are §5 human errors.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override
    /// it (SQLite in M10; server engines later).
    async fn column_stats(&self, _req: ColumnStatsRequest) -> Result<ColumnStats, AppError> {
        Err(AppError::Unsupported(
            "Column statistics are not supported for this engine yet.".into(),
        ))
    }

    /// Preview or apply a batch of staged structure edits ([`AlterOp`]) against
    /// one table (M8 structure editor, DESIGN_SPEC §3.6).
    ///
    /// - `apply == false` ⇒ **preview only**: generate the SQL statement strings
    ///   the batch implies and return them in [`AlterResult::statements`] with
    ///   `applied: false`. This MUST NOT mutate the database (it may read schema
    ///   metadata to validate ops and compute the target column set).
    /// - `apply == true` ⇒ **execute**: realize the batch transactionally and
    ///   return the same statements with `applied: true`. On ANY failure the
    ///   adapter rolls back fully so the table is untouched, and returns the
    ///   engine error §5-style.
    ///
    /// Errors (both modes): unknown schema/table/column, dropping or retyping a
    /// primary-key column, and — for SQLite apply — a table-rebuild that would
    /// lose features it cannot reconstruct (CHECK, generated columns,
    /// AUTOINCREMENT, WITHOUT ROWID, COLLATE, triggers) are all §5 human errors.
    ///
    /// Default impl: `Unsupported` — only engines that implement structure
    /// editing override it (SQLite in M8; server engines later).
    async fn alter_table(
        &self,
        _schema: &str,
        _table: &str,
        _ops: &[AlterOp],
        _apply: bool,
    ) -> Result<AlterResult, AppError> {
        Err(AppError::Unsupported(
            "Structure editing is not supported for this engine yet.".into(),
        ))
    }

    /// Update a single cell on one row (M11 inline edit, DESIGN_SPEC §3.5):
    /// `SET req.column = req.value` on the row identified by `req.pk`.
    ///
    /// **Mutates user data.** Safety contract (the adapter MUST enforce it):
    ///
    /// - Validate `column` against the table (a §5 error for an unknown column,
    ///   identical to the browse/insights column checks).
    /// - Require the FULL primary key: the `pk` predicate columns must be
    ///   exactly the table's primary-key columns — no missing pk column, and
    ///   every named column must actually be part of the pk. A table with no pk
    ///   is rejected. This is what guarantees the WHERE clause targets at most
    ///   one row (mass-update prevention), so the update is safe.
    /// - **Bind everything:** the new value AND every pk value are bound
    ///   parameters (`SET "c" = ? WHERE "pk" = ?`), never interpolated. An
    ///   injection payload stores/compares as an inert literal. A `null` `value`
    ///   is a valid `SET "c" = NULL` (the bound NULL works; only `WHERE c = NULL`
    ///   is the SQL trap, and pk values are non-null in normal use → a null pk
    ///   value matches nothing).
    /// - Execute transactionally and assert the affected count: `0` → the row
    ///   was not found (stale/deleted pk) → §5 error, nothing changed; `>1` →
    ///   roll back and §5 error (defense in depth — should be impossible once
    ///   the pk is validated, but a bug must never silently mass-update); `1` →
    ///   commit and return [`UpdateResult`] with the cosmetic statement string.
    ///
    /// Engine constraint failures (e.g. a NOT NULL violation when setting NULL)
    /// surface as §5 errors and roll back, leaving the row untouched.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it
    /// (SQLite in M11; server engines later).
    async fn update_cell(&self, _req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
        Err(AppError::Unsupported(
            "Editing cells is not supported for this engine yet.".into(),
        ))
    }

    /// Quote a single SQL identifier (column / table / schema name) the way
    /// THIS engine requires, doubling any embedded quote character (M15 export).
    ///
    /// The export use-cases run in the engine-agnostic application layer but
    /// must emit engine-correct `INSERT` statements (Postgres/SQLite wrap in
    /// double quotes, MySQL in backticks). Rather than leak per-engine quoting
    /// up the stack, the application layer asks the open connection to quote.
    /// This is a pure, synchronous string transform — no driver I/O — so it is
    /// a plain method, not `async`.
    ///
    /// Default impl: ANSI double-quoting (`"name"`, embedded `"` doubled),
    /// which is correct for SQLite and Postgres; MySQL overrides it to use
    /// backticks. Test fakes inherit the default unchanged.
    fn quote_identifier(&self, ident: &str) -> String {
        format!("\"{}\"", ident.replace('"', "\"\""))
    }

    /// Render `hex` (lowercase hex digits, no `0x`/`X` prefix; may be empty) as
    /// an engine-correct binary literal for a SQL dump's INSERT values, so a
    /// binary column round-trips. Default: the SQL-standard `X'..'` blob literal
    /// — correct for SQLite and accepted by MySQL. Postgres overrides it to a
    /// `bytea` literal.
    fn binary_literal(&self, hex: &str) -> String {
        format!("X'{hex}'")
    }

    /// Empty a table of all rows, keeping its structure (M15 truncate).
    ///
    /// **Mutates user data.** Engine-aware: Postgres/MySQL run `TRUNCATE TABLE`;
    /// SQLite, which has no `TRUNCATE`, runs `DELETE FROM …` inside a
    /// transaction (so `affected` reflects the prior row count). The adapter
    /// validates the table exists (a §5 error otherwise) and quotes both
    /// identifiers. Returns the number of rows removed — exact for SQLite's
    /// `DELETE`; for the server engines `TRUNCATE` does not report a row count,
    /// so the adapter counts the rows first and returns that (0 for an
    /// already-empty table).
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it.
    async fn truncate_table(&self, _schema: &str, _table: &str) -> Result<u64, AppError> {
        Err(AppError::Unsupported(
            "Truncating tables is not supported for this engine yet.".into(),
        ))
    }

    /// Drop every table in a schema and leave that schema empty, ready to
    /// recreate / re-import (M15 SQL enhancements — "drop schema").
    ///
    /// **Mutates user data — destructive.** The semantics are "drop + recreate
    /// an empty schema", engine-aware:
    ///
    /// - **Postgres** runs `DROP SCHEMA "x" CASCADE; CREATE SCHEMA "x";` inside
    ///   one transaction — Postgres has transactional DDL, so this is atomic and
    ///   leaves an empty schema even if interrupted.
    /// - **MySQL** treats schema == database: `DROP DATABASE \`x\`;
    ///   CREATE DATABASE \`x\`;`. **MySQL DDL auto-commits**, so this is NOT
    ///   atomic — the drop commits before the recreate runs; the adapter
    ///   recreates immediately so a successful call always leaves an empty
    ///   database.
    /// - **SQLite** has no droppable schema/database (`main` is the file
    ///   itself), so "drop schema" is defined as **drop every user table** in
    ///   that schema (`DROP TABLE` each non-`sqlite_%` table) inside a
    ///   transaction, leaving an empty schema. The database file is never
    ///   deleted.
    ///
    /// The adapter validates the schema exists where applicable (a §5 error
    /// otherwise) and quotes the identifier per engine. Returns `()` — the table
    /// list afterwards is empty by construction.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it.
    async fn drop_schema(&self, _schema: &str) -> Result<(), AppError> {
        Err(AppError::Unsupported(
            "Dropping a schema is not supported for this engine yet.".into(),
        ))
    }

    /// Create a new empty schema/database. Engine-aware: Postgres `CREATE
    /// SCHEMA "x"`, MySQL `CREATE DATABASE \`x\``. **SQLite has no notion of
    /// creating a schema** (a "schema" there is an ATTACHed database file), so it
    /// stays `Unsupported`. The adapter quotes the identifier per engine; a
    /// duplicate name surfaces the engine's §5 error.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it.
    async fn create_schema(&self, _schema: &str) -> Result<(), AppError> {
        Err(AppError::Unsupported(
            "Creating a schema is not supported for this engine.".into(),
        ))
    }

    /// Run a whole multi-statement SQL script (a dump: `CREATE TABLE` + `INSERT`
    /// + …) into the given schema (M15 import — the I/O counterpart of export).
    ///
    /// Unlike [`run_query`](Self::run_query), which runs a SINGLE statement, this
    /// executes the entire `;`-separated script in one go and returns the number
    /// of statements executed ([`ImportResult`]). It is engine-aware:
    ///
    /// - **SQLite** wraps the script in a `BEGIN`/`COMMIT` and runs it via
    ///   `execute_batch`; any error rolls the whole import back so a table is
    ///   never left half-created. SQLite has no "current schema" beyond
    ///   `main` + attached databases, so unqualified `CREATE`s land in `main`;
    ///   importing into a specific attached schema requires the script itself to
    ///   qualify names (out of scope — the SQLite adapter documents this).
    /// - **Postgres** prefixes `SET search_path` for the target schema and runs
    ///   the script through sqlx's multi-statement path, whose simple-query
    ///   protocol wraps the statements in an implicit transaction — a mid-script
    ///   failure rolls all of them back (atomic).
    /// - **MySQL** sets the database (`USE`) then runs the script. **MySQL DDL
    ///   auto-commits**, so a multi-statement import is NOT atomic: on a
    ///   mid-script failure the statements before it have already landed and
    ///   cannot be rolled back — the §5 error says how far it got.
    ///
    /// On any error the engine error surfaces as a §5 human sentence; the adapter
    /// rolls back where the engine allows. Unknown-schema and the engine's own
    /// SQL errors are §5 messages.
    ///
    /// `on_progress(done, total)` is called after each statement so the importer
    /// can drive a progress bar (see [`ProgressCallback`]).
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it.
    async fn execute_script(
        &self,
        _schema: &str,
        _sql: &str,
        _on_progress: ProgressCallback<'_>,
    ) -> Result<ImportResult, AppError> {
        Err(AppError::Unsupported(
            "Importing SQL is not supported for this engine yet.".into(),
        ))
    }

    /// Insert many pre-generated rows into one table (M16 generate). **Mutates
    /// user data — append only.** `columns` names the inserted columns; each row
    /// in `rows` is parallel to `columns` (`serde_json::Value`; `Null` → SQL
    /// NULL). `binary` is parallel to `columns`: a `true` entry marks a binary
    /// column whose values arrive as `0x`-hex strings and MUST be bound as raw
    /// bytes (BLOB / bytea / BINARY), so a `binary(n)` value round-trips instead
    /// of being stored as its hex text. The adapter quotes identifiers per
    /// engine, binds every value as a parameter, and runs the batch inside a
    /// transaction (multi-row `INSERT … VALUES (…),(…)` on Postgres/MySQL; a
    /// batched prepared insert in a transaction on SQLite). Returns rows inserted.
    ///
    /// Default impl: `Unsupported` — only the SQL engines override it.
    async fn bulk_insert(
        &self,
        _schema: &str,
        _table: &str,
        _columns: &[String],
        _binary: &[bool],
        _rows: &[Vec<serde_json::Value>],
    ) -> Result<u64, AppError> {
        Err(AppError::Unsupported(
            "Bulk insert is not supported for this engine yet.".into(),
        ))
    }

    /// Read up to `cap` existing key tuples from a table for FK sourcing and
    /// append-uniqueness baselining (M16 generate). Returns each row as the
    /// values of `columns`, in arbitrary order, capped to bound memory on large
    /// parent tables.
    ///
    /// Default impl: `Unsupported` — only the SQL engines override it.
    async fn fetch_pk_pool(
        &self,
        _schema: &str,
        _table: &str,
        _columns: &[String],
        _cap: u64,
    ) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
        Err(AppError::Unsupported(
            "Reading a key pool is not supported for this engine yet.".into(),
        ))
    }

    /// Release the underlying driver resources. For drop-managed drivers
    /// (rusqlite) this may be a no-op; server engines use it for an orderly
    /// goodbye.
    ///
    /// Concurrency: the manager hands out `Arc` clones of the connection,
    /// so `close` may be called while other clones are mid-operation (e.g.
    /// app teardown racing a slow query). Adapters must tolerate that —
    /// either by being a no-op and letting the last `Arc` drop do the real
    /// teardown (SQLite), or by serializing close against in-flight work.
    async fn close(&self) -> Result<(), AppError>;
}

/// The outcome of an [`EngineConnection::execute_script`] call (M15 import):
/// the number of top-level SQL statements that were executed.
///
/// `statements` is a best-effort count derived by splitting the script on
/// statement-terminating `;` outside string literals and comments (see
/// [`count_statements`]) — it is the same count the success toast shows
/// ("Imported {file} — {N} statements"). For an atomic engine (SQLite in a
/// transaction, Postgres's implicit BEGIN/COMMIT) all `statements` ran or none
/// did; for MySQL (DDL auto-commits) a mid-script failure leaves the statements
/// before the failure already applied — the §5 error names how far it got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Top-level statements executed by the script (best-effort count).
    pub statements: u64,
}

/// Count the top-level SQL statements in a dump for [`ImportResult::statements`]
/// — a best-effort, engine-agnostic parse, NOT a full SQL tokenizer.
///
/// A statement boundary is a `;` that is NOT inside a string/identifier literal
/// or a comment. We track: single-quoted (`'…'`) and double-quoted (`"…"`)
/// literals with doubled-quote escaping (`''` / `""` stay inside the literal);
/// backtick-quoted identifiers (MySQL); `--` line comments (to end of line);
/// and `/* … */` block comments. A trailing fragment with no terminating `;`
/// (e.g. a final statement the dump left unterminated) still counts as one
/// statement when it contains non-whitespace, non-comment text.
///
/// This intentionally does not understand dollar-quoting (`$$…$$`) or other
/// engine-specific quoting; for the CREATE TABLE + INSERT dumps ByteTable's own
/// export produces (and ordinary hand-written scripts) it is accurate, and a
/// miscount only affects the cosmetic toast number, never correctness.
pub fn count_statements(script: &str) -> u64 {
    let bytes = script.as_bytes();
    let mut i = 0usize;
    let len = bytes.len();
    let mut count: u64 = 0;
    // Whether the current statement has any meaningful (non-whitespace,
    // non-comment) content yet — so empty segments between `;`s don't count.
    let mut has_content = false;

    while i < len {
        let c = bytes[i];
        match c {
            b'\'' | b'"' | b'`' => {
                // Consume a quoted literal/identifier, honouring doubled-quote
                // escaping (`''` inside a '…' literal is an escaped quote).
                let quote = c;
                has_content = true;
                i += 1;
                while i < len {
                    if bytes[i] == quote {
                        if i + 1 < len && bytes[i + 1] == quote {
                            i += 2; // doubled quote → stays inside
                            continue;
                        }
                        i += 1; // closing quote
                        break;
                    }
                    i += 1;
                }
            }
            b'-' if i + 1 < len && bytes[i + 1] == b'-' => {
                // Line comment to end of line.
                i += 2;
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < len && bytes[i + 1] == b'*' => {
                // Block comment to the closing `*/`.
                i += 2;
                while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2; // skip the closing `*/` (or run off the end harmlessly)
            }
            b';' => {
                if has_content {
                    count += 1;
                }
                has_content = false;
                i += 1;
            }
            other => {
                if !other.is_ascii_whitespace() {
                    has_content = true;
                }
                i += 1;
            }
        }
    }
    // A trailing un-terminated statement with real content still counts.
    if has_content {
        count += 1;
    }
    count
}

/// Split a multi-statement SQL script into its individual statements, using the
/// same quote/comment-aware scan as [`count_statements`]. Each returned string
/// is one statement WITHOUT its trailing `;` (trimmed of surrounding
/// whitespace); empty / comment-only segments are dropped, so
/// `split_statements(s).len() == count_statements(s)`.
///
/// Used by the MySQL adapter, which executes a dump statement-by-statement (its
/// DDL auto-commits, so it tracks exactly how far it got on a mid-script
/// failure). The same best-effort caveats as [`count_statements`] apply.
pub fn split_statements(script: &str) -> Vec<String> {
    let bytes = script.as_bytes();
    let mut i = 0usize;
    let len = bytes.len();
    let mut statements: Vec<String> = Vec::new();
    let mut start = 0usize;

    // Keep a segment only if it carries real (non-whitespace, non-comment)
    // content — exactly the predicate `count_statements` uses — so that
    // `split_statements(s).len() == count_statements(s)`.
    let push = |statements: &mut Vec<String>, slice: &str| {
        if count_statements(slice) > 0 {
            statements.push(slice.trim().to_string());
        }
    };

    while i < len {
        let c = bytes[i];
        match c {
            b'\'' | b'"' | b'`' => {
                let quote = c;
                i += 1;
                while i < len {
                    if bytes[i] == quote {
                        if i + 1 < len && bytes[i + 1] == quote {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'-' if i + 1 < len && bytes[i + 1] == b'-' => {
                i += 2;
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < len && bytes[i + 1] == b'*' => {
                i += 2;
                while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            b';' => {
                // `start..i` is the statement body (the slice is valid UTF-8
                // because we only ever split on ASCII bytes outside literals).
                push(&mut statements, &script[start.min(len)..i.min(len)]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < len {
        push(&mut statements, &script[start..]);
    }
    statements
}

/// Generates engine-specific DDL: ALTER dialects, identifier quoting,
/// type mappings. Still a deliberate stub — methods arrive with the
/// structure editor milestones (M8/M14).
pub trait DdlDialect {}

/// Upper bound (bytes) for inlining a binary/blob value as hex. Covers the
/// common fixed-size cases — UUID (16), SHA-1 (20), SHA-256 (32) — which are
/// routinely used as keys / foreign keys. Larger values stay a placeholder.
pub const INLINE_BINARY_MAX_BYTES: usize = 32;

/// Render a binary/blob column value as JSON, shared by every engine adapter so
/// SQLite/MySQL/Postgres represent binary identically.
///
/// Small values (≤ [`INLINE_BINARY_MAX_BYTES`]) become a `0x`-prefixed
/// lowercase-hex string — readable in the grid AND usable as a real value (e.g.
/// a binary primary/foreign key). Larger blobs keep the `[N bytes]` placeholder:
/// there is no blob viewer yet, and shipping megabytes of hex across IPC for one
/// grid cell helps no one.
/// serde `skip_serializing_if` helper: omit a `false` flag from the wire so the
/// `binary` flags only appear when set, keeping the JSON clean and the
/// wire-shape tests stable.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

/// True for binary column types (binary / varbinary / blob / bytea), matched
/// case-insensitively on the declared type text. Used by the SQL export to emit
/// hex literals for binary columns so they round-trip.
pub fn is_binary_type(data_type: &str) -> bool {
    let t = data_type.to_ascii_lowercase();
    t.contains("binary") || t.contains("blob") || t.contains("bytea")
}

/// True if `s` is a canonical 8-4-4-4-12 hex UUID.
fn is_uuid_str(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && s.chars()
            .enumerate()
            .all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) || c.is_ascii_hexdigit())
}

/// Decode an even-length hex string to bytes; `None` on odd length or a non-hex
/// digit.
fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(hex.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    Some(out)
}

/// Parse a binary cell value (as the renderer sends it for a binary column — a
/// `0x`-hex string, a canonical UUID, or bare hex) into raw bytes for binding to
/// a BINARY/BLOB/BYTEA column. `null` → `None` (binds NULL). A non-string value
/// or malformed hex is a §5 `Invalid` error.
pub fn parse_binary_value(value: &serde_json::Value) -> Result<Option<Vec<u8>>, AppError> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(s) => {
            let t = s.trim();
            let hex: String = if is_uuid_str(t) {
                t.chars().filter(|c| *c != '-').collect()
            } else {
                t.strip_prefix("0x")
                    .or_else(|| t.strip_prefix("0X"))
                    .unwrap_or(t)
                    .to_string()
            };
            decode_hex(&hex).map(Some).ok_or_else(|| {
                AppError::Invalid(format!("'{s}' is not valid binary (hex or UUID)"))
            })
        }
        other => Err(AppError::Invalid(format!(
            "a binary value must be a hex/UUID string, got {other}"
        ))),
    }
}

pub fn binary_to_json(bytes: &[u8]) -> serde_json::Value {
    use std::fmt::Write as _;
    if bytes.len() <= INLINE_BINARY_MAX_BYTES {
        let mut s = String::with_capacity(2 + bytes.len() * 2);
        s.push_str("0x");
        for b in bytes {
            let _ = write!(s, "{b:02x}");
        }
        serde_json::Value::String(s)
    } else {
        serde_json::Value::String(format!("[{} bytes]", bytes.len()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_to_json_inlines_small_as_hex_and_placeholders_large() {
        assert_eq!(binary_to_json(&[]), serde_json::json!("0x"));
        assert_eq!(
            binary_to_json(&[0x00, 0xab, 0xff]),
            serde_json::json!("0x00abff")
        );
        // 16-byte UUID-shaped value → 0x + 32 hex chars.
        let uuid = [0x12u8; 16];
        assert_eq!(
            binary_to_json(&uuid),
            serde_json::json!("0x12121212121212121212121212121212")
        );
        // Exactly at the limit still inlines; one over falls back to placeholder.
        assert_eq!(
            binary_to_json(&[0u8; INLINE_BINARY_MAX_BYTES])
                .as_str()
                .unwrap()
                .len(),
            2 + INLINE_BINARY_MAX_BYTES * 2
        );
        assert_eq!(
            binary_to_json(&[0u8; INLINE_BINARY_MAX_BYTES + 1]),
            serde_json::json!(format!("[{} bytes]", INLINE_BINARY_MAX_BYTES + 1))
        );
    }

    #[test]
    fn count_statements_counts_terminated_and_trailing() {
        // Two terminated statements.
        assert_eq!(
            count_statements("CREATE TABLE t (id INT); INSERT INTO t VALUES (1);"),
            2
        );
        // A trailing statement with no final `;` still counts.
        assert_eq!(count_statements("SELECT 1; SELECT 2"), 2);
        // Empty / whitespace-only / pure-comment scripts count zero.
        assert_eq!(count_statements(""), 0);
        assert_eq!(count_statements("   \n\t  "), 0);
        assert_eq!(count_statements(";;;"), 0);
        assert_eq!(count_statements("-- just a comment\n"), 0);
        assert_eq!(count_statements("/* block only */"), 0);
    }

    #[test]
    fn count_statements_ignores_semicolons_in_strings_and_comments() {
        // A `;` inside a single-quoted literal is not a boundary.
        assert_eq!(
            count_statements("INSERT INTO t VALUES ('a;b;c'); SELECT 1;"),
            2
        );
        // Doubled quote inside a literal stays inside.
        assert_eq!(
            count_statements("INSERT INTO t VALUES ('O''Brien; Jr'); SELECT 1;"),
            2
        );
        // `;` inside a line comment is ignored; the statement spans the comment.
        assert_eq!(count_statements("SELECT 1 -- a; b; c\n; SELECT 2;"), 2);
        // `;` inside a block comment is ignored.
        assert_eq!(count_statements("SELECT 1 /* ; ; ; */; SELECT 2;"), 2);
        // Backtick identifiers (MySQL) may legally contain `;`.
        assert_eq!(count_statements("SELECT `we;ird`; SELECT 2;"), 2);
        // Double-quoted identifier with a `;` inside.
        assert_eq!(count_statements("SELECT \"a;b\"; SELECT 2;"), 2);
    }

    #[test]
    fn split_statements_splits_and_trims_and_matches_count() {
        let script =
            "CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);";
        let parts = split_statements(script);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts.len() as u64, count_statements(script));
        assert_eq!(parts[0], "CREATE TABLE t (id INT)");
        assert_eq!(parts[1], "INSERT INTO t VALUES (1)");
        assert_eq!(parts[2], "INSERT INTO t VALUES (2)");
    }

    #[test]
    fn split_statements_keeps_semicolons_inside_literals() {
        let parts = split_statements("INSERT INTO t VALUES ('a;b'); SELECT 1");
        assert_eq!(parts, vec!["INSERT INTO t VALUES ('a;b')", "SELECT 1"]);
    }

    #[test]
    fn split_statements_drops_empty_and_comment_only_segments() {
        // Leading comment, blank segments, trailing statement without `;`.
        let parts = split_statements("-- header\n;; CREATE TABLE t (id INT) ;\n  ; SELECT 1");
        assert_eq!(parts, vec!["CREATE TABLE t (id INT)", "SELECT 1"]);
        assert_eq!(
            parts.len() as u64,
            count_statements("-- header\n;; CREATE TABLE t (id INT) ;\n  ; SELECT 1")
        );
        // Pure comment → no statements.
        assert!(split_statements("/* nothing here */").is_empty());
    }

    #[test]
    fn import_result_wire_shape_is_camel_case() {
        assert_eq!(
            serde_json::to_value(ImportResult { statements: 3 }).unwrap(),
            serde_json::json!({ "statements": 3 })
        );
    }

    #[test]
    fn engine_serializes_lowercase_matching_renderer() {
        assert_eq!(serde_json::to_value(Engine::Sqlite).unwrap(), "sqlite");
        assert_eq!(serde_json::to_value(Engine::Mysql).unwrap(), "mysql");
        assert_eq!(serde_json::to_value(Engine::Postgres).unwrap(), "postgres");
    }

    #[test]
    fn sqlite_params_wire_shape_is_engine_tagged_camel_case() {
        let params = ConnectionParams::Sqlite {
            path: "/tmp/db.sqlite".into(),
        };
        assert_eq!(
            serde_json::to_value(&params).unwrap(),
            serde_json::json!({ "engine": "sqlite", "path": "/tmp/db.sqlite" })
        );
    }

    #[test]
    fn server_params_round_trip_and_report_their_engine() {
        let params = ConnectionParams::Mysql {
            host: "db.internal".into(),
            port: 3306,
            database: Some("shop".into()),
            user: Some("app".into()),
            tls_mode: TlsMode::Require,
            ssh: None,
        };
        assert_eq!(params.engine(), Engine::Mysql);
        assert!(params.ssh().is_none());
        let json = serde_json::to_value(&params).unwrap();
        // `tlsMode` is the canonical wire field; `ssh` is omitted when None.
        assert_eq!(json["tlsMode"], serde_json::json!("require"));
        assert!(json.get("ssh").is_none());
        let back: ConnectionParams = serde_json::from_value(json).unwrap();
        assert_eq!(back, params);
    }

    #[test]
    fn tls_mode_tokens_round_trip_and_default_is_prefer() {
        for (mode, token) in [
            (TlsMode::Disable, "disable"),
            (TlsMode::Prefer, "prefer"),
            (TlsMode::Require, "require"),
            (TlsMode::VerifyCa, "verify-ca"),
            (TlsMode::VerifyFull, "verify-full"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), token);
            assert_eq!(mode.as_token(), token);
            let back: TlsMode = serde_json::from_value(serde_json::json!(token)).unwrap();
            assert_eq!(back, mode);
        }
        assert_eq!(TlsMode::default(), TlsMode::Prefer);
    }

    #[test]
    fn legacy_tls_bool_migrates_to_tls_mode() {
        // Old saved connection: `tls: true` → Prefer.
        let old_true: ConnectionParams = serde_json::from_value(serde_json::json!({
            "engine": "postgres",
            "host": "db", "port": 5432, "database": "app", "user": "u",
            "tls": true
        }))
        .unwrap();
        assert!(matches!(
            old_true,
            ConnectionParams::Postgres {
                tls_mode: TlsMode::Prefer,
                ..
            }
        ));
        // `tls: false` → Disable.
        let old_false: ConnectionParams = serde_json::from_value(serde_json::json!({
            "engine": "mysql",
            "host": "db", "port": 3306, "database": "app", "user": "u",
            "tls": false
        }))
        .unwrap();
        assert!(matches!(
            old_false,
            ConnectionParams::Mysql {
                tls_mode: TlsMode::Disable,
                ..
            }
        ));
        // Neither field present → default (Prefer).
        let neither: ConnectionParams = serde_json::from_value(serde_json::json!({
            "engine": "postgres",
            "host": "db", "port": 5432, "database": "app", "user": "u"
        }))
        .unwrap();
        assert!(matches!(
            neither,
            ConnectionParams::Postgres {
                tls_mode: TlsMode::Prefer,
                ..
            }
        ));
    }

    #[test]
    fn server_params_with_ssh_round_trip() {
        let params = ConnectionParams::Postgres {
            host: "bt-pg".into(),
            port: 5432,
            database: Some("bytetable".into()),
            user: Some("postgres".into()),
            tls_mode: TlsMode::Disable,
            ssh: Some(SshConfig {
                host: "bastion".into(),
                port: 22,
                user: "tunnel".into(),
                auth: SshAuth::Key {
                    key_path: "~/.ssh/id_ed25519".into(),
                },
            }),
        };
        let json = serde_json::to_value(&params).unwrap();
        assert_eq!(
            json["ssh"],
            serde_json::json!({
                "host": "bastion",
                "port": 22,
                "user": "tunnel",
                "auth": { "method": "key", "keyPath": "~/.ssh/id_ed25519" }
            })
        );
        let back: ConnectionParams = serde_json::from_value(json).unwrap();
        assert_eq!(back, params);
        assert_eq!(back.ssh().map(|s| s.host.as_str()), Some("bastion"));

        // Password + agent auth shapes round-trip.
        for auth in [SshAuth::Password, SshAuth::Agent] {
            let p = ConnectionParams::Mysql {
                host: "h".into(),
                port: 3306,
                database: Some("d".into()),
                user: Some("u".into()),
                tls_mode: TlsMode::Prefer,
                ssh: Some(SshConfig {
                    host: "b".into(),
                    port: 2222,
                    user: "t".into(),
                    auth: auth.clone(),
                }),
            };
            let back: ConnectionParams =
                serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
            assert_eq!(back, p);
        }
    }

    #[test]
    fn engine_redis_serializes_lowercase() {
        assert_eq!(serde_json::to_value(Engine::Redis).unwrap(), "redis");
        let back: Engine = serde_json::from_value(serde_json::json!("redis")).unwrap();
        assert_eq!(back, Engine::Redis);
        assert_eq!(Engine::Redis.display_name(), "Redis");
    }

    #[test]
    fn redis_params_wire_shape_is_camel_case_and_round_trips() {
        let params = ConnectionParams::Redis {
            host: "cache.byteshop.io".into(),
            port: 6379,
            db_index: 0,
            user: None,
            tls_mode: TlsMode::Disable,
            ssh: None,
        };
        assert_eq!(params.engine(), Engine::Redis);
        assert!(params.ssh().is_none());
        let json = serde_json::to_value(&params).unwrap();
        assert_eq!(json["engine"], serde_json::json!("redis"));
        assert_eq!(json["dbIndex"], serde_json::json!(0));
        assert_eq!(json["tlsMode"], serde_json::json!("disable"));
        // `user` and `ssh` are omitted when None.
        assert!(json.get("user").is_none());
        assert!(json.get("ssh").is_none());
        // No relational `database` field exists on the Redis variant.
        assert!(json.get("database").is_none());
        let back: ConnectionParams = serde_json::from_value(json).unwrap();
        assert_eq!(back, params);
    }

    #[test]
    fn redis_params_defaults_port_db_index_and_user() {
        // Minimal payload: only engine + host. port→6379, dbIndex→0, user→None.
        let params: ConnectionParams =
            serde_json::from_value(serde_json::json!({ "engine": "redis", "host": "h" })).unwrap();
        assert_eq!(
            params,
            ConnectionParams::Redis {
                host: "h".into(),
                port: 6379,
                db_index: 0,
                user: None,
                tls_mode: TlsMode::Prefer,
                ssh: None,
            }
        );
        // An ACL user + non-zero db index + legacy tls bool.
        let params: ConnectionParams = serde_json::from_value(serde_json::json!({
            "engine": "redis", "host": "h", "port": 63790,
            "dbIndex": 3, "user": "app", "tls": true
        }))
        .unwrap();
        assert!(matches!(
            params,
            ConnectionParams::Redis {
                db_index: 3,
                tls_mode: TlsMode::Prefer,
                ..
            }
        ));
        if let ConnectionParams::Redis { user, .. } = &params {
            assert_eq!(user.as_deref(), Some("app"));
        }
    }

    #[test]
    fn connection_kind_serializes_lowercase() {
        assert_eq!(serde_json::to_value(ConnectionKind::Sql).unwrap(), "sql");
        assert_eq!(serde_json::to_value(ConnectionKind::Kv).unwrap(), "kv");
    }

    #[test]
    fn table_meta_wire_shape_is_camel_case_with_nullable_fk() {
        let meta = TableMeta {
            columns: vec![
                ColumnInfo {
                    name: "author_id".into(),
                    data_type: "INTEGER".into(),
                    nullable: false,
                    pk: false,
                    default_value: None,
                    fk: Some(FkRef {
                        table: "authors".into(),
                        column: "id".into(),
                    }),
                },
                ColumnInfo {
                    name: "note".into(),
                    data_type: String::new(),
                    nullable: true,
                    pk: true,
                    default_value: Some("'n/a'".into()),
                    fk: None,
                },
            ],
            ..Default::default()
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "columns": [
                    {
                        "name": "author_id",
                        "dataType": "INTEGER",
                        "nullable": false,
                        "pk": false,
                        "default": null,
                        "fk": { "table": "authors", "column": "id" }
                    },
                    {
                        "name": "note",
                        "dataType": "",
                        "nullable": true,
                        "pk": true,
                        "default": "'n/a'",
                        "fk": null
                    }
                ],
                // M7 additions: always present on the wire, empty/null by default.
                "comment": null,
                "indexes": [],
                "foreignKeys": [],
                "referencedBy": [],
                "ddl": null
            })
        );
        // And the shape round-trips.
        let back: TableMeta = serde_json::from_value(json).unwrap();
        assert_eq!(back, meta);
    }

    #[test]
    fn table_meta_m7_structure_fields_wire_shape_round_trips() {
        let meta = TableMeta {
            columns: vec![ColumnInfo {
                name: "id".into(),
                data_type: "INTEGER".into(),
                nullable: true,
                pk: true,
                default_value: None,
                fk: None,
            }],
            comment: Some("the books table".into()),
            indexes: vec![
                IndexInfo {
                    name: "sqlite_autoindex_books_1".into(),
                    columns: vec!["id".into()],
                    unique: true,
                    primary: true,
                    origin: Some("pk".into()),
                },
                IndexInfo {
                    name: "idx_books_author_title".into(),
                    columns: vec!["author_id".into(), "title".into()],
                    unique: false,
                    primary: false,
                    origin: Some("c".into()),
                },
            ],
            foreign_keys: vec![ForeignKeyInfo {
                name: None,
                columns: vec!["author_id".into()],
                ref_table: "authors".into(),
                ref_columns: vec!["id".into()],
                on_delete: Some("CASCADE".into()),
                on_update: Some("NO ACTION".into()),
            }],
            referenced_by: vec![InboundFkInfo {
                table: "reviews".into(),
                columns: vec!["book_id".into()],
                ref_columns: vec!["id".into()],
                on_delete: Some("SET NULL".into()),
            }],
            ddl: Some("CREATE TABLE books (id INTEGER PRIMARY KEY)".into()),
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "columns": [
                    { "name": "id", "dataType": "INTEGER", "nullable": true, "pk": true, "default": null, "fk": null }
                ],
                "comment": "the books table",
                "indexes": [
                    {
                        "name": "sqlite_autoindex_books_1",
                        "columns": ["id"],
                        "unique": true,
                        "primary": true,
                        "origin": "pk"
                    },
                    {
                        "name": "idx_books_author_title",
                        "columns": ["author_id", "title"],
                        "unique": false,
                        "primary": false,
                        "origin": "c"
                    }
                ],
                "foreignKeys": [
                    {
                        "name": null,
                        "columns": ["author_id"],
                        "refTable": "authors",
                        "refColumns": ["id"],
                        "onDelete": "CASCADE",
                        "onUpdate": "NO ACTION"
                    }
                ],
                "referencedBy": [
                    {
                        "table": "reviews",
                        "columns": ["book_id"],
                        "refColumns": ["id"],
                        "onDelete": "SET NULL"
                    }
                ],
                "ddl": "CREATE TABLE books (id INTEGER PRIMARY KEY)"
            })
        );
        let back: TableMeta = serde_json::from_value(json).unwrap();
        assert_eq!(back, meta);
    }

    #[test]
    fn query_options_default_limit_and_camel_case_wire_field() {
        let opts: QueryOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(opts.row_limit, 500);
        assert_eq!(opts.schema, None);
        let opts: QueryOptions = serde_json::from_str(r#"{"rowLimit": 10}"#).unwrap();
        assert_eq!(opts.row_limit, 10);
    }

    #[test]
    fn sort_direction_serializes_lowercase_and_maps_to_sql_keywords() {
        assert_eq!(serde_json::to_value(SortDirection::Asc).unwrap(), "asc");
        assert_eq!(serde_json::to_value(SortDirection::Desc).unwrap(), "desc");
        assert_eq!(SortDirection::Asc.sql_keyword(), "ASC");
        assert_eq!(SortDirection::Desc.sql_keyword(), "DESC");
    }

    #[test]
    fn fetch_rows_request_wire_shape_is_camel_case_and_round_trips() {
        let req = FetchRowsRequest {
            schema: "main".into(),
            table: "users".into(),
            sort: Some(SortSpec {
                column: "name".into(),
                direction: SortDirection::Desc,
            }),
            filter: None,
            offset: 100,
            limit: 50,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "schema": "main",
                "table": "users",
                "sort": { "column": "name", "direction": "desc" },
                "filter": null,
                "offset": 100,
                "limit": 50
            })
        );
        let back: FetchRowsRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);

        // A sortless request keeps `sort: null` on the wire and round-trips.
        let unsorted = FetchRowsRequest {
            sort: None,
            ..req.clone()
        };
        let json = serde_json::to_value(&unsorted).unwrap();
        assert_eq!(json["sort"], serde_json::Value::Null);
        let back: FetchRowsRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, unsorted);

        // `filter` is optional on the wire: an absent key deserializes to None.
        let no_filter_key: FetchRowsRequest = serde_json::from_value(serde_json::json!({
            "schema": "main",
            "table": "users",
            "sort": null,
            "offset": 0,
            "limit": 10
        }))
        .unwrap();
        assert_eq!(no_filter_key.filter, None);
    }

    #[test]
    fn filter_op_wire_tokens_are_camel_case_and_round_trip() {
        let cases = [
            (FilterOp::Eq, "eq"),
            (FilterOp::Ne, "ne"),
            (FilterOp::Gt, "gt"),
            (FilterOp::Gte, "gte"),
            (FilterOp::Lt, "lt"),
            (FilterOp::Lte, "lte"),
            (FilterOp::Contains, "contains"),
            (FilterOp::NotContains, "notContains"),
            (FilterOp::BeginsWith, "beginsWith"),
            (FilterOp::EndsWith, "endsWith"),
            (FilterOp::InList, "inList"),
            (FilterOp::IsNull, "isNull"),
            (FilterOp::IsNotNull, "isNotNull"),
        ];
        for (op, token) in cases {
            assert_eq!(serde_json::to_value(op).unwrap(), token);
            let back: FilterOp = serde_json::from_value(serde_json::json!(token)).unwrap();
            assert_eq!(back, op);
        }
        assert!(FilterOp::Eq.needs_value());
        assert!(!FilterOp::IsNull.needs_value());
        assert!(!FilterOp::IsNotNull.needs_value());
    }

    #[test]
    fn combinator_serializes_lowercase_and_maps_to_keywords() {
        assert_eq!(serde_json::to_value(Combinator::And).unwrap(), "and");
        assert_eq!(serde_json::to_value(Combinator::Or).unwrap(), "or");
        assert_eq!(Combinator::And.sql_keyword(), "AND");
        assert_eq!(Combinator::Or.sql_keyword(), "OR");
    }

    #[test]
    fn filter_value_untagged_distinguishes_scalar_from_list() {
        // A JSON array → List; a bare scalar → Scalar.
        let list: FilterValue = serde_json::from_value(serde_json::json!(["DE", "FR"])).unwrap();
        assert_eq!(
            list,
            FilterValue::List(vec![serde_json::json!("DE"), serde_json::json!("FR")])
        );
        let scalar: FilterValue = serde_json::from_value(serde_json::json!(42)).unwrap();
        assert_eq!(scalar, FilterValue::Scalar(serde_json::json!(42)));
        let text: FilterValue = serde_json::from_value(serde_json::json!("paid")).unwrap();
        assert_eq!(text, FilterValue::Scalar(serde_json::json!("paid")));
    }

    #[test]
    fn filter_spec_conditions_mode_wire_shape_round_trips() {
        let spec = FilterSpec::Conditions {
            items: vec![
                Condition {
                    column: "status".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!("paid"))),
                    binary: false,
                },
                Condition {
                    column: "deleted_at".into(),
                    op: FilterOp::IsNull,
                    value: None,
                    binary: false,
                },
                Condition {
                    column: "country".into(),
                    op: FilterOp::InList,
                    value: Some(FilterValue::List(vec![
                        serde_json::json!("DE"),
                        serde_json::json!("FR"),
                    ])),
                    binary: false,
                },
            ],
            combinator: Combinator::And,
        };
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "mode": "conditions",
                "items": [
                    { "column": "status", "op": "eq", "value": "paid" },
                    { "column": "deleted_at", "op": "isNull", "value": null },
                    { "column": "country", "op": "inList", "value": ["DE", "FR"] }
                ],
                "combinator": "and"
            })
        );
        let back: FilterSpec = serde_json::from_value(json).unwrap();
        assert_eq!(back, spec);
    }

    #[test]
    fn filter_spec_raw_mode_wire_shape_round_trips() {
        let spec = FilterSpec::Raw {
            sql: "total > 100 AND country IN ('DE', 'FR')".into(),
        };
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "mode": "raw",
                "sql": "total > 100 AND country IN ('DE', 'FR')"
            })
        );
        let back: FilterSpec = serde_json::from_value(json).unwrap();
        assert_eq!(back, spec);
    }

    #[test]
    fn row_lookup_request_wire_shape_is_camel_case_and_round_trips() {
        let req = RowLookupRequest {
            schema: "main".into(),
            table: "authors".into(),
            column: "id".into(),
            value: serde_json::json!(42),
            binary: false,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "schema": "main",
                "table": "authors",
                "column": "id",
                "value": 42
            })
        );
        let back: RowLookupRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);
    }

    #[test]
    fn row_lookup_wire_shape_is_camel_case_and_round_trips() {
        let found = RowLookup {
            columns: vec![ColumnMeta {
                name: "id".into(),
                type_hint: "INTEGER".into(),
            }],
            row: Some(vec![serde_json::json!(42), serde_json::json!("Ada")]),
            match_count: 1,
        };
        let json = serde_json::to_value(&found).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "columns": [{ "name": "id", "typeHint": "INTEGER" }],
                "row": [42, "Ada"],
                "matchCount": 1
            })
        );
        let back: RowLookup = serde_json::from_value(json).unwrap();
        assert_eq!(back, found);

        // A miss keeps `row: null` on the wire.
        let miss = RowLookup {
            row: None,
            match_count: 0,
            ..found
        };
        let json = serde_json::to_value(&miss).unwrap();
        assert_eq!(json["row"], serde_json::Value::Null);
        assert_eq!(json["matchCount"], serde_json::json!(0));
    }

    #[test]
    fn column_stats_request_wire_shape_is_camel_case_and_round_trips() {
        let req = ColumnStatsRequest {
            schema: "main".into(),
            table: "products".into(),
            column: "qty".into(),
            filter: Some(FilterSpec::Conditions {
                items: vec![Condition {
                    column: "status".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!("paid"))),
                    binary: false,
                }],
                combinator: Combinator::And,
            }),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "schema": "main",
                "table": "products",
                "column": "qty",
                "filter": {
                    "mode": "conditions",
                    "items": [{ "column": "status", "op": "eq", "value": "paid" }],
                    "combinator": "and"
                }
            })
        );
        let back: ColumnStatsRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);

        // `filter` is optional on the wire: an absent key deserializes to None.
        let no_filter: ColumnStatsRequest = serde_json::from_value(serde_json::json!({
            "schema": "main",
            "table": "products",
            "column": "qty"
        }))
        .unwrap();
        assert_eq!(no_filter.filter, None);
    }

    #[test]
    fn column_stats_wire_shape_is_camel_case_and_round_trips() {
        let stats = ColumnStats {
            total: 4,
            distinct: 3,
            nulls: 1,
            min: Some(serde_json::json!(0)),
            max: Some(serde_json::json!(10)),
            avg: Some(5.0),
            numeric: true,
            top: vec![
                FreqEntry {
                    value: serde_json::json!(5),
                    count: 2,
                },
                FreqEntry {
                    value: serde_json::json!(0),
                    count: 1,
                },
            ],
        };
        let json = serde_json::to_value(&stats).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "total": 4,
                "distinct": 3,
                "nulls": 1,
                "min": 0,
                "max": 10,
                "avg": 5.0,
                "numeric": true,
                "top": [
                    { "value": 5, "count": 2 },
                    { "value": 0, "count": 1 }
                ]
            })
        );
        let back: ColumnStats = serde_json::from_value(json).unwrap();
        assert_eq!(back, stats);

        // A text column: avg None, min/max present, numeric false.
        let text = ColumnStats {
            total: 2,
            distinct: 2,
            nulls: 0,
            min: Some(serde_json::json!("apple")),
            max: Some(serde_json::json!("banana")),
            avg: None,
            numeric: false,
            top: vec![],
        };
        let json = serde_json::to_value(&text).unwrap();
        assert_eq!(json["avg"], serde_json::Value::Null);
        assert_eq!(json["numeric"], serde_json::json!(false));
        assert_eq!(json["top"], serde_json::json!([]));
    }

    #[test]
    fn rows_page_wire_shape_is_camel_case_and_round_trips() {
        let page = RowsPage {
            columns: vec![ColumnMeta {
                name: "id".into(),
                type_hint: "INTEGER".into(),
            }],
            rows: vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]],
            offset: 0,
            limit: 100,
            total_rows: Some(42),
            elapsed_ms: 3,
        };
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "columns": [{ "name": "id", "typeHint": "INTEGER" }],
                "rows": [[1], [2]],
                "offset": 0,
                "limit": 100,
                "totalRows": 42,
                "elapsedMs": 3
            })
        );
        let back: RowsPage = serde_json::from_value(json).unwrap();
        assert_eq!(back, page);
    }

    #[test]
    fn update_cell_request_wire_shape_is_camel_case_and_round_trips() {
        let req = UpdateCellRequest {
            schema: "main".into(),
            table: "users".into(),
            column: "name".into(),
            value: serde_json::json!("Ada"),
            pk: vec![PkPredicate {
                column: "id".into(),
                value: serde_json::json!(42),
                binary: false,
            }],
            binary: false,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "schema": "main",
                "table": "users",
                "column": "name",
                "value": "Ada",
                "pk": [{ "column": "id", "value": 42 }]
            })
        );
        let back: UpdateCellRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);

        // A null new value round-trips (the "set to NULL" case).
        let null_value = UpdateCellRequest {
            value: serde_json::Value::Null,
            ..req.clone()
        };
        let json = serde_json::to_value(&null_value).unwrap();
        assert_eq!(json["value"], serde_json::Value::Null);
        let back: UpdateCellRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, null_value);

        // A composite-pk request carries one predicate per pk column.
        let composite = UpdateCellRequest {
            pk: vec![
                PkPredicate {
                    column: "a".into(),
                    value: serde_json::json!(1),
                    binary: false,
                },
                PkPredicate {
                    column: "b".into(),
                    value: serde_json::json!("x"),
                    binary: false,
                },
            ],
            ..req
        };
        let json = serde_json::to_value(&composite).unwrap();
        assert_eq!(
            json["pk"],
            serde_json::json!([
                { "column": "a", "value": 1 },
                { "column": "b", "value": "x" }
            ])
        );
        let back: UpdateCellRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, composite);
    }

    #[test]
    fn update_result_wire_shape_is_camel_case_and_round_trips() {
        let result = UpdateResult {
            affected: 1,
            statement: r#"UPDATE "main"."users" SET "name" = 'Ada' WHERE "id" = 42"#.into(),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "affected": 1,
                "statement": r#"UPDATE "main"."users" SET "name" = 'Ada' WHERE "id" = 42"#
            })
        );
        let back: UpdateResult = serde_json::from_value(json).unwrap();
        assert_eq!(back, result);
    }
}
