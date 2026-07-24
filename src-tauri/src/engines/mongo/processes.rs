//! MongoDB process-list adapter (M26): `db.currentOp()` → normalized
//! [`ProcessInfo`] (each in-progress operation is a "process"), and
//! `db.killOp(<opid>)` to terminate one. Both run against the `admin` database.

use async_trait::async_trait;
use mongodb::bson::{doc, Bson, Document};

use crate::shared::error::AppError;
use crate::shared::process::{ProcessInfo, ProcessKill, ProcessReader};

use super::error::db_err;
use super::value::doc_to_json;
use super::MongoDbConnection;

#[async_trait]
impl ProcessReader for MongoDbConnection {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, AppError> {
        let result = self
            .client
            .database("admin")
            .run_command(doc! { "currentOp": 1, "$all": false })
            .await
            .map_err(|e| db_err("List running operations", e))?;

        let inprog = result.get_array("inprog").map(Vec::as_slice).unwrap_or(&[]);
        Ok(inprog
            .iter()
            .filter_map(Bson::as_document)
            .map(op_to_process)
            .collect())
    }

    async fn kill_process(&self, target: ProcessKill) -> Result<(), AppError> {
        // killOp takes the opid exactly as currentOp reported it — a plain number
        // on a standalone/replica set, or a "shard:number" string on a mongos.
        let op = match target.pid.parse::<i64>() {
            Ok(n) => Bson::Int64(n),
            Err(_) => Bson::String(target.pid.clone()),
        };
        self.client
            .database("admin")
            .run_command(doc! { "killOp": 1, "op": op })
            .await
            .map_err(|e| db_err("Kill operation", e))?;
        Ok(())
    }
}

/// Map one `currentOp` `inprog` document to a [`ProcessInfo`].
fn op_to_process(op: &Document) -> ProcessInfo {
    let active = op.get_bool("active").unwrap_or(false);
    let secs = op
        .get_i64("secs_running")
        .ok()
        .or_else(|| op.get_i32("secs_running").ok().map(i64::from))
        .or_else(|| op.get_f64("secs_running").ok().map(|f| f as i64))
        .unwrap_or(0);
    // `client` on a standalone, `client_s` behind a mongos.
    let host = op
        .get_str("client")
        .or_else(|_| op.get_str("client_s"))
        .unwrap_or("")
        .to_string();
    let query = op
        .get_document("command")
        .ok()
        .map(|cmd| doc_to_json(cmd).to_string())
        .unwrap_or_default();

    ProcessInfo {
        pid: opid_string(op.get("opid")),
        serial: None,
        qid: None,
        user: op.get_str("op").unwrap_or("").to_string(),
        host,
        db: op.get_str("ns").unwrap_or("").to_string(),
        state: if active {
            "active".into()
        } else {
            "idle".into()
        },
        time_s: secs,
        query,
        is_self: false,
    }
}

/// Render an `opid` (int on most deployments, `shard:num` string on a mongos)
/// as a string.
fn opid_string(opid: Option<&Bson>) -> String {
    match opid {
        Some(Bson::Int32(n)) => n.to_string(),
        Some(Bson::Int64(n)) => n.to_string(),
        Some(Bson::Double(n)) => (*n as i64).to_string(),
        Some(Bson::String(s)) => s.clone(),
        _ => String::new(),
    }
}
