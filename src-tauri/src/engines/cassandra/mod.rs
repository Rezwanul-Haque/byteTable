//! Cassandra engine adapter (M19): the infrastructure implementation of the
//! wide-column port family in [`crate::shared::widecolumn`]. Uses the DataStax /
//! ScyllaDB `scylla` driver on Tauri's tokio runtime — no `spawn_blocking`,
//! mirroring the sqlx/redis/dynamo/mongo adapters.
//!
//! # Connection (MILESTONE_19 §19.0)
//!
//! Built from [`ConnectionParams::Cassandra`]:
//! - **Contact points** — the `contact_points` field is one host or a
//!   comma-separated list; each entry gets the native `port` appended when it
//!   carries none. The driver connects to these and *discovers the rest of the
//!   ring* from cluster metadata.
//! - **Local datacenter** — when set, the session prefers that datacenter for
//!   token-aware, DC-local routing ([`prefer_datacenter`]).
//! - **Auth** — when a `user` is given, `PasswordAuthenticator` credentials are
//!   built from it plus the transient password ([`ConnectSecret`] / keychain).
//! - **Keyspace** — an optional initial keyspace the session `USE`s.
//!
//! The reachability check is a `SELECT release_version FROM system.local`
//! round-trip — the MILESTONE_19 §19.0 acceptance metadata/version query, which
//! also forces the driver to actually reach a node and discover the cluster.
//!
//! # TLS
//!
//! Native-protocol TLS arrives with a later M19 subtask (behind an explicit
//! rustls feature, keeping the default build OpenSSL-free). For now the adapter
//! connects in plaintext for the `disable`/`prefer` modes (the local / Docker
//! case the §19.0 acceptance targets) and refuses the `require`/`verify-*` modes
//! with a §5 error rather than silently downgrading an encrypted request.

mod value;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use scylla::client::session::Session;
use scylla::client::session_builder::SessionBuilder;
use scylla::response::PagingState;
use scylla::statement::{Consistency, Statement};
use scylla::value::{CqlValue, Row};

use crate::shared::engine::{
    ConnectSecret, ConnectionParams, Connector, Engine, EngineInfo, OpenConnection, TlsMode,
};
use crate::shared::error::AppError;
use crate::shared::widecolumn::{
    CassClustering, CassColumn, CassCqlResult, CassCreateIndex, CassCreateKeyspace, CassCreateMv,
    CassCreateTable, CassDeleteRow, CassDeleteRows, CassIndex, CassInsertRow, CassMv,
    CassQueryRequest, CassQueryResult, CassUpdateRow, ClusterStatus, ColumnKind, KeyspaceInfo,
    NodeStatus, TableDescriptor, WideColumnConnection, WideColumnReader, WideColumnWriter,
};

use value::{cql_to_json, cql_value_type_label, decode_hex, hex_encode, json_to_cql};

/// Hard ceiling on rows a single browse query loads, so a huge partition/table
/// can never exhaust memory — "All" in the pager maps to this bound.
const ROW_CAP: u32 = 5000;

/// The legal query-builder operators.
const LEGAL_OPS: [&str; 7] = ["=", "<", "<=", ">", ">=", "IN", "CONTAINS"];

/// Parse a consistency-level token into the driver enum (defaults to
/// `LocalQuorum` for an unknown/absent value).
fn consistency_from(token: Option<&str>) -> Consistency {
    match token.unwrap_or("LOCAL_QUORUM") {
        "ONE" => Consistency::One,
        "QUORUM" => Consistency::Quorum,
        "LOCAL_ONE" => Consistency::LocalOne,
        "ALL" => Consistency::All,
        _ => Consistency::LocalQuorum,
    }
}

/// Quote a CQL identifier (double quotes, embedded quotes doubled) so a validated
/// column/table/keyspace name is injection-safe.
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// The built-in keyspaces hidden from the user-facing keyspace list.
const SYSTEM_KEYSPACES: [&str; 6] = [
    "system",
    "system_schema",
    "system_auth",
    "system_distributed",
    "system_traces",
    "system_views",
];

/// Map any driver error (each `scylla` error type implements `Display`) to a §5
/// human sentence.
fn db_err(context: &str, error: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("{context}: {error}"))
}

/// Opens and tests Cassandra connections. Stateless; registered once in `lib.rs`.
pub struct CassandraConnector;

#[async_trait]
impl Connector for CassandraConnector {
    async fn test(&self, params: &ConnectionParams) -> Result<EngineInfo, AppError> {
        self.test_with_secret(params, None).await
    }

    async fn open(&self, params: &ConnectionParams) -> Result<OpenConnection, AppError> {
        self.open_with_secret(params, None).await
    }

    async fn test_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<EngineInfo, AppError> {
        let session = build_session(params, secret).await?;
        let version = read_version(&session).await?;
        Ok(engine_info(version))
    }

    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        let session = build_session(params, secret).await?;
        let version = read_version(&session).await?;
        Ok(OpenConnection::wide_column(CassandraConnection {
            session,
            info: engine_info(version),
        }))
    }
}

/// Build the driver [`Session`] for `params`, honoring contact points + port,
/// optional local-datacenter preference, optional auth, and an optional initial
/// keyspace. The reachability round-trip is the caller's job (see
/// [`read_version`]).
async fn build_session(
    params: &ConnectionParams,
    secret: Option<&ConnectSecret>,
) -> Result<Session, AppError> {
    let (contact_points, port, keyspace, local_datacenter, user, tls_mode) = match params {
        ConnectionParams::Cassandra {
            contact_points,
            port,
            keyspace,
            local_datacenter,
            user,
            tls_mode,
        } => (
            contact_points,
            *port,
            keyspace,
            local_datacenter,
            user,
            *tls_mode,
        ),
        other => {
            return Err(AppError::Invalid(format!(
                "Cassandra connector received {} params",
                other.engine().display_name()
            )))
        }
    };

    // TLS is not wired in §19.0 — refuse the encrypting modes rather than
    // silently connecting in plaintext (see the module TLS note).
    match tls_mode {
        TlsMode::Disable | TlsMode::Prefer => {}
        TlsMode::Require | TlsMode::VerifyCa | TlsMode::VerifyFull => {
            return Err(AppError::Unsupported(
                "TLS for Cassandra connections arrives in a later update. \
                 Use the 'disable' or 'prefer' TLS mode for now."
                    .into(),
            ))
        }
    }

    let nodes = contact_nodes(contact_points, port);
    if nodes.is_empty() {
        return Err(AppError::Invalid(
            "At least one contact point (host) is required".into(),
        ));
    }

    let mut builder = SessionBuilder::new()
        .known_nodes(&nodes)
        .connection_timeout(Duration::from_secs(8));

    if let Some(dc) = local_datacenter {
        if !dc.is_empty() {
            builder = builder.prefer_datacenter(dc.clone());
        }
    }

    if let Some(user) = user {
        let password = secret
            .and_then(ConnectSecret::password)
            .unwrap_or("")
            .to_string();
        builder = builder.user(user.clone(), password);
    }

    if let Some(ks) = keyspace {
        if !ks.is_empty() {
            builder = builder.use_keyspace(ks.clone(), false);
        }
    }

    builder
        .build()
        .await
        .map_err(|e| db_err("Cassandra connection failed", e))
}

/// Split the contact-points field (one host, or a comma-separated list) into
/// `host:port` strings, appending the native `port` to any entry that carries no
/// explicit port. Blank entries are dropped.
fn contact_nodes(contact_points: &str, port: u16) -> Vec<String> {
    contact_points
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|host| {
            if host.contains(':') {
                host.to_string()
            } else {
                format!("{host}:{port}")
            }
        })
        .collect()
}

/// Round-trip a `SELECT release_version FROM system.local` — the §19.0
/// acceptance metadata query — and return the version string (best-effort:
/// an empty/absent result yields a usable `"Cassandra"` label upstream).
async fn read_version(session: &Session) -> Result<Option<String>, AppError> {
    let rows = session
        .query_unpaged("SELECT release_version FROM system.local", &[])
        .await
        .map_err(|e| db_err("Cassandra version query failed", e))?
        .into_rows_result()
        .map_err(|e| db_err("Cassandra version query failed", e))?;

    let mut iter = rows
        .rows::<(String,)>()
        .map_err(|e| db_err("Cassandra version query failed", e))?;
    if let Some(row) = iter.next() {
        let (version,) = row.map_err(|e| db_err("Cassandra version query failed", e))?;
        return Ok(Some(version));
    }
    Ok(None)
}

/// Build the [`EngineInfo`] label from the discovered release version.
fn engine_info(version: Option<String>) -> EngineInfo {
    EngineInfo {
        engine: Engine::Cassandra,
        server_version: match version {
            Some(v) => format!("Cassandra {v}"),
            None => "Cassandra".into(),
        },
    }
}

/// Strip the `org.apache.cassandra.locator.` package prefix from a replication
/// strategy class so the wire shape carries the short name the prototype uses
/// (`SimpleStrategy` / `NetworkTopologyStrategy`).
fn short_class(class: &str) -> &str {
    class.rsplit('.').next().unwrap_or(class)
}

/// Convert a `system_schema.keyspaces.replication` map into the JSON object the
/// renderer renders (`{ class, replication_factor | <dc>: n }`), short-naming the
/// strategy class.
fn replication_json(map: HashMap<String, String>) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    for (k, v) in map {
        if k == "class" {
            obj.insert(
                "class".into(),
                serde_json::Value::String(short_class(&v).into()),
            );
        } else {
            obj.insert(k, serde_json::Value::String(v));
        }
    }
    serde_json::Value::Object(obj)
}

/// Map a `system_schema.columns.kind` string to the [`ColumnKind`] enum.
fn column_kind(kind: &str) -> ColumnKind {
    match kind {
        "partition_key" => ColumnKind::PartitionKey,
        "clustering" => ColumnKind::Clustering,
        "static" => ColumnKind::Static,
        _ => ColumnKind::Regular,
    }
}

/// Assemble the `PRIMARY KEY` clause string from partition + clustering column
/// names, mirroring the prototype's `buildPrimaryKey`: `((p1, p2), c1, c2)`.
fn primary_key_string(partition: &[String], clustering: &[String]) -> String {
    let mut s = format!("(({})", partition.join(", "));
    if !clustering.is_empty() {
        s.push_str(", ");
        s.push_str(&clustering.join(", "));
    }
    s.push(')');
    s
}

/// One raw `system_schema.columns` row, before grouping into descriptors.
struct RawCol {
    name: String,
    kind: String,
    position: i32,
    data_type: String,
    clustering_order: String,
}

/// One open Cassandra connection: the driver session plus the resolved engine
/// info. The session manages its own connection pool and is `Drop`-managed, so
/// `close` is a no-op.
pub struct CassandraConnection {
    session: Session,
    info: EngineInfo,
}

impl CassandraConnection {
    /// Build every base-table descriptor for one keyspace from
    /// `system_schema.{tables,columns,indexes,views}` in a fixed set of queries —
    /// never a per-table round trip and never a `COUNT(*)`.
    async fn descriptors(&self, keyspace: &str) -> Result<Vec<TableDescriptor>, AppError> {
        // Base tables + their comments.
        let table_rows = self
            .session
            .query_unpaged(
                "SELECT table_name, comment FROM system_schema.tables WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .map_err(|e| db_err("List tables failed", e))?
            .into_rows_result()
            .map_err(|e| db_err("List tables failed", e))?;
        let mut tables: Vec<(String, Option<String>)> = Vec::new();
        for row in table_rows
            .rows::<(String, Option<String>)>()
            .map_err(|e| db_err("List tables failed", e))?
        {
            tables.push(row.map_err(|e| db_err("List tables failed", e))?);
        }

        // Columns for every table AND view in the keyspace (views carry their own
        // column rows), grouped by their owning table/view name.
        let col_res = self
            .session
            .query_unpaged(
                "SELECT table_name, column_name, kind, position, type, clustering_order \
                 FROM system_schema.columns WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .map_err(|e| db_err("List columns failed", e))?
            .into_rows_result()
            .map_err(|e| db_err("List columns failed", e))?;
        let mut cols_by: HashMap<String, Vec<RawCol>> = HashMap::new();
        for row in col_res
            .rows::<(String, String, String, i32, String, String)>()
            .map_err(|e| db_err("List columns failed", e))?
        {
            let (table_name, name, kind, position, data_type, clustering_order) =
                row.map_err(|e| db_err("List columns failed", e))?;
            cols_by.entry(table_name).or_default().push(RawCol {
                name,
                kind,
                position,
                data_type,
                clustering_order,
            });
        }

        // Secondary indexes, grouped by base table.
        let idx_res = self
            .session
            .query_unpaged(
                "SELECT table_name, index_name, options FROM system_schema.indexes \
                 WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .map_err(|e| db_err("List indexes failed", e))?
            .into_rows_result()
            .map_err(|e| db_err("List indexes failed", e))?;
        let mut idx_by: HashMap<String, Vec<CassIndex>> = HashMap::new();
        for row in idx_res
            .rows::<(String, String, HashMap<String, String>)>()
            .map_err(|e| db_err("List indexes failed", e))?
        {
            let (table_name, index_name, options) =
                row.map_err(|e| db_err("List indexes failed", e))?;
            let target = options.get("target").cloned().unwrap_or_default();
            idx_by.entry(table_name).or_default().push(CassIndex {
                name: index_name,
                target,
            });
        }

        // Materialized views, grouped by base table.
        let view_res = self
            .session
            .query_unpaged(
                "SELECT view_name, base_table_name FROM system_schema.views \
                 WHERE keyspace_name = ?",
                (keyspace,),
            )
            .await
            .map_err(|e| db_err("List views failed", e))?
            .into_rows_result()
            .map_err(|e| db_err("List views failed", e))?;
        let mut views_by: HashMap<String, Vec<String>> = HashMap::new();
        for row in view_res
            .rows::<(String, String)>()
            .map_err(|e| db_err("List views failed", e))?
        {
            let (view_name, base_table_name) = row.map_err(|e| db_err("List views failed", e))?;
            views_by.entry(base_table_name).or_default().push(view_name);
        }

        let mut out: Vec<TableDescriptor> = tables
            .into_iter()
            .map(|(name, comment)| {
                let descriptor = build_descriptor(
                    &name,
                    cols_by.get(&name).map(Vec::as_slice).unwrap_or(&[]),
                    idx_by.remove(&name).unwrap_or_default(),
                    views_by.get(&name).map(Vec::as_slice).unwrap_or(&[]),
                    &cols_by,
                    comment,
                );
                descriptor
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }
}

/// Assemble one [`TableDescriptor`] from its raw columns + indexes + view names.
fn build_descriptor(
    name: &str,
    raw_cols: &[RawCol],
    indexes: Vec<CassIndex>,
    view_names: &[String],
    cols_by: &HashMap<String, Vec<RawCol>>,
    comment: Option<String>,
) -> TableDescriptor {
    let mut partition: Vec<&RawCol> = raw_cols
        .iter()
        .filter(|c| c.kind == "partition_key")
        .collect();
    partition.sort_by_key(|c| c.position);
    let mut clustering_raw: Vec<&RawCol> =
        raw_cols.iter().filter(|c| c.kind == "clustering").collect();
    clustering_raw.sort_by_key(|c| c.position);
    let mut others: Vec<&RawCol> = raw_cols
        .iter()
        .filter(|c| c.kind != "partition_key" && c.kind != "clustering")
        .collect();
    others.sort_by(|a, b| a.name.cmp(&b.name));

    let partition_key: Vec<String> = partition.iter().map(|c| c.name.clone()).collect();
    let clustering: Vec<CassClustering> = clustering_raw
        .iter()
        .map(|c| CassClustering {
            name: c.name.clone(),
            data_type: c.data_type.clone(),
            order: c.clustering_order.to_uppercase(),
        })
        .collect();
    let clustering_names: Vec<String> = clustering.iter().map(|c| c.name.clone()).collect();

    // Columns in declaration-ish order: partition keys, clustering, then the rest.
    let columns: Vec<CassColumn> = partition
        .iter()
        .chain(clustering_raw.iter())
        .chain(others.iter())
        .map(|c| CassColumn {
            name: c.name.clone(),
            data_type: c.data_type.clone(),
            kind: column_kind(&c.kind),
        })
        .collect();

    let mvs: Vec<CassMv> = view_names
        .iter()
        .map(|view_name| {
            let view_cols = cols_by.get(view_name).map(Vec::as_slice).unwrap_or(&[]);
            let mut vp: Vec<&RawCol> = view_cols
                .iter()
                .filter(|c| c.kind == "partition_key")
                .collect();
            vp.sort_by_key(|c| c.position);
            let mut vc: Vec<&RawCol> = view_cols
                .iter()
                .filter(|c| c.kind == "clustering")
                .collect();
            vc.sort_by_key(|c| c.position);
            CassMv {
                name: view_name.clone(),
                partition_key: vp.iter().map(|c| c.name.clone()).collect(),
                clustering: vc.iter().map(|c| c.name.clone()).collect(),
            }
        })
        .collect();

    TableDescriptor {
        name: name.to_string(),
        primary_key: primary_key_string(&partition_key, &clustering_names),
        columns,
        partition_key,
        clustering,
        indexes,
        mvs,
        comment: comment.filter(|c| !c.is_empty()),
        est_rows: None,
    }
}

#[async_trait]
impl WideColumnReader for CassandraConnection {
    async fn list_keyspaces(&self) -> Result<Vec<KeyspaceInfo>, AppError> {
        let res = self
            .session
            .query_unpaged(
                "SELECT keyspace_name, durable_writes, replication FROM system_schema.keyspaces",
                &[],
            )
            .await
            .map_err(|e| db_err("List keyspaces failed", e))?
            .into_rows_result()
            .map_err(|e| db_err("List keyspaces failed", e))?;
        let mut out = Vec::new();
        for row in res
            .rows::<(String, bool, HashMap<String, String>)>()
            .map_err(|e| db_err("List keyspaces failed", e))?
        {
            let (name, durable_writes, replication) =
                row.map_err(|e| db_err("List keyspaces failed", e))?;
            if SYSTEM_KEYSPACES.contains(&name.as_str()) {
                continue;
            }
            out.push(KeyspaceInfo {
                name,
                replication: replication_json(replication),
                durable_writes,
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn list_tables(&self, keyspace: &str) -> Result<Vec<TableDescriptor>, AppError> {
        self.descriptors(keyspace).await
    }

    async fn table_meta(&self, keyspace: &str, table: &str) -> Result<TableDescriptor, AppError> {
        self.descriptors(keyspace)
            .await?
            .into_iter()
            .find(|t| t.name == table)
            .ok_or_else(|| {
                AppError::NotFound(format!("Table '{keyspace}.{table}' does not exist."))
            })
    }

    async fn cluster_status(&self) -> Result<ClusterStatus, AppError> {
        // Local node: cluster identity + this node's topology.
        let local = self
            .session
            .query_unpaged(
                "SELECT cluster_name, partitioner, data_center, rack, host_id, tokens, \
                 broadcast_address FROM system.local",
                &[],
            )
            .await
            .map_err(|e| db_err("Cluster status failed", e))?
            .into_rows_result()
            .map_err(|e| db_err("Cluster status failed", e))?;
        type LocalRow = (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<uuid::Uuid>,
            Option<Vec<String>>,
            Option<std::net::IpAddr>,
        );
        let mut cluster = "Cassandra Cluster".to_string();
        let mut partitioner = String::new();
        let mut nodes: Vec<NodeStatus> = Vec::new();
        if let Some(row) = local
            .maybe_first_row::<LocalRow>()
            .map_err(|e| db_err("Cluster status failed", e))?
        {
            let (name, part, dc, rack, host_id, tokens, addr) = row;
            if let Some(name) = name {
                cluster = name;
            }
            partitioner = part
                .map(|p| short_class(&p).to_string())
                .unwrap_or_default();
            nodes.push(NodeStatus {
                status: Some("UN".into()),
                address: addr
                    .map(|a| a.to_string())
                    .unwrap_or_else(|| "127.0.0.1".into()),
                dc: dc.unwrap_or_default(),
                rack: rack.unwrap_or_default(),
                load: None,
                owns: None,
                tokens: tokens.map(|t| t.len() as u32),
                host_id: host_id.map(|h| h.to_string()),
            });
        }

        // Peers: the rest of the ring (topology only; up/down needs gossip/JMX).
        let peers = self
            .session
            .query_unpaged(
                "SELECT peer, data_center, rack, host_id, tokens FROM system.peers",
                &[],
            )
            .await
            .map_err(|e| db_err("Cluster status failed", e))?
            .into_rows_result()
            .map_err(|e| db_err("Cluster status failed", e))?;
        type PeerRow = (
            Option<std::net::IpAddr>,
            Option<String>,
            Option<String>,
            Option<uuid::Uuid>,
            Option<Vec<String>>,
        );
        for row in peers
            .rows::<PeerRow>()
            .map_err(|e| db_err("Cluster status failed", e))?
        {
            let (peer, dc, rack, host_id, tokens) =
                row.map_err(|e| db_err("Cluster status failed", e))?;
            nodes.push(NodeStatus {
                status: None,
                address: peer.map(|a| a.to_string()).unwrap_or_default(),
                dc: dc.unwrap_or_default(),
                rack: rack.unwrap_or_default(),
                load: None,
                owns: None,
                tokens: tokens.map(|t| t.len() as u32),
                host_id: host_id.map(|h| h.to_string()),
            });
        }

        Ok(ClusterStatus {
            cluster,
            partitioner,
            snitch: None,
            nodes,
        })
    }

    async fn query(&self, req: CassQueryRequest) -> Result<CassQueryResult, AppError> {
        let table = self.table_meta(&req.keyspace, &req.table).await?;
        let col_type = |name: &str| -> Option<String> {
            table
                .columns
                .iter()
                .find(|c| c.name == name)
                .map(|c| c.data_type.clone())
        };

        // --- CQL query-rule analysis (mirrors the prototype engine) ----------
        let partition_restricted = !table.partition_key.is_empty()
            && table.partition_key.iter().all(|p| {
                req.predicates
                    .iter()
                    .any(|w| &w.col == p && (w.op == "=" || w.op == "IN"))
            });
        let mut keyset: Vec<&str> = Vec::new();
        keyset.extend(table.partition_key.iter().map(String::as_str));
        keyset.extend(table.clustering.iter().map(|c| c.name.as_str()));
        keyset.extend(table.indexes.iter().map(|i| i.target.as_str()));
        let non_key_predicate = req
            .predicates
            .iter()
            .any(|w| !keyset.contains(&w.col.as_str()));
        let needs_filtering =
            !req.predicates.is_empty() && (!partition_restricted || non_key_predicate);

        let mut warnings = Vec::new();
        if needs_filtering && !req.allow_filtering {
            let reason = if !partition_restricted {
                format!(
                    "the partition key ({}) is not fully restricted by an equality",
                    table.partition_key.join(", ")
                )
            } else {
                "a non-primary-key column is filtered".to_string()
            };
            return Err(AppError::Invalid(format!(
                "Cannot execute this query as it might involve data filtering and thus may have \
                 unpredictable performance. If you want to execute this query despite the \
                 performance unpredictability, use ALLOW FILTERING — ({reason})"
            )));
        }
        if needs_filtering && req.allow_filtering {
            warnings.push(
                "Query uses ALLOW FILTERING — it scans across partitions and will not scale on a \
                 real cluster."
                    .to_string(),
            );
        }

        // --- build the bounded, fully-bound CQL ------------------------------
        let select_cols = table
            .columns
            .iter()
            .map(|c| quote_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        let mut cql = format!(
            "SELECT {select_cols} FROM {}.{}",
            quote_ident(&req.keyspace),
            quote_ident(&req.table)
        );
        let mut values: Vec<CqlValue> = Vec::new();
        if !req.predicates.is_empty() {
            let mut conds = Vec::new();
            for p in &req.predicates {
                if !LEGAL_OPS.contains(&p.op.as_str()) {
                    return Err(AppError::Invalid(format!(
                        "Unsupported operator '{}'",
                        p.op
                    )));
                }
                let ty = col_type(&p.col).ok_or_else(|| {
                    AppError::Invalid(format!("Unknown column '{}' in filter", p.col))
                })?;
                if p.op == "IN" {
                    let items = match &p.val {
                        serde_json::Value::Array(a) => a.clone(),
                        other => vec![other.clone()],
                    };
                    let mut list = Vec::new();
                    for item in &items {
                        list.push(json_to_cql(item, &ty)?);
                    }
                    values.push(CqlValue::List(list));
                } else {
                    values.push(json_to_cql(&p.val, &ty)?);
                }
                conds.push(format!("{} {} ?", quote_ident(&p.col), p.op));
            }
            cql.push_str(" WHERE ");
            cql.push_str(&conds.join(" AND "));
        }

        if req.allow_filtering {
            cql.push_str(" ALLOW FILTERING");
        }

        // The chosen "row limit" is the PAGE SIZE — Cassandra has no OFFSET, so
        // we page with the driver's opaque paging state (a cursor) rather than a
        // numeric offset. "All" pages at the hard ROW_CAP per page.
        let page_rows = if req.limit == 0 {
            ROW_CAP
        } else {
            req.limit.min(ROW_CAP)
        };
        let page_size =
            i32::try_from(page_rows).map_err(|_| AppError::Invalid("Invalid page size".into()))?;
        let mut statement = Statement::new(cql).with_page_size(page_size);
        statement.set_consistency(consistency_from(req.consistency.as_deref()));

        // Resume from the caller's cursor (hex-encoded paging-state bytes) or
        // start a fresh scan.
        let paging_state = match &req.paging_state {
            Some(hex) => PagingState::new_from_raw_bytes(
                decode_hex(hex).ok_or_else(|| AppError::Invalid("Invalid paging cursor".into()))?,
            ),
            None => PagingState::start(),
        };

        let started = Instant::now();
        let (result, paging_response) = self
            .session
            .query_single_page(statement, values, paging_state)
            .await
            .map_err(|e| db_err("Query failed", e))?;
        let rows_result = result
            .into_rows_result()
            .map_err(|e| db_err("Query failed", e))?;

        let mut rows: Vec<serde_json::Value> = Vec::new();
        for row in rows_result
            .rows::<Row>()
            .map_err(|e| db_err("Query failed", e))?
        {
            let row = row.map_err(|e| db_err("Decode row failed", e))?;
            let mut obj = serde_json::Map::new();
            for (col, cell) in table.columns.iter().zip(row.columns.iter()) {
                obj.insert(
                    col.name.clone(),
                    cell.as_ref()
                        .map(cql_to_json)
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            rows.push(serde_json::Value::Object(obj));
        }
        let ms = started.elapsed().as_secs_f64() * 1000.0;

        // A continuation cursor means there are more pages; `Break` means this
        // was the last page.
        let next_paging_state = match paging_response.into_paging_control_flow() {
            std::ops::ControlFlow::Continue(state) => state.as_bytes_slice().map(|b| hex_encode(b)),
            std::ops::ControlFlow::Break(()) => None,
        };

        Ok(CassQueryResult {
            columns: table.columns,
            returned: rows.len() as u64,
            rows,
            truncated: next_paging_state.is_some(),
            next_paging_state,
            ms,
            allow_filtering: needs_filtering,
            partition_restricted,
            warnings,
            consistency: req.consistency.unwrap_or_else(|| "LOCAL_QUORUM".into()),
        })
    }

    async fn describe_table(&self, keyspace: &str, table: &str) -> Result<String, AppError> {
        let t = self.table_meta(keyspace, table).await?;
        Ok(build_ddl(keyspace, &t))
    }

    async fn run_cql(
        &self,
        keyspace: &str,
        cql: &str,
        consistency: Option<&str>,
    ) -> Result<CassCqlResult, AppError> {
        let raw = cql.trim().trim_end_matches(';').trim();
        let low = raw.to_lowercase();

        if let Some(rest) = low.strip_prefix("use ") {
            let _ = rest;
            let name = raw[4..].trim().trim_matches('"').to_string();
            return Ok(CassCqlResult::Use { keyspace: name });
        }
        if low == "describe keyspaces" || low == "desc keyspaces" {
            let items = self
                .list_keyspaces()
                .await?
                .into_iter()
                .map(|k| k.name)
                .collect();
            return Ok(CassCqlResult::List { items });
        }
        if low.starts_with("describe tables") || low.starts_with("desc tables") {
            let items = self
                .list_tables(keyspace)
                .await?
                .into_iter()
                .map(|t| t.name)
                .collect();
            return Ok(CassCqlResult::List { items });
        }
        if low.starts_with("describe ") || low.starts_with("desc ") {
            let after = raw
                .split_once(char::is_whitespace)
                .map(|(_, rest)| rest)
                .unwrap_or("")
                .trim();
            let after = after
                .strip_prefix("table ")
                .or_else(|| after.strip_prefix("TABLE "))
                .unwrap_or(after)
                .trim();
            let name = after
                .rsplit('.')
                .next()
                .unwrap_or(after)
                .trim()
                .trim_matches('"');
            return Ok(CassCqlResult::Ddl {
                text: self.describe_table(keyspace, name).await?,
            });
        }

        // Anything else: execute on the session at the requested consistency.
        let mut statement = Statement::new(raw.to_string());
        statement.set_consistency(consistency_from(consistency));
        let started = Instant::now();
        let result = self
            .session
            .query_unpaged(statement, &[])
            .await
            .map_err(|e| db_err("CQL failed", e))?;
        let ms = started.elapsed().as_secs_f64() * 1000.0;

        match result.into_rows_result() {
            Ok(rows_result) => {
                let names: Vec<String> = rows_result
                    .column_specs()
                    .iter()
                    .map(|s| s.name().to_string())
                    .collect();
                let mut type_label: Vec<&str> = vec!["text"; names.len()];
                let mut out_rows: Vec<serde_json::Value> = Vec::new();
                for row in rows_result
                    .rows::<Row>()
                    .map_err(|e| db_err("CQL failed", e))?
                {
                    if out_rows.len() as u32 >= ROW_CAP {
                        break;
                    }
                    let row = row.map_err(|e| db_err("Decode row failed", e))?;
                    let mut obj = serde_json::Map::new();
                    for (i, cell) in row.columns.iter().enumerate() {
                        let name = names.get(i).cloned().unwrap_or_else(|| format!("col{i}"));
                        match cell {
                            Some(v) => {
                                if type_label[i] == "text" {
                                    type_label[i] = cql_value_type_label(v);
                                }
                                obj.insert(name, cql_to_json(v));
                            }
                            None => {
                                obj.insert(name, serde_json::Value::Null);
                            }
                        }
                    }
                    out_rows.push(serde_json::Value::Object(obj));
                }
                let columns = names
                    .iter()
                    .enumerate()
                    .map(|(i, n)| CassColumn {
                        name: n.clone(),
                        data_type: type_label[i].to_string(),
                        kind: ColumnKind::Regular,
                    })
                    .collect();
                Ok(CassCqlResult::Rows {
                    columns,
                    returned: out_rows.len() as u64,
                    rows: out_rows,
                    ms,
                    warnings: Vec::new(),
                })
            }
            Err(_) => Ok(CassCqlResult::Ok {
                message: "Statement executed.".into(),
            }),
        }
    }
}

/// Build the `CREATE TABLE` (+ index/MV) CQL from a table descriptor, mirroring
/// the prototype's `describeTable`.
fn build_ddl(ks: &str, t: &TableDescriptor) -> String {
    let mut body: Vec<String> = t
        .columns
        .iter()
        .map(|c| {
            let stat = if c.kind == ColumnKind::Static {
                " static"
            } else {
                ""
            };
            format!("  {} {}{}", c.name, c.data_type, stat)
        })
        .collect();
    body.push(format!("  PRIMARY KEY {}", t.primary_key));
    let mut s = format!("CREATE TABLE {}.{} (\n{}\n)", ks, t.name, body.join(",\n"));

    let mut withs: Vec<String> = Vec::new();
    if !t.clustering.is_empty() {
        let order = t
            .clustering
            .iter()
            .map(|c| format!("{} {}", c.name, c.order))
            .collect::<Vec<_>>()
            .join(", ");
        withs.push(format!("CLUSTERING ORDER BY ({order})"));
    }
    if let Some(comment) = &t.comment {
        withs.push(format!("comment = '{}'", comment.replace('\'', "''")));
    }
    if !withs.is_empty() {
        s.push_str(&format!("\nWITH {}", withs.join("\n    AND ")));
    }
    s.push(';');

    for i in &t.indexes {
        s.push_str(&format!(
            "\n\nCREATE INDEX {} ON {}.{} ({});",
            i.name, ks, t.name, i.target
        ));
    }
    for mv in &t.mvs {
        let pk = mv.partition_key.join(", ");
        let clustering = if mv.clustering.is_empty() {
            String::new()
        } else {
            format!(", {}", mv.clustering.join(", "))
        };
        let not_null = mv
            .partition_key
            .iter()
            .chain(mv.clustering.iter())
            .map(|c| format!("{c} IS NOT NULL"))
            .collect::<Vec<_>>()
            .join(" AND ");
        s.push_str(&format!(
            "\n\nCREATE MATERIALIZED VIEW {}.{} AS\n  SELECT * FROM {}.{}\n  WHERE {}\n  PRIMARY KEY (({}){});",
            ks, mv.name, ks, t.name, not_null, pk, clustering
        ));
    }
    s
}

impl CassandraConnection {
    /// The full primary-key column names (partition + clustering), in order.
    fn full_key(table: &TableDescriptor) -> Vec<String> {
        let mut k = table.partition_key.clone();
        k.extend(table.clustering.iter().map(|c| c.name.clone()));
        k
    }
}

#[async_trait]
impl WideColumnWriter for CassandraConnection {
    async fn insert_row(&self, req: CassInsertRow) -> Result<(), AppError> {
        let table = self.table_meta(&req.keyspace, &req.table).await?;
        // Every primary-key column must be present (Cassandra requires it).
        for k in Self::full_key(&table) {
            if !req.row.contains_key(&k) {
                return Err(AppError::Invalid(format!(
                    "INSERT is missing primary-key column '{k}'"
                )));
            }
        }
        let mut cols = Vec::new();
        let mut placeholders = Vec::new();
        let mut values = Vec::new();
        for col in &table.columns {
            if let Some(v) = req.row.get(&col.name) {
                cols.push(quote_ident(&col.name));
                placeholders.push("?");
                values.push(json_to_cql(v, &col.data_type)?);
            }
        }
        let cql = format!(
            "INSERT INTO {}.{} ({}) VALUES ({})",
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            cols.join(", "),
            placeholders.join(", ")
        );
        self.session
            .query_unpaged(cql, values)
            .await
            .map_err(|e| db_err("Insert failed", e))?;
        Ok(())
    }

    async fn update_row(&self, req: CassUpdateRow) -> Result<(), AppError> {
        let table = self.table_meta(&req.keyspace, &req.table).await?;
        let key_cols = Self::full_key(&table);
        // Require the FULL primary key — no partial-key UPDATE.
        for k in &key_cols {
            if !req.key.contains_key(k) {
                return Err(AppError::Invalid(format!(
                    "UPDATE requires the full primary key (missing '{k}')"
                )));
            }
        }
        if req.set.is_empty() {
            return Err(AppError::Invalid("UPDATE has no columns to set".into()));
        }
        let col_type = |name: &str| {
            table
                .columns
                .iter()
                .find(|c| c.name == name)
                .map(|c| c.data_type.clone())
        };

        let mut set_parts = Vec::new();
        let mut values = Vec::new();
        for (name, val) in &req.set {
            if key_cols.contains(name) {
                return Err(AppError::Invalid(format!(
                    "Cannot UPDATE primary-key column '{name}' (delete + re-insert to change a key)"
                )));
            }
            let ty = col_type(name)
                .ok_or_else(|| AppError::Invalid(format!("Unknown column '{name}'")))?;
            set_parts.push(format!("{} = ?", quote_ident(name)));
            values.push(json_to_cql(val, &ty)?);
        }
        let mut where_parts = Vec::new();
        for k in &key_cols {
            let ty = col_type(k).unwrap_or_else(|| "text".into());
            where_parts.push(format!("{} = ?", quote_ident(k)));
            values.push(json_to_cql(&req.key[k], &ty)?);
        }
        let cql = format!(
            "UPDATE {}.{} SET {} WHERE {}",
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            set_parts.join(", "),
            where_parts.join(" AND ")
        );
        self.session
            .query_unpaged(cql, values)
            .await
            .map_err(|e| db_err("Update failed", e))?;
        Ok(())
    }

    async fn delete_row(&self, req: CassDeleteRow) -> Result<(), AppError> {
        let table = self.table_meta(&req.keyspace, &req.table).await?;
        let key_cols = Self::full_key(&table);
        for k in &key_cols {
            if !req.key.contains_key(k) {
                return Err(AppError::Invalid(format!(
                    "DELETE requires the full primary key (missing '{k}')"
                )));
            }
        }
        let col_type = |name: &str| {
            table
                .columns
                .iter()
                .find(|c| c.name == name)
                .map(|c| c.data_type.clone())
        };
        let mut where_parts = Vec::new();
        let mut values = Vec::new();
        for k in &key_cols {
            let ty = col_type(k).unwrap_or_else(|| "text".into());
            where_parts.push(format!("{} = ?", quote_ident(k)));
            values.push(json_to_cql(&req.key[k], &ty)?);
        }
        let cql = format!(
            "DELETE FROM {}.{} WHERE {}",
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            where_parts.join(" AND ")
        );
        self.session
            .query_unpaged(cql, values)
            .await
            .map_err(|e| db_err("Delete failed", e))?;
        Ok(())
    }

    async fn delete_rows(&self, req: CassDeleteRows) -> Result<u64, AppError> {
        let mut deleted = 0u64;
        for key in req.keys {
            self.delete_row(CassDeleteRow {
                keyspace: req.keyspace.clone(),
                table: req.table.clone(),
                key,
            })
            .await?;
            deleted += 1;
        }
        Ok(deleted)
    }

    async fn create_index(&self, req: CassCreateIndex) -> Result<(), AppError> {
        let cql = format!(
            "CREATE INDEX {} ON {}.{} ({})",
            quote_ident(&req.name),
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            quote_ident(&req.target)
        );
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Create index failed", e))?;
        Ok(())
    }

    async fn drop_index(&self, keyspace: &str, name: &str) -> Result<(), AppError> {
        let cql = format!("DROP INDEX {}.{}", quote_ident(keyspace), quote_ident(name));
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Drop index failed", e))?;
        Ok(())
    }

    async fn create_mv(&self, req: CassCreateMv) -> Result<(), AppError> {
        if req.partition_key.is_empty() {
            return Err(AppError::Invalid(
                "A materialized view needs at least one partition-key column".into(),
            ));
        }
        let pk = req
            .partition_key
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let clustering = if req.clustering.is_empty() {
            String::new()
        } else {
            format!(
                ", {}",
                req.clustering
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let not_null = req
            .partition_key
            .iter()
            .chain(req.clustering.iter())
            .map(|c| format!("{} IS NOT NULL", quote_ident(c)))
            .collect::<Vec<_>>()
            .join(" AND ");
        let cql = format!(
            "CREATE MATERIALIZED VIEW {}.{} AS SELECT * FROM {}.{} WHERE {} PRIMARY KEY (({}){})",
            quote_ident(&req.keyspace),
            quote_ident(&req.name),
            quote_ident(&req.keyspace),
            quote_ident(&req.table),
            not_null,
            pk,
            clustering
        );
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Create materialized view failed", e))?;
        Ok(())
    }

    async fn drop_mv(&self, keyspace: &str, name: &str) -> Result<(), AppError> {
        let cql = format!(
            "DROP MATERIALIZED VIEW {}.{}",
            quote_ident(keyspace),
            quote_ident(name)
        );
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Drop materialized view failed", e))?;
        Ok(())
    }

    async fn create_keyspace(&self, req: CassCreateKeyspace) -> Result<(), AppError> {
        // Build the replication map literal: every value rendered as a CQL string.
        let mut entries: Vec<String> = Vec::new();
        if let Some(class) = req.replication.get("class") {
            entries.push(format!("'class': '{}'", json_scalar_str(class)));
        }
        for (k, v) in &req.replication {
            if k == "class" {
                continue;
            }
            entries.push(format!("'{}': '{}'", k, json_scalar_str(v)));
        }
        let cql = format!(
            "CREATE KEYSPACE {} WITH replication = {{{}}} AND durable_writes = {}",
            quote_ident(&req.name),
            entries.join(", "),
            req.durable_writes
        );
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Create keyspace failed", e))?;
        Ok(())
    }

    async fn create_table(&self, req: CassCreateTable) -> Result<(), AppError> {
        if req.partition_key.is_empty() {
            return Err(AppError::Invalid(
                "A table needs at least one partition-key column".into(),
            ));
        }
        let mut lines: Vec<String> = req
            .columns
            .iter()
            .map(|c| {
                let stat = if c.kind == ColumnKind::Static {
                    " static"
                } else {
                    ""
                };
                format!("  {} {}{}", quote_ident(&c.name), c.data_type, stat)
            })
            .collect();
        let clustering_names: Vec<String> = req.clustering.iter().map(|c| c.name.clone()).collect();
        lines.push(format!(
            "  PRIMARY KEY {}",
            primary_key_string(&req.partition_key, &clustering_names)
        ));
        let mut cql = format!(
            "CREATE TABLE {}.{} (\n{}\n)",
            quote_ident(&req.keyspace),
            quote_ident(&req.name),
            lines.join(",\n")
        );
        let mut withs: Vec<String> = Vec::new();
        if !req.clustering.is_empty() {
            let order = req
                .clustering
                .iter()
                .map(|c| format!("{} {}", quote_ident(&c.name), c.order))
                .collect::<Vec<_>>()
                .join(", ");
            withs.push(format!("CLUSTERING ORDER BY ({order})"));
        }
        if let Some(comment) = &req.comment {
            if !comment.is_empty() {
                withs.push(format!("comment = '{}'", comment.replace('\'', "''")));
            }
        }
        if !withs.is_empty() {
            cql.push_str(&format!(" WITH {}", withs.join(" AND ")));
        }
        self.session
            .query_unpaged(cql, &[])
            .await
            .map_err(|e| db_err("Create table failed", e))?;
        Ok(())
    }
}

/// Render a JSON scalar as a bare string for a CQL map literal value.
fn json_scalar_str(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[async_trait]
impl WideColumnConnection for CassandraConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn close(&self) -> Result<(), AppError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contact_nodes_appends_default_port_when_absent() {
        assert_eq!(contact_nodes("127.0.0.1", 9042), vec!["127.0.0.1:9042"]);
    }

    #[test]
    fn contact_nodes_keeps_explicit_port_and_splits_a_list() {
        assert_eq!(
            contact_nodes("10.0.0.1:9043, 10.0.0.2 , ", 9042),
            vec!["10.0.0.1:9043", "10.0.0.2:9042"]
        );
    }

    #[test]
    fn contact_nodes_drops_blank_input() {
        assert!(contact_nodes("  ,  ", 9042).is_empty());
    }

    #[test]
    fn engine_info_labels_version_or_falls_back() {
        assert_eq!(
            engine_info(Some("4.1.3".into())).server_version,
            "Cassandra 4.1.3"
        );
        assert_eq!(engine_info(None).server_version, "Cassandra");
    }

    #[test]
    fn short_class_strips_package_prefix() {
        assert_eq!(
            short_class("org.apache.cassandra.locator.NetworkTopologyStrategy"),
            "NetworkTopologyStrategy"
        );
        assert_eq!(short_class("SimpleStrategy"), "SimpleStrategy");
    }

    #[test]
    fn replication_json_short_names_the_class() {
        let mut m = HashMap::new();
        m.insert(
            "class".to_string(),
            "org.apache.cassandra.locator.NetworkTopologyStrategy".to_string(),
        );
        m.insert("dc1".to_string(), "3".to_string());
        let v = replication_json(m);
        assert_eq!(v["class"], serde_json::json!("NetworkTopologyStrategy"));
        assert_eq!(v["dc1"], serde_json::json!("3"));
    }

    #[test]
    fn primary_key_string_composes_partition_and_clustering() {
        assert_eq!(
            primary_key_string(&["user_id".into()], &["order_id".into()]),
            "((user_id), order_id)"
        );
        assert_eq!(
            primary_key_string(&["a".into(), "b".into()], &[]),
            "((a, b))"
        );
    }

    fn raw(name: &str, kind: &str, position: i32, ty: &str, order: &str) -> RawCol {
        RawCol {
            name: name.into(),
            kind: kind.into(),
            position,
            data_type: ty.into(),
            clustering_order: order.into(),
        }
    }

    #[test]
    fn build_ddl_renders_create_table_with_clustering_order() {
        let cols = vec![
            raw("user_id", "partition_key", 0, "uuid", "none"),
            raw("order_id", "clustering", 0, "timeuuid", "desc"),
            raw("total", "regular", -1, "decimal", "none"),
        ];
        let by: HashMap<String, Vec<RawCol>> = HashMap::new();
        let d = build_descriptor(
            "orders_by_user",
            &cols,
            vec![],
            &[],
            &by,
            Some("a user's orders".into()),
        );
        let ddl = build_ddl("byteshop", &d);
        assert!(ddl.contains("CREATE TABLE byteshop.orders_by_user"));
        assert!(ddl.contains("PRIMARY KEY ((user_id), order_id)"));
        assert!(ddl.contains("CLUSTERING ORDER BY (order_id DESC)"));
        assert!(
            ddl.contains("comment = 'a user's orders'")
                || ddl.contains("comment = 'a user''s orders'")
        );
    }

    #[test]
    fn build_descriptor_orders_keys_and_assembles_pk() {
        let cols = vec![
            raw("name", "regular", -1, "text", "none"),
            raw("order_id", "clustering", 0, "timeuuid", "desc"),
            raw("user_id", "partition_key", 0, "uuid", "none"),
        ];
        let by: HashMap<String, Vec<RawCol>> = HashMap::new();
        let d = build_descriptor(
            "orders_by_user",
            &cols,
            vec![],
            &[],
            &by,
            Some(String::new()),
        );
        assert_eq!(d.partition_key, vec!["user_id".to_string()]);
        assert_eq!(d.clustering.len(), 1);
        assert_eq!(d.clustering[0].order, "DESC");
        assert_eq!(d.primary_key, "((user_id), order_id)");
        // Columns ordered partition → clustering → rest.
        let names: Vec<&str> = d.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["user_id", "order_id", "name"]);
        assert_eq!(d.columns[0].kind, ColumnKind::PartitionKey);
        assert_eq!(d.comment, None); // empty comment filtered to None
    }
}
