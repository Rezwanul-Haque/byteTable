//! Tauri command handlers for the browse slice. Deserialize → use-case →
//! serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for
//! the open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).
//!
//! All commands are `async fn` per the async-commands rule in
//! `crate::shared::engine` — they drive real database work. The page-size
//! clamp lives in the adapter (`MAX_PAGE_ROWS`), not here, so every caller
//! of `fetch_rows` (commands and tests alike) gets the same ceiling.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::engine::{FetchRowsRequest, RowLookup, RowLookupRequest, RowsPage};
use crate::shared::error::AppError;

use super::application;

/// One page of rows for the M4 data grid: paged (`offset`/`limit`) and
/// optionally sorted by a single column, with an exact unfiltered row count.
#[tauri::command]
pub async fn rows_fetch(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    req: FetchRowsRequest,
) -> Result<RowsPage, AppError> {
    application::fetch_rows(state.manager(), &handle_id, req).await
}

/// Single-row lookup by key for M10 "FK peek": click a foreign-key value to
/// fetch the referenced row. Returns the first match plus a total match count.
#[tauri::command]
pub async fn row_lookup(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    req: RowLookupRequest,
) -> Result<RowLookup, AppError> {
    application::fetch_row_by_key(state.manager(), &handle_id, req).await
}
