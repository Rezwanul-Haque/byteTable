//! Tauri command handlers for the export slice (M15). Deserialize → use-case →
//! serialize; no logic lives here. Commands read the connections feature's
//! managed `ConnectionsState` for the open-handle manager (sanctioned
//! cross-feature composition at the presentation/application boundary, the same
//! pattern browse/insights/mutate use).
//!
//! All command names match the renderer wrappers in `src/shared/api/engine.ts`.
//! `export_table` / `export_schema` build the text; `export_save` writes it to
//! the path the renderer obtained from the native save dialog.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;

use super::application;
use super::domain::ExportFormat;

/// Generate the export text for one table in the chosen format (`csv` / `sql`).
/// Unknown schema/table surface as `{ kind, message }` §5 errors.
#[tauri::command]
pub async fn export_table(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    table: String,
    format: ExportFormat,
) -> Result<String, AppError> {
    application::export_table(state.manager(), &handle_id, &schema, &table, format).await
}

/// Generate a SQL dump (DDL + data) for every base table in a schema.
#[tauri::command]
pub async fn export_schema(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
) -> Result<String, AppError> {
    application::export_schema_sql(state.manager(), &handle_id, &schema).await
}

/// Write generated export text to a user-chosen path (from the native save
/// dialog). IO failures surface a §5 error naming the path.
#[tauri::command]
pub async fn export_save(path: String, contents: String) -> Result<(), AppError> {
    application::export_save(&path, &contents)
}
