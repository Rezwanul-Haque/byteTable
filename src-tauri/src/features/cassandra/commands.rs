//! Tauri command handlers for the Cassandra slice. Deserialize → use-case →
//! serialize; no logic lives here. Each command reads the connections feature's
//! `ConnectionsState` for the open-handle manager and resolves the wide-column
//! connection via `ConnectionManager::get_wide_column`.
//!
//! All commands are `async fn` per the async-commands rule — they drive real
//! Cassandra work over the DataStax/ScyllaDB driver session.
//!
//! Wire: camelCase args (matching `src/features/cassandra_browse/api.ts`).

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;
use crate::shared::widecolumn::{
    CassCqlResult, CassCreateIndex, CassCreateKeyspace, CassCreateMv, CassCreateTable,
    CassDeleteRow, CassDeleteRows, CassInsertRow, CassQueryRequest, CassQueryResult, CassUpdateRow,
    ClusterStatus, KeyspaceInfo, TableDescriptor,
};

use super::application;

#[tauri::command]
pub async fn cassandra_list_keyspaces(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<KeyspaceInfo>, AppError> {
    application::list_keyspaces(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn cassandra_list_tables(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
) -> Result<Vec<TableDescriptor>, AppError> {
    application::list_tables(state.manager(), &handle_id, &keyspace).await
}

#[tauri::command]
pub async fn cassandra_table_meta(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
    table: String,
) -> Result<TableDescriptor, AppError> {
    application::table_meta(state.manager(), &handle_id, &keyspace, &table).await
}

#[tauri::command]
pub async fn cassandra_cluster_status(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<ClusterStatus, AppError> {
    application::cluster_status(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn cassandra_query(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: CassQueryRequest,
) -> Result<CassQueryResult, AppError> {
    application::query(state.manager(), &handle_id, request).await
}

#[tauri::command]
pub async fn cassandra_insert_row(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: CassInsertRow,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "insert rows")
        .await?;
    application::insert_row(state.manager(), &handle_id, request).await
}

#[tauri::command]
pub async fn cassandra_update_row(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: CassUpdateRow,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "change rows")
        .await?;
    application::update_row(state.manager(), &handle_id, request).await
}

#[tauri::command]
pub async fn cassandra_delete_row(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: CassDeleteRow,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "delete rows")
        .await?;
    application::delete_row(state.manager(), &handle_id, request).await
}

#[tauri::command]
pub async fn cassandra_run_cql(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
    cql: String,
    consistency: Option<String>,
) -> Result<CassCqlResult, AppError> {
    // The CQL editor can send anything, so the statement decides — the SQL
    // classifier reads CQL's statement vocabulary just as well.
    if state.manager().is_read_only(&handle_id).await
        && !crate::shared::readonly::sql_is_read_only(&cql)
    {
        return Err(crate::shared::readonly::read_only_error(
            "run a statement that changes data or structure",
        ));
    }
    application::run_cql(
        state.manager(),
        &handle_id,
        &keyspace,
        &cql,
        consistency.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn cassandra_delete_rows(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: CassDeleteRows,
) -> Result<u64, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "delete rows")
        .await?;
    application::delete_rows(state.manager(), &handle_id, request).await
}

#[tauri::command]
pub async fn cassandra_describe_table(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
    table: String,
) -> Result<String, AppError> {
    application::describe_table(state.manager(), &handle_id, &keyspace, &table).await
}

#[tauri::command]
pub async fn cassandra_create_index(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: CassCreateIndex,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "create indexes")
        .await?;
    application::create_index(state.manager(), &handle_id, request).await
}

#[tauri::command]
pub async fn cassandra_drop_index(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
    name: String,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "drop indexes")
        .await?;
    application::drop_index(state.manager(), &handle_id, &keyspace, &name).await
}

#[tauri::command]
pub async fn cassandra_create_mv(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: CassCreateMv,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "create materialized views")
        .await?;
    application::create_mv(state.manager(), &handle_id, request).await
}

#[tauri::command]
pub async fn cassandra_drop_mv(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
    name: String,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "drop materialized views")
        .await?;
    application::drop_mv(state.manager(), &handle_id, &keyspace, &name).await
}

#[tauri::command]
pub async fn cassandra_create_keyspace(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: CassCreateKeyspace,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "create keyspaces")
        .await?;
    application::create_keyspace(state.manager(), &handle_id, request).await
}

#[tauri::command]
pub async fn cassandra_drop_table(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
    name: String,
    drop_views: Option<bool>,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "drop tables")
        .await?;
    application::drop_table(
        state.manager(),
        &handle_id,
        &keyspace,
        &name,
        drop_views.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn cassandra_drop_keyspace(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "drop keyspaces")
        .await?;
    application::drop_keyspace(state.manager(), &handle_id, &keyspace).await
}

#[tauri::command]
pub async fn cassandra_truncate_table(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
    name: String,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "empty tables")
        .await?;
    application::truncate_table(state.manager(), &handle_id, &keyspace, &name).await
}

#[tauri::command]
pub async fn cassandra_empty_keyspace(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    keyspace: String,
) -> Result<u64, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "empty keyspaces")
        .await?;
    application::empty_keyspace(state.manager(), &handle_id, &keyspace).await
}

#[tauri::command]
pub async fn cassandra_create_table(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: CassCreateTable,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "create tables")
        .await?;
    application::create_table(state.manager(), &handle_id, request).await
}
