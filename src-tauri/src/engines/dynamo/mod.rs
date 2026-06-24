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

use std::collections::HashMap;

use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_config::Region;
use aws_credential_types::Credentials;
use aws_sdk_dynamodb::primitives::DateTimeFormat;
use aws_sdk_dynamodb::types::{
    AttributeValue, DeleteRequest, KeyType, PutRequest, ReturnConsumedCapacity, WriteRequest,
};
use aws_sdk_dynamodb::Client;
use serde_json::Value;

use crate::shared::document::{
    BatchWriteResult, DocumentStoreConnection, DocumentStoreReader, DocumentStoreWriter, ItemPage,
    KeySchema, QueryRequest, ScanRequest, SecondaryIndex, SortKeyOp, StatementResult,
    TableDescriptor,
};
use crate::shared::engine::{
    ConnectSecret, ConnectionParams, Connector, Engine, EngineInfo, OpenConnection,
};
use crate::shared::error::AppError;

use value::{attribute_union, item_to_json, json_to_item};

/// Maps an SDK error (any error in the chain) to a §5 human sentence. Walks the
/// `source()` chain so the underlying AWS message surfaces, not the generic
/// SdkError Display wrapper.
fn db_err<E: std::error::Error>(context: &str, error: E) -> AppError {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        let text = inner.to_string();
        if !text.is_empty() && !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = inner.source();
    }
    AppError::Database(format!("{context}: {message}"))
}

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

/// Encode a `LastEvaluatedKey` map as an opaque JSON continuation token.
fn encode_token(key: Option<&HashMap<String, AttributeValue>>) -> Option<String> {
    key.map(|k| item_to_json(k).to_string())
}

/// Decode a continuation token back into an `ExclusiveStartKey` map.
fn decode_token(token: &str) -> Result<HashMap<String, AttributeValue>, AppError> {
    let value: Value = serde_json::from_str(token)
        .map_err(|e| AppError::Invalid(format!("invalid pagination token: {e}")))?;
    Ok(json_to_item(&value))
}

/// Build an `AttributeValue` for a key/condition operand, honoring the declared
/// attribute type (`N` → number, everything else → string).
fn operand(
    attr_types: &std::collections::BTreeMap<String, String>,
    attr: &str,
    raw: &str,
) -> AttributeValue {
    match attr_types.get(attr).map(String::as_str) {
        Some("N") => AttributeValue::N(raw.to_string()),
        _ => AttributeValue::S(raw.to_string()),
    }
}

/// Build a `ProjectionExpression` + its `#p{i}` name aliases from a
/// comma-separated attribute list. Aliasing every name dodges DynamoDB reserved
/// words (e.g. `name`, `status`). Returns `None` for an empty/blank spec.
fn build_projection(spec: Option<&str>) -> Option<(String, HashMap<String, String>)> {
    let names: Vec<&str> = spec?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if names.is_empty() {
        return None;
    }
    let mut aliases = HashMap::new();
    let mut parts = Vec::with_capacity(names.len());
    for (i, name) in names.iter().enumerate() {
        let alias = format!("#p{i}");
        aliases.insert(alias.clone(), (*name).to_string());
        parts.push(alias);
    }
    Some((parts.join(", "), aliases))
}

#[async_trait]
impl DocumentStoreReader for DynamoConnection {
    async fn list_table_names(&self) -> Result<Vec<String>, AppError> {
        let out = self
            .client
            .list_tables()
            .send()
            .await
            .map_err(|e| db_err("List tables", e))?;
        Ok(out.table_names().to_vec())
    }

    async fn list_tables(&self) -> Result<Vec<TableDescriptor>, AppError> {
        let out = self
            .client
            .list_tables()
            .send()
            .await
            .map_err(|e| db_err("List tables", e))?;
        let names: Vec<String> = out.table_names().to_vec();
        let mut tables = Vec::with_capacity(names.len());
        for name in names {
            tables.push(self.descriptor(&name).await?);
        }
        Ok(tables)
    }

    async fn describe_table(&self, table: &str) -> Result<TableDescriptor, AppError> {
        self.descriptor(table).await
    }

    async fn scan(&self, table: &str, req: ScanRequest) -> Result<ItemPage, AppError> {
        let mut builder = self
            .client
            .scan()
            .table_name(table)
            .limit(req.limit.min(1000) as i32)
            .return_consumed_capacity(ReturnConsumedCapacity::Total);
        if let Some(token) = &req.next_token {
            builder = builder.set_exclusive_start_key(Some(decode_token(token)?));
        }
        if let Some((expr, names)) = build_projection(req.projection.as_deref()) {
            builder = builder
                .projection_expression(expr)
                .set_expression_attribute_names(Some(names));
        }
        let out = builder
            .send()
            .await
            .map_err(|e| db_err(&format!("Scan '{table}'"), e))?;

        let items: Vec<Value> = out.items().iter().map(item_to_json).collect();
        let scanned = out.scanned_count().max(0) as u64;
        let count = out.count().max(0) as u64;
        let capacity = out
            .consumed_capacity()
            .and_then(|c| c.capacity_units())
            .unwrap_or((scanned as f64) * 0.5);
        Ok(ItemPage {
            count: if count == 0 {
                items.len() as u64
            } else {
                count
            },
            scanned_count: scanned,
            capacity,
            index_name: None,
            next_token: encode_token(out.last_evaluated_key()),
            items,
        })
    }

    async fn query(&self, table: &str, req: QueryRequest) -> Result<ItemPage, AppError> {
        // Resolve the (pk, sk) attribute names + declared types for the chosen
        // index (base table when None) — exactly like the prototype.
        let desc = self.descriptor(table).await?;
        let (pk_attr, sk_attr) = match &req.index {
            Some(name) => {
                let idx = desc
                    .gsis
                    .iter()
                    .chain(desc.lsis.iter())
                    .find(|i| &i.name == name)
                    .ok_or_else(|| {
                        AppError::Invalid(format!("index '{name}' does not exist on '{table}'"))
                    })?;
                (idx.pk.clone(), idx.sk.clone())
            }
            None => (desc.key_schema.pk.clone(), desc.key_schema.sk.clone()),
        };

        let mut names = HashMap::new();
        names.insert("#pk".to_string(), pk_attr.clone());
        let mut values = HashMap::new();
        values.insert(
            ":pk".to_string(),
            operand(&desc.attr_types, &pk_attr, &req.pk_value),
        );
        let mut condition = "#pk = :pk".to_string();

        // Optional sort-key condition.
        if let (Some(op), Some(sk_name), Some(sk_val)) =
            (req.sk_op, sk_attr.as_ref(), req.sk_value.as_ref())
        {
            if !sk_val.is_empty() {
                names.insert("#sk".to_string(), sk_name.clone());
                values.insert(
                    ":sk".to_string(),
                    operand(&desc.attr_types, sk_name, sk_val),
                );
                let clause = match op {
                    SortKeyOp::Eq => "#sk = :sk".to_string(),
                    SortKeyOp::Lt => "#sk < :sk".to_string(),
                    SortKeyOp::Lte => "#sk <= :sk".to_string(),
                    SortKeyOp::Gt => "#sk > :sk".to_string(),
                    SortKeyOp::Gte => "#sk >= :sk".to_string(),
                    SortKeyOp::BeginsWith => "begins_with(#sk, :sk)".to_string(),
                    SortKeyOp::Between => {
                        let hi = req.sk_value2.clone().unwrap_or_else(|| sk_val.clone());
                        values.insert(":sk2".to_string(), operand(&desc.attr_types, sk_name, &hi));
                        "#sk BETWEEN :sk AND :sk2".to_string()
                    }
                };
                condition.push_str(" AND ");
                condition.push_str(&clause);
            }
        }

        // Projection: merge its `#p{i}` aliases into the shared names map (one
        // ExpressionAttributeNames per request) and add the expression.
        let projection = build_projection(req.projection.as_deref());
        if let Some((_, proj_names)) = &projection {
            for (alias, attr) in proj_names {
                names.insert(alias.clone(), attr.clone());
            }
        }

        let mut builder = self
            .client
            .query()
            .table_name(table)
            .key_condition_expression(condition)
            .set_expression_attribute_names(Some(names))
            .set_expression_attribute_values(Some(values))
            .limit(req.limit.min(1000) as i32)
            .return_consumed_capacity(ReturnConsumedCapacity::Total);
        if let Some((expr, _)) = projection {
            builder = builder.projection_expression(expr);
        }
        if let Some(name) = &req.index {
            builder = builder.index_name(name);
        }
        if let Some(token) = &req.next_token {
            builder = builder.set_exclusive_start_key(Some(decode_token(token)?));
        }

        let out = builder
            .send()
            .await
            .map_err(|e| db_err(&format!("Query '{table}'"), e))?;

        let items: Vec<Value> = out.items().iter().map(item_to_json).collect();
        let count = out.count().max(0) as u64;
        let capacity = out
            .consumed_capacity()
            .and_then(|c| c.capacity_units())
            .unwrap_or((items.len() as f64) * 0.5);
        Ok(ItemPage {
            count: if count == 0 {
                items.len() as u64
            } else {
                count
            },
            scanned_count: out.scanned_count().max(0) as u64,
            capacity,
            index_name: req.index,
            next_token: encode_token(out.last_evaluated_key()),
            items,
        })
    }

    async fn get_item(&self, table: &str, key: Value) -> Result<Option<Value>, AppError> {
        let out = self
            .client
            .get_item()
            .table_name(table)
            .set_key(Some(json_to_item(&key)))
            .send()
            .await
            .map_err(|e| db_err(&format!("GetItem '{table}'"), e))?;
        Ok(out.item().map(item_to_json))
    }

    async fn execute_statement(
        &self,
        statement: &str,
        next_token: Option<String>,
    ) -> Result<StatementResult, AppError> {
        let mut builder = self.client.execute_statement().statement(statement);
        if let Some(token) = next_token {
            builder = builder.next_token(token);
        }
        let out = builder
            .send()
            .await
            .map_err(|e| db_err("PartiQL statement failed", e))?;
        let items: Vec<Value> = out.items().iter().map(item_to_json).collect();
        let columns = attribute_union(&items);
        // DynamoDB plans Query vs Scan from the statement; surface a light hint
        // (a WHERE on the partition key plans a Query).
        let op = if statement.to_lowercase().contains(" where ") {
            "Query"
        } else {
            "Scan"
        };
        Ok(StatementResult {
            count: items.len() as u64,
            columns,
            op: op.to_string(),
            next_token: out.next_token().map(str::to_string),
            items,
        })
    }
}

#[async_trait]
impl DocumentStoreWriter for DynamoConnection {
    async fn put_item(&self, table: &str, item: Value) -> Result<(), AppError> {
        if !item.is_object() {
            return Err(AppError::Invalid("item must be a JSON object".into()));
        }
        self.client
            .put_item()
            .table_name(table)
            .set_item(Some(json_to_item(&item)))
            .send()
            .await
            .map_err(|e| db_err(&format!("PutItem '{table}'"), e))?;
        Ok(())
    }

    async fn delete_item(&self, table: &str, key: Value) -> Result<(), AppError> {
        self.client
            .delete_item()
            .table_name(table)
            .set_key(Some(json_to_item(&key)))
            .send()
            .await
            .map_err(|e| db_err(&format!("DeleteItem '{table}'"), e))?;
        Ok(())
    }

    async fn batch_write(
        &self,
        table: &str,
        items: Vec<Value>,
    ) -> Result<BatchWriteResult, AppError> {
        const CHUNK: usize = 25; // DynamoDB BatchWriteItem hard limit.
        let mut written = 0u64;
        let mut unprocessed_total = 0u64;
        for chunk in items.chunks(CHUNK) {
            let requests: Vec<WriteRequest> = chunk
                .iter()
                .filter(|v| v.is_object())
                .map(|v| {
                    WriteRequest::builder()
                        .put_request(
                            PutRequest::builder()
                                .set_item(Some(json_to_item(v)))
                                .build()
                                .expect("put request item set"),
                        )
                        .build()
                })
                .collect();
            let attempted = requests.len() as u64;
            if attempted == 0 {
                continue;
            }
            let mut pending: HashMap<String, Vec<WriteRequest>> = HashMap::new();
            pending.insert(table.to_string(), requests);

            // Retry unprocessed items a bounded number of times.
            let mut tries = 0;
            loop {
                let out = self
                    .client
                    .batch_write_item()
                    .set_request_items(Some(pending.clone()))
                    .send()
                    .await
                    .map_err(|e| db_err(&format!("BatchWriteItem '{table}'"), e))?;
                let leftover = out
                    .unprocessed_items()
                    .and_then(|m| m.get(table))
                    .cloned()
                    .unwrap_or_default();
                tries += 1;
                if leftover.is_empty() || tries >= 5 {
                    let leftover_count = leftover.len() as u64;
                    written += attempted - leftover_count;
                    unprocessed_total += leftover_count;
                    break;
                }
                pending.clear();
                pending.insert(table.to_string(), leftover);
            }
        }
        Ok(BatchWriteResult {
            written,
            unprocessed: unprocessed_total,
        })
    }

    async fn batch_delete(
        &self,
        table: &str,
        keys: Vec<Value>,
    ) -> Result<BatchWriteResult, AppError> {
        const CHUNK: usize = 25; // DynamoDB BatchWriteItem hard limit.
        let mut written = 0u64;
        let mut unprocessed_total = 0u64;
        for chunk in keys.chunks(CHUNK) {
            let requests: Vec<WriteRequest> = chunk
                .iter()
                .filter(|v| v.is_object())
                .map(|v| {
                    WriteRequest::builder()
                        .delete_request(
                            DeleteRequest::builder()
                                .set_key(Some(json_to_item(v)))
                                .build()
                                .expect("delete request key set"),
                        )
                        .build()
                })
                .collect();
            let attempted = requests.len() as u64;
            if attempted == 0 {
                continue;
            }
            let mut pending: HashMap<String, Vec<WriteRequest>> = HashMap::new();
            pending.insert(table.to_string(), requests);

            // Retry unprocessed keys a bounded number of times.
            let mut tries = 0;
            loop {
                let out = self
                    .client
                    .batch_write_item()
                    .set_request_items(Some(pending.clone()))
                    .send()
                    .await
                    .map_err(|e| db_err(&format!("BatchWriteItem (delete) '{table}'"), e))?;
                let leftover = out
                    .unprocessed_items()
                    .and_then(|m| m.get(table))
                    .cloned()
                    .unwrap_or_default();
                tries += 1;
                if leftover.is_empty() || tries >= 5 {
                    let leftover_count = leftover.len() as u64;
                    written += attempted - leftover_count;
                    unprocessed_total += leftover_count;
                    break;
                }
                pending.clear();
                pending.insert(table.to_string(), leftover);
            }
        }
        Ok(BatchWriteResult {
            written,
            unprocessed: unprocessed_total,
        })
    }
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
