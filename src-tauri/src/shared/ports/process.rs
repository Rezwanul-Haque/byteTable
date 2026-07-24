//! Process-list port (M26): the live server session / operation / client list
//! an engine exposes, and the per-row **kill** action.
//!
//! Unlike the five engine *families* (`sql` / `keyvalue` / `mongo` / …) this is a
//! narrow **capability** a connection may or may not expose — a server engine
//! (Postgres/MySQL/SQL Server/ClickHouse process lists, Redis `CLIENT LIST`,
//! MongoDB `db.currentOp()`) implements it; an embedded engine (SQLite) and the
//! serverless stores (DynamoDB/Cassandra) do not. Rather than force it into every
//! family trait, connections opt in via `as_process_reader` on their family trait
//! (default `None`), and the [`crate::features::connections::application::ConnectionManager`]
//! surfaces a single `get_process_reader` accessor across the family arms.
//!
//! The DTO is engine-neutral: `pid` is the primary id shown and killed (MySQL
//! `Id`, Postgres `pid`, SQL Server `spid`, Redis client id, Mongo `opid`);
//! `qid` carries ClickHouse's query id (which is what its `KILL` targets); the
//! renderer builds the human-readable kill-statement *preview* per engine, but
//! the authoritative kill runs here.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::engine::QueryResult;
use crate::shared::error::AppError;

/// One live server session / operation / client, normalized across engines
/// (M26 Task 1). Mirrors `ProcessInfo` in the renderer's
/// `src/features/processes/api.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    /// The primary id shown and killed: MySQL `Id`, Postgres `pid`, SQL Server
    /// `spid`, ClickHouse query id, Redis client id, Mongo `opid`. A string so a
    /// non-numeric id (Mongo shard opids, ClickHouse uuids) survives intact.
    pub pid: String,
    /// Oracle's `serial#` companion to the SID — `None` for every other engine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// ClickHouse's `query_id` — what its `KILL QUERY` targets. `None` elsewhere.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qid: Option<String>,
    /// The connected user (Mongo: the op type; Redis: the client name).
    pub user: String,
    /// The client host/address (Redis: `addr`).
    pub host: String,
    /// The database / namespace (Redis: `db<N>`; Mongo: `ns`).
    pub db: String,
    /// The session state (`active` / `idle` / `waiting…` / `idle in transaction`;
    /// Redis: `active` / `idle` / `blocked (…)` / `pubsub`).
    pub state: String,
    /// Seconds the session/op has been running (or idle).
    pub time_s: i64,
    /// The running statement / command (empty for an idle session — the renderer
    /// shows a dim `—`).
    pub query: String,
    /// True for the connection ByteTable itself is using, so the UI protects it
    /// (a `me` badge + disabled kill button).
    pub is_self: bool,
}

/// What the renderer sends back to kill a process: enough for any engine to
/// build its statement. `pid` is always present; `serial`/`qid` ride along for
/// the engines that need them (Oracle `sid,serial#`, ClickHouse `query_id`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessKill {
    pub pid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qid: Option<String>,
}

/// The process-list capability: list the engine's live sessions and kill one.
/// Adapters map driver errors to §5 human sentences before they cross here.
#[async_trait]
pub trait ProcessReader: Send + Sync {
    /// The live session / operation / client list.
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, AppError>;

    /// Terminate one session/operation/client. Killing an id that has already
    /// gone is not an error (it is simply no longer listed on the next refresh).
    async fn kill_process(&self, target: ProcessKill) -> Result<(), AppError>;
}

// ---------------------------------------------------------------------------
// SQL helper: shared row-mapping for the four relational engines
// ---------------------------------------------------------------------------
//
// Every SQL adapter's `list_processes` SELECTs the SAME ten columns in the SAME
// order, so one mapper serves all of them. The column contract is:
//
//   0 pid  1 serial  2 qid  3 user  4 host  5 db  6 state  7 time_s  8 query  9 is_self
//
// Empty-string serial/qid map to `None`; is_self accepts a JSON bool (Postgres)
// or a 0/1 number (MySQL/SQL Server/ClickHouse).

/// Map a [`QueryResult`] from the fixed ten-column process SELECT to
/// [`ProcessInfo`] rows (M26 SQL adapters share this).
pub fn map_sql_rows(result: QueryResult) -> Vec<ProcessInfo> {
    result
        .rows
        .iter()
        .map(|row| ProcessInfo {
            pid: cell_string(row, 0),
            serial: cell_opt_string(row, 1),
            qid: cell_opt_string(row, 2),
            user: cell_string(row, 3),
            host: cell_string(row, 4),
            db: cell_string(row, 5),
            state: cell_string(row, 6),
            time_s: cell_i64(row, 7),
            query: cell_string(row, 8),
            is_self: cell_bool(row, 9),
        })
        .collect()
}

/// Parse a process id as an integer, rejecting anything else so a kill can never
/// interpolate arbitrary text into a `KILL <id>` statement.
pub fn numeric_id(raw: &str) -> Result<i64, AppError> {
    raw.trim()
        .parse::<i64>()
        .map_err(|_| AppError::Invalid(format!("'{raw}' is not a valid process id.")))
}

fn cell_string(row: &[Value], i: usize) -> String {
    match row.get(i) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn cell_opt_string(row: &[Value], i: usize) -> Option<String> {
    match cell_string(row, i) {
        s if s.is_empty() => None,
        s => Some(s),
    }
}

fn cell_i64(row: &[Value], i: usize) -> i64 {
    match row.get(i) {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn cell_bool(row: &[Value], i: usize) -> bool {
    match row.get(i) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().map(|v| v != 0).unwrap_or(false),
        Some(Value::String(s)) => matches!(s.trim(), "1" | "t" | "true" | "TRUE" | "True"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::engine::ColumnMeta;
    use serde_json::json;

    fn result(rows: Vec<Vec<Value>>) -> QueryResult {
        QueryResult {
            columns: vec![ColumnMeta {
                name: "c".into(),
                type_hint: "t".into(),
            }],
            row_count: rows.len(),
            rows,
            truncated: false,
            elapsed_ms: 0,
        }
    }

    #[test]
    fn maps_the_fixed_ten_column_layout() {
        let procs = map_sql_rows(result(vec![vec![
            json!("42"),
            json!(""),
            json!(""),
            json!("app_rw"),
            json!("10.0.4.18"),
            json!("shop"),
            json!("active"),
            json!(31),
            json!("SELECT 1"),
            json!(true),
        ]]));
        assert_eq!(procs.len(), 1);
        let p = &procs[0];
        assert_eq!(p.pid, "42");
        assert_eq!(p.serial, None);
        assert_eq!(p.qid, None);
        assert_eq!(p.user, "app_rw");
        assert_eq!(p.time_s, 31);
        assert!(p.is_self);
    }

    #[test]
    fn is_self_accepts_bool_and_numeric_flags() {
        let procs = map_sql_rows(result(vec![
            vec![
                json!("1"),
                json!(""),
                json!(""),
                json!(""),
                json!(""),
                json!(""),
                json!("idle"),
                json!(0),
                json!(""),
                json!(1),
            ],
            vec![
                json!("2"),
                json!(""),
                json!(""),
                json!(""),
                json!(""),
                json!(""),
                json!("idle"),
                json!(0),
                json!(""),
                json!(0),
            ],
        ]));
        assert!(procs[0].is_self);
        assert!(!procs[1].is_self);
    }

    #[test]
    fn numeric_id_rejects_non_integers() {
        assert_eq!(numeric_id(" 128 ").unwrap(), 128);
        assert!(numeric_id("128; DROP").is_err());
    }
}
