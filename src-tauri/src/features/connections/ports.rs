//! Ports: the traits the connections use-cases need. Implemented by
//! infrastructure adapters, faked in application tests.
//!
//! The slice also re-uses two shared-kernel ports: `shared::engine::Connector`
//! (per-engine, registered in the composition root) and
//! `shared::engine::EngineConnection` (held by the `ConnectionManager`).

use crate::shared::error::AppError;

use super::domain::SavedConnection;

/// Persistence boundary for the saved-connection registry.
///
/// Deliberately *sync*: the backing store is a small local JSON file, so
/// each call is effectively instant. The Tauri commands of this slice are
/// still `async fn` (they also drive real DB work); calling these sync
/// methods inline from an async command is fine because they never block
/// for a meaningful duration. If a slow store ever backs this port, make it
/// async then.
///
/// `Send + Sync` bound: instances are shared across Tauri's async command
/// invocations.
pub trait ConnectionRepository: Send + Sync {
    /// All saved connections, in stored order.
    fn list(&self) -> Result<Vec<SavedConnection>, AppError>;

    /// Look up one saved connection. `Ok(None)` when the id is unknown —
    /// "does not exist" is a normal outcome here, not an error.
    fn get(&self, id: &str) -> Result<Option<SavedConnection>, AppError>;

    /// Insert or update (by id) one saved connection.
    fn save(&self, connection: &SavedConnection) -> Result<(), AppError>;

    /// Remove a saved connection. Returns `NotFound` for unknown ids so the
    /// renderer can tell a stale list from a successful delete.
    fn delete(&self, id: &str) -> Result<(), AppError>;
}
