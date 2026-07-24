//! Use-cases for the processes slice (M26): resolve the connection's
//! process-list capability and delegate to the port. No Tauri, no drivers.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::error::AppError;
use crate::shared::process::{ProcessInfo, ProcessKill};

/// The engine's live session / operation / client list. A §5 `Unsupported`
/// error for an embedded/serverless engine with no server session list.
pub async fn list_processes(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<ProcessInfo>, AppError> {
    manager
        .get_process_reader(handle)
        .await?
        .list_processes()
        .await
}

/// Kill one session / operation / client on the connection.
pub async fn kill_process(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    target: ProcessKill,
) -> Result<(), AppError> {
    manager
        .get_process_reader(handle)
        .await?
        .kill_process(target)
        .await
}
