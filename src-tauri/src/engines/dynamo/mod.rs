//! DynamoDB engine adapter (M17): the infrastructure implementation of the
//! document port family in [`crate::shared::document`]. Uses the official AWS
//! SDK (`aws-sdk-dynamodb`) on Tauri's tokio runtime — no `spawn_blocking`,
//! mirroring the sqlx/redis adapters.
//!
//! # Credentials & endpoint (MILESTONE_17 §17.0)
//!
//! Built from [`ConnectionParams::Dynamodb`]:
//! - **Profile** auth resolves credentials from the shared `~/.aws/credentials`
//!   file via the SDK's profile provider.
//! - **Keys** auth uses static access keys — the access-key id from params, the
//!   secret access key from the transient [`ConnectSecret`] (keychain/modal).
//! - **Local**: a custom `endpoint` URL points the client at DynamoDB Local /
//!   LocalStack; the region is then just a label.
//!
//! # Safety (MILESTONE_17 "Notes / safety")
//!
//! - Item/size counts come from `DescribeTable` (approximate) — never a scan.
//! - Every scan is bounded by `Limit` + a continuation token (the
//!   `ExclusiveStartKey`/`LastEvaluatedKey` pair, threaded as an opaque JSON
//!   token string).
//!
//! # Errors
//!
//! SDK failures map to §5 human [`AppError::Database`] sentences via
//! [`db_err`], which walks the error's source chain so the real AWS message
//! (e.g. `ResourceNotFoundException`) surfaces rather than the generic
//! "service error" wrapper.

mod value;

use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_config::Region;
use aws_credential_types::Credentials;
use aws_sdk_dynamodb::primitives::DateTimeFormat;
use aws_sdk_dynamodb::types::KeyType;
use aws_sdk_dynamodb::Client;

use crate::shared::document::{
    DocumentStoreConnection, KeySchema, SecondaryIndex, TableDescriptor,
};
use crate::shared::engine::{
    ConnectSecret, ConnectionParams, Connector, Engine, EngineInfo, OpenConnection,
};
use crate::shared::error::AppError;

mod error;
mod reader;
mod writer;

use error::db_err;

/// Opens and tests DynamoDB connections. Stateless; registered once in `lib.rs`.
pub struct DynamoConnector;

#[async_trait]
impl Connector for DynamoConnector {
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
        let (client, info) = build_client(params, secret).await?;
        // Round-trip check: ListTables (MILESTONE_17 §17.0 acceptance).
        client
            .list_tables()
            .send()
            .await
            .map_err(|e| db_err("DynamoDB connection failed", e))?;
        Ok(info)
    }

    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        let (client, info) = build_client(params, secret).await?;
        // Validate reachability/credentials before handing back a handle.
        client
            .list_tables()
            .send()
            .await
            .map_err(|e| db_err("DynamoDB connection failed", e))?;
        Ok(OpenConnection::document(DynamoConnection { client, info }))
    }
}

/// Build the `aws_sdk_dynamodb::Client` for `params`, honoring the credential
/// mode (profile vs static keys) and any custom Local endpoint. Returns the
/// client plus the [`EngineInfo`] (engine + a region-tagged version string).
async fn build_client(
    params: &ConnectionParams,
    secret: Option<&ConnectSecret>,
) -> Result<(Client, EngineInfo), AppError> {
    let (region, endpoint, auth) = match params {
        ConnectionParams::Dynamodb {
            region,
            endpoint,
            auth,
        } => (region, endpoint, auth),
        other => {
            return Err(AppError::Invalid(format!(
                "DynamoDB connector received {} params",
                other.engine().display_name()
            )))
        }
    };

    let is_local = endpoint.is_some();

    let mut loader =
        aws_config::defaults(BehaviorVersion::latest()).region(Region::new(region.clone()));

    match auth {
        crate::shared::engine::DynamoAuth::Profile { profile } => {
            // DynamoDB Local / LocalStack ignore credentials, but the SDK still
            // needs *some* to sign requests — a named profile (default "default")
            // is usually absent on a local-only setup, so the provider chain
            // fails with "no providers in chain provided credentials". For a
            // custom endpoint we therefore inject dummy static credentials
            // (matching the form's "any access keys work"); only a real AWS
            // target resolves the shared-profile chain.
            if is_local {
                loader =
                    loader.credentials_provider(Credentials::from_keys("local", "local", None));
            } else {
                loader = loader.profile_name(profile.clone());
            }
        }
        crate::shared::engine::DynamoAuth::Keys { access_key_id } => {
            let secret_key = secret.and_then(ConnectSecret::password).unwrap_or("");
            // Allow an empty secret against a local endpoint (any keys work).
            let secret_key = if secret_key.is_empty() && is_local {
                "local"
            } else {
                secret_key
            };
            loader = loader.credentials_provider(Credentials::from_keys(
                access_key_id.clone(),
                secret_key.to_string(),
                None,
            ));
        }
    }

    if let Some(url) = endpoint {
        loader = loader.endpoint_url(url.clone());
    }

    let sdk_config = loader.load().await;
    let client = Client::new(&sdk_config);

    let info = EngineInfo {
        engine: Engine::Dynamodb,
        server_version: format!("DynamoDB (AWS SDK) · {region}"),
    };
    Ok((client, info))
}

/// One open DynamoDB connection: the SDK client plus the resolved engine info.
/// The SDK client is `Clone`/`Drop`-managed, so there is no per-db connection
/// cache (unlike Redis) and `close` is a no-op.
pub struct DynamoConnection {
    client: Client,
    info: EngineInfo,
}

impl DynamoConnection {
    /// Resolve a table's descriptor — used both as the public `describe_table`
    /// and internally to learn key/index attribute names for `query`.
    async fn descriptor(&self, table: &str) -> Result<TableDescriptor, AppError> {
        let out = self
            .client
            .describe_table()
            .table_name(table)
            .send()
            .await
            .map_err(|e| db_err(&format!("Describe table '{table}'"), e))?;
        let desc = out.table().ok_or_else(|| {
            AppError::NotFound(format!("Requested resource not found: Table {table}"))
        })?;

        // Declared attribute types (key/index attrs only — DynamoDB is otherwise
        // schemaless).
        let mut attr_types = std::collections::BTreeMap::new();
        for def in desc.attribute_definitions() {
            attr_types.insert(
                def.attribute_name().to_string(),
                def.attribute_type().as_str().to_string(),
            );
        }

        let key_schema = read_key_schema(desc.key_schema());

        let gsis = desc
            .global_secondary_indexes()
            .iter()
            .map(|g| SecondaryIndex {
                name: g.index_name().unwrap_or_default().to_string(),
                pk: index_key(g.key_schema(), KeyType::Hash).unwrap_or_default(),
                sk: index_key(g.key_schema(), KeyType::Range),
                projection: g
                    .projection()
                    .and_then(|p| p.projection_type())
                    .map(|t| t.as_str().to_string())
                    .unwrap_or_else(|| "ALL".into()),
            })
            .collect();

        let lsis = desc
            .local_secondary_indexes()
            .iter()
            .map(|l| SecondaryIndex {
                name: l.index_name().unwrap_or_default().to_string(),
                pk: index_key(l.key_schema(), KeyType::Hash).unwrap_or_default(),
                sk: index_key(l.key_schema(), KeyType::Range),
                projection: l
                    .projection()
                    .and_then(|p| p.projection_type())
                    .map(|t| t.as_str().to_string())
                    .unwrap_or_else(|| "ALL".into()),
            })
            .collect();

        // Billing + provisioned throughput.
        let billing_mode = desc
            .billing_mode_summary()
            .and_then(|b| b.billing_mode())
            .map(|m| m.as_str().to_string());
        let throughput = desc.provisioned_throughput();
        let rcu = throughput
            .and_then(|t| t.read_capacity_units())
            .filter(|&n| n > 0);
        let wcu = throughput
            .and_then(|t| t.write_capacity_units())
            .filter(|&n| n > 0);
        let billing = billing_mode.unwrap_or_else(|| {
            if rcu.is_some() || wcu.is_some() {
                "PROVISIONED".into()
            } else {
                "PAY_PER_REQUEST".into()
            }
        });

        let created = desc
            .creation_date_time()
            .and_then(|d| d.fmt(DateTimeFormat::DateTime).ok());

        // TTL is a separate call; best-effort (DynamoDB Local may not support it).
        let ttl_attribute = self.read_ttl(table).await;

        Ok(TableDescriptor {
            name: desc.table_name().unwrap_or(table).to_string(),
            key_schema,
            attr_types,
            gsis,
            lsis,
            billing,
            rcu: rcu.map(|n| n as u64),
            wcu: wcu.map(|n| n as u64),
            ttl_attribute,
            item_count: desc.item_count().unwrap_or(0).max(0) as u64,
            size_bytes: desc.table_size_bytes().unwrap_or(0).max(0) as u64,
            status: desc
                .table_status()
                .map(|s| s.as_str().to_string())
                .unwrap_or_else(|| "ACTIVE".into()),
            created,
        })
    }

    /// Best-effort TTL attribute lookup (`DescribeTimeToLive`); `None` on any
    /// error or when TTL is disabled.
    async fn read_ttl(&self, table: &str) -> Option<String> {
        let out = self
            .client
            .describe_time_to_live()
            .table_name(table)
            .send()
            .await
            .ok()?;
        out.time_to_live_description()
            .filter(|d| {
                matches!(
                    d.time_to_live_status(),
                    Some(aws_sdk_dynamodb::types::TimeToLiveStatus::Enabled)
                )
            })
            .and_then(|d| d.attribute_name())
            .map(str::to_string)
    }
}

/// Read a base-table key schema into [`KeySchema`] (HASH → pk, RANGE → sk).
fn read_key_schema(elements: &[aws_sdk_dynamodb::types::KeySchemaElement]) -> KeySchema {
    KeySchema {
        pk: index_key(elements, KeyType::Hash).unwrap_or_default(),
        sk: index_key(elements, KeyType::Range),
    }
}

/// The attribute name of the element with the given key type, if present.
fn index_key(
    elements: &[aws_sdk_dynamodb::types::KeySchemaElement],
    key_type: KeyType,
) -> Option<String> {
    elements
        .iter()
        .find(|e| *e.key_type() == key_type)
        .map(|e| e.attribute_name().to_string())
}

#[async_trait]
impl DocumentStoreConnection for DynamoConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn close(&self) -> Result<(), AppError> {
        // The SDK client is Drop-managed; nothing to tear down explicitly.
        Ok(())
    }
}
