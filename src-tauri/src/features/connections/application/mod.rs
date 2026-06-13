//! Use-cases for the connections slice. Depend on domain + ports + the
//! shared engine abstraction only — no Tauri, no drivers.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::shared::engine::{
    ConnectionParams, Connector, Engine, EngineConnection, EngineInfo, QueryOptions, QueryResult,
    SchemaInfo, TableInfo,
};
use crate::shared::error::AppError;

use super::domain::SavedConnection;
use super::ports::ConnectionRepository;

// ---------------------------------------------------------------------------
// Connector registry
// ---------------------------------------------------------------------------

/// Maps each [`Engine`] to its [`Connector`] adapter. Built once in the
/// composition root (`lib.rs`); engines without a registered connector get
/// a friendly `Unsupported` error (MySQL/Postgres until M12).
#[derive(Default)]
pub struct ConnectorRegistry {
    connectors: HashMap<Engine, Arc<dyn Connector>>,
}

impl ConnectorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, engine: Engine, connector: Arc<dyn Connector>) {
        self.connectors.insert(engine, connector);
    }

    /// The connector for an engine, or `Unsupported` with a human message.
    pub fn get(&self, engine: Engine) -> Result<Arc<dyn Connector>, AppError> {
        self.connectors.get(&engine).cloned().ok_or_else(|| {
            AppError::Unsupported(format!(
                "{} connections arrive in a later milestone.",
                engine.display_name()
            ))
        })
    }
}

// ---------------------------------------------------------------------------
// Connection manager (open handles)
// ---------------------------------------------------------------------------

/// Opaque identifier for one open connection. The renderer holds this
/// string; the driver handle never crosses the command boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConnectionHandleId(pub String);

/// Holds every open [`EngineConnection`], keyed by handle id.
///
/// Connections are stored as `Arc` so operations clone the handle and drop
/// the lock *before* awaiting driver work — one slow query never blocks
/// opening or querying other connections.
#[derive(Default)]
pub struct ConnectionManager {
    open: RwLock<HashMap<ConnectionHandleId, Arc<dyn EngineConnection>>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Store a freshly opened connection and mint its handle id.
    pub async fn insert(&self, connection: Box<dyn EngineConnection>) -> ConnectionHandleId {
        let id = ConnectionHandleId(uuid::Uuid::new_v4().to_string());
        self.open
            .write()
            .await
            .insert(id.clone(), Arc::from(connection));
        id
    }

    /// The open connection behind a handle.
    pub async fn get(
        &self,
        handle: &ConnectionHandleId,
    ) -> Result<Arc<dyn EngineConnection>, AppError> {
        self.open.read().await.get(handle).cloned().ok_or_else(|| {
            AppError::NotFound(format!(
                "connection handle '{}' is not open (it may have been closed)",
                handle.0
            ))
        })
    }

    /// Remove a handle, returning the connection for teardown — or `None`
    /// when the handle is unknown (already closed); see [`close_connection`]
    /// for why that is not an error.
    pub async fn remove(&self, handle: &ConnectionHandleId) -> Option<Arc<dyn EngineConnection>> {
        self.open.write().await.remove(handle)
    }

    /// Drain every open handle and `close()` each connection. Called once at
    /// app teardown (see the `RunEvent::ExitRequested` hook in `lib.rs`).
    ///
    /// Close errors are swallowed: the process is exiting and there is no
    /// renderer left to show them to; drop-managed drivers release their
    /// resources regardless.
    pub async fn close_all(&self) {
        let connections: Vec<_> = self.open.write().await.drain().collect();
        for (_, connection) in connections {
            let _ = connection.close().await;
        }
    }

    /// Number of currently open handles (used by tests and diagnostics).
    pub async fn open_count(&self) -> usize {
        self.open.read().await.len()
    }
}

// ---------------------------------------------------------------------------
// Registry use-cases (saved connections)
// ---------------------------------------------------------------------------

/// All saved connections.
pub fn list_connections<R: ConnectionRepository + ?Sized>(
    repository: &R,
) -> Result<Vec<SavedConnection>, AppError> {
    repository.list()
}

/// Insert or update a saved connection. New entries (empty `id`) get a UUID
/// and a `created_at` timestamp; updates keep both. Returns the stored value
/// so the renderer learns the assigned id.
pub fn save_connection<R: ConnectionRepository + ?Sized>(
    repository: &R,
    mut connection: SavedConnection,
) -> Result<SavedConnection, AppError> {
    if connection.name.trim().is_empty() {
        return Err(AppError::Invalid(
            "connection name must not be empty".into(),
        ));
    }
    if connection.engine != connection.params.engine() {
        return Err(AppError::Invalid(format!(
            "engine '{}' does not match the connection parameters (which are for {})",
            connection.engine.display_name(),
            connection.params.engine().display_name(),
        )));
    }
    if connection.id.trim().is_empty() {
        connection.id = uuid::Uuid::new_v4().to_string();
        connection.created_at = Some(now_epoch_ms());
    }
    repository.save(&connection)?;
    Ok(connection)
}

/// Remove a saved connection by id.
pub fn delete_connection<R: ConnectionRepository + ?Sized>(
    repository: &R,
    id: &str,
) -> Result<(), AppError> {
    repository.delete(id)
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Live-connection use-cases
// ---------------------------------------------------------------------------

/// Probe the target without keeping a connection open ("Test connection").
pub async fn test_connection(
    registry: &ConnectorRegistry,
    params: &ConnectionParams,
) -> Result<EngineInfo, AppError> {
    registry.get(params.engine())?.test(params).await
}

/// What `open_connection` opens: either a saved entry or ad-hoc parameters
/// (e.g. "Open SQLite file…" before anything is saved).
pub enum OpenTarget {
    SavedId(String),
    Params(ConnectionParams),
}

/// Everything the renderer needs right after opening a connection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedConnection {
    pub handle_id: ConnectionHandleId,
    pub engine_info: EngineInfo,
    pub schemas: Vec<SchemaInfo>,
}

/// Open a live connection, register it with the manager, and return the
/// opaque handle plus the initial schema list.
pub async fn open_connection<R: ConnectionRepository + ?Sized>(
    repository: &R,
    registry: &ConnectorRegistry,
    manager: &ConnectionManager,
    target: OpenTarget,
) -> Result<OpenedConnection, AppError> {
    let params = match target {
        OpenTarget::Params(params) => params,
        OpenTarget::SavedId(id) => {
            repository
                .get(&id)?
                .ok_or_else(|| AppError::NotFound(format!("saved connection '{id}'")))?
                .params
        }
    };
    let connection = registry.get(params.engine())?.open(&params).await?;
    let engine_info = connection.engine_info();
    let schemas = connection.list_schemas().await?;
    let handle_id = manager.insert(connection).await;
    Ok(OpenedConnection {
        handle_id,
        engine_info,
        schemas,
    })
}

/// Close an open connection and forget its handle.
///
/// Closing an unknown handle is a no-op `Ok(())`, not an error: teardown
/// races are benign (renderer disconnect racing app shutdown's `close_all`,
/// a double-fired close from the UI) and surfacing them would only produce
/// spurious error toasts for a connection that is already gone.
pub async fn close_connection(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<(), AppError> {
    match manager.remove(handle).await {
        Some(connection) => connection.close().await,
        None => Ok(()),
    }
}

/// Schemas visible on an open connection.
pub async fn connection_schemas(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<Vec<SchemaInfo>, AppError> {
    manager.get(handle).await?.list_schemas().await
}

/// Tables in one schema of an open connection.
pub async fn connection_tables(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
) -> Result<Vec<TableInfo>, AppError> {
    manager.get(handle).await?.list_tables(schema).await
}

/// Run SQL on an open connection. Lives here temporarily — M6 (SQL editor)
/// may move query execution into its own slice; the manager + handle seam
/// will stay.
pub async fn run_query(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    sql: &str,
    options: QueryOptions,
) -> Result<QueryResult, AppError> {
    manager.get(handle).await?.run_query(sql, options).await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::features::connections::domain::Env;

    // -- fakes --------------------------------------------------------------

    #[derive(Default)]
    struct FakeRepository {
        items: Mutex<Vec<SavedConnection>>,
    }

    impl ConnectionRepository for FakeRepository {
        fn list(&self) -> Result<Vec<SavedConnection>, AppError> {
            Ok(self.items.lock().unwrap().clone())
        }

        fn get(&self, id: &str) -> Result<Option<SavedConnection>, AppError> {
            Ok(self
                .items
                .lock()
                .unwrap()
                .iter()
                .find(|c| c.id == id)
                .cloned())
        }

        fn save(&self, connection: &SavedConnection) -> Result<(), AppError> {
            let mut items = self.items.lock().unwrap();
            if let Some(existing) = items.iter_mut().find(|c| c.id == connection.id) {
                *existing = connection.clone();
            } else {
                items.push(connection.clone());
            }
            Ok(())
        }

        fn delete(&self, id: &str) -> Result<(), AppError> {
            let mut items = self.items.lock().unwrap();
            let before = items.len();
            items.retain(|c| c.id != id);
            if items.len() == before {
                return Err(AppError::NotFound(format!("saved connection '{id}'")));
            }
            Ok(())
        }
    }

    struct FakeConnection {
        closed: Arc<AtomicBool>,
    }

    #[async_trait]
    impl EngineConnection for FakeConnection {
        fn engine_info(&self) -> EngineInfo {
            EngineInfo {
                engine: Engine::Sqlite,
                server_version: "SQLite 0.0-test".into(),
            }
        }

        async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
            Ok(vec![SchemaInfo {
                name: "main".into(),
                table_count: Some(0),
            }])
        }

        async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, AppError> {
            Ok(vec![])
        }

        async fn table_meta(
            &self,
            _schema: &str,
            _table: &str,
        ) -> Result<crate::shared::engine::TableMeta, AppError> {
            Ok(crate::shared::engine::TableMeta { columns: vec![] })
        }

        async fn run_query(
            &self,
            _sql: &str,
            _options: QueryOptions,
        ) -> Result<QueryResult, AppError> {
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                row_count: 0,
                truncated: false,
                elapsed_ms: 0,
            })
        }

        async fn fetch_rows(
            &self,
            _req: crate::shared::engine::FetchRowsRequest,
        ) -> Result<crate::shared::engine::RowsPage, AppError> {
            Ok(crate::shared::engine::RowsPage {
                columns: vec![],
                rows: vec![],
                offset: 0,
                limit: 0,
                total_rows: Some(0),
                elapsed_ms: 0,
            })
        }

        async fn close(&self) -> Result<(), AppError> {
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    struct FakeConnector {
        opens: AtomicUsize,
        closed_flag: Arc<AtomicBool>,
    }

    #[async_trait]
    impl Connector for FakeConnector {
        async fn test(&self, _params: &ConnectionParams) -> Result<EngineInfo, AppError> {
            Ok(EngineInfo {
                engine: Engine::Sqlite,
                server_version: "SQLite 0.0-test".into(),
            })
        }

        async fn open(
            &self,
            _params: &ConnectionParams,
        ) -> Result<Box<dyn EngineConnection>, AppError> {
            self.opens.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeConnection {
                closed: Arc::clone(&self.closed_flag),
            }))
        }
    }

    fn sqlite_params() -> ConnectionParams {
        ConnectionParams::Sqlite {
            path: "/tmp/x.db".into(),
        }
    }

    fn new_connection(name: &str) -> SavedConnection {
        SavedConnection {
            id: String::new(),
            name: name.into(),
            engine: Engine::Sqlite,
            params: sqlite_params(),
            env: Env::Local,
            created_at: None,
        }
    }

    fn registry_with_fake(closed_flag: Arc<AtomicBool>) -> ConnectorRegistry {
        let mut registry = ConnectorRegistry::new();
        registry.register(
            Engine::Sqlite,
            Arc::new(FakeConnector {
                opens: AtomicUsize::new(0),
                closed_flag,
            }),
        );
        registry
    }

    // -- registry use-cases --------------------------------------------------

    #[test]
    fn save_assigns_uuid_and_created_at_to_new_connections() {
        let repo = FakeRepository::default();
        let saved = save_connection(&repo, new_connection("Dev DB")).expect("save");
        assert!(!saved.id.is_empty());
        assert!(saved.created_at.is_some());
        assert_eq!(list_connections(&repo).unwrap(), vec![saved]);
    }

    #[test]
    fn save_keeps_existing_id_and_updates_in_place() {
        let repo = FakeRepository::default();
        let saved = save_connection(&repo, new_connection("Dev DB")).expect("save");
        let renamed = SavedConnection {
            name: "Renamed".into(),
            ..saved.clone()
        };
        let stored = save_connection(&repo, renamed).expect("update");
        assert_eq!(stored.id, saved.id);
        assert_eq!(stored.created_at, saved.created_at);
        let all = list_connections(&repo).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Renamed");
    }

    #[test]
    fn save_rejects_blank_names_and_engine_params_mismatch() {
        let repo = FakeRepository::default();
        let blank = SavedConnection {
            name: "   ".into(),
            ..new_connection("x")
        };
        assert!(matches!(
            save_connection(&repo, blank),
            Err(AppError::Invalid(_))
        ));

        let mismatched = SavedConnection {
            engine: Engine::Mysql,
            ..new_connection("Dev DB")
        };
        let err = save_connection(&repo, mismatched).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(err.to_string().contains("MySQL"));
    }

    #[test]
    fn delete_removes_and_unknown_id_is_not_found() {
        let repo = FakeRepository::default();
        let saved = save_connection(&repo, new_connection("Dev DB")).expect("save");
        delete_connection(&repo, &saved.id).expect("delete");
        assert!(list_connections(&repo).unwrap().is_empty());
        assert!(matches!(
            delete_connection(&repo, "nope"),
            Err(AppError::NotFound(_))
        ));
    }

    // -- connector registry ----------------------------------------------------

    #[tokio::test]
    async fn unregistered_engines_get_a_human_unsupported_error() {
        let registry = registry_with_fake(Arc::new(AtomicBool::new(false)));
        let params = ConnectionParams::Mysql {
            host: "h".into(),
            port: 3306,
            database: "d".into(),
            user: "u".into(),
            tls: false,
        };
        let err = test_connection(&registry, &params).await.unwrap_err();
        assert!(matches!(err, AppError::Unsupported(_)));
        assert_eq!(
            err.to_string(),
            "MySQL connections arrive in a later milestone."
        );
    }

    // -- manager lifecycle -----------------------------------------------------

    #[tokio::test]
    async fn open_then_close_runs_the_full_lifecycle() {
        let closed = Arc::new(AtomicBool::new(false));
        let registry = registry_with_fake(Arc::clone(&closed));
        let manager = ConnectionManager::new();
        let repo = FakeRepository::default();

        let opened = open_connection(
            &repo,
            &registry,
            &manager,
            OpenTarget::Params(sqlite_params()),
        )
        .await
        .expect("open");
        assert_eq!(opened.engine_info.engine, Engine::Sqlite);
        assert_eq!(opened.schemas.len(), 1);
        assert_eq!(manager.open_count().await, 1);

        // The handle works for follow-up calls.
        let schemas = connection_schemas(&manager, &opened.handle_id)
            .await
            .expect("schemas");
        assert_eq!(schemas[0].name, "main");

        close_connection(&manager, &opened.handle_id)
            .await
            .expect("close");
        assert!(closed.load(Ordering::SeqCst), "close() reached the driver");
        assert_eq!(manager.open_count().await, 0);

        // Using a closed handle is a NotFound with a human message.
        let err = connection_schemas(&manager, &opened.handle_id)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("closed"));

        // Closing again is a benign no-op, not an error: teardown races
        // (double-fired UI close, shutdown's close_all) must stay silent.
        close_connection(&manager, &opened.handle_id)
            .await
            .expect("double close is idempotent");
    }

    #[tokio::test]
    async fn close_all_drains_the_manager_and_closes_every_connection() {
        let manager = ConnectionManager::new();
        let flags: Vec<Arc<AtomicBool>> =
            (0..3).map(|_| Arc::new(AtomicBool::new(false))).collect();
        for flag in &flags {
            manager
                .insert(Box::new(FakeConnection {
                    closed: Arc::clone(flag),
                }))
                .await;
        }
        assert_eq!(manager.open_count().await, 3);

        manager.close_all().await;

        assert_eq!(manager.open_count().await, 0);
        for (index, flag) in flags.iter().enumerate() {
            assert!(
                flag.load(Ordering::SeqCst),
                "connection {index} was not closed"
            );
        }

        // A second close_all on an empty manager is a no-op.
        manager.close_all().await;
        assert_eq!(manager.open_count().await, 0);
    }

    #[tokio::test]
    async fn open_by_saved_id_loads_params_from_the_repository() {
        let closed = Arc::new(AtomicBool::new(false));
        let registry = registry_with_fake(closed);
        let manager = ConnectionManager::new();
        let repo = FakeRepository::default();
        let saved = save_connection(&repo, new_connection("Dev DB")).expect("save");

        let opened = open_connection(
            &repo,
            &registry,
            &manager,
            OpenTarget::SavedId(saved.id.clone()),
        )
        .await
        .expect("open");
        assert_eq!(manager.open_count().await, 1);
        assert_eq!(opened.engine_info.server_version, "SQLite 0.0-test");

        let missing = open_connection(
            &repo,
            &registry,
            &manager,
            OpenTarget::SavedId("ghost".into()),
        )
        .await
        .unwrap_err();
        assert!(matches!(missing, AppError::NotFound(_)));
    }
}
