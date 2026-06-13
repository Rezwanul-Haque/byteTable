//! Tauri command handlers for the mutate slice. Deserialize → use-case →
//! serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for the
//! open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).
//!
//! All commands are `async fn` per the async-commands rule in
//! `crate::shared::engine` — they drive real database work. The mutation
//! safety contract (parameterized binding, full-pk targeting, transactional
//! affected-count guard) lives in the adapter, not here.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::engine::{UpdateCellRequest, UpdateResult};
use crate::shared::error::AppError;

use super::application;
use super::application::TruncateResult;

/// Update a single cell for M11 inline editing (`row_update` command): set one
/// column to a new value on the row identified by its full primary key.
/// Returns the affected count (always 1 on success) plus a cosmetic statement
/// string for the §3.5 toast. Unknown schema/table/column, a missing/partial
/// primary key, a stale pk, and engine constraint failures surface as
/// `{ kind, message }` errors.
#[tauri::command]
pub async fn row_update(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    req: UpdateCellRequest,
) -> Result<UpdateResult, AppError> {
    application::update_cell(state.manager(), &handle_id, req).await
}

/// Empty a table of all rows, keeping its structure (M15 `truncate_table`
/// command). **Mutates user data.** Engine-aware in the adapter (Postgres/MySQL
/// `TRUNCATE`, SQLite `DELETE` in a transaction). Returns `{ affected }`, the
/// number of rows removed. Unknown schema/table surface as `{ kind, message }`
/// §5 errors. The production-confirm dialog is renderer-side (Task 2).
#[tauri::command]
pub async fn truncate_table(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    table: String,
) -> Result<TruncateResult, AppError> {
    application::truncate_table(state.manager(), &handle_id, &schema, &table).await
}

/// Drop every table in a schema, leaving it empty (M15 `drop_schema` command).
/// **Mutates user data — destructive.** Engine-aware in the adapter (Postgres
/// `DROP SCHEMA … CASCADE; CREATE SCHEMA …` atomic; MySQL `DROP/CREATE DATABASE`
/// non-atomic; SQLite drops every user table in a transaction). Returns `()`;
/// the schema is empty afterward. Unknown schema surfaces as a `{ kind, message }`
/// §5 error. The production-confirm dialog is renderer-side.
#[tauri::command]
pub async fn drop_schema(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
) -> Result<(), AppError> {
    application::drop_schema(state.manager(), &handle_id, &schema).await
}
