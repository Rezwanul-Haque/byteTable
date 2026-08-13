//! SQLite `EXPLAIN QUERY PLAN`.
//!
//! Flat `(id, parent, notused, detail)` rows reassembled into a tree by their
//! parent links. SQLite reports prose, not fields — `SCAN o`, `SEARCH u USING
//! INTEGER PRIMARY KEY (rowid=?)`, `USE TEMP B-TREE FOR GROUP BY` — so the
//! detail line is kept verbatim (it *is* the plan) and only the name, kind and
//! index are lifted out of it.
//!
//! There are no rows, costs or timings anywhere in this output, which is why a
//! SQLite plan shows "—" in the numeric columns rather than a figure that came
//! from somewhere else.

use serde_json::Value;

use super::{kind_of, Listing, NodeKind, PlanNode, ServerPlan};
use crate::shared::engine::Engine;

struct Row {
    id: i64,
    parent: i64,
    detail: String,
}

pub(super) fn parse(columns: &[String], rows: &[Vec<Value>]) -> Option<ServerPlan> {
    let at = |name: &str| columns.iter().position(|c| c.eq_ignore_ascii_case(name));
    let (id_at, parent_at, detail_at) = (at("id")?, at("parent")?, at("detail")?);

    let parsed: Vec<Row> = rows
        .iter()
        .map(|r| Row {
            id: r.get(id_at).and_then(Value::as_i64).unwrap_or(0),
            parent: r.get(parent_at).and_then(Value::as_i64).unwrap_or(0),
            detail: r
                .get(detail_at)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .collect();
    if parsed.is_empty() {
        return None;
    }

    let mut nodes = Vec::new();
    // `parent: 0` marks a top-level step; SQLite never issues 0 as an id.
    for row in parsed.iter().filter(|r| r.parent == 0) {
        emit(row, 0, &parsed, &mut nodes);
    }

    (!nodes.is_empty()).then_some(ServerPlan {
        nodes,
        source: Engine::Sqlite,
        total_ms: None,
        share: None,
        listing: Listing::Execution,
    })
}

fn emit(row: &Row, depth: usize, all: &[Row], nodes: &mut Vec<PlanNode>) {
    let detail = row.detail.as_str();
    let scan = scan_target(detail);
    let index = index_name(detail);
    let primary_key = detail.contains("USING INTEGER PRIMARY KEY");

    let (name, kind) = match &scan {
        Some((verb, table)) => {
            let access = if verb == "SEARCH" {
                "Index Lookup"
            } else {
                "Seq Scan"
            };
            let using = match (&index, primary_key) {
                (Some(i), _) => format!(" using {i}"),
                (None, true) => " using PRIMARY KEY".to_string(),
                _ => String::new(),
            };
            (format!("{access}{using} on {table}"), NodeKind::Scan)
        }
        None if detail.contains("CO-ROUTINE") || detail.contains("MATERIALIZE") => {
            (detail.to_string(), NodeKind::Other)
        }
        None => (detail.to_string(), kind_of(detail)),
    };

    let mut node = PlanNode::new(name, kind, depth, depth > 0);
    // Only worth repeating underneath when the name is a rewrite of it.
    node.detail = if scan.is_some() {
        detail.to_string()
    } else {
        String::new()
    };
    node.rel = scan.as_ref().map(|(_, t)| t.clone());
    node.alias = scan.as_ref().map(|(_, t)| t.clone());
    node.index = index.or_else(|| primary_key.then(|| "PRIMARY KEY".to_string()));
    nodes.push(node);

    for child in all.iter().filter(|r| r.parent == row.id && r.id != row.id) {
        emit(child, depth + 1, all, nodes);
    }
}

/// `SCAN orders` / `SEARCH u USING …` → the verb and the relation it names.
fn scan_target(detail: &str) -> Option<(String, String)> {
    let mut words = detail.split_whitespace();
    let verb = words.next()?;
    if verb != "SCAN" && verb != "SEARCH" {
        return None;
    }
    let table = words.next()?;
    Some((verb.to_string(), table.to_string()))
}

/// `USING INDEX ix` / `USING COVERING INDEX ix` → the index name.
fn index_name(detail: &str) -> Option<String> {
    let rest = detail.split("USING ").nth(1)?;
    let rest = rest.strip_prefix("COVERING ").unwrap_or(rest);
    let rest = rest.strip_prefix("INDEX ")?;
    let name = rest.split_whitespace().next()?;
    (!name.is_empty()).then(|| name.to_string())
}
