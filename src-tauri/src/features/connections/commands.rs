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

use crate::shared::engine::{
    ConnectSecret, ConnectionParams, EngineInfo, QueryOptions, QueryResult,
};
use crate::shared::engine::{SchemaInfo, TableInfo};
use crate::shared::error::AppError;

/// Wrap an optional transient password from the renderer into a [`ConnectSecret`].
///
/// The password reaches the command as a plain `Option<String>` argument and is
/// turned into a short-lived [`ConnectSecret`] here; it is never persisted (it
/// is not part of [`ConnectionParams`]). M12 Task 3 replaces this argument with
/// an OS-keychain lookup keyed by the saved-connection id — see [`ConnectSecret`].
fn into_secret(password: Option<String>) -> Option<ConnectSecret> {
    password.filter(|p| !p.is_empty()).map(ConnectSecret)
}

use super::application::{
    self, ConnectionHandleId, ConnectionManager, ConnectorRegistry, OpenTarget, OpenedConnection,
};
use super::domain::SavedConnection;
use super::ports::ConnectionRepository;

/// Hard ceiling for `QueryOptions::row_limit`, enforced at the command
/// boundary regardless of what the renderer asks for. 10 000 rows is already
/// far beyond what a grid usefully shows; the clamp keeps a renderer bug (or
/// a hand-crafted invoke) from marshalling an unbounded result set across
/// IPC. Engines still set `truncated` when the clamped limit cuts a result.
const MAX_ROW_LIMIT: usize = 10_000;

/// Clamp the requested row limit to [`MAX_ROW_LIMIT`].
fn clamp_row_limit(mut options: QueryOptions) -> QueryOptions {
    options.row_limit = options.row_limit.min(MAX_ROW_LIMIT);
    options
}

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

    /// The open-handle manager, for app-teardown hooks in the composition
    /// root (`lib.rs` calls `close_all` on exit).
    pub fn manager(&self) -> &ConnectionManager {
        &self.manager
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

/// `password` is the transient connection secret for server engines (Postgres
/// in M12 Task 1), carried only for this call and never persisted. SQLite
/// ignores it. M12 Task 3 will source it from the OS keychain instead of the
/// renderer.
#[tauri::command]
pub async fn connection_test(
    state: State<'_, ConnectionsState>,
    params: ConnectionParams,
    password: Option<String>,
) -> Result<EngineInfo, AppError> {
    application::test_connection(&state.registry, &params, into_secret(password).as_ref()).await
}

/// Open by saved id *or* ad-hoc params ("Open SQLite file…"); exactly one
/// must be provided.
#[tauri::command]
pub async fn connection_open(
    state: State<'_, ConnectionsState>,
    id: Option<String>,
    params: Option<ConnectionParams>,
    password: Option<String>,
) -> Result<OpenedConnection, AppError> {
    let target = match (id, params) {
        (Some(id), None) => OpenTarget::SavedId(id),
        (None, Some(params)) => OpenTarget::Params(params),
        (Some(_), Some(_)) => {
            return Err(AppError::Invalid(
                "provide either a saved connection id or connection params, not both".into(),
            ))
        }
        (None, None) => {
            return Err(AppError::Invalid(
                "provide either a saved connection id or connection params".into(),
            ))
        }
    };
    application::open_connection(
        state.repository.as_ref(),
        &state.registry,
        &state.manager,
        target,
        into_secret(password).as_ref(),
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

// NOTE: `connection_schemas` / `connection_tables` predate the introspection
// slice (`features::introspection`), which owns all NEW introspection
// surface (M3's `table_meta` onward). Moving these two over is deferred —
// the renderer already depends on their names.
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
        clamp_row_limit(options.unwrap_or_default()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_limit_is_clamped_to_the_ceiling_and_smaller_values_pass_through() {
        let huge = clamp_row_limit(QueryOptions {
            row_limit: usize::MAX,
            schema: None,
        });
        assert_eq!(huge.row_limit, MAX_ROW_LIMIT);

        let at_ceiling = clamp_row_limit(QueryOptions {
            row_limit: MAX_ROW_LIMIT,
            schema: Some("main".into()),
        });
        assert_eq!(at_ceiling.row_limit, MAX_ROW_LIMIT);
        assert_eq!(at_ceiling.schema, Some("main".into()));

        let small = clamp_row_limit(QueryOptions::default());
        assert_eq!(small.row_limit, 500, "the default stays untouched");
    }
}
