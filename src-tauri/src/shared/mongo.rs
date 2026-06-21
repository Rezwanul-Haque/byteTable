//! MongoDB engine port family (M18).
//!
//! MongoDB is a document database — databases → collections → schemaless BSON
//! documents, an aggregation pipeline, and a JSON-Schema validator surface. Its
//! query/aggregation shape is distinct enough from the SQL
//! [`crate::shared::engine::EngineConnection`] surface, the Redis key-value
//! [`crate::shared::keyvalue`] surface, AND the DynamoDB document
//! [`crate::shared::document`] surface that it gets its own port family per
//! MILESTONE_18 §0. This module is the document/collection side: a reader
//! (introspection, bounded find, aggregate, explain, schema inference) plus a
//! writer (CRUD + index/validator DDL), bundled as the [`MongoConnection`]
//! super-trait the `engines::mongo` adapter implements.
//!
//! The [`crate::shared::engine::OpenConnection`] kind enum is the single seam
//! that lets one `ConnectionManager` store a SQL, key-value, DynamoDB-document,
//! OR MongoDB connection behind one handle id; `get_mongo` enforces the kind.
//!
//! # Wire shapes
//!
//! All DTOs are camelCase on the wire (matching `src/features/mongo_browse`).
//! MongoDB is schemaless, so a *document* is a free-form JSON object. BSON types
//! the renderer must render distinctly survive as the prototype's Extended-JSON
//! tags — `{ "$oid": "<24hex>" }` for an ObjectId and `{ "$date": "<iso>" }` for
//! an ISODate — exactly the `mongo-data.js` `OID`/`DATE` contract. The
//! `engines::mongo::value` layer does the BSON ⇄ tagged-JSON translation so the
//! renderer never sees raw `bson` Extended JSON.
//!
//! # Async commands rule
//!
//! Like the other port families, every trait method is `async` (`async_trait`).
//! The mongo adapter awaits the official driver's tokio client directly — no
//! `spawn_blocking`.
//!
//! # Safety contract (MILESTONE_18 "Notes / safety")
//!
//! - Counts/size come from `collStats` / `estimatedDocumentCount`, NEVER a full
//!   scan.
//! - Every [`MongoReader::find`] is bounded by a `limit` (default 50) + `skip`
//!   paging; *All* in the renderer maps to a paged cursor, never one unbounded
//!   load.
//! - ObjectId / ISODate survive read → edit → write via the `{$oid}`/`{$date}`
//!   tags.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::engine::EngineInfo;
use crate::shared::error::AppError;

/// One index on a collection, mirroring `mongo-data.js`'s `indexes[]`
/// (`{ name, keys, unique?, sparse? }`). `keys` is the key pattern object
/// (`{ "category": 1, "price": -1 }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub keys: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sparse: Option<bool>,
}

/// Per-collection descriptor, mapped to the `mongo-data.js` collection shape.
/// `count`/`storage_bytes`/`avg_doc_bytes` come from `collStats` /
/// `estimatedDocumentCount` — never a full scan (MILESTONE_18 safety note).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDescriptor {
    pub name: String,
    /// Approximate document count (`estimatedDocumentCount` / `collStats.count`).
    pub count: u64,
    pub indexes: Vec<IndexInfo>,
    /// The `$jsonSchema` validator object, when the collection has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validator: Option<Value>,
    pub storage_bytes: u64,
    pub avg_doc_bytes: u64,
}

/// One database's name + collection list (the sidebar's per-database payload).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub collections: Vec<CollectionDescriptor>,
}

/// A bounded `find` request (MILESTONE_18 §18.2). `filter`/`projection`/`sort`
/// are MQL objects; `limit` caps the page (`None` = *All*, served by `skip`
/// paging, never one unbounded load); `skip` is the page offset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRequest {
    #[serde(default = "empty_object")]
    pub filter: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projection: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<Value>,
    /// Page size. `None` = *All* (the renderer pages with `skip`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default)]
    pub skip: u32,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

impl Default for FindRequest {
    fn default() -> Self {
        Self {
            filter: empty_object(),
            projection: None,
            sort: None,
            limit: Some(50),
            skip: 0,
        }
    }
}

/// A `find` result page: the documents plus the count machinery the Find bar
/// and Explain panel show (`matched`/`returned`/`ms`/`usedIndex`), mirroring
/// `mongo-engine.js`'s `find` return.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub docs: Vec<Value>,
    /// Total documents matching the filter (before limit/skip) — from a count,
    /// never a full materialization.
    pub matched: u64,
    /// Documents returned in this page.
    pub returned: u64,
    pub ms: f64,
    /// The index `find` would use for this filter, when one applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_index: Option<String>,
}

/// An aggregation-pipeline result (MILESTONE_18 §18.4), mirroring
/// `mongo-engine.js`'s `aggregate` return.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregateResult {
    pub docs: Vec<Value>,
    pub returned: u64,
    pub ms: f64,
    /// The op names of the stages that ran (`["$match","$group","$sort"]`).
    pub stages: Vec<String>,
}

/// A real `explain("executionStats")` summary (MILESTONE_18 §18.5), mapped to
/// the `mongo-engine.js` `explain` shape the Explain panel renders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainResult {
    pub namespace: String,
    /// `IXSCAN` (an index was used) or `COLLSCAN` (a full scan).
    pub stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_name: Option<String>,
    pub n_returned: u64,
    pub docs_examined: u64,
    pub keys_examined: u64,
    pub total_docs: u64,
    /// `nReturned / max(1, docsExamined)` — the selectivity bar.
    pub ratio: f64,
    pub ms: f64,
    /// The nested `winningPlan` stage tree, as genuine `explain()` JSON.
    pub plan: Value,
}

/// One inferred-schema field row (MILESTONE_18 §18.5/§18.7), mirroring
/// `mongo-engine.js`'s `inferSchema` rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaField {
    /// Dotted path (nested objects: `address.city`; array-of-object: `items[].productId`).
    pub path: String,
    /// BSON type names seen at this path, most-common first.
    pub types: Vec<String>,
    /// Presence percentage across sampled docs (0–100).
    pub presence: u32,
    /// Nesting depth (0 = top level).
    pub depth: u32,
}

/// The outcome of a `replaceOne` / `updateOne` (MILESTONE_18 §18.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub matched: u64,
    pub modified: u64,
}

/// The outcome of a `deleteOne` (MILESTONE_18 §18.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: u64,
}

/// The outcome of a chunked `insertMany` import (MILESTONE_18 §18.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertManyResult {
    pub inserted: u64,
}

/// A new index to create (MILESTONE_18 §18.5 Structure → Create index).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIndexSpec {
    /// Key pattern object (`{ "email": 1 }`).
    pub keys: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sparse: Option<bool>,
}

// ---------------------------------------------------------------------------
// Port traits
// ---------------------------------------------------------------------------

/// Read side of a MongoDB connection (MILESTONE_18 §18.1/§18.2/§18.4/§18.5).
/// All errors are §5 human sentences (the adapter maps driver errors).
#[async_trait]
pub trait MongoReader: Send + Sync {
    /// `listDatabases` → database names (excludes the admin/internal dbs the
    /// driver hides). Used both for the sidebar selector and the connect check.
    async fn list_databases(&self) -> Result<Vec<String>, AppError>;

    /// `listCollections` + per-collection `collStats`/`listIndexes` for one
    /// database (MILESTONE_18 §18.1). Counts/size never scan.
    async fn list_collections(&self, db: &str) -> Result<Vec<CollectionDescriptor>, AppError>;

    /// One bounded `find` page (filter/projection/sort + limit/skip).
    async fn find(&self, db: &str, coll: &str, req: FindRequest) -> Result<FindResult, AppError>;

    /// `countDocuments` for a filter (mongosh `.countDocuments()`).
    async fn count_documents(&self, db: &str, coll: &str, filter: Value) -> Result<u64, AppError>;

    /// Run an aggregation `pipeline` (MILESTONE_18 §18.4). The pipeline is a
    /// JSON array of stage objects; the driver supports the full stage set.
    async fn aggregate(
        &self,
        db: &str,
        coll: &str,
        pipeline: Vec<Value>,
    ) -> Result<AggregateResult, AppError>;

    /// Real `explain("executionStats")` for a filter/sort (MILESTONE_18 §18.5).
    async fn explain(
        &self,
        db: &str,
        coll: &str,
        filter: Value,
        sort: Option<Value>,
    ) -> Result<ExplainResult, AppError>;

    /// Inferred schema by sampling documents (MILESTONE_18 §18.5/§18.7).
    async fn infer_schema(&self, db: &str, coll: &str) -> Result<Vec<SchemaField>, AppError>;

    /// `listIndexes` for one collection (Structure → Indexes tab).
    async fn list_indexes(&self, db: &str, coll: &str) -> Result<Vec<IndexInfo>, AppError>;
}

/// Write side of a MongoDB connection (MILESTONE_18 §18.3/§18.5/§18.8). Every
/// method mutates the live database.
#[async_trait]
pub trait MongoWriter: Send + Sync {
    /// `insertOne` — insert a whole document (the renderer seeds a fresh
    /// ObjectId). Returns the inserted `_id` as a tagged value.
    async fn insert_one(&self, db: &str, coll: &str, doc: Value) -> Result<Value, AppError>;

    /// `replaceOne` by `_id` — overwrite a whole document (MILESTONE_18 §18.3).
    async fn replace_one(
        &self,
        db: &str,
        coll: &str,
        id: Value,
        doc: Value,
    ) -> Result<WriteResult, AppError>;

    /// `deleteOne` by `_id` (MILESTONE_18 §18.3, inline tree-card delete).
    async fn delete_one(&self, db: &str, coll: &str, id: Value) -> Result<DeleteResult, AppError>;

    /// `deleteMany` by a set of `_id`s (grid multi-select bulk delete).
    async fn delete_many(
        &self,
        db: &str,
        coll: &str,
        ids: Vec<Value>,
    ) -> Result<DeleteResult, AppError>;

    /// Chunked `insertMany` of many documents (import, MILESTONE_18 §18.8).
    async fn insert_many(
        &self,
        db: &str,
        coll: &str,
        docs: Vec<Value>,
    ) -> Result<InsertManyResult, AppError>;

    /// `createIndex` (Structure → Indexes → Create index, MILESTONE_18 §18.5).
    async fn create_index(
        &self,
        db: &str,
        coll: &str,
        spec: CreateIndexSpec,
    ) -> Result<String, AppError>;

    /// `collMod` the `$jsonSchema` validator (Structure → Validation,
    /// MILESTONE_18 §18.5). `None` clears the validator.
    async fn set_validator(
        &self,
        db: &str,
        coll: &str,
        validator: Option<Value>,
    ) -> Result<(), AppError>;
}

/// A live MongoDB connection: the read + write ports bundled, plus the shared
/// [`EngineInfo`] accessor and an orderly `close`. The `engines::mongo` adapter
/// implements all three; the [`crate::shared::engine::OpenConnection`] `Mongo`
/// arm holds an `Arc<dyn MongoConnection>`.
#[async_trait]
pub trait MongoConnection: MongoReader + MongoWriter {
    /// Engine + version of this connection (`MongoDB 7.0.9`).
    fn engine_info(&self) -> EngineInfo;

    /// Release driver resources. The driver client is `Clone`/`Drop`-managed,
    /// so this is typically a no-op, but the manager calls it for symmetry.
    async fn close(&self) -> Result<(), AppError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_request_defaults_to_a_bounded_page() {
        let req: FindRequest = serde_json::from_str("{}").unwrap();
        assert!(req.filter.is_object());
        assert!(req.projection.is_none());
        assert_eq!(req.skip, 0);
    }

    #[test]
    fn collection_descriptor_is_camel_case() {
        let c = CollectionDescriptor {
            name: "products".into(),
            count: 12,
            indexes: vec![IndexInfo {
                name: "sku_1".into(),
                keys: serde_json::json!({ "sku": 1 }),
                unique: Some(true),
                sparse: None,
            }],
            validator: Some(serde_json::json!({ "$jsonSchema": { "bsonType": "object" } })),
            storage_bytes: 17304,
            avg_doc_bytes: 720,
        };
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(json["storageBytes"], 17304);
        assert_eq!(json["avgDocBytes"], 720);
        assert_eq!(json["indexes"][0]["unique"], true);
        assert!(json["indexes"][0].get("sparse").is_none());
    }
}
