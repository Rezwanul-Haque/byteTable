//! DynamoDB write path: PutItem, batch write and PartiQL writes
//! (`DocumentStoreWriter`). Mirrors the `ports::document` write surface.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use aws_sdk_dynamodb::types::{
    AttributeDefinition, AttributeValue, BillingMode, DeleteRequest, KeySchemaElement, KeyType,
    ProvisionedThroughput, PutRequest, ScalarAttributeType, WriteRequest,
};
use serde_json::Value;

use crate::shared::document::*;
use crate::shared::error::AppError;

use super::error::db_err;
use super::value::json_to_item;
use super::DynamoConnection;

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
        let keys = keys
            .iter()
            .filter(|v| v.is_object())
            .map(json_to_item)
            .collect();
        self.delete_keys(table, keys).await
    }

    async fn create_table(&self, spec: CreateTableSpec) -> Result<TableDescriptor, AppError> {
        let name = spec.name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::Invalid("table name must not be empty".into()));
        }
        let pk = spec.pk.trim().to_string();
        if pk.is_empty() {
            return Err(AppError::Invalid(
                "a table needs a partition key attribute".into(),
            ));
        }
        let sk = spec
            .sk
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if sk.as_deref() == Some(pk.as_str()) {
            return Err(AppError::Invalid(
                "the sort key must be a different attribute from the partition key".into(),
            ));
        }

        let mut builder = self
            .client
            .create_table()
            .table_name(&name)
            .attribute_definitions(attr_def(&pk, &spec.pk_type)?)
            .key_schema(key_element(&pk, KeyType::Hash));
        if let Some(sk) = &sk {
            let sk_type = spec.sk_type.as_deref().unwrap_or("S");
            builder = builder
                .attribute_definitions(attr_def(sk, sk_type)?)
                .key_schema(key_element(sk, KeyType::Range));
        }

        // PROVISIONED is the only mode that takes capacity numbers, and the API
        // rejects the call without them — so they are defaulted, not optional,
        // on that path.
        builder = if spec.billing.eq_ignore_ascii_case("PROVISIONED") {
            builder
                .billing_mode(BillingMode::Provisioned)
                .provisioned_throughput(
                    ProvisionedThroughput::builder()
                        .read_capacity_units(spec.rcu.unwrap_or(5).max(1) as i64)
                        .write_capacity_units(spec.wcu.unwrap_or(5).max(1) as i64)
                        .build()
                        .expect("provisioned throughput set"),
                )
        } else {
            builder.billing_mode(BillingMode::PayPerRequest)
        };

        builder
            .send()
            .await
            .map_err(|e| db_err(&format!("Create table '{name}'"), e))?;

        // CreateTable returns while the table is still CREATING — a table the
        // caller cannot scan yet. Wait a bounded while for it to settle.
        for _ in 0..WAIT_TRIES {
            match self.descriptor(&name).await {
                Ok(desc) if desc.status == "ACTIVE" => return Ok(desc),
                Ok(_) => {}
                // Eventual consistency: a describe right after a create can
                // still 404. Keep waiting rather than failing a live create.
                Err(_) => {}
            }
            tokio::time::sleep(WAIT_STEP).await;
        }
        // Still not ACTIVE. The table exists and is on its way; hand back what
        // it looks like now (status included) rather than reporting a failure.
        self.descriptor(&name).await
    }

    async fn delete_table(&self, table: &str) -> Result<(), AppError> {
        self.client
            .delete_table()
            .table_name(table)
            .send()
            .await
            .map_err(|e| db_err(&format!("Delete table '{table}'"), e))?;

        // DELETING tables still appear in ListTables, so a refresh right after
        // this returns would show a ghost. Wait for it to actually go. Any
        // describe error means it is gone (or unreachable) — either way there
        // is nothing left to wait for.
        for _ in 0..WAIT_TRIES {
            if self.descriptor(table).await.is_err() {
                return Ok(());
            }
            tokio::time::sleep(WAIT_STEP).await;
        }
        Ok(())
    }

    async fn truncate_table(&self, table: &str) -> Result<u64, AppError> {
        let desc = self.descriptor(table).await?;

        // Project only the key attributes: the delete needs nothing else, and
        // reading whole items would multiply the scan's cost for nothing.
        // Placeholders because key attributes are free to be named `name`,
        // `status`, `size`… — all DynamoDB reserved words in an expression.
        let mut names: HashMap<String, String> = HashMap::new();
        names.insert("#pk".into(), desc.key_schema.pk.clone());
        let mut projection = String::from("#pk");
        if let Some(sk) = &desc.key_schema.sk {
            names.insert("#sk".into(), sk.clone());
            projection.push_str(", #sk");
        }

        let mut deleted = 0u64;
        let mut start_key: Option<HashMap<String, AttributeValue>> = None;
        loop {
            let out = self
                .client
                .scan()
                .table_name(table)
                .projection_expression(&projection)
                .set_expression_attribute_names(Some(names.clone()))
                .limit(SCAN_PAGE)
                .set_exclusive_start_key(start_key)
                .send()
                .await
                .map_err(|e| db_err(&format!("Scan '{table}' (truncate)"), e))?;

            let keys: Vec<HashMap<String, AttributeValue>> = out.items().to_vec();
            if !keys.is_empty() {
                deleted += self.delete_keys(table, keys).await?.written;
            }

            start_key = out.last_evaluated_key().cloned();
            if start_key.is_none() {
                break;
            }
        }
        Ok(deleted)
    }
}

/// How long a create/delete waits for DynamoDB's asynchronous DDL to settle:
/// 40 × 500ms = 20s, comfortably past a normal table's few seconds without
/// hanging the UI on a table that is taking unusually long.
const WAIT_TRIES: u32 = 40;
const WAIT_STEP: Duration = Duration::from_millis(500);

/// Items per truncate scan page. Larger than the 25-item write batch on
/// purpose — one scan feeds several batches.
const SCAN_PAGE: i32 = 500;

/// One `AttributeDefinition`, validating the declared key type.
fn attr_def(name: &str, ty: &str) -> Result<AttributeDefinition, AppError> {
    let scalar = match ty.to_ascii_uppercase().as_str() {
        "S" => ScalarAttributeType::S,
        "N" => ScalarAttributeType::N,
        "B" => ScalarAttributeType::B,
        other => {
            return Err(AppError::Invalid(format!(
                "key attribute '{name}' has type '{other}'; DynamoDB keys must be S (string), N (number) or B (binary)"
            )))
        }
    };
    AttributeDefinition::builder()
        .attribute_name(name)
        .attribute_type(scalar)
        .build()
        .map_err(|e| AppError::Invalid(format!("invalid key attribute '{name}': {e}")))
}

fn key_element(name: &str, kind: KeyType) -> KeySchemaElement {
    KeySchemaElement::builder()
        .attribute_name(name)
        .key_type(kind)
        .build()
        .expect("key schema element fully set")
}

impl DynamoConnection {
    /// Chunked `BatchWriteItem` of `DeleteRequest`s, retrying whatever the
    /// service hands back as unprocessed. Shared by the grid's delete-selected
    /// (which arrives as JSON keys) and by truncate (which already has
    /// AttributeValue keys straight off a scan).
    async fn delete_keys(
        &self,
        table: &str,
        keys: Vec<HashMap<String, AttributeValue>>,
    ) -> Result<BatchWriteResult, AppError> {
        const CHUNK: usize = 25; // DynamoDB BatchWriteItem hard limit.
        let mut written = 0u64;
        let mut unprocessed_total = 0u64;
        for chunk in keys.chunks(CHUNK) {
            let requests: Vec<WriteRequest> = chunk
                .iter()
                .map(|key| {
                    WriteRequest::builder()
                        .delete_request(
                            DeleteRequest::builder()
                                .set_key(Some(key.clone()))
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
