//! Postgres process-list adapter (M26): `pg_stat_activity` → normalized
//! [`ProcessInfo`], and `pg_terminate_backend` to kill a backend.

use async_trait::async_trait;

use crate::shared::engine::{EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::process::{self, ProcessInfo, ProcessKill, ProcessReader};

use super::PostgresEngineConnection;

/// The fixed ten-column process SELECT (see [`process::map_sql_rows`]). Idle
/// backends blank their `query` (it holds the *last* statement, not a running
/// one) so the grid shows a dim `—`. `is_self` flags EVERY backend belonging to
/// this ByteTable connection's pool via the `application_name` the connector
/// sets (see `sql::connect_options`) — not just the one pool connection running
/// this query — so the UI protects all of them and the "me" flag never hops
/// between pool connections across auto-refreshes.
const LIST_SQL: &str = "SELECT \
    pid::text, \
    ''::text, \
    ''::text, \
    coalesce(usename, ''), \
    coalesce(host(client_addr), 'local'), \
    coalesce(datname, ''), \
    coalesce(state, ''), \
    coalesce(extract(epoch FROM (now() - query_start))::bigint, 0), \
    CASE WHEN state = 'idle' THEN '' ELSE coalesce(query, '') END, \
    (application_name = 'ByteTable') \
    FROM pg_stat_activity \
    WHERE backend_type = 'client backend' \
    ORDER BY (state = 'active') DESC, query_start ASC NULLS LAST";

#[async_trait]
impl ProcessReader for PostgresEngineConnection {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, AppError> {
        let result = self.run_query(LIST_SQL, QueryOptions::default()).await?;
        Ok(process::map_sql_rows(result))
    }

    async fn kill_process(&self, target: ProcessKill) -> Result<(), AppError> {
        let pid = process::numeric_id(&target.pid)?;
        self.run_query(
            &format!("SELECT pg_terminate_backend({pid})"),
            QueryOptions::default(),
        )
        .await?;
        Ok(())
    }
}
