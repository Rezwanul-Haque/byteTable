//! Use-cases for the MongoDB slice. Each thin function resolves the open
//! MongoDB connection behind a handle (via the connections feature's
//! `ConnectionManager::get_mongo`) and delegates to a port-trait method. No
//! Tauri, no drivers. The kind-mismatch / closed-handle §5 errors come from
//! `get_mongo`.

use serde_json::Value;

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::error::AppError;
use crate::shared::mongo::{
    AggregateResult, CollectionDescriptor, CreateIndexSpec, DeleteResult, ExplainResult,
    FindRequest, FindResult, IndexInfo, InsertManyResult, SchemaField, WriteResult,
};

/// `listDatabases` → database names (MILESTONE_18 §18.1).
pub async fn list_databases(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<String>, AppError> {
    manager.get_mongo(handle).await?.list_databases().await
}

/// `listCollections` + per-collection stats/indexes for one database.
pub async fn list_collections(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
) -> Result<Vec<CollectionDescriptor>, AppError> {
    manager.get_mongo(handle).await?.list_collections(db).await
}

/// One bounded `find` page (MILESTONE_18 §18.2).
pub async fn find(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    request: FindRequest,
) -> Result<FindResult, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .find(db, coll, request)
        .await
}

/// `countDocuments` for a filter.
pub async fn count_documents(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    filter: Value,
) -> Result<u64, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .count_documents(db, coll, filter)
        .await
}

/// Run an aggregation pipeline (MILESTONE_18 §18.4).
pub async fn aggregate(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    pipeline: Vec<Value>,
) -> Result<AggregateResult, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .aggregate(db, coll, pipeline)
        .await
}

/// Real `explain("executionStats")` (MILESTONE_18 §18.5).
pub async fn explain(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    filter: Value,
    sort: Option<Value>,
) -> Result<ExplainResult, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .explain(db, coll, filter, sort)
        .await
}

/// Inferred-schema field union (MILESTONE_18 §18.5/§18.7).
pub async fn infer_schema(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
) -> Result<Vec<SchemaField>, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .infer_schema(db, coll)
        .await
}

/// `listIndexes` for one collection (MILESTONE_18 §18.5).
pub async fn list_indexes(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
) -> Result<Vec<IndexInfo>, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .list_indexes(db, coll)
        .await
}

/// `insertOne` (MILESTONE_18 §18.3) — returns the inserted `_id` tagged value.
pub async fn insert_one(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    doc: Value,
) -> Result<Value, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .insert_one(db, coll, doc)
        .await
}

/// `replaceOne` by `_id` (MILESTONE_18 §18.3).
pub async fn replace_one(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    id: Value,
    doc: Value,
) -> Result<WriteResult, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .replace_one(db, coll, id, doc)
        .await
}

/// `deleteOne` by `_id` (MILESTONE_18 §18.3).
pub async fn delete_one(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    id: Value,
) -> Result<DeleteResult, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .delete_one(db, coll, id)
        .await
}

/// `deleteMany` by a set of `_id`s (grid multi-select bulk delete).
pub async fn delete_many(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    ids: Vec<Value>,
) -> Result<DeleteResult, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .delete_many(db, coll, ids)
        .await
}

/// Chunked `insertMany` import (MILESTONE_18 §18.8).
pub async fn insert_many(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    docs: Vec<Value>,
) -> Result<InsertManyResult, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .insert_many(db, coll, docs)
        .await
}

/// `createIndex` (MILESTONE_18 §18.5).
pub async fn create_index(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    spec: CreateIndexSpec,
) -> Result<String, AppError> {
    manager
        .get_mongo(handle)
        .await?
        .create_index(db, coll, spec)
        .await
}

/// `collMod` the `$jsonSchema` validator (MILESTONE_18 §18.5).
pub async fn set_validator(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    db: &str,
    coll: &str,
    validator: Option<Value>,
) -> Result<(), AppError> {
    manager
        .get_mongo(handle)
        .await?
        .set_validator(db, coll, validator)
        .await
}
