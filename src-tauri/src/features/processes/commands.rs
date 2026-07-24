//! Tauri command handlers for the processes slice (M26). Deserialize →
//! use-case → serialize; no logic lives here.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;
use crate::shared::process::{ProcessInfo, ProcessKill};

use super::application;

/// List the engine's live sessions / operations / clients.
#[tauri::command]
pub async fn process_list(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<ProcessInfo>, AppError> {
    application::list_processes(state.manager(), &handle_id).await
}

/// Kill one session / operation / client by its engine-specific id(s).
#[tauri::command]
pub async fn process_kill(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    target: ProcessKill,
) -> Result<(), AppError> {
    application::kill_process(state.manager(), &handle_id, target).await
}
