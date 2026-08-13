//! Tauri command handlers for the explain slice. Deserialize → use-case →
//! serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for the
//! open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;

use super::application;
use super::domain::{ExplainCapabilities, Measurement, RawPlan, ServerPlan};

/// Which forms of EXPLAIN this connection's engine supports, so the panel can
/// disable what it cannot offer instead of failing on click.
#[tauri::command]
pub async fn explain_capabilities(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<ExplainCapabilities, AppError> {
    application::capabilities(state.manager(), &handle_id).await
}

/// The engine's own plan for `sql`, parsed into the panel's node model.
///
/// **Plans only — the statement is not executed.** `null` means the engine has
/// no machine-readable plan, or returned one we could not read; the renderer
/// then keeps its modelled tree.
#[tauri::command]
pub async fn explain_plan(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    sql: String,
    schema: Option<String>,
) -> Result<Option<ServerPlan>, AppError> {
    application::plan(state.manager(), &handle_id, &sql, schema).await
}

/// The plan as the engine prints it, untouched, for the "Raw output" view.
///
/// `analyze: false` plans without executing. **`analyze: true` runs the
/// statement** and reports actual rows and timings — the renderer keeps that
/// behind an explicit toggle.
#[tauri::command]
pub async fn explain_raw(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    sql: String,
    schema: Option<String>,
    analyze: bool,
) -> Result<RawPlan, AppError> {
    application::raw(state.manager(), &handle_id, &sql, schema, analyze).await
}

/// Run the statement and count what it read — the panel's summary figures.
///
/// **This executes `sql`.** Unlike the other commands here it is not
/// plan-only, which is why the renderer keeps it behind the same gate as any
/// other query: automatic on dev and staging, an explicit click on production.
#[tauri::command]
pub async fn explain_measure(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    sql: String,
    schema: Option<String>,
) -> Result<Measurement, AppError> {
    application::measure(state.manager(), &handle_id, &sql, schema).await
}
