//! Use-cases for the search slice. Each thin function resolves the open search
//! connection behind a handle (via the connections feature's
//! `ConnectionManager::get_search`) and delegates to a port-trait method. No
//! Tauri, no HTTP. The kind-mismatch / closed-handle §5 errors come from
//! `get_search`.

use serde_json::Value;

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::error::AppError;
use crate::shared::search::{
    AliasInfo, AnalyticsOverview, ApiKeyInfo, ClusterHealth, ClusterStats, CollectionDescriptor,
    CurationInfo, DocumentPage, EmptyStateDiagnosis, HttpConsoleRequest, HttpConsoleResponse,
    NodeInfo, SearchRequest, SearchResponse, ServerCapabilities, SynonymInfo,
};

/// What the connect-time probe learned — the version and, crucially, whether
/// the key is admin or search-only (MILESTONE_30 Task 1).
pub async fn capabilities(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<ServerCapabilities, AppError> {
    Ok(manager.get_search(handle).await?.capabilities())
}

/// `GET /health` + version — the sidebar cluster pill.
pub async fn health(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<ClusterHealth, AppError> {
    manager.get_search(handle).await?.health().await
}

/// Per-node host / raft state / health / uptime / memory (MILESTONE_30 Task 6).
pub async fn nodes(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<NodeInfo>, AppError> {
    manager.get_search(handle).await?.nodes().await
}

/// Aggregate counts for the dashboard stat cards.
pub async fn cluster_stats(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<ClusterStats, AppError> {
    manager.get_search(handle).await?.cluster_stats().await
}

/// The collection list (admin key required).
pub async fn collections(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<CollectionDescriptor>, AppError> {
    manager.get_search(handle).await?.collections().await
}

/// One collection's schema — reachable with a search-only key scoped to it,
/// which is how the sidebar shows the configured default collection when
/// [`collections`] is refused.
pub async fn collection(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    name: &str,
) -> Result<CollectionDescriptor, AppError> {
    manager.get_search(handle).await?.collection(name).await
}

/// `GET /aliases` (admin key required).
pub async fn aliases(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<AliasInfo>, AppError> {
    manager.get_search(handle).await?.aliases().await
}

/// `GET /keys` — metadata only, never a full key (admin key required).
pub async fn api_keys(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<ApiKeyInfo>, AppError> {
    manager.get_search(handle).await?.api_keys().await
}

/// Synonyms for a collection (admin key required).
pub async fn synonyms(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    collection: &str,
) -> Result<Vec<SynonymInfo>, AppError> {
    manager.get_search(handle).await?.synonyms(collection).await
}

/// Curation rules for a collection (admin key required).
pub async fn curations(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    collection: &str,
) -> Result<Vec<CurationInfo>, AppError> {
    manager
        .get_search(handle)
        .await?
        .curations(collection)
        .await
}

/// Analytics rules + popular queries; reports `configured: false` rather than
/// failing when the server has no analytics set up.
pub async fn analytics(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<AnalyticsOverview, AppError> {
    manager.get_search(handle).await?.analytics().await
}

/// Run a search (MILESTONE_30 Task 2).
pub async fn search(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: SearchRequest,
) -> Result<SearchResponse, AppError> {
    manager.get_search(handle).await?.search(request).await
}

/// A page of raw documents for the Documents tab.
pub async fn documents(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    collection: &str,
    page: u32,
    per_page: u32,
) -> Result<DocumentPage, AppError> {
    manager
        .get_search(handle)
        .await?
        .documents(collection, page, per_page)
        .await
}

/// The empty-state diagnosis (MILESTONE_30 Task 4).
pub async fn diagnose(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    collection: &str,
    fields: Vec<String>,
    query: &str,
    num_typos: u8,
    relax_min_len: bool,
) -> Result<EmptyStateDiagnosis, AppError> {
    manager
        .get_search(handle)
        .await?
        .diagnose(collection, fields, query, num_typos, relax_min_len)
        .await
}

/// Upsert one document (MILESTONE_30 Task 7).
pub async fn upsert_document(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    collection: &str,
    document: Value,
) -> Result<Value, AppError> {
    manager
        .get_search(handle)
        .await?
        .upsert_document(collection, document)
        .await
}

/// Delete one document by id (MILESTONE_30 Task 7).
pub async fn delete_document(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    collection: &str,
    id: &str,
) -> Result<(), AppError> {
    manager
        .get_search(handle)
        .await?
        .delete_document(collection, id)
        .await
}

/// Proxy a raw request for the HTTP console (MILESTONE_30 Task 8).
pub async fn raw_http(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: HttpConsoleRequest,
) -> Result<HttpConsoleResponse, AppError> {
    manager.get_search(handle).await?.raw_http(request).await
}
