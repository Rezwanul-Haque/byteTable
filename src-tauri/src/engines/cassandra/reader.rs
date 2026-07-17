//! Cassandra read path: keyspace/table introspection, row paging and CQL
//! queries (`WideColumnReader`). Mirrors the `ports::widecolumn` read surface.

use std::collections::HashMap;
use std::time::Instant;

use async_trait::async_trait;
use scylla::response::PagingState;
use scylla::statement::Statement;
use scylla::value::{CqlValue, Row};

use crate::shared::error::AppError;
use crate::shared::widecolumn::*;

use super::error::db_err;
use super::value::{cql_to_json, cql_value_type_label, decode_hex, hex_encode, json_to_cql};
use super::{
    build_ddl, consistency_from, quote_ident, replication_json, short_class, CassandraConnection,
};

/// Hard ceiling on rows a single browse query loads, so a huge partition/table
/// can never exhaust memory — "All" in the pager maps to this bound.
const ROW_CAP: u32 = 5000;

/// The legal query-builder operators.
const LEGAL_OPS: [&str; 7] = ["=", "<", "<=", ">", ">=", "IN", "CONTAINS"];

/// The built-in keyspaces hidden from the user-facing keyspace list.
const SYSTEM_KEYSPACES: [&str; 6] = [
    "system",
    "system_schema",
    "system_auth",
    "system_distributed",
    "system_traces",
    "system_views",
];

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
