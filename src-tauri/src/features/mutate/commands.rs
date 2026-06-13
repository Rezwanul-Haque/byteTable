//! Tauri command handlers for the mutate slice. Deserialize → use-case →
//! serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for the
//! open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).
//!
//! All commands are `async fn` per the async-commands rule in
//! `crate::shared::engine` — they drive real database work. The mutation
//! safety contract (parameterized binding, full-pk targeting, transactional
//! affected-count guard) lives in the adapter, not here.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::engine::{UpdateCellRequest, UpdateResult};
use crate::shared::error::AppError;

use super::application;

/// Update a single cell for M11 inline editing (`row_update` command): set one
/// column to a new value on the row identified by its full primary key.
/// Returns the affected count (always 1 on success) plus a cosmetic statement
/// string for the §3.5 toast. Unknown schema/table/column, a missing/partial
/// primary key, a stale pk, and engine constraint failures surface as
/// `{ kind, message }` errors.
#[tauri::command]
pub async fn row_update(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    req: UpdateCellRequest,
) -> Result<UpdateResult, AppError> {
    application::update_cell(state.manager(), &handle_id, req).await
}
