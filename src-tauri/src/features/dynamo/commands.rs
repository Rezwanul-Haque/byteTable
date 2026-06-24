//! Tauri command handlers for the DynamoDB slice. Deserialize → use-case →
//! serialize; no logic lives here. Each command reads the connections feature's
//! `ConnectionsState` for the open-handle manager and resolves the
//! document-store connection via `ConnectionManager::get_document`.
//!
//! All commands are `async fn` per the async-commands rule — they drive real
//! DynamoDB work over the AWS SDK client.
//!
//! Wire: camelCase args (matching `src/features/dynamo_browse/api.ts`). Items
//! and keys are plain JSON (`serde_json::Value`) — the adapter does the
//! AttributeValue marshalling, so the renderer never sees DynamoDB-typed JSON.

use serde_json::Value;
use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::document::{
    BatchWriteResult, ItemPage, QueryRequest, ScanRequest, StatementResult, TableDescriptor,
};
use crate::shared::error::AppError;

use super::application;

#[tauri::command]
pub async fn dynamo_list_table_names(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<String>, AppError> {
    application::list_table_names(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn dynamo_list_tables(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<TableDescriptor>, AppError> {
    application::list_tables(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn dynamo_describe_table(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    table: String,
) -> Result<TableDescriptor, AppError> {
    application::describe_table(state.manager(), &handle_id, &table).await
}

#[tauri::command]
pub async fn dynamo_scan(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    table: String,
    request: ScanRequest,
) -> Result<ItemPage, AppError> {
    application::scan(state.manager(), &handle_id, &table, request).await
}

#[tauri::command]
pub async fn dynamo_query(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    table: String,
    request: QueryRequest,
) -> Result<ItemPage, AppError> {
    application::query(state.manager(), &handle_id, &table, request).await
}

#[tauri::command]
pub async fn dynamo_get_item(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    table: String,
    key: Value,
) -> Result<Option<Value>, AppError> {
    application::get_item(state.manager(), &handle_id, &table, key).await
}

#[tauri::command]
pub async fn dynamo_put_item(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    table: String,
    item: Value,
) -> Result<(), AppError> {
    application::put_item(state.manager(), &handle_id, &table, item).await
}

#[tauri::command]
pub async fn dynamo_delete_item(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    table: String,
    key: Value,
) -> Result<(), AppError> {
    application::delete_item(state.manager(), &handle_id, &table, key).await
}

#[tauri::command]
pub async fn dynamo_batch_write(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    table: String,
    items: Vec<Value>,
) -> Result<BatchWriteResult, AppError> {
    application::batch_write(state.manager(), &handle_id, &table, items).await
}

#[tauri::command]
pub async fn dynamo_batch_delete(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    table: String,
    keys: Vec<Value>,
) -> Result<BatchWriteResult, AppError> {
    application::batch_delete(state.manager(), &handle_id, &table, keys).await
}

#[tauri::command]
pub async fn dynamo_execute_statement(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    statement: String,
    next_token: Option<String>,
) -> Result<StatementResult, AppError> {
    application::execute_statement(state.manager(), &handle_id, &statement, next_token).await
}
