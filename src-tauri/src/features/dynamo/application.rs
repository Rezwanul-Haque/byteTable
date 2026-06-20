//! Use-cases for the DynamoDB slice. Each thin function resolves the open
//! document-store connection behind a handle (via the connections feature's
//! `ConnectionManager::get_document`) and delegates to a port-trait method. No
//! Tauri, no drivers. The kind-mismatch / closed-handle §5 errors come from
//! `get_document`.

use serde_json::Value;

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::document::{
    BatchWriteResult, ItemPage, QueryRequest, ScanRequest, StatementResult, TableDescriptor,
};
use crate::shared::error::AppError;

/// `ListTables` + per-table `DescribeTable` (MILESTONE_17 §17.1).
pub async fn list_tables(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<TableDescriptor>, AppError> {
    manager.get_document(handle).await?.list_tables().await
}

/// `DescribeTable` for one table.
pub async fn describe_table(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    table: &str,
) -> Result<TableDescriptor, AppError> {
    manager
        .get_document(handle)
        .await?
        .describe_table(table)
        .await
}

/// One bounded `Scan` page (MILESTONE_17 §17.2 — Limit + continuation token).
pub async fn scan(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    table: &str,
    request: ScanRequest,
) -> Result<ItemPage, AppError> {
    manager
        .get_document(handle)
        .await?
        .scan(table, request)
        .await
}

/// One `Query` page (key-condition + optional GSI/LSI).
pub async fn query(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    table: &str,
    request: QueryRequest,
) -> Result<ItemPage, AppError> {
    manager
        .get_document(handle)
        .await?
        .query(table, request)
        .await
}

/// `GetItem` by full primary key.
pub async fn get_item(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    table: &str,
    key: Value,
) -> Result<Option<Value>, AppError> {
    manager
        .get_document(handle)
        .await?
        .get_item(table, key)
        .await
}

/// `PutItem` — create/overwrite a whole item (MILESTONE_17 §17.3).
pub async fn put_item(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    table: &str,
    item: Value,
) -> Result<(), AppError> {
    manager
        .get_document(handle)
        .await?
        .put_item(table, item)
        .await
}

/// `DeleteItem` by full primary key.
pub async fn delete_item(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    table: &str,
    key: Value,
) -> Result<(), AppError> {
    manager
        .get_document(handle)
        .await?
        .delete_item(table, key)
        .await
}

/// Chunked `BatchWriteItem` import (MILESTONE_17 §17.6).
pub async fn batch_write(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    table: &str,
    items: Vec<Value>,
) -> Result<BatchWriteResult, AppError> {
    manager
        .get_document(handle)
        .await?
        .batch_write(table, items)
        .await
}

/// Chunked `BatchWriteItem` delete-by-key (grid multi-select "delete selected").
pub async fn batch_delete(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    table: &str,
    keys: Vec<Value>,
) -> Result<BatchWriteResult, AppError> {
    manager
        .get_document(handle)
        .await?
        .batch_delete(table, keys)
        .await
}

/// `ExecuteStatement` (PartiQL) (MILESTONE_17 §17.4).
pub async fn execute_statement(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    statement: &str,
    next_token: Option<String>,
) -> Result<StatementResult, AppError> {
    manager
        .get_document(handle)
        .await?
        .execute_statement(statement, next_token)
        .await
}
