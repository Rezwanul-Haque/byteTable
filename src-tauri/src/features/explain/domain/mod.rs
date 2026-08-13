//! Plan value objects, the per-engine EXPLAIN statement builder, and the
//! parsers that turn each engine's answer into one node model. Pure: no IO, no
//! Tauri, no driver types.

use serde::{Deserialize, Serialize};

use crate::shared::engine::Engine;

pub use statement::{count_probes, CountProbes};

mod mysql;
mod postgres;
mod sqlite;
mod statement;

#[cfg(test)]
mod tests;

/// The operator kinds a plan node can have. Drives the icon and colour in the
/// renderer; `Other` is the catch-all so an operator we have never seen still
/// renders instead of breaking the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Scan,
    Join,
    Agg,
    Sort,
    Unique,
    Limit,
    Other,
}

/// What a node's headline figure and its share bar represent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Share {
    /// Measured milliseconds, from a plan produced by an ANALYZE run.
    Time,
    /// The planner's cost estimate — no execution happened.
    Cost,
}

/// The order the engine listed its nodes in, which decides how the "#" column
/// numbers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Listing {
    /// Postgres and MySQL print the outermost operator first.
    OutermostFirst,
    /// SQLite's `EXPLAIN QUERY PLAN` lists steps in the order they run.
    Execution,
}

/// One node of a plan. Mirrors the renderer's `PlanNode`; every figure is
/// optional because the three engines report wildly different amounts (SQLite
/// reports no numbers at all).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    /// Display name, psql style (`Index Scan using idx_x on orders o`).
    pub node: String,
    pub kind: NodeKind,
    /// Rows leaving this node — actual if the plan was analyzed, else the
    /// planner's estimate.
    pub rows: Option<i64>,
    /// The one line under the name (`Filter: …`, `Group Key: …`).
    pub detail: String,
    /// Milliseconds, inclusive of children, when the engine measured them.
    pub ms: Option<f64>,
    /// Nesting level. Siblings — the two inputs of a join — share a depth.
    pub depth: usize,
    /// Rows read before this node's filter (scans only).
    pub scanned: Option<i64>,
    /// Rows the filter discarded (scans only).
    pub removed: Option<i64>,
    /// `quicksort` / `external merge` (sorts only).
    pub method: Option<String>,
    /// Relation and alias behind a scan node.
    pub rel: Option<String>,
    pub alias: Option<String>,
    /// The index the optimizer chose, when it reported one.
    pub index: Option<String>,
    /// The planner's cost for this node, inclusive of children.
    pub cost: Option<f64>,
    /// True for nodes belonging to a derived table's own plan.
    pub subplan: bool,
    /// This node's own share of the work, excluding its children.
    ///
    /// Postgres reports time and cost inclusive of the subtree, so ranking by
    /// `ms` / `cost` would crown the root every time. Those stay inclusive to
    /// match what psql prints; this is what the share bar ranks by. `None`
    /// where the reported figure is already per-node.
    pub self_work: Option<f64>,
}

impl PlanNode {
    /// A node with only the fields every engine supplies; parsers fill the rest.
    fn new(node: impl Into<String>, kind: NodeKind, depth: usize, subplan: bool) -> Self {
        Self {
            node: node.into(),
            kind,
            rows: None,
            detail: String::new(),
            ms: None,
            depth,
            scanned: None,
            removed: None,
            method: None,
            rel: None,
            alias: None,
            index: None,
            cost: None,
            subplan,
            self_work: None,
        }
    }
}

/// A plan tree as one engine reported it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPlan {
    pub nodes: Vec<PlanNode>,
    /// Which engine produced it, so the renderer can say so.
    pub source: Engine,
    /// Execution time the server reported, when the plan came from an ANALYZE.
    pub total_ms: Option<f64>,
    pub share: Option<Share>,
    pub listing: Listing,
}

/// What forms of EXPLAIN an engine can produce as an ordinary statement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainCapabilities {
    /// `EXPLAIN` — plans only, executes nothing.
    pub plan: bool,
    /// `EXPLAIN ANALYZE` — executes the statement and reports actuals.
    pub analyze: bool,
    /// Whether a machine-readable plan is available for the plan tree.
    pub structured: bool,
    /// Why a form is missing, phrased for the panel to show as-is.
    pub note: Option<String>,
}

/// What running the statement actually measured. Every count is optional: a
/// probe a dialect rejects leaves its column empty rather than sinking the run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    /// Wall-clock milliseconds for the statement.
    pub ms: u64,
    /// Rows it returned.
    pub rows: i64,
    /// True when the row cap cut the result — `rows` is then a lower bound.
    pub truncated: bool,
    /// Rows the base relation holds, counted.
    pub scanned: Option<i64>,
    /// Rows of the base relation surviving WHERE, counted.
    pub kept: Option<i64>,
}

/// A raw plan, exactly as the engine printed it, for the "Raw output" view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPlan {
    /// The statement that was sent, for the prompt line.
    pub statement: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// True when the plan is a single text column rather than a real table.
    pub text: bool,
}

/// Per-engine capability.
///
/// SQL Server and Oracle are absent on purpose: SQL Server's plan comes from
/// `SET SHOWPLAN_ALL ON` applied to a *later* batch on the same session, and
/// Oracle's needs `EXPLAIN PLAN FOR` followed by a query against `DBMS_XPLAN`.
/// Neither survives a single pooled statement.
pub fn capabilities(engine: Engine) -> ExplainCapabilities {
    match engine {
        Engine::Postgres | Engine::Mysql => ExplainCapabilities {
            plan: true,
            analyze: true,
            structured: true,
            note: None,
        },
        Engine::Sqlite => ExplainCapabilities {
            plan: true,
            analyze: false,
            structured: true,
            note: Some(
                "SQLite has no EXPLAIN ANALYZE — `EXPLAIN QUERY PLAN` reports the access path only."
                    .into(),
            ),
        },
        Engine::Clickhouse => ExplainCapabilities {
            plan: true,
            analyze: false,
            structured: false,
            note: Some(
                "ClickHouse's EXPLAIN describes the query pipeline; it has no ANALYZE form."
                    .into(),
            ),
        },
        Engine::Mssql => ExplainCapabilities {
            plan: false,
            analyze: false,
            structured: false,
            note: Some(
                "SQL Server's showplan needs a session-wide SET applied to a following batch, which a pooled connection cannot guarantee."
                    .into(),
            ),
        },
        _ => ExplainCapabilities {
            plan: false,
            analyze: false,
            structured: false,
            note: Some(
                "This engine has no SQL EXPLAIN that can be run as an ordinary statement.".into(),
            ),
        },
    }
}

/// Strip the trailing semicolon so the statement can be prefixed. Returns
/// `None` for an empty statement, which there is nothing to explain.
fn body(sql: &str) -> Option<&str> {
    let trimmed = sql.trim().trim_end_matches(';').trim_end();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// The human-readable EXPLAIN — what a terminal client prints.
pub fn raw_statement(engine: Engine, sql: &str, analyze: bool) -> Option<String> {
    let body = body(sql)?;
    let caps = capabilities(engine);
    if if analyze { !caps.analyze } else { !caps.plan } {
        return None;
    }
    Some(match engine {
        Engine::Mysql if analyze => format!("EXPLAIN ANALYZE {body}"),
        Engine::Mysql => format!("EXPLAIN {body}"),
        // BUFFERS is free once ANALYZE is on and turns "this is slow" into
        // "this is slow because it read N blocks".
        Engine::Postgres if analyze => format!("EXPLAIN (ANALYZE, BUFFERS) {body}"),
        Engine::Postgres => format!("EXPLAIN {body}"),
        Engine::Sqlite => format!("EXPLAIN QUERY PLAN {body}"),
        Engine::Clickhouse => format!("EXPLAIN {body}"),
        _ => return None,
    })
}

/// The machine-readable EXPLAIN — what [`parse`] can read.
///
/// Separate from [`raw_statement`] because Postgres and MySQL both offer JSON,
/// which is worth far more than scraping their text. Always the plan-only form:
/// drawing a tree must never execute the query.
pub fn structured_statement(engine: Engine, sql: &str) -> Option<String> {
    let body = body(sql)?;
    Some(match engine {
        Engine::Postgres => format!("EXPLAIN (FORMAT JSON) {body}"),
        Engine::Mysql => format!("EXPLAIN FORMAT=JSON {body}"),
        Engine::Sqlite => format!("EXPLAIN QUERY PLAN {body}"),
        _ => return None,
    })
}

/// Parse a structured plan. `None` for an engine with no parser, or a shape we
/// do not recognise — the renderer then keeps its modelled tree, which always
/// draws, rather than showing half of one.
pub fn parse(
    engine: Engine,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> Option<ServerPlan> {
    match engine {
        Engine::Postgres => postgres::parse(rows),
        Engine::Mysql => mysql::parse(rows),
        Engine::Sqlite => sqlite::parse(columns, rows),
        _ => None,
    }
}

/// Classify an engine's node type into one of the panel's kinds. Substring
/// matching on purpose: every engine spells these differently and new node
/// types arrive with every release.
fn kind_of(node_type: &str) -> NodeKind {
    let t = node_type.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| t.contains(n));
    if has(&["limit"]) {
        NodeKind::Limit
    } else if has(&["sort", "filesort", "order by"]) {
        NodeKind::Sort
    } else if has(&["unique", "distinct", "duplicates"]) {
        NodeKind::Unique
    } else if has(&["aggregate", "group"]) {
        NodeKind::Agg
    } else if has(&["join", "nested loop"]) {
        NodeKind::Join
    } else if has(&["scan", "seek", "search", "lookup", "index", "table"]) {
        NodeKind::Scan
    } else {
        NodeKind::Other
    }
}

/// A single text column joined into one block — engines split their text plans
/// differently (psql one row per line, MySQL the whole tree in one cell).
fn joined_text(rows: &[Vec<serde_json::Value>]) -> String {
    rows.iter()
        .map(|r| match r.first() {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}
