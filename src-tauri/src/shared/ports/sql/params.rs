// Connection-param + engine-tag types (the stored, secret-free connection
// shapes and their custom engine-tagged (de)serialisation).

use serde::{Deserialize, Serialize};

/// Database engines ByteTable supports. Lowercase on the wire, matching the
/// renderer's `Engine` type in `src/shared/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Sqlite,
    Mysql,
    Postgres,
    /// Microsoft SQL Server (M21) — a **fourth relational engine** (T-SQL
    /// dialect). It implements the same SQL [`EngineConnection`] surface as
    /// SQLite/MySQL/Postgres and flows through the relational workspace; only
    /// the dialect differs (bracket-quoted identifiers, `OFFSET…FETCH` paging,
    /// `IDENTITY`, `sys.*` catalog, `dbo` default schema, indexed views for
    /// materialized views, `sqlcmd` terminal). Backed by the `tiberius` TDS
    /// driver in [`crate::engines::mssql`].
    Mssql,
    /// Oracle Database (M23) — a **fifth relational engine** (Oracle SQL /
    /// PL/SQL dialect). It implements the same SQL [`EngineConnection`] surface
    /// as SQLite/MySQL/Postgres/SQL Server and flows through the relational
    /// workspace; only the dialect differs (uppercase user-schemas, the `ALL_*`
    /// catalog, `GENERATED … AS IDENTITY`, `OFFSET…FETCH` paging, real
    /// materialized views, `SYSTIMESTAMP`/`SYS_GUID()` defaults, `sqlplus`
    /// terminal). Backed by the OCI `oracle` crate in [`crate::engines::oracle`]
    /// behind the `engine-oracle` Cargo feature — see that module's docs for the
    /// Instant Client / driver rationale. The `Engine::Oracle` seam itself is
    /// compiled unconditionally so the engine exists in the type system and UI
    /// even when the driver feature is off.
    Oracle,
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
    /// MongoDB (M18) — a document database (databases → collections → BSON
    /// documents, an aggregation pipeline). NOT relational, NOT the Redis
    /// keyspace, and distinct from DynamoDB's single-table document model. It
    /// implements its own MongoDB port family in [`crate::shared::mongo`]; the
    /// [`OpenConnection`] kind seam keeps it apart from every other family.
    Mongodb,
    /// Cassandra (M19) — a wide-column store (cluster → keyspaces → tables with
    /// partition/clustering keys, denormalized `*_by_*` query tables, CQL). NOT
    /// relational and distinct from every NoSQL family above: CQL's
    /// partition-key / clustering / `ALLOW FILTERING` semantics warrant their own
    /// port family in [`crate::shared::widecolumn`]; the [`OpenConnection`] kind
    /// seam keeps it apart from SQL / key-value / document / MongoDB.
    Cassandra,
}

impl Engine {
    /// Human display name for error messages and UI copy.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Sqlite => "SQLite",
            Self::Mysql => "MySQL",
            Self::Postgres => "PostgreSQL",
            Self::Mssql => "SQL Server",
            Self::Oracle => "Oracle",
            Self::Redis => "Redis",
            Self::Dynamodb => "DynamoDB",
            Self::Mongodb => "MongoDB",
            Self::Cassandra => "Cassandra",
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
    /// A Microsoft SQL Server (M21). Same relational shape as MySQL/Postgres —
    /// password + SSH secrets live in the OS keychain, never here. `database`
    /// and `user` are optional: omitted, the driver connects to the login's
    /// default database with the server's default user. Default port 1433.
    Mssql {
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
    /// An Oracle Database (M23). Relational like MySQL/Postgres/SQL Server, but
    /// Oracle connects by **service name** (`service_name`, e.g. `ORCLPDB1`) on
    /// the TNS listener rather than a relational `database`; `sid` is the
    /// optional legacy SID form (mutually exclusive with the service name at
    /// DSN-build time, service name preferred). `user` is the optional schema
    /// user (Oracle uppercases it). Default port 1521. Password + SSH secrets
    /// live in the OS keychain, never here.
    Oracle {
        host: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        service_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sid: Option<String>,
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
    /// MongoDB (M18) — a document database. Two connect shapes (the modal's
    /// Host/port ⇄ Connection string toggle): when `uri` is `Some` it is a full
    /// `mongodb://` / `mongodb+srv://` (Atlas SRV) connection string and the
    /// host/port/database/user fields are ignored; otherwise the connector
    /// assembles a URI from `host`/`port`/`database`/`user`/`tls_mode`. The
    /// password (either mode) lives in the OS keychain, never here.
    Mongodb {
        /// A full `mongodb://` / `mongodb+srv://` URI (connection-string mode).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
        host: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        database: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
        tls_mode: TlsMode,
    },
    /// Cassandra (M19) — a wide-column store reached over the native (CQL)
    /// protocol. `contact_points` is the host (or comma-separated list of hosts)
    /// the driver connects to and discovers the rest of the ring from; `port` is
    /// the native-protocol port (default 9042). `keyspace` (optional) is the
    /// initial keyspace; `local_datacenter` (optional, e.g. `dc1`) enables
    /// token-aware, DC-local routing. `user` is the optional auth username; the
    /// password (PasswordAuthenticator) lives in the OS keychain, never here. No
    /// SSH tunnel (mirrors DynamoDB / MongoDB).
    Cassandra {
        contact_points: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyspace: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        local_datacenter: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
        tls_mode: TlsMode,
    },
}

impl ConnectionParams {
    /// The engine these parameters target.
    pub fn engine(&self) -> Engine {
        match self {
            Self::Sqlite { .. } => Engine::Sqlite,
            Self::Mysql { .. } => Engine::Mysql,
            Self::Postgres { .. } => Engine::Postgres,
            Self::Mssql { .. } => Engine::Mssql,
            Self::Oracle { .. } => Engine::Oracle,
            Self::Redis { .. } => Engine::Redis,
            Self::Dynamodb { .. } => Engine::Dynamodb,
            Self::Mongodb { .. } => Engine::Mongodb,
            Self::Cassandra { .. } => Engine::Cassandra,
        }
    }

    /// The SSH tunnel config, when this is a server connection reached through
    /// a bastion. `None` for SQLite and for direct server connections.
    pub fn ssh(&self) -> Option<&SshConfig> {
        match self {
            Self::Sqlite { .. }
            | Self::Dynamodb { .. }
            | Self::Mongodb { .. }
            | Self::Cassandra { .. } => None,
            Self::Mysql { ssh, .. }
            | Self::Postgres { ssh, .. }
            | Self::Mssql { ssh, .. }
            | Self::Oracle { ssh, .. }
            | Self::Redis { ssh, .. } => ssh.as_ref(),
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
            "mysql" | "postgres" | "mssql" => {
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
                match engine {
                    "mysql" => Ok(ConnectionParams::Mysql {
                        host,
                        port,
                        database,
                        user,
                        tls_mode,
                        ssh,
                    }),
                    "mssql" => Ok(ConnectionParams::Mssql {
                        host,
                        port,
                        database,
                        user,
                        tls_mode,
                        ssh,
                    }),
                    _ => Ok(ConnectionParams::Postgres {
                        host,
                        port,
                        database,
                        user,
                        tls_mode,
                        ssh,
                    }),
                }
            }
            "oracle" => {
                // Oracle differs from the mysql/postgres/mssql group: it
                // connects by `serviceName` (or the legacy `sid`) rather than a
                // relational `database`. `user` is optional; TLS + SSH are read
                // exactly like the SQL engines (granular `tlsMode`, legacy `tls`
                // bool tolerated). `port` defaults to 1521.
                let host = value
                    .get("host")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .ok_or_else(|| D::Error::custom("oracle params missing 'host'"))?;
                let port = value
                    .get("port")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|p| u16::try_from(p).ok())
                    .unwrap_or(1521);
                let opt_str = |k: &str| {
                    value
                        .get(k)
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                };
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
                Ok(ConnectionParams::Oracle {
                    host,
                    port,
                    service_name: opt_str("serviceName"),
                    sid: opt_str("sid"),
                    user: opt_str("user"),
                    tls_mode,
                    ssh,
                })
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
            "mongodb" => {
                // MongoDB carries either a full `uri` (connection-string mode)
                // or host/port/database/user (+ tlsMode) fields. `port` defaults
                // to 27017, host to "localhost". TLS reads like the SQL engines
                // (granular `tlsMode`, legacy `tls` bool tolerated). No SSH.
                let uri = value
                    .get("uri")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let host = value
                    .get("host")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("localhost")
                    .to_string();
                let port = value
                    .get("port")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|p| u16::try_from(p).ok())
                    .unwrap_or(27017);
                let opt_str = |k: &str| {
                    value
                        .get(k)
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                };
                let tls_mode = match value.get("tlsMode") {
                    Some(m) => TlsMode::deserialize(m.clone()).map_err(D::Error::custom)?,
                    None => match value.get("tls").and_then(serde_json::Value::as_bool) {
                        Some(true) => TlsMode::Prefer,
                        Some(false) => TlsMode::Disable,
                        None => TlsMode::default(),
                    },
                };
                Ok(ConnectionParams::Mongodb {
                    uri,
                    host,
                    port,
                    database: opt_str("database"),
                    user: opt_str("user"),
                    tls_mode,
                })
            }
            "cassandra" => {
                // Cassandra carries the contact points (host or comma-separated
                // hosts), the native port (default 9042), an optional initial
                // keyspace + local datacenter, an optional auth user, and the
                // granular `tlsMode` (legacy `tls` bool tolerated). No SSH.
                let contact_points = value
                    .get("contactPoints")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .ok_or_else(|| D::Error::custom("cassandra params missing 'contactPoints'"))?;
                let port = value
                    .get("port")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|p| u16::try_from(p).ok())
                    .unwrap_or(9042);
                let opt_str = |k: &str| {
                    value
                        .get(k)
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                };
                let tls_mode = match value.get("tlsMode") {
                    Some(m) => TlsMode::deserialize(m.clone()).map_err(D::Error::custom)?,
                    None => match value.get("tls").and_then(serde_json::Value::as_bool) {
                        Some(true) => TlsMode::Prefer,
                        Some(false) => TlsMode::Disable,
                        None => TlsMode::default(),
                    },
                };
                Ok(ConnectionParams::Cassandra {
                    contact_points,
                    port,
                    keyspace: opt_str("keyspace"),
                    local_datacenter: opt_str("localDatacenter"),
                    user: opt_str("user"),
                    tls_mode,
                })
            }
            other => Err(D::Error::custom(format!("unknown engine tag '{other}'"))),
        }
    }
}
