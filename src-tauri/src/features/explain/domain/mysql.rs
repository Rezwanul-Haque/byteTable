//! MySQL `EXPLAIN FORMAT=JSON`.
//!
//! Not a tree of uniform nodes but a `query_block` of nested *operations*:
//! `ordering_operation` wraps `grouping_operation` wraps `duplicates_removal`
//! wraps either a `nested_loop` array of tables or a single `table`. A derived
//! table hangs off the table that reads it, as `materialized_from_subquery`.
//!
//! Unlike Postgres, MySQL's per-table `read_cost` + `eval_cost` are already
//! per-node, so no self-vs-inclusive correction is needed here.

use serde_json::Value;

use super::{joined_text, Listing, NodeKind, PlanNode, ServerPlan, Share};
use crate::shared::engine::Engine;

pub(super) fn parse(rows: &[Vec<Value>]) -> Option<ServerPlan> {
    let doc: Value = serde_json::from_str(&joined_text(rows)).ok()?;
    let block = doc.get("query_block")?;
    let mut nodes = Vec::new();
    walk_block(block, 0, false, &mut nodes);
    (!nodes.is_empty()).then_some(ServerPlan {
        nodes,
        source: Engine::Mysql,
        total_ms: None,
        share: Some(Share::Cost),
        listing: Listing::OutermostFirst,
    })
}

fn walk_block(block: &Value, depth: usize, subplan: bool, nodes: &mut Vec<PlanNode>) {
    let mut d = depth;
    let mut inner = block;

    if let Some(order) = block.get("ordering_operation") {
        let filesort = order
            .get("using_filesort")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        push_op(
            nodes,
            if filesort { "Sort (filesort)" } else { "Sort" },
            NodeKind::Sort,
            "ORDER BY",
            cost(order),
            d,
            subplan,
        );
        d += 1;
        inner = order;
    }
    if let Some(group) = inner.get("grouping_operation") {
        let temporary = group
            .get("using_temporary_table")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        push_op(
            nodes,
            if temporary {
                "Aggregate using temporary table"
            } else {
                "Aggregate"
            },
            NodeKind::Agg,
            "GROUP BY",
            cost(group),
            d,
            subplan,
        );
        d += 1;
        inner = group;
    }
    if let Some(dedupe) = inner.get("duplicates_removal") {
        push_op(
            nodes,
            "Duplicate removal",
            NodeKind::Unique,
            "DISTINCT",
            cost(dedupe),
            d,
            subplan,
        );
        d += 1;
        inner = dedupe;
    }

    if let Some(loop_) = inner.get("nested_loop").and_then(Value::as_array) {
        if loop_.len() > 1 {
            push_op(
                nodes,
                "Nested Loop",
                NodeKind::Join,
                &format!("joins {} tables, left to right", loop_.len()),
                None,
                d,
                subplan,
            );
            d += 1;
        }
        for entry in loop_ {
            if let Some(table) = entry.get("table") {
                push_table(table, d, subplan, nodes);
            }
        }
        return;
    }
    if let Some(table) = inner.get("table") {
        push_table(table, d, subplan, nodes);
    }
}

fn push_op(
    nodes: &mut Vec<PlanNode>,
    name: &str,
    kind: NodeKind,
    detail: &str,
    cost: Option<f64>,
    depth: usize,
    subplan: bool,
) {
    let mut node = PlanNode::new(name, kind, depth, subplan);
    node.detail = detail.to_string();
    node.cost = cost;
    nodes.push(node);
}

fn push_table(t: &Value, depth: usize, subplan: bool, nodes: &mut Vec<PlanNode>) {
    let scanned = t.get("rows_examined_per_scan").and_then(Value::as_i64);
    // `filtered` is the percentage of scanned rows expected to survive the
    // condition — the only handle MySQL gives on how much one discards.
    let filtered = t.get("filtered").and_then(|v| {
        v.as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| v.as_f64())
    });
    let rows = t
        .get("rows_produced_per_join")
        .and_then(Value::as_i64)
        .or_else(|| match (scanned, filtered) {
            (Some(s), Some(f)) => Some(((s as f64) * f / 100.0).round() as i64),
            _ => scanned,
        });

    let table_name = t.get("table_name").and_then(Value::as_str);
    let key = t.get("key").and_then(Value::as_str);
    let mut node = PlanNode::new(
        access_name(t, key, table_name),
        NodeKind::Scan,
        depth,
        subplan,
    );
    node.rows = rows;
    node.scanned = scanned;
    node.removed = match (scanned, rows) {
        (Some(s), Some(r)) if s > r => Some(s - r),
        _ => None,
    };
    node.detail = table_detail(t);
    node.cost = cost(t);
    node.rel = table_name.map(str::to_owned);
    node.alias = table_name.map(str::to_owned);
    node.index = key.map(str::to_owned);
    nodes.push(node);

    if let Some(sub) = t
        .get("materialized_from_subquery")
        .and_then(|m| m.get("query_block"))
    {
        let mut marker = PlanNode::new("Materialize", NodeKind::Other, depth + 1, true);
        marker.detail = "derived table — the plan below produces its rows".into();
        nodes.push(marker);
        walk_block(sub, depth + 2, true, nodes);
    }
}

/// MySQL's access types, named the way the rest of the tree reads.
fn access_name(t: &Value, key: Option<&str>, table_name: Option<&str>) -> String {
    let access = t
        .get("access_type")
        .and_then(Value::as_str)
        .unwrap_or("ALL");
    let mut name = match access {
        "ALL" => "Seq Scan".to_string(),
        "index" => "Index Scan".to_string(),
        "range" => "Index Range Scan".to_string(),
        "eq_ref" | "const" => "Unique Index Lookup".to_string(),
        "ref" => "Index Lookup".to_string(),
        other => other.to_ascii_uppercase(),
    };
    if let Some(key) = key {
        name.push_str(&format!(" using {key}"));
    }
    if let Some(table) = table_name {
        name.push_str(&format!(" on {table}"));
    }
    name
}

fn table_detail(t: &Value) -> String {
    if let Some(cond) = t.get("attached_condition").and_then(Value::as_str) {
        return format!("Filter: {cond}");
    }
    if let Some(refs) = t.get("ref").and_then(Value::as_array) {
        let joined = refs
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        if !joined.is_empty() {
            return format!("Ref: {joined}");
        }
    }
    if t.get("using_index").and_then(Value::as_bool) == Some(true) {
        return "covering index — no table lookup".into();
    }
    String::new()
}

/// Per-node cost. `prefix_cost` is cumulative down the join order, so the parts
/// are what we want; rounded because summing MySQL's decimal strings as floats
/// otherwise yields costs like `1.8399999999999999`.
fn cost(v: &Value) -> Option<f64> {
    let info = v.get("cost_info")?;
    let part = |key: &str| {
        info.get(key).and_then(|x| {
            x.as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| x.as_f64())
        })
    };
    let total = match (part("read_cost"), part("eval_cost")) {
        (None, None) => part("sort_cost").or_else(|| part("query_cost"))?,
        (read, evaluate) => read.unwrap_or(0.0) + evaluate.unwrap_or(0.0),
    };
    Some((total * 100.0).round() / 100.0)
}
