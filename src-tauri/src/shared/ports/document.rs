//! Document-store engine port family (M17 DynamoDB).
//!
//! DynamoDB is a NoSQL key/value + single-table-design store — it has no
//! relational schemas/tables/columns AND it is not the Redis keyspace. Forcing
//! it through either the SQL [`crate::shared::engine::EngineConnection`] surface
//! or the key-value [`crate::shared::keyvalue::KeyValueConnection`] surface would
//! litter those traits with `Unsupported` stubs and lie about its shape, so it
//! gets its own port family per MILESTONE_17 §0. This module is the document
//! side: a table/item reader, an item writer, bundled as the
//! [`DocumentStoreConnection`] super-trait the `engines::dynamo` adapter
//! implements.
//!
//! The [`crate::shared::engine::OpenConnection`] kind enum is the single seam
//! that lets one `ConnectionManager` store a SQL, key-value, OR document
//! connection behind one handle id; `get_document` enforces the kind.
//!
//! # Wire shapes
//!
//! All DTOs are camelCase on the wire (matching the renderer's
//! `src/features/dynamo_browse/api.ts`). DynamoDB is schemaless, so an *item* is
//! a free-form JSON object of already-unmarshalled plain values
//! ([`serde_json::Value`]) — the adapter does the AttributeValue ⇄ JSON
//! translation so the renderer never sees DynamoDB-typed JSON. Field names
//! mirror `bytetable/dynamo-data.js` (`keySchema`, `attrTypes`, `gsis`, `lsis`,
//! `billing`, `rcu`/`wcu`, `ttlAttribute`, `itemCount`, `sizeBytes`).
//!
//! # Async commands rule
//!
//! Like the other port families, every trait method is `async` (`async_trait`).
//! The dynamo adapter awaits the AWS SDK's tokio client directly — no
//! `spawn_blocking`.
//!
//! # Safety contract (MILESTONE_17 "Notes / safety")
//!
//! - Counts come from `DescribeTable` (approximate), NEVER a full scan.
//! - Every [`DocumentStoreReader::scan`] is bounded by `limit` + a continuation
//!   token; the adapter never issues an unbounded scan.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::engine::EngineInfo;
use crate::shared::error::AppError;

/// A table's primary key schema. `sk` is `None` for a partition-only table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySchema {
    pub pk: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sk: Option<String>,
}

/// One secondary index (GSI or LSI), mirroring `dynamo-data.js`'s `gsis[]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecondaryIndex {
    pub name: String,
    pub pk: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sk: Option<String>,
    /// `ALL` / `KEYS_ONLY` / `INCLUDE`.
    pub projection: String,
}

/// Per-table descriptor from `DescribeTable`, mapped to the `dynamo-data.js`
/// shape. Item/size counts are the table's approximate values from
/// `DescribeTable` — never a full scan (MILESTONE_17 safety note).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDescriptor {
    pub name: String,
    pub key_schema: KeySchema,
    /// Declared attribute types for the key/index attributes (`{ "PK": "S" }`).
    /// DynamoDB only declares types for key attributes; everything else is
    /// schemaless and discovered from item data.
    pub attr_types: std::collections::BTreeMap<String, String>,
    pub gsis: Vec<SecondaryIndex>,
    pub lsis: Vec<SecondaryIndex>,
    /// `PAY_PER_REQUEST` (on-demand) or `PROVISIONED`.
    pub billing: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rcu: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wcu: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_attribute: Option<String>,
    /// Approximate item count from `DescribeTable`.
    pub item_count: u64,
    /// Approximate table size in bytes from `DescribeTable`.
    pub size_bytes: u64,
    /// `ACTIVE` / `CREATING` / … (the raw table status string).
    pub status: String,
    /// Creation timestamp as an ISO-8601 string, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

/// The sort-key comparison operators a Query exposes (MILESTONE_17 §17.2),
/// matching `dynamo-engine.js`. Lowercase on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortKeyOp {
    Eq,
    Lt,
    Lte,
    Gt,
    Gte,
    BeginsWith,
    Between,
}

/// A bounded `Scan` request (MILESTONE_17 safety: never unbounded). `limit`
/// caps the page; `next_token` is the opaque continuation cursor returned by a
/// prior page (`None` starts a fresh scan).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    #[serde(default = "default_limit")]
    pub limit: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_token: Option<String>,
    /// Comma-separated attribute names to return (DynamoDB `ProjectionExpression`).
    /// `None`/empty = all attributes. The adapter aliases each name to dodge
    /// reserved words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projection: Option<String>,
}

fn default_limit() -> u32 {
    100
}

impl Default for ScanRequest {
    fn default() -> Self {
        Self {
            limit: default_limit(),
            next_token: None,
            projection: None,
        }
    }
}

/// A `Query` request: a partition-key value, an optional sort-key condition, an
/// optional index (base table when `None`), and the page bound.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    /// The partition-key value to match (always an equality on the PK).
    pub pk_value: String,
    /// The sort-key operator, when a sort-key condition is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sk_op: Option<SortKeyOp>,
    /// The sort-key value (the single operand, or the low bound of `between`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sk_value: Option<String>,
    /// The high bound for `between`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sk_value2: Option<String>,
    /// The GSI/LSI name to query, or `None` for the base table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_token: Option<String>,
    /// Comma-separated attribute names to return (`ProjectionExpression`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projection: Option<String>,
}

/// One page of a scan/query: the unmarshalled items plus the capacity accounting
/// (`dynamo-engine.js`) and the continuation token for the next page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPage {
    /// Items as plain (unmarshalled) JSON objects.
    pub items: Vec<Value>,
    /// `Count` — items returned after any filter.
    pub count: u64,
    /// `ScannedCount` — items examined.
    pub scanned_count: u64,
    /// `ConsumedCapacity.CapacityUnits` (RCU), when the SDK reports it.
    pub capacity: f64,
    /// The index actually queried (`None` = base table).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_name: Option<String>,
    /// Continuation token for the next page; `None` means the scan/query is
    /// exhausted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_token: Option<String>,
}

/// A PartiQL `ExecuteStatement` result (MILESTONE_17 §17.4), unmarshalled to
/// plain JSON so the terminal renders typed JSON as plain values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    /// Attribute-union column order across the returned items.
    pub columns: Vec<String>,
    pub items: Vec<Value>,
    pub count: u64,
    /// `Query` or `Scan` — DynamoDB plans this from the WHERE clause.
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_token: Option<String>,
}

/// The outcome of a chunked `BatchWriteItem` import (MILESTONE_17 §17.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchWriteResult {
    pub written: u64,
    /// Items the API could not write (unprocessed after retries), if any.
    pub unprocessed: u64,
}

// ---------------------------------------------------------------------------
// Port traits
// ---------------------------------------------------------------------------

/// Read side of a document store (MILESTONE_17 §17.1/§17.2/§17.4): table
/// introspection, bounded scan/query, single-item get, and PartiQL. All errors
/// are §5 human sentences (the adapter maps SDK errors).
#[async_trait]
pub trait DocumentStoreReader: Send + Sync {
    /// `ListTables` — returns only table names (no `DescribeTable` per table).
    async fn list_table_names(&self) -> Result<Vec<String>, AppError>;

    /// `ListTables` → per-table descriptors (each via `DescribeTable`).
    async fn list_tables(&self) -> Result<Vec<TableDescriptor>, AppError>;

    /// `DescribeTable` for one table. Unknown tables are a §5 human error.
    async fn describe_table(&self, table: &str) -> Result<TableDescriptor, AppError>;

    /// One bounded `Scan` page (Limit + continuation token; never unbounded).
    async fn scan(&self, table: &str, req: ScanRequest) -> Result<ItemPage, AppError>;

    /// One `Query` page (key-condition + optional GSI/LSI).
    async fn query(&self, table: &str, req: QueryRequest) -> Result<ItemPage, AppError>;

    /// `GetItem` by full primary key (`key` is a plain JSON object holding the
    /// PK — and SK, for a composite-key table). `None` when absent.
    async fn get_item(&self, table: &str, key: Value) -> Result<Option<Value>, AppError>;

    /// `ExecuteStatement` (PartiQL). `next_token` paginates a prior statement.
    async fn execute_statement(
        &self,
        statement: &str,
        next_token: Option<String>,
    ) -> Result<StatementResult, AppError>;
}

/// Write side of a document store (MILESTONE_17 §17.3/§17.6). Every method
/// mutates the live table.
#[async_trait]
pub trait DocumentStoreWriter: Send + Sync {
    /// `PutItem` — create or overwrite a whole item (`item` is a plain JSON
    /// object; the adapter marshals it to AttributeValues).
    async fn put_item(&self, table: &str, item: Value) -> Result<(), AppError>;

    /// `DeleteItem` by full primary key.
    async fn delete_item(&self, table: &str, key: Value) -> Result<(), AppError>;

    /// Chunked `BatchWriteItem` of many items (import). The adapter splits into
    /// 25-item batches and retries unprocessed items.
    async fn batch_write(
        &self,
        table: &str,
        items: Vec<Value>,
    ) -> Result<BatchWriteResult, AppError>;

    /// Chunked `BatchWriteItem` of `DeleteRequest`s — delete many items by their
    /// primary keys (grid multi-select "delete selected"). Each `key` is a plain
    /// JSON object holding the PK (and SK for a composite-key table). The adapter
    /// splits into 25-key batches and retries unprocessed keys.
    async fn batch_delete(
        &self,
        table: &str,
        keys: Vec<Value>,
    ) -> Result<BatchWriteResult, AppError>;
}

/// A live document-store connection: the read + write ports bundled, plus the
/// shared [`EngineInfo`] accessor and an orderly `close`. The `engines::dynamo`
/// adapter implements all three; the [`crate::shared::engine::OpenConnection`]
/// `Document` arm holds an `Arc<dyn DocumentStoreConnection>`.
#[async_trait]
pub trait DocumentStoreConnection: DocumentStoreReader + DocumentStoreWriter {
    /// Engine + version of this connection (`DynamoDB (AWS SDK)`).
    fn engine_info(&self) -> EngineInfo;

    /// Release driver resources. The AWS SDK client is `Drop`-managed, so this
    /// is typically a no-op, but the manager calls it for symmetry with the
    /// other engine families.
    async fn close(&self) -> Result<(), AppError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_key_op_is_snake_case_on_the_wire() {
        assert_eq!(
            serde_json::to_value(SortKeyOp::BeginsWith).unwrap(),
            "begins_with"
        );
        assert_eq!(serde_json::to_value(SortKeyOp::Lte).unwrap(), "lte");
        assert_eq!(
            serde_json::from_value::<SortKeyOp>(serde_json::json!("between")).unwrap(),
            SortKeyOp::Between
        );
    }

    #[test]
    fn scan_request_defaults_to_a_bounded_fresh_page() {
        let req: ScanRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(req.limit, 100);
        assert!(req.next_token.is_none());
    }

    #[test]
    fn table_descriptor_is_camel_case() {
        let t = TableDescriptor {
            name: "ShopApp".into(),
            key_schema: KeySchema {
                pk: "PK".into(),
                sk: Some("SK".into()),
            },
            attr_types: [("PK".to_string(), "S".to_string())].into_iter().collect(),
            gsis: vec![SecondaryIndex {
                name: "GSI1".into(),
                pk: "GSI1PK".into(),
                sk: Some("GSI1SK".into()),
                projection: "ALL".into(),
            }],
            lsis: vec![],
            billing: "PAY_PER_REQUEST".into(),
            rcu: None,
            wcu: None,
            ttl_attribute: None,
            item_count: 42,
            size_bytes: 17304,
            status: "ACTIVE".into(),
            created: None,
        };
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["keySchema"]["pk"], "PK");
        assert_eq!(json["keySchema"]["sk"], "SK");
        assert_eq!(json["itemCount"], 42);
        assert_eq!(json["sizeBytes"], 17304);
        assert_eq!(json["gsis"][0]["projection"], "ALL");
        assert_eq!(json["billing"], "PAY_PER_REQUEST");
    }
}
