//! Ports: the persistence boundary the schema-map use-cases need. Implemented
//! by the infrastructure adapter, faked in application tests.

use crate::shared::error::AppError;

use super::domain::MapLayout;

/// Persistence boundary for per-(connectionId, schema) ER-diagram layouts.
///
/// Deliberately *sync*: the backing store is a small local JSON file, so each
/// call is effectively instant. The slice's Tauri commands are `async fn` for
/// consistency with the rest of the app; calling these sync methods inline from
/// an async command is fine because they never block for a meaningful duration.
///
/// `Send + Sync` bound: a single instance is shared across Tauri's async
/// command invocations.
pub trait MapLayoutRepository: Send + Sync {
    /// The saved layout for one (connection, schema), or `None` if the user has
    /// never saved one — the renderer then lays the diagram out from scratch.
    fn get(&self, connection_id: &str, schema: &str) -> Result<Option<MapLayout>, AppError>;

    /// Persist (overwrite) the layout for one (connection, schema).
    fn save(&self, connection_id: &str, schema: &str, layout: &MapLayout) -> Result<(), AppError>;
}
