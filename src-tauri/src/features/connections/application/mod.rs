//! Use-cases for the connections slice. Depend on domain + ports + the
//! shared engine abstraction only — no Tauri, no drivers.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::shared::engine::{
    ConnectSecret, ConnectionParams, Connector, Engine, EngineConnection, EngineInfo, QueryOptions,
    QueryResult, SchemaInfo, TableInfo,
};
use crate::shared::error::AppError;

use super::domain::SavedConnection;
use super::ports::ConnectionRepository;
use super::secrets::{self as secrets_mod, SecretStore};

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

/// The transient secrets the connect modal may supply on save/open/test: the
/// database password and (for a tunnelled connection) the SSH secret (private-
/// key passphrase or bastion password). Both optional and empty-strings are
/// treated as absent (so re-saving without retyping keeps the stored secret).
#[derive(Default, Clone)]
pub struct TransientSecrets {
    pub password: Option<String>,
    pub ssh: Option<String>,
}

impl TransientSecrets {
    /// Build from the raw optional command args, dropping empty strings.
    pub fn new(password: Option<String>, ssh: Option<String>) -> Self {
        let clean = |s: Option<String>| s.filter(|v| !v.is_empty());
        Self {
            password: clean(password),
            ssh: clean(ssh),
        }
    }

    fn is_empty(&self) -> bool {
        self.password.is_none() && self.ssh.is_none()
    }
}

/// Insert or update a saved connection, persisting any supplied secrets to the
/// keychain keyed by the (now-assigned) connection id. New entries (empty `id`)
/// get a UUID and a `created_at` timestamp; updates keep both. The JSON repo
/// stores only non-secret params; the db password → keychain account `{id}`,
/// the SSH secret → `{id}:ssh`. Returns the stored value so the renderer learns
/// the assigned id.
///
/// Secret policy: only secrets the modal actually supplied are written (empty
/// = absent), so re-saving a connection without retyping the password keeps the
/// previously stored secret. SQLite connections carry no secrets — `secrets` is
/// empty and the keychain is untouched.
pub fn save_connection<R: ConnectionRepository + ?Sized, S: SecretStore + ?Sized>(
    repository: &R,
    secret_store: &S,
    mut connection: SavedConnection,
    secrets: &TransientSecrets,
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

    // Persist secrets only after the id is settled, and only the ones supplied.
    if let Some(password) = &secrets.password {
        secret_store.set(&secrets_mod::db_account(&connection.id), password)?;
    }
    if let Some(ssh) = &secrets.ssh {
        secret_store.set(&secrets_mod::ssh_account(&connection.id), ssh)?;
    }
    Ok(connection)
}

/// Remove a saved connection by id, deleting its keychain secrets too (best
/// effort: a missing keychain entry is not an error).
pub fn delete_connection<R: ConnectionRepository + ?Sized, S: SecretStore + ?Sized>(
    repository: &R,
    secret_store: &S,
    id: &str,
) -> Result<(), AppError> {
    repository.delete(id)?;
    secret_store.delete(&secrets_mod::db_account(id))?;
    secret_store.delete(&secrets_mod::ssh_account(id))?;
    Ok(())
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
///
/// Uses ONLY the transiently-typed secrets (the modal's password / SSH secret)
/// — testing happens before save, so the keychain is never read or written
/// here. SQLite ignores secrets (default `Connector` impl).
pub async fn test_connection(
    registry: &ConnectorRegistry,
    params: &ConnectionParams,
    secrets: &TransientSecrets,
) -> Result<EngineInfo, AppError> {
    let secret = connect_secret_from(secrets);
    registry
        .get(params.engine())?
        .test_with_secret(params, secret.as_ref())
        .await
}

/// Build a [`ConnectSecret`] from transient secrets, or `None` when both are
/// absent (so SQLite and direct passwordless connections pass `None`).
fn connect_secret_from(secrets: &TransientSecrets) -> Option<ConnectSecret> {
    if secrets.is_empty() {
        None
    } else {
        Some(ConnectSecret::with_ssh(
            secrets.password.clone(),
            secrets.ssh.clone(),
        ))
    }
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
///
/// Secret sourcing (M12 Task 3): for a saved connection, the db password is
/// read from keychain account `{id}` and the SSH secret from `{id}:ssh`; a
/// transiently-typed secret (first connect, before save) takes precedence so
/// the modal's "Open" works before anything is stored. For an ad-hoc params
/// target (no id — e.g. "Open SQLite file…") only the transient secrets apply.
/// SQLite carries no secrets.
pub async fn open_connection<R: ConnectionRepository + ?Sized, S: SecretStore + ?Sized>(
    repository: &R,
    registry: &ConnectorRegistry,
    secret_store: &S,
    manager: &ConnectionManager,
    target: OpenTarget,
    transient: &TransientSecrets,
) -> Result<OpenedConnection, AppError> {
    let (params, saved_id) = match target {
        OpenTarget::Params(params) => (params, None),
        OpenTarget::SavedId(id) => {
            let params = repository
                .get(&id)?
                .ok_or_else(|| AppError::NotFound(format!("saved connection '{id}'")))?
                .params;
            (params, Some(id))
        }
    };

    // Merge keychain-stored secrets with transient ones (transient wins).
    let secret = resolve_open_secret(secret_store, saved_id.as_deref(), transient)?;

    let connection = registry
        .get(params.engine())?
        .open_with_secret(&params, secret.as_ref())
        .await?;
    let engine_info = connection.engine_info();
    let schemas = connection.list_schemas().await?;
    let handle_id = manager.insert(connection).await;
    Ok(OpenedConnection {
        handle_id,
        engine_info,
        schemas,
    })
}

/// Resolve the effective [`ConnectSecret`] for an open: keychain values for a
/// saved id, overridden by any transiently-typed secret. Returns `None` when
/// nothing applies (SQLite, passwordless direct connections).
fn resolve_open_secret<S: SecretStore + ?Sized>(
    secret_store: &S,
    saved_id: Option<&str>,
    transient: &TransientSecrets,
) -> Result<Option<ConnectSecret>, AppError> {
    let mut password = transient.password.clone();
    let mut ssh = transient.ssh.clone();
    if let Some(id) = saved_id {
        if password.is_none() {
            password = secret_store.get(&secrets_mod::db_account(id))?;
        }
        if ssh.is_none() {
            ssh = secret_store.get(&secrets_mod::ssh_account(id))?;
        }
    }
    if password.is_none() && ssh.is_none() {
        Ok(None)
    } else {
        Ok(Some(ConnectSecret::with_ssh(password, ssh)))
    }
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
            Ok(crate::shared::engine::TableMeta::default())
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

    use super::super::secrets::{db_account, ssh_account, InMemorySecretStore};

    fn no_secrets() -> TransientSecrets {
        TransientSecrets::default()
    }

    fn server_connection(name: &str) -> SavedConnection {
        let params = ConnectionParams::Postgres {
            host: "db".into(),
            port: 5432,
            database: "app".into(),
            user: "u".into(),
            tls_mode: crate::shared::engine::TlsMode::Disable,
            ssh: None,
        };
        SavedConnection {
            id: String::new(),
            name: name.into(),
            engine: Engine::Postgres,
            params,
            env: Env::Local,
            created_at: None,
        }
    }

    // -- registry use-cases --------------------------------------------------

    #[test]
    fn save_assigns_uuid_and_created_at_to_new_connections() {
        let repo = FakeRepository::default();
        let store = InMemorySecretStore::default();
        let saved =
            save_connection(&repo, &store, new_connection("Dev DB"), &no_secrets()).expect("save");
        assert!(!saved.id.is_empty());
        assert!(saved.created_at.is_some());
        assert_eq!(list_connections(&repo).unwrap(), vec![saved]);
    }

    #[test]
    fn save_keeps_existing_id_and_updates_in_place() {
        let repo = FakeRepository::default();
        let store = InMemorySecretStore::default();
        let saved =
            save_connection(&repo, &store, new_connection("Dev DB"), &no_secrets()).expect("save");
        let renamed = SavedConnection {
            name: "Renamed".into(),
            ..saved.clone()
        };
        let stored = save_connection(&repo, &store, renamed, &no_secrets()).expect("update");
        assert_eq!(stored.id, saved.id);
        assert_eq!(stored.created_at, saved.created_at);
        let all = list_connections(&repo).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Renamed");
    }

    #[test]
    fn save_rejects_blank_names_and_engine_params_mismatch() {
        let repo = FakeRepository::default();
        let store = InMemorySecretStore::default();
        let blank = SavedConnection {
            name: "   ".into(),
            ..new_connection("x")
        };
        assert!(matches!(
            save_connection(&repo, &store, blank, &no_secrets()),
            Err(AppError::Invalid(_))
        ));

        let mismatched = SavedConnection {
            engine: Engine::Mysql,
            ..new_connection("Dev DB")
        };
        let err = save_connection(&repo, &store, mismatched, &no_secrets()).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(err.to_string().contains("MySQL"));
    }

    #[test]
    fn save_stores_supplied_secrets_in_the_keychain_keyed_by_id() {
        let repo = FakeRepository::default();
        let store = InMemorySecretStore::default();
        let secrets = TransientSecrets::new(Some("pw".into()), Some("ssh-pass".into()));
        let saved =
            save_connection(&repo, &store, server_connection("Prod"), &secrets).expect("save");
        assert_eq!(
            store.get(&db_account(&saved.id)).unwrap().as_deref(),
            Some("pw")
        );
        assert_eq!(
            store.get(&ssh_account(&saved.id)).unwrap().as_deref(),
            Some("ssh-pass")
        );

        // Re-saving WITHOUT secrets leaves the stored ones untouched (empty =
        // absent → keep the keychain value, so the user need not retype).
        let resaved = save_connection(
            &repo,
            &store,
            SavedConnection {
                name: "Prod 2".into(),
                ..saved.clone()
            },
            &TransientSecrets::new(Some(String::new()), None),
        )
        .expect("re-save");
        assert_eq!(
            store.get(&db_account(&resaved.id)).unwrap().as_deref(),
            Some("pw")
        );
    }

    #[test]
    fn delete_removes_and_clears_keychain_and_unknown_id_is_not_found() {
        let repo = FakeRepository::default();
        let store = InMemorySecretStore::default();
        let secrets = TransientSecrets::new(Some("pw".into()), Some("ssh".into()));
        let saved =
            save_connection(&repo, &store, server_connection("Prod"), &secrets).expect("save");
        delete_connection(&repo, &store, &saved.id).expect("delete");
        assert!(list_connections(&repo).unwrap().is_empty());
        // Both keychain accounts are cleared.
        assert_eq!(store.get(&db_account(&saved.id)).unwrap(), None);
        assert_eq!(store.get(&ssh_account(&saved.id)).unwrap(), None);
        // Unknown id → NotFound from the repo (delete runs repo first).
        assert!(matches!(
            delete_connection(&repo, &store, "nope"),
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
            tls_mode: crate::shared::engine::TlsMode::Disable,
            ssh: None,
        };
        let err = test_connection(&registry, &params, &no_secrets())
            .await
            .unwrap_err();
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

        let store = InMemorySecretStore::default();
        let opened = open_connection(
            &repo,
            &registry,
            &store,
            &manager,
            OpenTarget::Params(sqlite_params()),
            &no_secrets(),
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
        let store = InMemorySecretStore::default();
        let saved =
            save_connection(&repo, &store, new_connection("Dev DB"), &no_secrets()).expect("save");

        let opened = open_connection(
            &repo,
            &registry,
            &store,
            &manager,
            OpenTarget::SavedId(saved.id.clone()),
            &no_secrets(),
        )
        .await
        .expect("open");
        assert_eq!(manager.open_count().await, 1);
        assert_eq!(opened.engine_info.server_version, "SQLite 0.0-test");

        let missing = open_connection(
            &repo,
            &registry,
            &store,
            &manager,
            OpenTarget::SavedId("ghost".into()),
            &no_secrets(),
        )
        .await
        .unwrap_err();
        assert!(matches!(missing, AppError::NotFound(_)));
    }

    // -- secret resolution on open -------------------------------------------

    #[test]
    fn resolve_open_secret_merges_keychain_and_transient() {
        let store = InMemorySecretStore::default();
        store.set(&db_account("id1"), "stored-pw").unwrap();
        store.set(&ssh_account("id1"), "stored-ssh").unwrap();

        // No transient → keychain values are used.
        let secret = resolve_open_secret(&store, Some("id1"), &no_secrets())
            .unwrap()
            .expect("some secret");
        assert_eq!(secret.password(), Some("stored-pw"));
        assert_eq!(secret.ssh(), Some("stored-ssh"));

        // A transient password overrides the stored one (first connect / retype).
        let transient = TransientSecrets::new(Some("typed".into()), None);
        let secret = resolve_open_secret(&store, Some("id1"), &transient)
            .unwrap()
            .expect("some secret");
        assert_eq!(secret.password(), Some("typed"));
        // ssh still falls back to the keychain.
        assert_eq!(secret.ssh(), Some("stored-ssh"));

        // No id and no transient → nothing applies (SQLite / passwordless).
        assert!(resolve_open_secret(&store, None, &no_secrets())
            .unwrap()
            .is_none());
    }
}
