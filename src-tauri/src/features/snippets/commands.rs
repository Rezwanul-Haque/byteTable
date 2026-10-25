//! Tauri command handlers: the thin presentation layer of the slice.
//! Deserialize → use-case → serialize; no logic lives here.
//!
//! Commands are `async fn` for consistency with the rest of the app's command
//! surface, even though the snippet port is sync (a tiny local JSON file).

use tauri::State;

use crate::shared::error::AppError;

use super::application;
use super::domain::Snippet;
use super::ports::SnippetRepository;

/// Managed state for the snippets slice, registered in `lib.rs`.
///
/// Commands depend only on the `SnippetRepository` port; the concrete adapter is
/// chosen exclusively in the composition root (mirrors the saved-queries
/// slice's boxed-trait pattern).
pub struct SnippetsState {
    repository: Box<dyn SnippetRepository + Send + Sync>,
}

impl SnippetsState {
    pub fn new(repository: Box<dyn SnippetRepository + Send + Sync>) -> Self {
        Self { repository }
    }
}

#[tauri::command]
pub async fn snippet_list(state: State<'_, SnippetsState>) -> Result<Vec<Snippet>, AppError> {
    application::list_snippets(state.repository.as_ref())
}

#[tauri::command]
pub async fn snippet_save(
    state: State<'_, SnippetsState>,
    snippet: Snippet,
) -> Result<Snippet, AppError> {
    application::save_snippet(state.repository.as_ref(), snippet)
}

#[tauri::command]
pub async fn snippet_delete(state: State<'_, SnippetsState>, id: String) -> Result<(), AppError> {
    application::delete_snippet(state.repository.as_ref(), &id)
}
