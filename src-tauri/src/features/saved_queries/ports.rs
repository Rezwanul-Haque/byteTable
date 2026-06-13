//! Ports: the trait the saved-queries use-cases need. Implemented by the
//! infrastructure adapter, faked in application tests.

use crate::shared::error::AppError;

use super::domain::SavedQuery;

/// Persistence boundary for the global saved-query store.
///
/// Deliberately *sync*: the backing store is a small local JSON file, so each
/// call is effectively instant. The Tauri commands of this slice are `async
/// fn` for consistency with the rest of the app, and calling these sync
/// methods inline from an async command is fine because they never block for a
/// meaningful duration. If a slow store ever backs this port, make it async
/// then.
///
/// `Send + Sync` bound: a single instance is shared across Tauri's async
/// command invocations.
pub trait SavedQueryRepository: Send + Sync {
    /// All saved queries, in stored order.
    fn list(&self) -> Result<Vec<SavedQuery>, AppError>;

    /// Insert or update (by id) one saved query, returning the stored value.
    ///
    /// When the incoming `id` is empty the adapter mints a UUID and stamps
    /// `saved_at`, mirroring the connections registry's save; an existing id
    /// updates in place and keeps its original `saved_at`. The use-case
    /// handles the id/timestamp assignment, so adapters can rely on a
    /// fully-populated value here.
    fn save(&self, query: &SavedQuery) -> Result<(), AppError>;

    /// Remove a saved query. Returns `NotFound` for unknown ids so the
    /// renderer can tell a stale list from a successful delete.
    fn delete(&self, id: &str) -> Result<(), AppError>;
}
