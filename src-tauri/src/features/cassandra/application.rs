//! Use-cases for the Cassandra slice. Each thin function resolves the open
//! wide-column connection behind a handle (via the connections feature's
//! `ConnectionManager::get_wide_column`) and delegates to a port-trait method. No
//! Tauri, no drivers. The kind-mismatch / closed-handle §5 errors come from
//! `get_wide_column`.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::error::AppError;
use crate::shared::widecolumn::{
    CassCqlResult, CassCreateIndex, CassCreateKeyspace, CassCreateMv, CassCreateTable,
    CassDeleteRow, CassDeleteRows, CassInsertRow, CassQueryRequest, CassQueryResult, CassUpdateRow,
    ClusterStatus, KeyspaceInfo, TableDescriptor,
};

/// Keyspaces visible on the cluster (M19 §19.1).
pub async fn list_keyspaces(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<KeyspaceInfo>, AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .list_keyspaces()
        .await
}

/// Full table descriptors for one keyspace (M19 §19.1). Never a `COUNT(*)`.
pub async fn list_tables(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    keyspace: &str,
) -> Result<Vec<TableDescriptor>, AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .list_tables(keyspace)
        .await
}

/// One table's descriptor (M19 §19.1).
pub async fn table_meta(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    keyspace: &str,
    table: &str,
) -> Result<TableDescriptor, AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .table_meta(keyspace, table)
        .await
}

/// The cluster ring for the dashboard + `nodetool status` (M19 §19.1).
pub async fn cluster_status(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<ClusterStatus, AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .cluster_status()
        .await
}

/// A bounded, CQL-correct query from the query builder (M19 §19.2).
pub async fn query(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: CassQueryRequest,
) -> Result<CassQueryResult, AppError> {
    manager.get_wide_column(handle).await?.query(request).await
}

/// Insert a whole row (M19 §19.3).
pub async fn insert_row(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: CassInsertRow,
) -> Result<(), AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .insert_row(request)
        .await
}

/// Update by full primary key (M19 §19.3).
pub async fn update_row(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: CassUpdateRow,
) -> Result<(), AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .update_row(request)
        .await
}

/// Delete by full primary key (M19 §19.3).
pub async fn delete_row(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: CassDeleteRow,
) -> Result<(), AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .delete_row(request)
        .await
}

/// Bulk delete selected rows by full primary key (grid multi-select).
pub async fn delete_rows(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: CassDeleteRows,
) -> Result<u64, AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .delete_rows(request)
        .await
}

/// The `CREATE TABLE` (+ index/MV) CQL for one table (M19 §19.4/§19.5).
pub async fn describe_table(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    keyspace: &str,
    table: &str,
) -> Result<String, AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .describe_table(keyspace, table)
        .await
}

/// Run one raw CQL statement (M19 §19.5 — standalone query tab + cqlsh).
pub async fn run_cql(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    keyspace: &str,
    cql: &str,
    consistency: Option<&str>,
) -> Result<CassCqlResult, AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .run_cql(keyspace, cql, consistency)
        .await
}

/// Create a secondary index (M19 §19.4).
pub async fn create_index(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: CassCreateIndex,
) -> Result<(), AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .create_index(request)
        .await
}

/// Drop a secondary index (M19 §19.4).
pub async fn drop_index(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    keyspace: &str,
    name: &str,
) -> Result<(), AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .drop_index(keyspace, name)
        .await
}

/// Create a materialized view (M19 §19.4).
pub async fn create_mv(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: CassCreateMv,
) -> Result<(), AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .create_mv(request)
        .await
}

/// Drop a materialized view (M19 §19.4).
pub async fn drop_mv(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    keyspace: &str,
    name: &str,
) -> Result<(), AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .drop_mv(keyspace, name)
        .await
}

/// Create a keyspace (M19 §19.6).
pub async fn create_keyspace(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: CassCreateKeyspace,
) -> Result<(), AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .create_keyspace(request)
        .await
}

/// Create a table (M19 §19.6).
pub async fn create_table(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    request: CassCreateTable,
) -> Result<(), AppError> {
    manager
        .get_wide_column(handle)
        .await?
        .create_table(request)
        .await
}
