//! DynamoDB write path: PutItem, batch write and PartiQL writes
//! (`DocumentStoreWriter`). Mirrors the `ports::document` write surface.

use std::collections::HashMap;

use async_trait::async_trait;
use aws_sdk_dynamodb::types::{DeleteRequest, PutRequest, WriteRequest};
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
