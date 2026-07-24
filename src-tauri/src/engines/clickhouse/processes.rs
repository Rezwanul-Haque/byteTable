//! ClickHouse process-list adapter (M26): `system.processes` → normalized
//! [`ProcessInfo`], and `KILL QUERY WHERE query_id = …` to cancel a query.
//!
//! ClickHouse has no persistent sessions — `system.processes` lists the queries
//! running *right now*, so every row is `active` and the primary id shown/killed
//! is the `query_id` (surfaced in both `pid` and `qid`). The listing query sees
//! itself; that row is flagged `is_self` by matching the `system.processes`
//! reference in its own text so the UI protects it.

use async_trait::async_trait;

use crate::shared::engine::{EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::process::{self, ProcessInfo, ProcessKill, ProcessReader};

use super::ClickhouseEngineConnection;

/// The fixed ten-column process SELECT (see [`process::map_sql_rows`]). `serial`
/// is unused (empty → `None`); `qid` mirrors `query_id`.
const LIST_SQL: &str = "SELECT \
    query_id, \
    '', \
    query_id, \
    user, \
    toString(address), \
    current_database, \
    'active', \
    toInt64(elapsed), \
    query, \
    position(query, 'system.processes') > 0 \
    FROM system.processes \
    ORDER BY elapsed DESC";

#[async_trait]
impl ProcessReader for ClickhouseEngineConnection {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, AppError> {
        let result = self.run_query(LIST_SQL, QueryOptions::default()).await?;
        Ok(process::map_sql_rows(result))
    }

    async fn kill_process(&self, target: ProcessKill) -> Result<(), AppError> {
        // ClickHouse kills by query_id, not a numeric pid. Escape single quotes
        // defensively even though query ids are engine-generated.
        let qid = target.qid.as_deref().unwrap_or(&target.pid);
        let escaped = qid.replace('\'', "''");
        self.run_query(
            &format!("KILL QUERY WHERE query_id = '{escaped}' SYNC"),
            QueryOptions::default(),
        )
        .await?;
        Ok(())
    }
}
