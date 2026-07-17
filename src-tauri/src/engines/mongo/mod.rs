//! MongoDB engine adapter (M18): the infrastructure implementation of the
//! MongoDB port family in [`crate::shared::mongo`]. Uses the official `mongodb`
//! driver on Tauri's tokio runtime — no `spawn_blocking`, mirroring the
//! sqlx/redis/dynamo adapters.
//!
//! # Connection (MILESTONE_18 §18.0)
//!
//! Built from [`ConnectionParams::Mongodb`]:
//! - **Connection-string mode** (`uri` is `Some`): parsed straight through
//!   `ClientOptions::parse`, accepting both `mongodb://` and `mongodb+srv://`
//!   (Atlas SRV). Credentials in the URI are honored as-is.
//! - **Host/port mode**: a [`ClientOptions`] is assembled from
//!   host/port/database/user + TLS, and the password (from the transient
//!   [`ConnectSecret`] / keychain) is injected into the credential.
//!
//! The reachability check is a `listDatabases` round-trip (which forces the
//! lazily-connecting driver to actually reach the server).
//!
//! # Safety (MILESTONE_18 "Notes / safety")
//!
//! - Counts come from `estimatedDocumentCount` / `collStats` — never a full
//!   scan to count.
//! - Every `find` is bounded by a default limit + `skip` paging.
//! - ObjectId / ISODate survive read → edit → write via the `{$oid}`/`{$date}`
//!   tags (see [`value`]).

mod value;

use std::time::Duration;

use async_trait::async_trait;
use mongodb::bson::{doc, Document};
use mongodb::options::{ClientOptions, Credential, ServerAddress, Tls, TlsOptions};
use mongodb::Client;
use serde_json::Value;

use crate::shared::engine::{
    ConnectSecret, ConnectionParams, Connector, Engine, EngineInfo, OpenConnection, TlsMode,
};
use crate::shared::error::AppError;
use crate::shared::mongo::{IndexInfo, MongoConnection};

use value::doc_to_json;

mod error;
mod reader;
mod writer;

use error::db_err;

/// Opens and tests MongoDB connections. Stateless; registered once in `lib.rs`.
pub struct MongoConnector;

#[async_trait]
impl Connector for MongoConnector {
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
        let client = build_client(params, secret).await?;
        // Round-trip check: listDatabases forces a real connection (the driver
        // connects lazily otherwise) — MILESTONE_18 §18.0 acceptance.
        client
            .list_database_names()
            .await
            .map_err(|e| db_err("MongoDB connection failed", e))?;
        Ok(read_engine_info(&client).await)
    }

    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        let client = build_client(params, secret).await?;
        client
            .list_database_names()
            .await
            .map_err(|e| db_err("MongoDB connection failed", e))?;
        let info = read_engine_info(&client).await;
        Ok(OpenConnection::mongo(MongoDbConnection { client, info }))
    }
}

/// Build the driver [`Client`] for `params`, honoring connection-string vs
/// host/port mode and injecting the password secret for host/port auth.
async fn build_client(
    params: &ConnectionParams,
    secret: Option<&ConnectSecret>,
) -> Result<Client, AppError> {
    let (uri, host, port, database, user, tls_mode) = match params {
        ConnectionParams::Mongodb {
            uri,
            host,
            port,
            database,
            user,
            tls_mode,
        } => (uri, host, *port, database, user, *tls_mode),
        other => {
            return Err(AppError::Invalid(format!(
                "MongoDB connector received {} params",
                other.engine().display_name()
            )))
        }
    };

    let mut options = if let Some(uri) = uri {
        // Connection-string mode: parse `mongodb://` or `mongodb+srv://` as-is.
        ClientOptions::parse(uri)
            .await
            .map_err(|e| db_err("Invalid MongoDB connection string", e))?
    } else {
        // Host/port mode: assemble options from the discrete fields.
        let mut options = ClientOptions::default();
        options.hosts = vec![ServerAddress::Tcp {
            host: host.clone(),
            port: Some(port),
        }];
        options.default_database = database.clone();
        if let Some(user) = user {
            let mut credential = Credential::default();
            credential.username = Some(user.clone());
            credential.password = secret
                .and_then(ConnectSecret::password)
                .map(str::to_string)
                .or(Some(String::new()));
            // Default the auth source to the target db (or "admin") — the
            // common case; a URI connection carries its own authSource.
            credential.source = database.clone().or_else(|| Some("admin".into()));
            options.credential = Some(credential);
        }
        options.tls = tls_for(tls_mode);
        options
    };

    options.app_name = Some("ByteTable".into());
    // Fail fast on an unreachable server rather than hanging the test button.
    options.server_selection_timeout = Some(Duration::from_secs(8));
    options.connect_timeout = Some(Duration::from_secs(8));

    Client::with_options(options).map_err(|e| db_err("Could not build MongoDB client", e))
}

/// Translate the modal's TLS mode into the driver's TLS config. MongoDB has no
/// "prefer" — local plaintext maps `disable`/`prefer` to no TLS; the verify
/// modes enable TLS, with `require` accepting an invalid/self-signed cert.
fn tls_for(mode: TlsMode) -> Option<Tls> {
    match mode {
        TlsMode::Disable | TlsMode::Prefer => None,
        TlsMode::Require => {
            let mut options = TlsOptions::default();
            options.allow_invalid_certificates = Some(true);
            Some(Tls::Enabled(options))
        }
        TlsMode::VerifyCa | TlsMode::VerifyFull => Some(Tls::Enabled(TlsOptions::default())),
    }
}

/// Read the server version (`buildInfo`) into [`EngineInfo`]; best-effort — a
/// version that can't be read still yields a usable "MongoDB" label.
async fn read_engine_info(client: &Client) -> EngineInfo {
    let version = client
        .database("admin")
        .run_command(doc! { "buildInfo": 1 })
        .await
        .ok()
        .and_then(|d| d.get_str("version").ok().map(str::to_string));
    EngineInfo {
        engine: Engine::Mongodb,
        server_version: match version {
            Some(v) => format!("MongoDB {v}"),
            None => "MongoDB".into(),
        },
    }
}

/// One open MongoDB connection: the driver client plus the resolved engine info.
/// The client is `Clone`/`Drop`-managed (an internal connection pool), so there
/// is no per-db handle cache and `close` is a no-op.
pub struct MongoDbConnection {
    client: Client,
    info: EngineInfo,
}

impl MongoDbConnection {
    /// The `<db>.<coll>` typed-as-`Document` collection handle.
    fn coll(&self, db: &str, coll: &str) -> mongodb::Collection<Document> {
        self.client.database(db).collection::<Document>(coll)
    }

    /// `listIndexes` → [`IndexInfo`] rows.
    async fn indexes(&self, db: &str, coll: &str) -> Result<Vec<IndexInfo>, AppError> {
        let mut cursor = self
            .coll(db, coll)
            .list_indexes()
            .await
            .map_err(|e| db_err(&format!("List indexes for '{coll}'"), e))?;
        let mut out = Vec::new();
        while cursor
            .advance()
            .await
            .map_err(|e| db_err("Read index", e))?
        {
            let model = cursor
                .deserialize_current()
                .map_err(|e| db_err("Decode index", e))?;
            let opts = model.options.unwrap_or_default();
            let name = opts
                .name
                .unwrap_or_else(|| index_name_from_keys(&model.keys));
            out.push(IndexInfo {
                name,
                keys: doc_to_json(&model.keys),
                unique: opts.unique,
                sparse: opts.sparse,
            });
        }
        Ok(out)
    }

    /// Collect a cursor of documents into tagged JSON values (bounded by the
    /// caller's limit) via the `advance`/`deserialize_current` API — no
    /// `futures` dependency.
    async fn drain(
        cursor: &mut mongodb::Cursor<Document>,
        context: &str,
    ) -> Result<Vec<Value>, AppError> {
        let mut docs = Vec::new();
        while cursor.advance().await.map_err(|e| db_err(context, e))? {
            let d = cursor
                .deserialize_current()
                .map_err(|e| db_err(context, e))?;
            docs.push(doc_to_json(&d));
        }
        Ok(docs)
    }
}

/// Derive a Mongo-style index name from its key pattern (`{category:1,price:-1}`
/// → `category_1_price_-1`) — used when the driver omits an explicit name.
fn index_name_from_keys(keys: &Document) -> String {
    keys.iter()
        .map(|(k, v)| {
            let dir = v
                .as_i32()
                .or_else(|| v.as_i64().map(|n| n as i32))
                .unwrap_or(1);
            format!("{k}_{dir}")
        })
        .collect::<Vec<_>>()
        .join("_")
}

#[async_trait]
impl MongoConnection for MongoDbConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn close(&self) -> Result<(), AppError> {
        // The driver client is Drop-managed (internal pool); nothing explicit.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_name_derived_from_keys() {
        let keys = doc! { "category": 1, "price": -1 };
        assert_eq!(index_name_from_keys(&keys), "category_1_price_-1");
    }
}
