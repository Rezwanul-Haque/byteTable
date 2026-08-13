//! Postgres `EXPLAIN (FORMAT JSON)`.
//!
//! By far the richest of the three: a recursive `Plan` tree carrying node type,
//! relation, alias, chosen index, conditions, estimated rows and cost — and,
//! when the plan came from an ANALYZE run, actual rows, actual time, rows
//! removed by each filter and the sort method.

use serde_json::Value;

use super::{joined_text, kind_of, Listing, NodeKind, PlanNode, ServerPlan, Share};
use crate::shared::engine::Engine;

/// Inclusive figures plus child indices, kept alongside the flattened nodes so
/// each node's own share can be worked out once the whole tree is known.
struct Inclusive {
    ms: Option<f64>,
    cost: Option<f64>,
    children: Vec<usize>,
}

pub(super) fn parse(rows: &[Vec<Value>]) -> Option<ServerPlan> {
    let doc: Value = serde_json::from_str(&joined_text(rows)).ok()?;
    let first = doc.get(0)?;
    let root = first.get("Plan")?;

    let analyzed = root.get("Actual Total Time").is_some();
    let mut nodes = Vec::new();
    let mut tree: Vec<Inclusive> = Vec::new();
    walk(root, 0, false, &mut nodes, &mut tree);

    // Self = inclusive minus the direct children's inclusive figures.
    for (i, node) in nodes.iter_mut().enumerate() {
        let entry = &tree[i];
        let inclusive = if analyzed { entry.ms } else { entry.cost };
        let Some(inclusive) = inclusive else { continue };
        let child_sum: f64 = entry
            .children
            .iter()
            .filter_map(|c| if analyzed { tree[*c].ms } else { tree[*c].cost })
            .sum();
        node.self_work = Some((inclusive - child_sum).max(0.0));
    }

    Some(ServerPlan {
        nodes,
        source: Engine::Postgres,
        total_ms: first.get("Execution Time").and_then(Value::as_f64),
        share: Some(if analyzed { Share::Time } else { Share::Cost }),
        listing: Listing::OutermostFirst,
    })
}

fn walk(
    n: &Value,
    depth: usize,
    subplan: bool,
    nodes: &mut Vec<PlanNode>,
    tree: &mut Vec<Inclusive>,
) -> usize {
    let node_type = n
        .get("Node Type")
        .and_then(Value::as_str)
        .unwrap_or("Unknown");
    let kind = kind_of(node_type);
    let rows = n
        .get("Actual Rows")
        .or_else(|| n.get("Plan Rows"))
        .and_then(Value::as_i64);
    let removed = n.get("Rows Removed by Filter").and_then(Value::as_i64);
    // Rows read = what survived plus what the filter threw away. Only knowable
    // from an ANALYZE run, and meaningless off a scan.
    let scanned = match (kind, rows, removed) {
        (NodeKind::Scan, Some(r), Some(d)) => Some(r + d),
        (NodeKind::Scan, r, None) => r,
        _ => None,
    };
    // `Actual Total Time` is per loop; the node's real cost is that times the
    // number of loops the executor ran it for.
    let ms = n
        .get("Actual Total Time")
        .and_then(Value::as_f64)
        .map(|per_loop| per_loop * n.get("Actual Loops").and_then(Value::as_f64).unwrap_or(1.0));
    let cost = n.get("Total Cost").and_then(Value::as_f64);

    let index = nodes.len();
    let mut node = PlanNode::new(name(n, node_type), kind, depth, subplan);
    node.rows = rows;
    node.detail = detail(n);
    node.ms = ms;
    node.cost = cost;
    node.scanned = scanned;
    node.removed = removed;
    node.method = str_of(n, "Sort Method");
    node.rel = str_of(n, "Relation Name");
    node.alias = str_of(n, "Alias");
    node.index = str_of(n, "Index Name");
    nodes.push(node);
    tree.push(Inclusive {
        ms,
        cost,
        children: Vec::new(),
    });

    let mut children = Vec::new();
    if let Some(plans) = n.get("Plans").and_then(Value::as_array) {
        for child in plans {
            // A SubPlan / InitPlan is a separate query, not part of this branch.
            let nested = subplan || child.get("Subplan Name").is_some();
            children.push(walk(child, depth + 1, nested, nodes, tree));
        }
    }
    tree[index].children = children;
    index
}

fn str_of(n: &Value, key: &str) -> Option<String> {
    n.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// psql's display name, which the JSON splits back apart into fields.
fn name(n: &Value, node_type: &str) -> String {
    let mut name = node_type.to_string();
    if node_type == "Aggregate" {
        match n.get("Strategy").and_then(Value::as_str) {
            Some("Hashed") => name = "HashAggregate".into(),
            Some(other) if other != "Plain" => name = format!("{other} Aggregate"),
            _ => {}
        }
    }
    if let Some(join) = n.get("Join Type").and_then(Value::as_str) {
        let joinish = node_type.to_ascii_lowercase();
        if join != "Inner" && (joinish.contains("join") || joinish.contains("nested loop")) {
            name.push_str(&format!(" {join} Join"));
        }
    }
    if let Some(index) = n.get("Index Name").and_then(Value::as_str) {
        name.push_str(&format!(" using {index}"));
    }
    if let Some(rel) = n.get("Relation Name").and_then(Value::as_str) {
        name.push_str(&format!(" on {rel}"));
        if let Some(alias) = n.get("Alias").and_then(Value::as_str) {
            if alias != rel {
                name.push_str(&format!(" {alias}"));
            }
        }
    }
    name
}

/// Whichever condition psql would print under the node.
fn detail(n: &Value) -> String {
    for (key, label) in [
        ("Filter", "Filter"),
        ("Index Cond", "Index Cond"),
        ("Recheck Cond", "Recheck Cond"),
        ("Hash Cond", "Hash Cond"),
        ("Join Filter", "Join Filter"),
    ] {
        if let Some(v) = n.get(key).and_then(Value::as_str) {
            return format!("{label}: {v}");
        }
    }
    for (key, label) in [("Group Key", "Group Key"), ("Sort Key", "Sort Key")] {
        if let Some(list) = n.get(key).and_then(Value::as_array) {
            let joined = list
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            if !joined.is_empty() {
                return format!("{label}: {joined}");
            }
        }
    }
    String::new()
}
