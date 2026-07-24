//! SQL Server process-list adapter (M26): `sys.dm_exec_sessions` (+ requests /
//! sql_text) → normalized [`ProcessInfo`], and `KILL <spid>` to terminate a
//! session.

use async_trait::async_trait;

use crate::shared::engine::{EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::process::{self, ProcessInfo, ProcessKill, ProcessReader};

use super::MssqlEngineConnection;

/// The fixed ten-column process SELECT (see [`process::map_sql_rows`]). `state`
/// normalizes the request/session status pair (a running request → `active`, a
/// `suspended` request → `waiting`, a sleeping session → `idle`); the running
/// statement text comes from `sys.dm_exec_sql_text` for sessions with a live
/// request, blank otherwise; `is_self` flags `@@SPID`.
const LIST_SQL: &str = "SELECT \
    CAST(s.session_id AS varchar(12)), \
    '', \
    '', \
    coalesce(s.login_name, ''), \
    coalesce(s.host_name, ''), \
    coalesce(DB_NAME(s.database_id), ''), \
    CASE WHEN r.status = 'suspended' THEN 'waiting' \
         WHEN r.status IS NOT NULL THEN 'active' \
         WHEN s.status = 'sleeping' THEN 'idle' \
         ELSE lower(s.status) END, \
    CAST(coalesce(DATEDIFF(second, s.last_request_start_time, GETDATE()), 0) AS bigint), \
    CASE WHEN r.session_id IS NULL THEN '' ELSE coalesce(t.text, '') END, \
    CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END \
    FROM sys.dm_exec_sessions s \
    LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id \
    OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t \
    WHERE s.is_user_process = 1 \
    ORDER BY CASE WHEN r.status = 'running' THEN 0 ELSE 1 END, s.session_id";

#[async_trait]
impl ProcessReader for MssqlEngineConnection {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, AppError> {
        let result = self.run_query(LIST_SQL, QueryOptions::default()).await?;
        Ok(process::map_sql_rows(result))
    }

    async fn kill_process(&self, target: ProcessKill) -> Result<(), AppError> {
        let spid = process::numeric_id(&target.pid)?;
        self.run_query(&format!("KILL {spid}"), QueryOptions::default())
            .await?;
        Ok(())
    }
}
