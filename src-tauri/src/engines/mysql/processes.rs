//! MySQL process-list adapter (M26): `information_schema.processlist` (the
//! stable-column form of `SHOW FULL PROCESSLIST`) → normalized [`ProcessInfo`],
//! and `KILL <id>` to terminate a session.

use std::collections::HashSet;

use async_trait::async_trait;

use crate::shared::engine::{EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::process::{self, ProcessInfo, ProcessKill, ProcessReader};

use super::{MysqlEngineConnection, POOL_MAX_CONNECTIONS};

/// The fixed ten-column process SELECT (see [`process::map_sql_rows`]). `state`
/// collapses MySQL's Command/State pair: a `Sleep` command → `idle`, a
/// non-empty fine-grained state (e.g. `Waiting for table lock`) as-is, else the
/// command (`active` for `Query`). Sleeping sessions blank their `Info`.
const LIST_SQL: &str = "SELECT \
    CAST(id AS CHAR), \
    '', \
    '', \
    coalesce(user, ''), \
    coalesce(host, ''), \
    coalesce(db, ''), \
    CASE WHEN command = 'Sleep' THEN 'idle' \
         WHEN state IS NOT NULL AND state <> '' THEN state \
         WHEN command = 'Query' THEN 'active' \
         ELSE lower(command) END, \
    coalesce(time, 0), \
    CASE WHEN command = 'Sleep' THEN '' ELSE coalesce(info, '') END, \
    (id = connection_id()) \
    FROM information_schema.processlist \
    ORDER BY (command = 'Query') DESC, time DESC";

#[async_trait]
impl ProcessReader for MysqlEngineConnection {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, AppError> {
        // Flag EVERY connection in this ByteTable connection's pool as self, not
        // just the one serving this query. MySQL has no per-connection app tag in
        // the processlist, so we collect the `connection_id()` of each currently
        // open pool connection: hold as many as `try_acquire` yields (up to the
        // pool max) so they are distinct, read each id, then release them before
        // running the list. Without this the pool rotates which connection serves
        // each auto-refresh, so the "me" flag would hop between rows.
        let self_ids = self.pool_connection_ids().await;

        let result = self.run_query(LIST_SQL, QueryOptions::default()).await?;
        let mut procs = process::map_sql_rows(result);
        if !self_ids.is_empty() {
            for p in &mut procs {
                p.is_self = p.is_self || self_ids.contains(&p.pid);
            }
        }
        Ok(procs)
    }

    async fn kill_process(&self, target: ProcessKill) -> Result<(), AppError> {
        let id = process::numeric_id(&target.pid)?;
        self.run_query(&format!("KILL {id}"), QueryOptions::default())
            .await?;
        Ok(())
    }
}

impl MysqlEngineConnection {
    /// The `connection_id()` of every currently-open connection in this pool, as
    /// strings (matching `ProcessInfo::pid`). Holds each connection `try_acquire`
    /// yields (up to the pool max) so they are distinct, reads its id, then
    /// releases them all. Best-effort: a connection whose id read fails is simply
    /// not flagged. Empty when the pool is momentarily fully contended, in which
    /// case the list falls back to the SQL `id = connection_id()` self flag.
    async fn pool_connection_ids(&self) -> HashSet<String> {
        let mut held = Vec::new();
        let mut ids = HashSet::new();
        while held.len() < POOL_MAX_CONNECTIONS as usize {
            let Some(mut conn) = self.pool.try_acquire() else {
                break;
            };
            if let Ok(id) = sqlx::query_scalar::<_, u64>("SELECT connection_id()")
                .fetch_one(&mut *conn)
                .await
            {
                ids.insert(id.to_string());
            }
            held.push(conn);
        }
        drop(held);
        ids
    }
}
