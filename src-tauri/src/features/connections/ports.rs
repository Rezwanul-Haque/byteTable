//! Ports: the traits the connections use-cases need. Implemented by
//! infrastructure adapters, faked in application tests.
//!
//! The slice also re-uses two shared-kernel ports: `shared::engine::Connector`
//! (per-engine, registered in the composition root) and
//! `shared::engine::EngineConnection` (held by the `ConnectionManager`).

use crate::shared::error::AppError;

use super::domain::{SavedConnection, UnsupportedConnection};

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

    /// Registry entries this build cannot parse (unknown engine, etc.), surfaced
    /// so the connect screen can show them struck-out with a delete action rather
    /// than dropping them or failing the whole load. Default: none (fakes and
    /// in-memory repositories have nothing unreadable).
    fn list_unsupported(&self) -> Result<Vec<UnsupportedConnection>, AppError> {
        Ok(Vec::new())
    }

    /// Look up one saved connection. `Ok(None)` when the id is unknown —
    /// "does not exist" is a normal outcome here, not an error.
    fn get(&self, id: &str) -> Result<Option<SavedConnection>, AppError>;

    /// Insert or update (by id) one saved connection.
    fn save(&self, connection: &SavedConnection) -> Result<(), AppError>;

    /// Insert or update (by id) one entry from its RAW registry JSON.
    ///
    /// Exists for the connection-bundle import (M40), which must be able to
    /// write back an entry whose `engine` *this* build does not know — the same
    /// rows `list_unsupported` reports. Parsing such an entry to a
    /// `SavedConnection` is impossible by definition, so the import path hands
    /// the raw object straight through, exactly as the JSON adapter already
    /// preserves unreadable rows across a `save`.
    ///
    /// The default implementation parses and delegates to [`Self::save`], which
    /// is correct for every in-memory fake (they have no raw layer to preserve)
    /// and simply cannot carry an unknown engine — the real adapter overrides it.
    fn save_raw(&self, entry: &serde_json::Value) -> Result<(), AppError> {
        self.save(&serde_json::from_value::<SavedConnection>(entry.clone())?)
    }

    /// Remove a saved connection. Returns `NotFound` for unknown ids so the
    /// renderer can tell a stale list from a successful delete.
    fn delete(&self, id: &str) -> Result<(), AppError>;
}
