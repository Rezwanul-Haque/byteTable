//! Tauri command handlers: the thin presentation layer of the slice.
//! Deserialize → use-case → serialize; no logic lives here.
//!
//! Commands are `async fn` for consistency with the rest of the app's command
//! surface, even though the layout port is sync (a tiny local JSON file) and
//! the export write is a one-shot file write.

use tauri::State;

use crate::shared::error::AppError;

use super::application;
use super::domain::{ExportPayload, MapLayout};
use super::infrastructure::write_export;
use super::ports::MapLayoutRepository;

/// Managed state for the schema-map slice, registered in `lib.rs`.
///
/// Commands depend only on the `MapLayoutRepository` port; the concrete adapter
/// is chosen exclusively in the composition root (mirrors the saved_queries /
/// connections boxed-trait pattern).
pub struct SchemaMapState {
    repository: Box<dyn MapLayoutRepository + Send + Sync>,
}

impl SchemaMapState {
    pub fn new(repository: Box<dyn MapLayoutRepository + Send + Sync>) -> Self {
        Self { repository }
    }
}

/// The saved layout for one (connectionId, schema), or `null` when none was
/// ever saved (renderer lays out from scratch).
#[tauri::command]
pub async fn map_layout_get(
    state: State<'_, SchemaMapState>,
    connection_id: String,
    schema: String,
) -> Result<Option<MapLayout>, AppError> {
    application::get_map_layout(state.repository.as_ref(), &connection_id, &schema)
}

/// Persist (overwrite) the layout for one (connectionId, schema).
#[tauri::command]
pub async fn map_layout_save(
    state: State<'_, SchemaMapState>,
    connection_id: String,
    schema: String,
    layout: MapLayout,
) -> Result<(), AppError> {
    application::save_map_layout(state.repository.as_ref(), &connection_id, &schema, layout)
}

/// Write an exported diagram (SVG text or base64 PNG bytes) to the
/// user-chosen `payload.path`. The path comes from the native save dialog, so
/// no scope restriction applies beyond that explicit user action.
#[tauri::command]
pub async fn diagram_export(payload: ExportPayload) -> Result<(), AppError> {
    write_export(&payload)
}
