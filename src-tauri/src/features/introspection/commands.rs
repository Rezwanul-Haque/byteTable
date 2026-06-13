//! Tauri command handlers for the introspection slice. Deserialize →
//! use-case → serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for
//! the open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).
//!
//! All commands are `async fn` per the async-commands rule in
//! `crate::shared::engine` — they drive real database work.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::engine::TableMeta;
use crate::shared::error::AppError;

use super::application;

/// Column-level metadata for one table (M3 sidebar: expandable column
/// lists with pk/fk icons and type labels).
#[tauri::command]
pub async fn table_meta(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    table: String,
) -> Result<TableMeta, AppError> {
    application::get_table_meta(state.manager(), &handle_id, &schema, &table).await
}
