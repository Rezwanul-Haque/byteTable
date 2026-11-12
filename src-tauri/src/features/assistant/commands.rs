//! Tauri commands for the assistant slice (M44). Deserialize → use-case →
//! serialize; no logic here. The managed [`AssistantState`] holds the
//! adapters chosen in `lib.rs` and the slice's registries — parked prompts,
//! per-send cancel tokens, the schema-snapshot cache — the way
//! `GenerateState` holds its cancel flags.
//!
//! The assistant's keys arrive WITH each call (`settings`), as the renderer
//! holds them at that moment, rather than being read back from the
//! `settings.json` mirror. The mirror is written by the same renderer,
//! fire-and-forget, so reading it added no trust — only a window where a
//! just-flipped switch had not landed yet, and a silent failure mode when a
//! save didn't land at all ("the assistant is off" with it switched on). What
//! the renderer can't vouch for is still resolved here: whether the handle's
//! connection is production comes from the connection registry.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::features::connections::secrets::SecretStore;
use crate::features::settings::domain::AiSettings;
use crate::shared::error::AppError;

use super::application::{
    self, Described, KeyInfo, LogPage, ModelsReport, Parked, PrepareRequest, Prepared,
    ProviderFactory, SchemaTable, SnapshotCache, StreamEvent, TestReport,
};
use super::ports::{KeyIndex, PromptLog};

/// Bound on parked prompts: a renderer that prepares and never sends must not
/// grow the registry without limit.
const MAX_PARKED: usize = 64;

/// Managed state, registered in `lib.rs`.
pub struct AssistantState {
    factory: Box<dyn ProviderFactory>,
    secrets: Arc<dyn SecretStore>,
    keys: Box<dyn KeyIndex>,
    log: Box<dyn PromptLog>,
    parked: Mutex<HashMap<String, Parked>>,
    inflight: Mutex<HashMap<String, CancellationToken>>,
    snapshots: SnapshotCache,
}

impl AssistantState {
    pub fn new(
        factory: Box<dyn ProviderFactory>,
        secrets: Arc<dyn SecretStore>,
        keys: Box<dyn KeyIndex>,
        log: Box<dyn PromptLog>,
    ) -> Self {
        Self {
            factory,
            secrets,
            keys,
            log,
            parked: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            snapshots: SnapshotCache::default(),
        }
    }

    /// Park a built prompt under a fresh id, evicting the oldest when full.
    fn park(&self, parked: Parked) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let mut map = self.parked.lock().unwrap();
        if map.len() >= MAX_PARKED {
            if let Some(oldest) = map.iter().min_by_key(|(_, p)| p.at).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
        map.insert(id.clone(), parked);
        id
    }

    /// Take a parked prompt out — it is sent at most once.
    fn take(&self, id: &str) -> Result<Parked, AppError> {
        self.parked.lock().unwrap().remove(id).ok_or_else(|| {
            AppError::NotFound("That prompt is no longer waiting; send it again.".into())
        })
    }

    fn register(&self, id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.inflight
            .lock()
            .unwrap()
            .insert(id.to_string(), token.clone());
        token
    }

    fn finish(&self, id: &str) {
        self.inflight.lock().unwrap().remove(id);
    }
}

/// The destination rule and lock state for display, under the settings the
/// renderer is showing. Gates nothing.
#[tauri::command]
pub fn assistant_describe(
    settings: AiSettings,
    production: bool,
    connection_id: Option<String>,
) -> Described {
    application::describe(&settings, production, connection_id.as_deref())
}

/// Base tables of a schema with their column and index names. Structure only.
#[tauri::command]
pub async fn assistant_schema(
    state: State<'_, AssistantState>,
    conns: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
) -> Result<Vec<SchemaTable>, AppError> {
    application::schema_tables(conns.manager(), &state.snapshots, &handle_id, &schema).await
}

/// Build and park the exact prompt for one message. Sends nothing.
#[tauri::command]
pub async fn assistant_prepare(
    state: State<'_, AssistantState>,
    conns: State<'_, ConnectionsState>,
    settings: AiSettings,
    request: PrepareRequest,
) -> Result<Prepared, AppError> {
    let ws = application::workspace_of(
        conns.manager(),
        conns.repository(),
        &request.handle_id,
        request.connection_id.clone(),
    )
    .await;
    let prompt =
        application::prepare(conns.manager(), &state.snapshots, &settings, &ws, &request).await?;
    let id = state.park(Parked::new(
        request.kind,
        request.handle_id,
        request.connection_id,
        &prompt,
    ));
    Ok(Prepared { id, prompt })
}

/// Send a parked prompt; the reply streams through `on_event`.
#[tauri::command]
pub async fn assistant_send(
    state: State<'_, AssistantState>,
    conns: State<'_, ConnectionsState>,
    settings: AiSettings,
    id: String,
    on_event: Channel<StreamEvent>,
) -> Result<(), AppError> {
    let parked = state.take(&id)?;
    let ws = application::workspace_of(
        conns.manager(),
        conns.repository(),
        &parked.handle,
        parked.connection_id.clone(),
    )
    .await;
    let sink = move |e: StreamEvent| {
        let _ = on_event.send(e);
    };
    let cancel = state.register(&id);
    let result = application::send(
        state.factory.as_ref(),
        state.secrets.as_ref(),
        state.log.as_ref(),
        &settings,
        &ws,
        parked,
        cancel,
        &sink,
    )
    .await;
    state.finish(&id);
    result
}

/// Abort an in-flight send. The HTTP request is dropped mid-stream.
#[tauri::command]
pub fn assistant_cancel(state: State<'_, AssistantState>, id: String) {
    if let Some(t) = state.inflight.lock().unwrap().get(&id) {
        t.cancel();
    }
}

/// Drop a parked prompt the user cancelled in review.
#[tauri::command]
pub fn assistant_discard(state: State<'_, AssistantState>, id: String) {
    state.parked.lock().unwrap().remove(&id);
}

#[tauri::command]
pub async fn assistant_models(
    state: State<'_, AssistantState>,
    settings: AiSettings,
    connection_id: Option<String>,
) -> Result<ModelsReport, AppError> {
    application::models(
        state.factory.as_ref(),
        state.secrets.as_ref(),
        &settings,
        connection_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn assistant_test(
    state: State<'_, AssistantState>,
    settings: AiSettings,
    connection_id: Option<String>,
) -> Result<TestReport, AppError> {
    application::test(
        state.factory.as_ref(),
        state.secrets.as_ref(),
        state.log.as_ref(),
        &settings,
        connection_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub fn assistant_key_info(
    state: State<'_, AssistantState>,
    account: String,
) -> Result<KeyInfo, AppError> {
    application::key_info(state.secrets.as_ref(), state.keys.as_ref(), &account)
}

#[tauri::command]
pub fn assistant_key_set(
    state: State<'_, AssistantState>,
    account: String,
    key: String,
) -> Result<KeyInfo, AppError> {
    application::key_set(state.secrets.as_ref(), state.keys.as_ref(), &account, &key)
}

#[tauri::command]
pub fn assistant_key_remove(
    state: State<'_, AssistantState>,
    account: String,
) -> Result<KeyInfo, AppError> {
    application::key_remove(state.secrets.as_ref(), state.keys.as_ref(), &account)
}

#[tauri::command]
pub fn assistant_log_read(
    state: State<'_, AssistantState>,
    limit: Option<usize>,
) -> Result<LogPage, AppError> {
    application::log_read(state.log.as_ref(), limit.unwrap_or(50))
}

#[tauri::command]
pub fn assistant_log_clear(state: State<'_, AssistantState>) -> Result<(), AppError> {
    application::log_clear(state.log.as_ref())
}
