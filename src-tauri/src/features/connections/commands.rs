//! Tauri command handlers: the thin presentation layer of the slice.
//! Deserialize → use-case → serialize; no logic lives here.
//!
//! All commands are `async fn` per the async-commands rule in
//! `crate::shared::engine` — they drive real database work.
//!
//! `query_run` lives here temporarily: M2 only needs a minimal query
//! surface. M6 (SQL editor) may move it to a dedicated query slice; the
//! handle-id seam will survive that move.

use tauri::State;

use crate::shared::engine::{ConnectionParams, EngineInfo, QueryOptions, QueryResult};
use crate::shared::engine::{SchemaInfo, TableInfo};
use crate::shared::error::AppError;

use super::application::{
    self, ConnectionHandleId, ConnectionManager, ConnectorRegistry, OpenTarget, OpenedConnection,
};
use super::domain::SavedConnection;
use super::ports::ConnectionRepository;

/// Managed state for the connections slice, registered in `lib.rs`.
///
/// Commands depend only on ports (`ConnectionRepository`, the shared
/// `Connector` trait behind `ConnectorRegistry`); concrete adapters are
/// chosen exclusively in the composition root.
pub struct ConnectionsState {
    repository: Box<dyn ConnectionRepository>,
    registry: ConnectorRegistry,
    manager: ConnectionManager,
}

impl ConnectionsState {
    pub fn new(
        repository: Box<dyn ConnectionRepository>,
        registry: ConnectorRegistry,
        manager: ConnectionManager,
    ) -> Self {
        Self {
            repository,
            registry,
            manager,
        }
    }
}

#[tauri::command]
pub async fn connection_list(
    state: State<'_, ConnectionsState>,
) -> Result<Vec<SavedConnection>, AppError> {
    application::list_connections(state.repository.as_ref())
}

#[tauri::command]
pub async fn connection_save(
    state: State<'_, ConnectionsState>,
    connection: SavedConnection,
) -> Result<SavedConnection, AppError> {
    application::save_connection(state.repository.as_ref(), connection)
}

#[tauri::command]
pub async fn connection_delete(
    state: State<'_, ConnectionsState>,
    id: String,
) -> Result<(), AppError> {
    application::delete_connection(state.repository.as_ref(), &id)
}

#[tauri::command]
pub async fn connection_test(
    state: State<'_, ConnectionsState>,
    params: ConnectionParams,
) -> Result<EngineInfo, AppError> {
    application::test_connection(&state.registry, &params).await
}

/// Open by saved id *or* ad-hoc params ("Open SQLite file…"); exactly one
/// must be provided.
#[tauri::command]
pub async fn connection_open(
    state: State<'_, ConnectionsState>,
    id: Option<String>,
    params: Option<ConnectionParams>,
) -> Result<OpenedConnection, AppError> {
    let target = match (id, params) {
        (Some(id), None) => OpenTarget::SavedId(id),
        (None, Some(params)) => OpenTarget::Params(params),
        _ => {
            return Err(AppError::Invalid(
                "provide either a saved connection id or connection params, not both".into(),
            ))
        }
    };
    application::open_connection(
        state.repository.as_ref(),
        &state.registry,
        &state.manager,
        target,
    )
    .await
}

#[tauri::command]
pub async fn connection_close(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<(), AppError> {
    application::close_connection(&state.manager, &handle_id).await
}

#[tauri::command]
pub async fn connection_schemas(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
) -> Result<Vec<SchemaInfo>, AppError> {
    application::connection_schemas(&state.manager, &handle_id).await
}

#[tauri::command]
pub async fn connection_tables(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
) -> Result<Vec<TableInfo>, AppError> {
    application::connection_tables(&state.manager, &handle_id, &schema).await
}

#[tauri::command]
pub async fn query_run(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    sql: String,
    options: Option<QueryOptions>,
) -> Result<QueryResult, AppError> {
    application::run_query(
        &state.manager,
        &handle_id,
        &sql,
        options.unwrap_or_default(),
    )
    .await
}
