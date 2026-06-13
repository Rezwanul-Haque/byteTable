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

use crate::shared::engine::ImportResult;

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

/// Read a user-picked text file (CSV or `.sql`) for the renderer to
/// preview/parse. The `path` comes from the native open dialog (the user's
/// choice is the consent — same path handling as `export_save`). A
/// missing/unreadable file surfaces a §5 IO error naming the path.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, AppError> {
    application::read_text_file(&path)
}

/// Run a multi-statement SQL script given as TEXT (not a file path) into
/// `schema` — the in-memory counterpart of `import_sql`, so the renderer can
/// apply generated SQL (e.g. INSERTs built from a parsed CSV) without a temp
/// file. Engine-aware atomicity (see `execute_script`); a script failure
/// surfaces a §5 error. Returns the number of statements executed.
#[tauri::command]
pub async fn execute_script_text(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    sql: String,
) -> Result<ImportResult, AppError> {
    application::execute_script_text(state.manager(), &handle_id, &schema, &sql).await
}

/// Import a `.sql` dump (the I/O counterpart of `export_save`): read the file at
/// `path` (obtained from the renderer's native open dialog — the user's choice
/// is the consent) and run the whole multi-statement script into `schema`. A
/// missing/unreadable file or a script failure surfaces a §5 error. Returns the
/// number of statements executed (`{ statements }`).
#[tauri::command]
pub async fn import_sql(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    path: String,
) -> Result<ImportResult, AppError> {
    application::import_sql(state.manager(), &handle_id, &schema, &path).await
}
