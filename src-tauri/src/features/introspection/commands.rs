//! Tauri command handlers for the introspection slice. Deserialize →
//! use-case → serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for
//! the open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).
//!
//! All commands are `async fn` per the async-commands rule in
//! `crate::shared::engine` — they drive real database work.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::engine::{DbObjectDefinition, DbObjectInfo, DbObjectKind, TableMeta};
use crate::shared::error::AppError;

use super::application;

/// Column-level metadata for one table (M3 sidebar: expandable column
/// lists with pk/fk icons and type labels).
#[tauri::command]
pub async fn table_meta(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    table: String,
) -> Result<TableMeta, AppError> {
    application::get_table_meta(state.manager(), &handle_id, &schema, &table).await
}

/// Schema objects of one kind (views / matviews / functions / procedures /
/// triggers). Empty for engines that do not support the kind.
#[tauri::command]
pub async fn list_objects(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    kind: DbObjectKind,
) -> Result<Vec<DbObjectInfo>, AppError> {
    application::list_objects(state.manager(), &handle_id, &schema, kind).await
}

/// The `CREATE …` DDL for one object (viewer + editor seed).
#[tauri::command]
pub async fn object_definition(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    kind: DbObjectKind,
    name: String,
    detail: Option<String>,
) -> Result<DbObjectDefinition, AppError> {
    application::object_definition(
        state.manager(),
        &handle_id,
        &schema,
        kind,
        &name,
        detail.as_deref(),
    )
    .await
}

/// Drop one object (engine builds the precise `DROP …`). **Mutates schema.**
#[tauri::command]
pub async fn drop_object(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    kind: DbObjectKind,
    name: String,
    detail: Option<String>,
) -> Result<(), AppError> {
    application::drop_object(
        state.manager(),
        &handle_id,
        &schema,
        kind,
        &name,
        detail.as_deref(),
    )
    .await
}

/// Run object-DDL statements verbatim (each string is one whole statement —
/// the caller already separated DROP from CREATE; no `;`-splitting).
/// **Mutates schema.**
#[tauri::command]
pub async fn run_object_ddl(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    statements: Vec<String>,
) -> Result<(), AppError> {
    application::run_object_ddl(state.manager(), &handle_id, &statements).await
}
