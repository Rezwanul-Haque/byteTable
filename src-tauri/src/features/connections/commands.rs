//! Tauri command handlers: the thin presentation layer of the slice.
//! Deserialize → use-case → serialize; no logic lives here.
//!
//! All commands are `async fn` per the async-commands rule in
//! `crate::shared::engine` — they drive real database work.
//!
//! `query_run` lives here temporarily: M2 only needs a minimal query
//! surface. M6 (SQL editor) may move it to a dedicated query slice; the
//! handle-id seam will survive that move.

use serde::Serialize;
use tauri::State;

use crate::shared::engine::{ConnectionParams, Engine, EngineInfo, QueryOptions, QueryResult};
use crate::shared::engine::{SchemaInfo, TableInfo};
use crate::shared::error::AppError;

use super::application::{
    self, ConnectionHandleId, ConnectionManager, ConnectorRegistry, OpenTarget, OpenedConnection,
    TransientSecrets,
};
use super::domain::SavedConnection;
use super::ports::ConnectionRepository;
use super::secrets::SecretStore;

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
    /// OS-keychain-backed store for server-connection secrets (M12 Task 3):
    /// the db password and the SSH key passphrase / bastion password. SQLite
    /// connections never touch it.
    secret_store: Box<dyn SecretStore>,
}

impl ConnectionsState {
    pub fn new(
        repository: Box<dyn ConnectionRepository>,
        registry: ConnectorRegistry,
        manager: ConnectionManager,
        secret_store: Box<dyn SecretStore>,
    ) -> Self {
        Self {
            repository,
            registry,
            manager,
            secret_store,
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

/// Whether an engine's driver is actually usable in THIS build/host — drives the
/// connect modal's proactive "driver unavailable" indicator so the user learns
/// *before* a failed connect why an engine won't work and how to fix it.
///
/// Every pure-Rust engine is always available. Oracle (M23) is the exception:
/// its OCI adapter is compiled only behind the `engine-oracle` Cargo feature and
/// needs the Oracle Instant Client at runtime, so both are probed. `detail`
/// carries the client version when present (a tooltip nicety); `reason` carries a
/// §5-style explanation + fix when unavailable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub available: bool,
    /// Machine-readable state so the UI can decide how to present it:
    /// - `notShipped` — this edition of ByteTable does not include the engine.
    ///   The UI hides it in release builds (showing it would be a dead choice).
    /// - `needsSetup` — the engine ships, but a host-side prerequisite (the
    ///   Oracle Instant Client) is missing. The UI shows it with the fix.
    ///
    /// `None` when `available` is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// A short, END-USER-facing explanation shown in the connect modal when
    /// unavailable (no build/CLI jargon in release). `None` when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// A short driver/version detail for the "available" tooltip (e.g. the
    /// Instant Client version). `None` otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Report whether `engine`'s driver is usable here. Never touches the database —
/// Oracle's probe only loads the client library ([`oracle::Version::client`]).
#[tauri::command]
pub async fn engine_driver_status(engine: Engine) -> DriverStatus {
    match engine {
        Engine::Oracle => oracle_driver_status(),
        // Every other engine is a pure-Rust driver compiled unconditionally.
        _ => DriverStatus {
            available: true,
            code: None,
            reason: None,
            detail: None,
        },
    }
}

/// A developer-only build hint, appended to the user-facing reason ONLY in debug
/// builds — a shipped release never shows `--features`/CLI internals to users.
fn dev_hint(hint: &str) -> String {
    if cfg!(debug_assertions) {
        format!(" (Dev: {hint})")
    } else {
        String::new()
    }
}

/// Feature build: probe the Instant Client by asking for its version (a `dlopen`
/// of `libclntsh`, no DB connection). Ok → present; Err → missing/misconfigured.
#[cfg(feature = "engine-oracle")]
fn oracle_driver_status() -> DriverStatus {
    match oracle::Version::client() {
        Ok(version) => DriverStatus {
            available: true,
            code: None,
            reason: None,
            detail: Some(format!("Oracle Instant Client {version}")),
        },
        Err(err) => {
            // The DPI-1047 error carries the entire dyld search-path dump — far
            // too long for a UI warning. Log it for developers; keep the UI line
            // short with only a concise dev hint.
            if cfg!(debug_assertions) {
                eprintln!("engine-oracle: Oracle Instant Client not loadable: {err}");
            }
            DriverStatus {
                available: false,
                code: Some("needsSetup".to_string()),
                reason: Some(format!(
                    "Oracle support needs the Oracle Instant Client, which wasn't found \
                     on this system. Install it, then restart ByteTable.{}",
                    dev_hint(
                        "put the arm64 Instant Client on DYLD_LIBRARY_PATH (or in ~/lib or \
                         /usr/local/lib); full error logged to the console"
                    )
                )),
                detail: None,
            }
        }
    }
}

/// Default build: the OCI adapter was not compiled into this edition, so Oracle
/// is not available regardless of the host. The user-facing line says exactly
/// that (no build jargon); the dev hint is added only in debug builds.
#[cfg(not(feature = "engine-oracle"))]
fn oracle_driver_status() -> DriverStatus {
    DriverStatus {
        available: false,
        code: Some("notShipped".to_string()),
        reason: Some(format!(
            "Oracle isn't available in this version of ByteTable.{}",
            dev_hint("build with `--features engine-oracle` to enable it")
        )),
        detail: None,
    }
}

/// Save a connection. `password` / `sshSecret` are the optional transient
/// secrets the modal typed; when present they are stored in the OS keychain
/// keyed by the (assigned) connection id — the JSON registry stores only
/// non-secret params. Empty/absent secrets leave any stored secret untouched.
#[tauri::command]
pub async fn connection_save(
    state: State<'_, ConnectionsState>,
    connection: SavedConnection,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<SavedConnection, AppError> {
    let secrets = TransientSecrets::new(password, ssh_secret);
    application::save_connection(
        state.repository.as_ref(),
        state.secret_store.as_ref(),
        connection,
        &secrets,
    )
}

#[tauri::command]
pub async fn connection_delete(
    state: State<'_, ConnectionsState>,
    id: String,
) -> Result<(), AppError> {
    application::delete_connection(state.repository.as_ref(), state.secret_store.as_ref(), &id)
}

/// `password` is the transient connection secret for server engines (Postgres
/// in M12 Task 1), carried only for this call and never persisted. SQLite
/// ignores it. M12 Task 3 will source it from the OS keychain instead of the
/// renderer.
/// Test a connection using ONLY the transiently-typed secrets (`password` /
/// `sshSecret`) — testing happens before save, so the keychain is not touched.
#[tauri::command]
pub async fn connection_test(
    state: State<'_, ConnectionsState>,
    params: ConnectionParams,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<EngineInfo, AppError> {
    let secrets = TransientSecrets::new(password, ssh_secret);
    application::test_connection(&state.registry, &params, &secrets).await
}

/// Open by saved id *or* ad-hoc params ("Open SQLite file…"); exactly one
/// must be provided. For a saved id the secrets are sourced from the keychain
/// (a transiently-typed `password` / `sshSecret` overrides, for first connect
/// before save).
#[tauri::command]
pub async fn connection_open(
    state: State<'_, ConnectionsState>,
    id: Option<String>,
    params: Option<ConnectionParams>,
    password: Option<String>,
    ssh_secret: Option<String>,
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
    let secrets = TransientSecrets::new(password, ssh_secret);
    application::open_connection(
        state.repository.as_ref(),
        &state.registry,
        state.secret_store.as_ref(),
        &state.manager,
        target,
        &secrets,
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
