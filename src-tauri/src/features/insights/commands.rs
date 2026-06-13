//! Tauri command handlers for the insights slice. Deserialize → use-case →
//! serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for the
//! open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).
//!
//! All commands are `async fn` per the async-commands rule in
//! `crate::shared::engine` — they drive real database work.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::engine::{ColumnStats, ColumnStatsRequest};
use crate::shared::error::AppError;

use super::application;

/// Per-column statistics over the current filtered set (M10 "column
/// insights"): distinct/null counts, min/max, avg for numerics, and the top-5
/// most frequent values, computed over the grid's current filter.
#[tauri::command]
pub async fn column_stats(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    req: ColumnStatsRequest,
) -> Result<ColumnStats, AppError> {
    application::column_stats(state.manager(), &handle_id, req).await
}
