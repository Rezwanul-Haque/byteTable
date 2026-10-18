//! Tauri command handlers for the MongoDB slice. Deserialize → use-case →
//! serialize; no logic lives here. Each command reads the connections feature's
//! `ConnectionsState` for the open-handle manager and resolves the MongoDB
//! connection via `ConnectionManager::get_mongo`.
//!
//! All commands are `async fn` per the async-commands rule — they drive real
//! MongoDB work over the driver client.
//!
//! Wire: camelCase args (matching `src/features/mongo_browse/api.ts`).
//! Documents, filters, and `_id`s are plain JSON (`serde_json::Value`) with the
//! `{$oid}`/`{$date}` tags — the adapter does the BSON marshalling, so the
//! renderer never sees raw BSON Extended JSON.

use serde_json::Value;
use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;
use crate::shared::mongo::{
    AggregateResult, CollectionDescriptor, CreateIndexSpec, DeleteResult, ExplainResult,
    FindRequest, FindResult, IndexInfo, InsertManyResult, SchemaField, WriteResult,
};

use super::application;

/// Aggregation stages that write their result into a collection rather than
/// returning it. An aggregate is otherwise a read, so these two are the only
/// reason the pipeline needs inspecting in a read-only workspace.
const WRITING_STAGES: [&str; 2] = ["$out", "$merge"];

/// Refuse an aggregation that would write. `$out` replaces a whole collection
/// and `$merge` upserts into one, so a pipeline containing either is a
/// mutation wearing a query's clothes.
async fn refuse_writing_pipeline(
    state: &ConnectionsState,
    handle_id: &ConnectionHandleId,
    pipeline: &[Value],
) -> Result<(), AppError> {
    if !state.manager().is_read_only(handle_id).await {
        return Ok(());
    }
    let writes = pipeline.iter().any(|stage| {
        stage.as_object().is_some_and(|fields| {
            fields
                .keys()
                .any(|key| WRITING_STAGES.contains(&key.as_str()))
        })
    });
    if writes {
        return Err(crate::shared::readonly::read_only_error(
            "run an aggregation that writes its result to a collection",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn mongo_list_databases(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<String>, AppError> {
    application::list_databases(state.manager(), &handle_id).await
}

#[tauri::command]
pub async fn mongo_list_collections(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
) -> Result<Vec<CollectionDescriptor>, AppError> {
    application::list_collections(state.manager(), &handle_id, &db).await
}

#[tauri::command]
pub async fn mongo_find(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    request: FindRequest,
) -> Result<FindResult, AppError> {
    application::find(state.manager(), &handle_id, &db, &coll, request).await
}

#[tauri::command]
pub async fn mongo_count(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    filter: Value,
) -> Result<u64, AppError> {
    application::count_documents(state.manager(), &handle_id, &db, &coll, filter).await
}

#[tauri::command]
pub async fn mongo_aggregate(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    pipeline: Vec<Value>,
) -> Result<AggregateResult, AppError> {
    refuse_writing_pipeline(&state, &handle_id, &pipeline).await?;
    application::aggregate(state.manager(), &handle_id, &db, &coll, pipeline).await
}

#[tauri::command]
pub async fn mongo_explain(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    filter: Value,
    sort: Option<Value>,
) -> Result<ExplainResult, AppError> {
    application::explain(state.manager(), &handle_id, &db, &coll, filter, sort).await
}

#[tauri::command]
pub async fn mongo_explain_aggregate(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    pipeline: Vec<Value>,
) -> Result<ExplainResult, AppError> {
    application::explain_aggregate(state.manager(), &handle_id, &db, &coll, pipeline).await
}

#[tauri::command]
pub async fn mongo_infer_schema(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
) -> Result<Vec<SchemaField>, AppError> {
    application::infer_schema(state.manager(), &handle_id, &db, &coll).await
}

#[tauri::command]
pub async fn mongo_list_indexes(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
) -> Result<Vec<IndexInfo>, AppError> {
    application::list_indexes(state.manager(), &handle_id, &db, &coll).await
}

#[tauri::command]
pub async fn mongo_insert_one(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    doc: Value,
) -> Result<Value, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "insert documents")
        .await?;
    application::insert_one(state.manager(), &handle_id, &db, &coll, doc).await
}

#[tauri::command]
pub async fn mongo_replace_one(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    id: Value,
    doc: Value,
) -> Result<WriteResult, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "change documents")
        .await?;
    application::replace_one(state.manager(), &handle_id, &db, &coll, id, doc).await
}

#[tauri::command]
pub async fn mongo_delete_one(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    id: Value,
) -> Result<DeleteResult, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "delete documents")
        .await?;
    application::delete_one(state.manager(), &handle_id, &db, &coll, id).await
}

#[tauri::command]
pub async fn mongo_delete_many(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    ids: Vec<Value>,
) -> Result<DeleteResult, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "delete documents")
        .await?;
    application::delete_many(state.manager(), &handle_id, &db, &coll, ids).await
}

#[tauri::command]
pub async fn mongo_insert_many(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    docs: Vec<Value>,
) -> Result<InsertManyResult, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "insert documents")
        .await?;
    application::insert_many(state.manager(), &handle_id, &db, &coll, docs).await
}

/// Create an explicit, empty collection. MongoDB would create one implicitly on
/// first insert, so this is for the cases that cannot serve: an empty target to
/// import into, or one to index/validate before any data arrives.
#[tauri::command]
pub async fn mongo_create_collection(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "create collections")
        .await?;
    application::create_collection(state.manager(), &handle_id, &db, &coll).await
}

/// **Destructive.** Drop a collection with its documents, indexes and validator.
#[tauri::command]
pub async fn mongo_drop_collection(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "drop collections")
        .await?;
    application::drop_collection(state.manager(), &handle_id, &db, &coll).await
}

/// **Destructive.** Remove every document but keep the collection, its indexes
/// and its validator — MongoDB's answer to TRUNCATE. Returns the count removed.
#[tauri::command]
pub async fn mongo_truncate_collection(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
) -> Result<u64, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "empty collections")
        .await?;
    application::truncate_collection(state.manager(), &handle_id, &db, &coll).await
}

/// **Destructive.** Drop every collection in a database, leaving the database
/// itself standing. Returns the collections dropped.
#[tauri::command]
pub async fn mongo_empty_database(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
) -> Result<Vec<String>, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "empty databases")
        .await?;
    application::empty_database(state.manager(), &handle_id, &db).await
}

/// **Destructive.** Drop a database: every collection AND the database itself.
/// The counterpart of `mongo_empty_database`, which keeps the database.
#[tauri::command]
pub async fn mongo_drop_database(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "drop databases")
        .await?;
    application::drop_database(state.manager(), &handle_id, &db).await
}

#[tauri::command]
pub async fn mongo_create_index(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    spec: CreateIndexSpec,
) -> Result<String, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "create indexes")
        .await?;
    application::create_index(state.manager(), &handle_id, &db, &coll, spec).await
}

#[tauri::command]
pub async fn mongo_set_validator(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    db: String,
    coll: String,
    validator: Option<Value>,
) -> Result<(), AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "change collection validation")
        .await?;
    application::set_validator(state.manager(), &handle_id, &db, &coll, validator).await
}
