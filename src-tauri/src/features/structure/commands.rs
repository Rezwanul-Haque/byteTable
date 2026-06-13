//! Tauri command handlers for the structure-editor slice (M8). Deserialize →
//! use-case → serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for the
//! open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).
//!
//! All commands are `async fn` per the async-commands rule in
//! `crate::shared::engine` — they drive real database work. `alter_preview` is
//! pure (no DB writes); `alter_apply` executes the batch transactionally.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::features::structure::domain::AlterOp;
use crate::shared::engine::AlterResult;
use crate::shared::error::AppError;

use super::application;

/// Preview the SQL a batch of staged edits implies (the "Review SQL" panel).
/// Pure: never mutates the database.
#[tauri::command]
pub async fn alter_preview(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    table: String,
    ops: Vec<AlterOp>,
) -> Result<AlterResult, AppError> {
    application::preview_alter(state.manager(), &handle_id, &schema, &table, &ops).await
}

/// Apply a batch of staged edits transactionally. Rolls back fully on any
/// failure and returns the engine error §5-style.
#[tauri::command]
pub async fn alter_apply(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    table: String,
    ops: Vec<AlterOp>,
) -> Result<AlterResult, AppError> {
    application::apply_alter(state.manager(), &handle_id, &schema, &table, &ops).await
}
