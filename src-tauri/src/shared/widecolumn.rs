//! Cassandra wide-column engine port family (M19).
//!
//! Cassandra is a wide-column store — cluster → keyspaces → tables with
//! partition/clustering keys, denormalized `*_by_*` query tables, and CQL. Its
//! query model (partition key required for an efficient read, clustering columns
//! used in order, non-key/non-indexed predicates requiring `ALLOW FILTERING`) is
//! distinct enough from the SQL [`crate::shared::engine::EngineConnection`]
//! surface, the Redis key-value [`crate::shared::keyvalue`] surface, the DynamoDB
//! document [`crate::shared::document`] surface, AND the MongoDB
//! [`crate::shared::mongo`] surface that it gets its own port family per
//! MILESTONE_19 §0.
//!
//! The [`crate::shared::engine::OpenConnection`] kind enum is the single seam
//! that lets one `ConnectionManager` store a SQL, key-value, DynamoDB-document,
//! MongoDB, OR Cassandra connection behind one handle id; `get_wide_column`
//! enforces the kind.
//!
//! # Read / write split
//!
//! The family is split into a [`WideColumnReader`] (introspection, bounded
//! CQL-correct query, cluster status, `DESCRIBE`) and a [`WideColumnWriter`]
//! (full-primary-key CRUD + index/MV/keyspace/table DDL), bundled as the
//! [`WideColumnConnection`] super-trait the `engines::cassandra` adapter
//! implements. This module is the scaffold (M19 §19.0): the reader/writer method
//! surface is added by the later subtasks (§19.1 schema + dashboard, §19.2 query,
//! §19.3 CRUD, §19.4 structure DDL, §19.6 create flows) so each lands behind the
//! port it belongs to. For now the family carries the connection-level surface
//! (engine info + close) needed to open and route a Cassandra workspace.
//!
//! # Async commands rule
//!
//! Like the other port families, every trait method is `async` (`async_trait`).
//! The Cassandra adapter awaits the DataStax / ScyllaDB driver's session on
//! Tauri's tokio runtime directly — no `spawn_blocking`.
//!
//! # Safety contract (MILESTONE_19 "Notes / safety")
//!
//! - **Never** issue `COUNT(*)` to populate the table list or a row count —
//!   Cassandra has no cheap count.
//! - Every read is bounded by a default limit + paged cursor.
//! - CQL query rules are enforced end-to-end: partition key required for an
//!   efficient path; clustering columns used in order; non-key/non-indexed
//!   predicates require an opt-in `ALLOW FILTERING`.
//! - Primary-key columns are immutable identity (inline edit is regular-scalar
//!   only; changing a key = delete + re-insert).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::engine::EngineInfo;
use crate::shared::error::AppError;

/// The role a column plays in a table (mirrors `system_schema.columns.kind` and
/// the prototype's `cassandra-data.js` `kind`). Lowercase-with-underscore on the
/// wire (`partition_key` / `clustering` / `static` / `regular`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnKind {
    PartitionKey,
    Clustering,
    Static,
    Regular,
}

/// One column of a Cassandra table — `{ name, type, kind }`, mirroring the
/// prototype's `C(name, type, kind)` column shape. `data_type` is the CQL type
/// verbatim (`uuid`, `text`, `set<text>`, `map<text,text>`, …) so the renderer's
/// `CassValue` typing matches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassColumn {
    pub name: String,
    /// CQL type verbatim. Named `data_type` because `type` is a Rust keyword;
    /// the wire name is `type`.
    #[serde(rename = "type")]
    pub data_type: String,
    pub kind: ColumnKind,
}

/// One clustering column with its order — `{ name, type, order }` (order
/// `ASC`/`DESC`), mirroring the prototype's `clustering[]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassClustering {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    /// `ASC` or `DESC`.
    pub order: String,
}

/// A secondary index on a table — `{ name, target }` (the indexed column),
/// mirroring `cassandra-data.js` `indexes[]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassIndex {
    pub name: String,
    pub target: String,
}

/// A materialized view derived from a base table — `{ name, partitionKey[],
/// clustering[] }`, mirroring `cassandra-data.js` `mvs[]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassMv {
    pub name: String,
    pub partition_key: Vec<String>,
    pub clustering: Vec<String>,
}

/// A full table descriptor, mapped to the `cassandra-data.js` table shape. Powers
/// the sidebar list, the dashboard per-table panel, and the structure view.
///
/// `est_rows` is deliberately `None`: Cassandra has no cheap `COUNT(*)`, so the
/// row count is never populated for the list (MILESTONE_19 safety note).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDescriptor {
    pub name: String,
    pub columns: Vec<CassColumn>,
    pub partition_key: Vec<String>,
    pub clustering: Vec<CassClustering>,
    /// The assembled PRIMARY KEY clause, e.g. `((user_id), order_id)`.
    pub primary_key: String,
    pub indexes: Vec<CassIndex>,
    pub mvs: Vec<CassMv>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// Always `None` — see the type docs (no cheap count).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub est_rows: Option<u64>,
}

/// One keyspace: name, replication, and durable-writes flag. `replication` is the
/// raw `system_schema.keyspaces.replication` map as a JSON object with the class
/// short-named (`{ "class": "NetworkTopologyStrategy", "dc1": "3" }` /
/// `{ "class": "SimpleStrategy", "replication_factor": "1" }`), mirroring
/// `cassandra-data.js` `replication`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyspaceInfo {
    pub name: String,
    pub replication: Value,
    pub durable_writes: bool,
}

/// One node in the cluster ring (`nodetool status` row). `load`/`owns`/`status`
/// are best-effort: driver/`system.*` metadata gives topology (address, dc, rack,
/// tokens, host id) but not live load/ownership/up-down without JMX, so those are
/// `None` when unavailable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    /// Two-letter state like `UN` (Up/Normal) when known, else `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub address: String,
    pub dc: String,
    pub rack: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owns: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
}

/// The cluster ring summary for the dashboard Cluster panel + `nodetool status`,
/// mirroring `cassandra-engine.js` `clusterStatus()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterStatus {
    pub cluster: String,
    pub partitioner: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snitch: Option<String>,
    pub nodes: Vec<NodeStatus>,
}

/// One predicate in the query builder — `{ col, op, val }`. `op` is one of
/// `=` `<` `<=` `>` `>=` `IN` `CONTAINS` (validated by the adapter). `val` is a
/// JSON scalar (or array for `IN`); the adapter *binds* it as a parameter of the
/// column's CQL type — never interpolated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassPredicate {
    pub col: String,
    pub op: String,
    pub val: Value,
}

/// A bounded query request from the query builder (M19 §19.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassQueryRequest {
    pub keyspace: String,
    pub table: String,
    #[serde(default)]
    pub predicates: Vec<CassPredicate>,
    /// Row cap; `0` = "All" (the adapter still bounds it to a hard ceiling +
    /// paged read so a huge partition can't exhaust memory).
    #[serde(default)]
    pub limit: u32,
    /// Opt-in `ALLOW FILTERING` (a red flag — never silently added).
    #[serde(default)]
    pub allow_filtering: bool,
    /// Consistency level (`ONE`/`QUORUM`/`LOCAL_ONE`/`LOCAL_QUORUM`/`ALL`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consistency: Option<String>,
    /// Forward-paging cursor (hex-encoded driver paging-state bytes) from a prior
    /// page's `nextPagingState`. Absent = first page. Cassandra has no OFFSET, so
    /// paging is cursor-based, not numeric.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paging_state: Option<String>,
}

/// A bounded query result (M19 §19.2). No total row count — Cassandra has no
/// cheap `COUNT(*)`; `truncated` flags that the row cap was reached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassQueryResult {
    /// The table's columns (header + types), in table order.
    pub columns: Vec<CassColumn>,
    /// Row objects keyed by column name (the grid reads `row[col.name]`).
    pub rows: Vec<Value>,
    pub returned: u64,
    /// True when more pages exist (a continuation cursor was returned).
    pub truncated: bool,
    /// The cursor to fetch the next page (hex paging-state bytes), or `None` on
    /// the last page. Pass it back as the request's `pagingState`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_paging_state: Option<String>,
    pub ms: f64,
    /// Whether the query needed `ALLOW FILTERING`.
    pub allow_filtering: bool,
    /// Whether the partition key was fully restricted by equality.
    pub partition_restricted: bool,
    pub warnings: Vec<String>,
    pub consistency: String,
}

/// The tagged outcome of a raw CQL statement (M19 §19.5 — the standalone query
/// tab + cqlsh terminal). `kind` lowercase on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CassCqlResult {
    /// A `SELECT` result set.
    Rows {
        columns: Vec<CassColumn>,
        rows: Vec<Value>,
        returned: u64,
        ms: f64,
        #[serde(default)]
        warnings: Vec<String>,
    },
    /// `DESCRIBE <table>` → the CQL DDL.
    Ddl { text: String },
    /// `DESCRIBE KEYSPACES`/`TABLES` → a name list.
    List { items: Vec<String> },
    /// `USE <keyspace>` → switch the active keyspace (renderer-side).
    Use { keyspace: String },
    /// A non-row statement (INSERT/UPDATE/DELETE/DDL) executed OK.
    Ok { message: String },
}

/// Read side of a Cassandra connection (introspection, bounded CQL query,
/// cluster status, `DESCRIBE`). All errors are §5 human sentences (the adapter
/// maps driver errors).
///
/// §19.1 adds the schema introspection + cluster status the sidebar and
/// dashboard need; the bounded query / column-stats surface (§19.2) and
/// `describe_table` (§19.4/§19.5) extend it. Methods not yet implemented default
/// to `Unsupported` so later subtasks add them without touching the adapter.
#[async_trait]
pub trait WideColumnReader: Send + Sync {
    /// Keyspaces visible on the cluster (user keyspaces; the `system*` keyspaces
    /// are filtered out). From `system_schema.keyspaces`.
    async fn list_keyspaces(&self) -> Result<Vec<KeyspaceInfo>, AppError>;

    /// Full table descriptors for one keyspace — columns/keys/indexes/MVs/comment
    /// from `system_schema.{tables,columns,indexes,views}`. NEVER a `COUNT(*)`.
    async fn list_tables(&self, keyspace: &str) -> Result<Vec<TableDescriptor>, AppError>;

    /// One table's descriptor (the structure/grid header). Unknown tables are a
    /// §5 human error.
    async fn table_meta(&self, keyspace: &str, table: &str) -> Result<TableDescriptor, AppError>;

    /// The cluster ring for the dashboard Cluster panel + `nodetool status`. From
    /// driver/`system.*` metadata — never a full scan.
    async fn cluster_status(&self) -> Result<ClusterStatus, AppError>;

    /// Run a bounded query from the query builder (M19 §19.2), enforcing CQL
    /// rules: the partition key must be fully restricted for an efficient path,
    /// clustering columns are used in order, and a non-key/non-indexed predicate
    /// requires `ALLOW FILTERING` (else a §5 error mirroring the driver's). Every
    /// value is bound; every read is bounded by a row cap.
    async fn query(&self, req: CassQueryRequest) -> Result<CassQueryResult, AppError>;

    /// The `CREATE TABLE` (+ index/MV) CQL for the structure view's CQL section
    /// and the cqlsh `DESCRIBE` (M19 §19.4/§19.5), built from table metadata.
    async fn describe_table(&self, keyspace: &str, table: &str) -> Result<String, AppError>;

    /// Run one raw CQL statement (M19 §19.5 — standalone query tab + cqlsh):
    /// `USE` / `DESCRIBE KEYSPACES|TABLES|<table>` are handled locally; every
    /// other statement (SELECT/DML/DDL) executes on the session at the given
    /// consistency. SELECT results are bounded by a row cap.
    async fn run_cql(
        &self,
        keyspace: &str,
        cql: &str,
        consistency: Option<&str>,
    ) -> Result<CassCqlResult, AppError>;
}

/// A whole-row insert (M19 §19.3). `row` is a column→value map; every value is
/// bound as a parameter of its column's CQL type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassInsertRow {
    pub keyspace: String,
    pub table: String,
    pub row: serde_json::Map<String, Value>,
}

/// A full-primary-key update (M19 §19.3). `key` must carry every partition +
/// clustering column (no partial-key UPDATE); `set` holds the changed non-key
/// columns. All values are bound.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassUpdateRow {
    pub keyspace: String,
    pub table: String,
    pub key: serde_json::Map<String, Value>,
    pub set: serde_json::Map<String, Value>,
}

/// A full-primary-key delete (M19 §19.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassDeleteRow {
    pub keyspace: String,
    pub table: String,
    pub key: serde_json::Map<String, Value>,
}

/// A grid multi-select bulk delete — one full primary key per row to remove.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassDeleteRows {
    pub keyspace: String,
    pub table: String,
    pub keys: Vec<serde_json::Map<String, Value>>,
}

/// Create a secondary index on a column (M19 §19.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassCreateIndex {
    pub keyspace: String,
    pub table: String,
    pub name: String,
    pub target: String,
}

/// Create a materialized view from a base table (M19 §19.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassCreateMv {
    pub keyspace: String,
    pub table: String,
    pub name: String,
    pub partition_key: Vec<String>,
    #[serde(default)]
    pub clustering: Vec<String>,
}

/// Create a keyspace (M19 §19.6). `replication` is the strategy map
/// (`{ class, replication_factor | <dc>: n }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassCreateKeyspace {
    pub name: String,
    pub replication: serde_json::Map<String, Value>,
    pub durable_writes: bool,
}

/// One column definition in a `CREATE TABLE` (M19 §19.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassCreateColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    pub kind: ColumnKind,
}

/// One clustering column (name + order) in a `CREATE TABLE` (M19 §19.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassCreateClustering {
    pub name: String,
    pub order: String,
}

/// Create a table (M19 §19.6) — columns + partition/clustering keys + order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CassCreateTable {
    pub keyspace: String,
    pub name: String,
    pub columns: Vec<CassCreateColumn>,
    pub partition_key: Vec<String>,
    #[serde(default)]
    pub clustering: Vec<CassCreateClustering>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// Write side of a Cassandra connection (full-primary-key CRUD + index / MV /
/// keyspace / table DDL). Every method mutates the live cluster.
///
/// Primary-key columns are immutable identity, so there is **no partial-key
/// UPDATE** — [`Self::update_row`] / [`Self::delete_row`] require the full
/// primary key (the adapter validates it). Index/MV/keyspace/table DDL lands with
/// §19.4/§19.6.
#[async_trait]
pub trait WideColumnWriter: Send + Sync {
    /// `INSERT INTO …` a whole row (M19 §19.3). All bound.
    async fn insert_row(&self, req: CassInsertRow) -> Result<(), AppError>;

    /// `UPDATE … SET … WHERE <full primary key>` (M19 §19.3). Rejects a partial
    /// key.
    async fn update_row(&self, req: CassUpdateRow) -> Result<(), AppError>;

    /// `DELETE FROM … WHERE <full primary key>` (M19 §19.3). Rejects a partial
    /// key.
    async fn delete_row(&self, req: CassDeleteRow) -> Result<(), AppError>;

    /// Bulk delete — one full-primary-key `DELETE` per selected row (grid
    /// multi-select). Returns the number deleted.
    async fn delete_rows(&self, req: CassDeleteRows) -> Result<u64, AppError>;

    /// `CREATE INDEX … ON … (col)` (M19 §19.4).
    async fn create_index(&self, req: CassCreateIndex) -> Result<(), AppError>;

    /// `DROP INDEX ks.name` (M19 §19.4).
    async fn drop_index(&self, keyspace: &str, name: &str) -> Result<(), AppError>;

    /// `CREATE MATERIALIZED VIEW …` (M19 §19.4).
    async fn create_mv(&self, req: CassCreateMv) -> Result<(), AppError>;

    /// `DROP MATERIALIZED VIEW ks.name` (M19 §19.4).
    async fn drop_mv(&self, keyspace: &str, name: &str) -> Result<(), AppError>;

    /// `CREATE KEYSPACE …` (M19 §19.6).
    async fn create_keyspace(&self, req: CassCreateKeyspace) -> Result<(), AppError>;

    /// `CREATE TABLE …` (M19 §19.6).
    async fn create_table(&self, req: CassCreateTable) -> Result<(), AppError>;
}

/// A live Cassandra connection: the read + write ports bundled, plus the shared
/// [`EngineInfo`] accessor and an orderly `close`. The `engines::cassandra`
/// adapter implements all three; the [`crate::shared::engine::OpenConnection`]
/// `WideColumn` arm holds an `Arc<dyn WideColumnConnection>`.
#[async_trait]
pub trait WideColumnConnection: WideColumnReader + WideColumnWriter {
    /// Engine + version of this connection (`Cassandra 4.1.3`).
    fn engine_info(&self) -> EngineInfo;

    /// Release driver resources. The DataStax/ScyllaDB session manages its own
    /// connection pool and is `Drop`-managed, so this is typically a no-op, but
    /// the manager calls it for symmetry with the other families.
    async fn close(&self) -> Result<(), AppError>;
}
