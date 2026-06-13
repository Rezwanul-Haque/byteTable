//! Tauri command handlers for the key-value (Redis) slice. Deserialize →
//! use-case → serialize; no logic lives here. Each command reads the
//! connections feature's `ConnectionsState` for the open-handle manager (the
//! same sanctioned cross-feature composition the SQL introspection slice uses)
//! and resolves the key-value connection via `ConnectionManager::get_kv`.
//!
//! All commands are `async fn` per the async-commands rule — they drive real
//! Redis work over the multiplexed connection.
//!
//! Wire: camelCase args, lowercase enums (matching
//! `src/features/redis_browse/api.ts`). The `db` argument selects the logical
//! Redis database per call (the renderer passes the workspace's current db);
//! the adapter binds it without racing a shared selected-db (see
//! `engines::redis`).

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;
use crate::shared::keyvalue::{
    KeyType, KeyView, KvDbInfo, KvServerInfo, KvServerStats, RespReply, ScanPage, ScanRequest,
};

use super::application;

#[tauri::command]
pub async fn kv_server_info(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<KvServerInfo, AppError> {
    application::server_info(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn kv_server_stats(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<KvServerStats, AppError> {
    application::server_stats(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn kv_keyspace(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<KvDbInfo>, AppError> {
    application::keyspace(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn kv_scan(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    request: ScanRequest,
) -> Result<ScanPage, AppError> {
    application::scan(state.manager(), &handle_id, db, request).await
}

#[tauri::command]
pub async fn kv_get_key(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
) -> Result<KeyView, AppError> {
    application::get_key(state.manager(), &handle_id, db, &key).await
}

#[tauri::command]
pub async fn kv_set_string(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    value: String,
) -> Result<(), AppError> {
    application::set_string(state.manager(), &handle_id, db, &key, &value).await
}

#[tauri::command]
pub async fn kv_hash_set(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    field: String,
    value: String,
) -> Result<(), AppError> {
    application::hash_set(state.manager(), &handle_id, db, &key, &field, &value).await
}

#[tauri::command]
pub async fn kv_hash_del(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    field: String,
) -> Result<bool, AppError> {
    application::hash_del(state.manager(), &handle_id, db, &key, &field).await
}

#[tauri::command]
pub async fn kv_list_set(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    index: i64,
    value: String,
) -> Result<(), AppError> {
    application::list_set(state.manager(), &handle_id, db, &key, index, &value).await
}

#[tauri::command]
pub async fn kv_set_add(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    member: String,
) -> Result<bool, AppError> {
    application::set_add(state.manager(), &handle_id, db, &key, &member).await
}

#[tauri::command]
pub async fn kv_set_remove(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    member: String,
) -> Result<bool, AppError> {
    application::set_remove(state.manager(), &handle_id, db, &key, &member).await
}

#[tauri::command]
pub async fn kv_zset_add(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    member: String,
    score: f64,
) -> Result<(), AppError> {
    application::zset_add(state.manager(), &handle_id, db, &key, &member, score).await
}

#[tauri::command]
pub async fn kv_zset_remove(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    member: String,
) -> Result<bool, AppError> {
    application::zset_remove(state.manager(), &handle_id, db, &key, &member).await
}

#[tauri::command]
pub async fn kv_delete_key(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
) -> Result<bool, AppError> {
    application::delete_key(state.manager(), &handle_id, db, &key).await
}

#[tauri::command]
pub async fn kv_rename_key(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    new_key: String,
) -> Result<(), AppError> {
    application::rename_key(state.manager(), &handle_id, db, &key, &new_key).await
}

#[tauri::command]
pub async fn kv_expire(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    seconds: i64,
) -> Result<bool, AppError> {
    application::expire(state.manager(), &handle_id, db, &key, seconds).await
}

#[tauri::command]
pub async fn kv_persist(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
) -> Result<bool, AppError> {
    application::persist(state.manager(), &handle_id, db, &key).await
}

#[tauri::command]
pub async fn kv_create_key(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    key: String,
    key_type: KeyType,
    initial: Option<String>,
) -> Result<(), AppError> {
    application::create_key(
        state.manager(),
        &handle_id,
        db,
        &key,
        key_type,
        initial.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn kv_command(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: u8,
    args: Vec<String>,
) -> Result<RespReply, AppError> {
    application::run_command(state.manager(), &handle_id, db, args).await
}
