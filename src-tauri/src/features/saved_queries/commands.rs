//! Tauri command handlers: the thin presentation layer of the slice.
//! Deserialize → use-case → serialize; no logic lives here.
//!
//! Commands are `async fn` for consistency with the rest of the app's command
//! surface, even though the saved-query port is sync (a tiny local JSON file).

use tauri::State;

use crate::shared::error::AppError;

use super::application;
use super::domain::SavedQuery;
use super::ports::SavedQueryRepository;

/// Managed state for the saved-queries slice, registered in `lib.rs`.
///
/// Commands depend only on the `SavedQueryRepository` port; the concrete
/// adapter is chosen exclusively in the composition root (mirrors the
/// connections slice's boxed-trait pattern).
pub struct SavedQueriesState {
    repository: Box<dyn SavedQueryRepository + Send + Sync>,
}

impl SavedQueriesState {
    pub fn new(repository: Box<dyn SavedQueryRepository + Send + Sync>) -> Self {
        Self { repository }
    }
}

#[tauri::command]
pub async fn saved_query_list(
    state: State<'_, SavedQueriesState>,
) -> Result<Vec<SavedQuery>, AppError> {
    application::list_saved_queries(state.repository.as_ref())
}

#[tauri::command]
pub async fn saved_query_save(
    state: State<'_, SavedQueriesState>,
    query: SavedQuery,
) -> Result<SavedQuery, AppError> {
    application::save_saved_query(state.repository.as_ref(), query)
}

#[tauri::command]
pub async fn saved_query_delete(
    state: State<'_, SavedQueriesState>,
    id: String,
) -> Result<(), AppError> {
    application::delete_saved_query(state.repository.as_ref(), &id)
}
