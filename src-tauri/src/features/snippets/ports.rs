//! Ports: the trait the snippets use-cases need. Implemented by the
//! infrastructure adapter, faked in application tests.

use crate::shared::error::AppError;

use super::domain::Snippet;

/// Persistence boundary for the global snippet library.
///
/// Deliberately *sync*, for the same reason as the saved-queries port: the
/// backing store is a small local JSON file, so each call is effectively
/// instant, and calling it inline from an `async` Tauri command never blocks
/// for a meaningful duration. If a slow store ever backs this port, make it
/// async then.
///
/// `Send + Sync` bound: a single instance is shared across Tauri's async
/// command invocations.
pub trait SnippetRepository: Send + Sync {
    /// All snippets, in stored order.
    fn list(&self) -> Result<Vec<Snippet>, AppError>;

    /// Insert or update (by id) one snippet.
    ///
    /// The use-case handles id/timestamp assignment, so adapters can rely on a
    /// fully-populated value here.
    fn save(&self, snippet: &Snippet) -> Result<(), AppError>;

    /// Remove a snippet. Returns `NotFound` for unknown ids so the renderer can
    /// tell a stale list from a successful delete.
    fn delete(&self, id: &str) -> Result<(), AppError>;
}
