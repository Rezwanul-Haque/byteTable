//! Redis process-list adapter (M26): `CLIENT LIST` → normalized [`ProcessInfo`]
//! (each connected client is a "process"), and `CLIENT KILL ID <id>` to close
//! one. `CLIENT ID` identifies our own connection so the UI protects it.

use async_trait::async_trait;

use crate::shared::error::AppError;
use crate::shared::process::{self, ProcessInfo, ProcessKill, ProcessReader};

use super::error::map_query_error;
use super::RedisKvConnection;

/// Redis commands that park the client waiting for data — surfaced as a
/// `blocked (CMD)` amber state (matches the prototype's `blocked (BLPOP)`).
const BLOCKING: [&str; 10] = [
    "blpop",
    "brpop",
    "brpoplpush",
    "blmove",
    "blmpop",
    "bzpopmin",
    "bzpopmax",
    "bzmpop",
    "wait",
    "xread",
];

#[async_trait]
impl ProcessReader for RedisKvConnection {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, AppError> {
        // CLIENT LIST / CLIENT ID are server-global; db 0 is just the carrier.
        let mut conn = self.conn_for(0).await?;
        let self_id: i64 = redis::cmd("CLIENT")
            .arg("ID")
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        let list: String = redis::cmd("CLIENT")
            .arg("LIST")
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(parse_client_list(&list, self_id))
    }

    async fn kill_process(&self, target: ProcessKill) -> Result<(), AppError> {
        let id = process::numeric_id(&target.pid)?;
        let mut conn = self.conn_for(0).await?;
        let _: redis::Value = redis::cmd("CLIENT")
            .arg("KILL")
            .arg("ID")
            .arg(id)
            .query_async(&mut conn)
            .await
            .map_err(map_query_error)?;
        Ok(())
    }
}

/// Parse the newline-separated `CLIENT LIST` reply into [`ProcessInfo`] rows.
/// Each line is space-separated `key=value` pairs.
fn parse_client_list(reply: &str, self_id: i64) -> Vec<ProcessInfo> {
    reply
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let get = |key: &str| field(line, key);
            let id = get("id").unwrap_or_default();
            let raw_cmd = get("cmd").unwrap_or_default();
            let flags = get("flags").unwrap_or_default();
            let idle: i64 = get("idle").and_then(|v| v.parse().ok()).unwrap_or(0);
            let age: i64 = get("age").and_then(|v| v.parse().ok()).unwrap_or(0);
            let name = get("name")
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "—".into());
            let db = get("db").unwrap_or_else(|| "0".into());

            let state = client_state(&raw_cmd, &flags, idle);
            let is_self = id.parse::<i64>().map(|v| v == self_id).unwrap_or(false);

            ProcessInfo {
                pid: id,
                serial: None,
                qid: None,
                user: name,
                host: get("addr").unwrap_or_default(),
                db: format!("db{db}"),
                state,
                time_s: age,
                query: display_cmd(&raw_cmd),
                is_self,
            }
        })
        .collect()
}

/// The value of one `key=value` token on a `CLIENT LIST` line.
fn field(line: &str, key: &str) -> Option<String> {
    line.split_whitespace().find_map(|token| {
        token
            .strip_prefix(key)
            .and_then(|rest| rest.strip_prefix('='))
            .map(str::to_string)
    })
}

/// Derive the display state from the last command, flags, and idle time.
fn client_state(raw_cmd: &str, flags: &str, idle: i64) -> String {
    let head = raw_cmd.split('|').next().unwrap_or("").to_lowercase();
    if flags.contains('P') || head.ends_with("subscribe") {
        "pubsub".into()
    } else if BLOCKING.contains(&head.as_str()) {
        format!("blocked ({})", head.to_uppercase())
    } else if idle >= 1 {
        "idle".into()
    } else {
        "active".into()
    }
}

/// A readable last-command string (`client|list` → `CLIENT LIST`).
fn display_cmd(raw_cmd: &str) -> String {
    if raw_cmd.is_empty() || raw_cmd == "NULL" {
        return String::new();
    }
    raw_cmd
        .split('|')
        .map(|part| part.to_uppercase())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_client_line_and_flags_self() {
        let reply = "id=6 addr=10.0.4.18:52310 name=web-1 age=42 idle=0 flags=N db=2 cmd=get\n\
             id=7 addr=10.0.4.22:52311 name= age=900 idle=900 flags=N db=0 cmd=subscribe";
        let procs = parse_client_list(reply, 6);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, "6");
        assert_eq!(procs[0].user, "web-1");
        assert_eq!(procs[0].host, "10.0.4.18:52310");
        assert_eq!(procs[0].db, "db2");
        assert_eq!(procs[0].state, "active");
        assert_eq!(procs[0].query, "GET");
        assert!(procs[0].is_self);
        // Unnamed client → em dash; subscribe → pubsub state.
        assert_eq!(procs[1].user, "—");
        assert_eq!(procs[1].state, "pubsub");
        assert!(!procs[1].is_self);
    }

    #[test]
    fn blocking_command_is_amber() {
        let reply = "id=9 addr=x:1 name=w age=3 idle=3 flags=N db=0 cmd=blpop";
        let procs = parse_client_list(reply, 1);
        assert_eq!(procs[0].state, "blocked (BLPOP)");
    }
}
