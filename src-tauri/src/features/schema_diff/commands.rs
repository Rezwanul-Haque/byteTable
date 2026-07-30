//! Tauri command handlers for the schema-diff slice (M28). Deserialize →
//! use-case → serialize; no logic lives here.
//!
//! Three commands, matching the feature's three moves: snapshot a schema,
//! compare two snapshots, apply the chosen statements. Snapshots round-trip
//! through the renderer so swapping direction (or re-picking a side) re-diffs
//! without touching either database again.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::engine::Engine;
use crate::shared::error::AppError;

use super::application;
use super::domain::{MigrationStatement, SchemaComparison, SchemaSnapshot};

/// The structure of one schema (tables → columns + indexes). **Reads no rows.**
#[tauri::command]
pub async fn schema_snapshot(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
) -> Result<SchemaSnapshot, AppError> {
    application::read_schema(state.manager(), &handle_id, &schema).await
}

/// Diff two snapshots and plan the migration that makes the target match the
/// source, in the target engine's dialect. Pure — no database access.
#[tauri::command]
pub async fn schema_diff_compare(
    source: SchemaSnapshot,
    target: SchemaSnapshot,
    target_engine: Engine,
) -> Result<SchemaComparison, AppError> {
    Ok(application::compare_snapshots(
        &source,
        &target,
        target_engine,
    ))
}

/// Run the selected statements against the target schema, as one script.
/// **Mutates schema** (never row data); see `application::apply_migration` for
/// the per-engine atomicity contract. Returns how many statements were sent.
#[tauri::command]
pub async fn schema_diff_apply(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    statements: Vec<MigrationStatement>,
) -> Result<u64, AppError> {
    application::apply_migration(state.manager(), &handle_id, &schema, &statements).await
}
