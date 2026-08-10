//! Tauri command handlers for the search slice. Deserialize → use-case →
//! serialize; no logic lives here. Each command reads the connections feature's
//! `ConnectionsState` for the open-handle manager and resolves the search
//! connection via `ConnectionManager::get_search`.
//!
//! All commands are `async fn` per the async-commands rule — they drive real
//! HTTP work against the Typesense node.
//!
//! Wire: camelCase args (matching `src/features/browse/typesense/api.ts`).
//! Documents are plain JSON (`serde_json::Value`) — Typesense stores JSON, so
//! no marshalling layer is needed.
//!
//! Naming: the commands are prefixed `typesense_` (the engine the user
//! recognises), while the slice is named for the family — the same split the
//! `cassandra` commands / `widecolumn` port family already use.

use serde_json::Value;
use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;
use crate::shared::search::{
    AliasInfo, AnalyticsOverview, ApiKeyInfo, ClusterHealth, ClusterStats, CollectionDescriptor,
    CurationInfo, DocumentPage, EmptyStateDiagnosis, HttpConsoleRequest, HttpConsoleResponse,
    NodeInfo, SearchRequest, SearchResponse, ServerCapabilities, SynonymInfo,
};

use super::application;

#[tauri::command]
pub async fn typesense_capabilities(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<ServerCapabilities, AppError> {
    application::capabilities(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn typesense_health(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<ClusterHealth, AppError> {
    application::health(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn typesense_nodes(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<NodeInfo>, AppError> {
    application::nodes(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn typesense_cluster_stats(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<ClusterStats, AppError> {
    application::cluster_stats(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn typesense_collections(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<CollectionDescriptor>, AppError> {
    application::collections(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn typesense_collection(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    name: String,
) -> Result<CollectionDescriptor, AppError> {
    application::collection(state.manager(), &handle_id, &name).await
}

#[tauri::command]
pub async fn typesense_aliases(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<AliasInfo>, AppError> {
    application::aliases(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn typesense_api_keys(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<ApiKeyInfo>, AppError> {
    application::api_keys(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn typesense_synonyms(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    collection: String,
) -> Result<Vec<SynonymInfo>, AppError> {
    application::synonyms(state.manager(), &handle_id, &collection).await
}

#[tauri::command]
pub async fn typesense_curations(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    collection: String,
) -> Result<Vec<CurationInfo>, AppError> {
    application::curations(state.manager(), &handle_id, &collection).await
}

#[tauri::command]
pub async fn typesense_analytics(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<AnalyticsOverview, AppError> {
    application::analytics(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn typesense_search(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: SearchRequest,
) -> Result<SearchResponse, AppError> {
    application::search(state.manager(), &handle_id, request).await
}

#[tauri::command]
pub async fn typesense_documents(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    collection: String,
    page: u32,
    per_page: u32,
) -> Result<DocumentPage, AppError> {
    application::documents(state.manager(), &handle_id, &collection, page, per_page).await
}

#[tauri::command]
pub async fn typesense_diagnose(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    collection: String,
    fields: Vec<String>,
    query: String,
    num_typos: u8,
    relax_min_len: bool,
) -> Result<EmptyStateDiagnosis, AppError> {
    application::diagnose(
        state.manager(),
        &handle_id,
        &collection,
        fields,
        &query,
        num_typos,
        relax_min_len,
    )
    .await
}

#[tauri::command]
pub async fn typesense_upsert_document(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    collection: String,
    document: Value,
) -> Result<Value, AppError> {
    application::upsert_document(state.manager(), &handle_id, &collection, document).await
}

#[tauri::command]
pub async fn typesense_delete_document(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    collection: String,
    id: String,
) -> Result<(), AppError> {
    application::delete_document(state.manager(), &handle_id, &collection, &id).await
}

#[tauri::command]
pub async fn typesense_raw_http(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    request: HttpConsoleRequest,
) -> Result<HttpConsoleResponse, AppError> {
    application::raw_http(state.manager(), &handle_id, request).await
}
