//! Use-cases for the assistant slice (M44). Free functions over their
//! collaborators — the connection manager, a provider factory, the keychain
//! port, the prompt log — like the other slices' application layers; the
//! command layer owns the registries (parked prompts, cancel tokens, the
//! snapshot cache) and passes in what each call needs.
//!
//! The flow every message takes:
//!
//! 1. **prepare** — introspect the schema and build the exact prompt
//!    ([`prompt::build_prompt`]). The command parks it under an id and the
//!    renderer shows that text in review. Nothing leaves the machine.
//! 2. **send** — re-check every gate against the *current* settings, log the
//!    parked text, hand that same text to the provider and stream the reply.
//!    The bytes reviewed, sent, logged and kept on the receipt are one string,
//!    built once (§4: "build once, show, send").
//!
//! The hard gates (Task A8) live here, not in the UI: the assistant is off →
//! no provider is even constructed; a locked production workspace, a request
//! for rows on production, or an endpoint that is not fully set up → refused.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::features::connections::domain::Env;
use crate::features::connections::ports::ConnectionRepository;
use crate::features::connections::secrets::SecretStore;
use crate::features::settings::domain::AiSettings;
use crate::shared::engine::{Engine, FetchRowsRequest, TableMeta};
use crate::shared::error::AppError;

use super::domain::dest::{self, AiState, Dest, HostOf, ProviderKind, KEY_ACCOUNTS};
use super::domain::prompt::{
    self, ColumnSnap, IndexSnap, PlanText, Prompt, PromptInput, PromptKind, RowSample,
    SchemaSnapshot, TableSnap,
};
use super::domain::{mask_key, LogEntry};
use super::infrastructure::{keychain_name, AnthropicProvider, OllamaProvider, OpenAiProvider};
use super::ports::{KeyIndex, ModelInfo, ModelProvider, PromptLog, ProviderError};

/// Builds the provider for a destination. A seam so tests can count calls.
pub trait ProviderFactory: Send + Sync {
    fn build(&self, d: &Dest, key: Option<String>) -> Result<Box<dyn ModelProvider>, AppError>;
}

/// The real factory: one shared HTTP client for every adapter.
pub struct HttpProviderFactory {
    client: reqwest::Client,
}

impl HttpProviderFactory {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

impl ProviderFactory for HttpProviderFactory {
    fn build(&self, d: &Dest, key: Option<String>) -> Result<Box<dyn ModelProvider>, AppError> {
        let c = self.client.clone();
        Ok(match d.kind {
            ProviderKind::Ollama => {
                Box::new(OllamaProvider::new(c, &d.base_url, &d.host, &d.model))
            }
            ProviderKind::OpenAi => {
                // LM Studio's "loaded model" placeholder means: ask the endpoint.
                let model = if d.via == "LM Studio" && d.model == "loaded model" {
                    ""
                } else {
                    &d.model
                };
                Box::new(OpenAiProvider::new(c, &d.base_url, &d.host, model, key))
            }
            ProviderKind::Anthropic => {
                let key =
                    key.ok_or_else(|| AppError::Invalid("No Anthropic key is saved.".into()))?;
                Box::new(AnthropicProvider::new(
                    c,
                    &d.base_url,
                    &d.host,
                    &d.model,
                    key,
                ))
            }
        })
    }
}

/// Whether the workspace behind a handle is production, and its saved id —
/// resolved by the backend from the handle, never taken from the renderer.
#[derive(Debug, Clone, Default)]
pub struct Workspace {
    pub production: bool,
    pub connection_id: Option<String>,
}

/// Resolve the workspace behind `handle` from the backend's own records: the
/// saved connection the handle was opened from, and that entry's env.
///
/// A handle opened ad hoc (an "Open SQLite file…" path, saved to the registry
/// only after it opened) has no origin; it is not production, and its
/// connection id — which the per-connection switch is keyed by — is the one
/// the renderer gives (`fallback`). A handle WITH an origin ignores `fallback`,
/// so the production lock is always the registry's answer.
pub async fn workspace_of<R: ConnectionRepository + ?Sized>(
    manager: &ConnectionManager,
    repository: &R,
    handle: &ConnectionHandleId,
    fallback: Option<String>,
) -> Workspace {
    let Some(id) = manager.origin(handle).await else {
        return Workspace {
            production: false,
            connection_id: fallback,
        };
    };
    let production = repository
        .get(&id)
        .ok()
        .flatten()
        .is_some_and(|c| c.env == Env::Production);
    Workspace {
        production,
        connection_id: Some(id),
    }
}

/// A parked prompt awaiting Send.
#[derive(Debug, Clone)]
pub struct Parked {
    pub kind: PromptKind,
    pub text: String,
    pub tokens: u32,
    pub rows: bool,
    pub handle: ConnectionHandleId,
    /// The renderer's connection id, for a handle with no saved origin.
    pub connection_id: Option<String>,
    pub at: Instant,
}

impl Parked {
    pub fn new(
        kind: PromptKind,
        handle: ConnectionHandleId,
        connection_id: Option<String>,
        built: &Prompt,
    ) -> Self {
        Self {
            kind,
            text: built.text.clone(),
            tokens: built.tokens,
            rows: !built.row_tables.is_empty(),
            handle,
            connection_id,
            at: Instant::now(),
        }
    }
}

/// Schema snapshots are reused for this long (the drawer's table chip and the
/// next prompt read the same introspection).
const SNAPSHOT_TTL_SECS: u64 = 30;
/// Introspect at most this many tables concurrently.
const META_CONCURRENCY: usize = 8;

/// A short-lived cache of introspected schemas, keyed by handle + schema.
#[derive(Default)]
pub struct SnapshotCache {
    entries: tokio::sync::Mutex<HashMap<(ConnectionHandleId, String), (Instant, SchemaSnapshot)>>,
}

impl SnapshotCache {
    async fn get(&self, handle: &ConnectionHandleId, schema: &str) -> Option<SchemaSnapshot> {
        let entries = self.entries.lock().await;
        let (at, snap) = entries.get(&(handle.clone(), schema.to_string()))?;
        (at.elapsed().as_secs() < SNAPSHOT_TTL_SECS).then(|| snap.clone())
    }

    async fn put(&self, handle: &ConnectionHandleId, snap: &SchemaSnapshot) {
        self.entries.lock().await.insert(
            (handle.clone(), snap.name.clone()),
            (Instant::now(), snap.clone()),
        );
    }
}

/// What a message asks the backend to build.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    pub handle_id: ConnectionHandleId,
    pub schema: String,
    pub kind: PromptKind,
    #[serde(default)]
    pub scope: Vec<String>,
    #[serde(default)]
    pub request: String,
    #[serde(default)]
    pub sql: String,
    #[serde(default)]
    pub prev_sql: Option<String>,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub row_data: bool,
    /// Tables the message @-mentions: when any is a real table, the message's
    /// scope is those tables plus their foreign-key targets, not the ticked set.
    #[serde(default)]
    pub focus: Vec<String>,
    /// The workspace's saved-connection id as the renderer knows it — used
    /// only when the handle has no saved origin (see [`workspace_of`]).
    #[serde(default)]
    pub connection_id: Option<String>,
}

/// The parked prompt as the review shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub id: String,
    #[serde(flatten)]
    pub prompt: Prompt,
}

/// One streamed event of a send.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum StreamEvent {
    Token {
        text: String,
    },
    Done {
        ms: u64,
    },
    Cancelled,
    /// `kind`: `unreachable` (nothing was sent), `auth`, `failed`, `setup`
    /// (endpoint not fully set up — nothing was sent), `refused` (a gate).
    Error {
        kind: String,
        message: String,
    },
}

impl StreamEvent {
    fn error(kind: &str, message: impl Into<String>) -> Self {
        Self::Error {
            kind: kind.into(),
            message: message.into(),
        }
    }
    fn provider(e: ProviderError) -> Self {
        match e {
            ProviderError::Unreachable(m) => Self::error("unreachable", m),
            ProviderError::Auth(m) => Self::error("auth", m),
            ProviderError::Failed(m) => Self::error("failed", m),
        }
    }
}

/// A table name plus its column names, for the drawer's table chip and the
/// renderer's local validation of generated SQL.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTable {
    pub name: String,
    pub columns: Vec<String>,
    pub indexes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsReport {
    pub reachable: bool,
    pub models: Vec<ModelInfo>,
    pub error: Option<ProviderError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub ok: bool,
    pub ms: u64,
    pub error: Option<ProviderError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub account: String,
    /// `sk-ant-••••3f9a` — the only form of a key the renderer ever sees.
    pub masked: Option<String>,
    pub keychain: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub total: usize,
    pub entries: Vec<LogEntry>,
}

/// The destination rule and the lock state, for display. The renderer never
/// re-implements either: it asks here, with the settings it is showing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Described {
    pub dest: Dest,
    pub state: AiState,
    pub rows_allowed: bool,
    /// The named runtime's endpoint (Ollama or LM Studio, whichever is picked).
    pub runtime: HostOf,
    /// The custom endpoint.
    pub custom: HostOf,
}

/// Describe the assistant under `ai` for one workspace. Pure: it gates
/// nothing — [`gate`] does, on every call that reaches a model.
pub fn describe(ai: &AiSettings, production: bool, connection_id: Option<&str>) -> Described {
    let runtime_url = if ai.ai_runtime == "lmstudio" {
        &ai.ai_lm_url
    } else {
        &ai.ai_ollama_url
    };
    Described {
        dest: dest::dest(ai),
        state: dest::state_for(ai, production, connection_id),
        rows_allowed: dest::rows_allowed(production),
        runtime: dest::host_of(runtime_url),
        custom: dest::host_of(&ai.ai_custom_url),
    }
}

/// The gate every call passes (Task A8). `Err` carries the refusal message.
pub fn gate(ai: &AiSettings, ws: &Workspace) -> Result<(), AppError> {
    match dest::state_for(ai, ws.production, ws.connection_id.as_deref()) {
        AiState::Off => Err(AppError::Unsupported(
            "The assistant is off for this workspace. Turn it on in Settings → AI assistant."
                .into(),
        )),
        AiState::Locked => Err(AppError::Unsupported(
            "The assistant is off for this production workspace.".into(),
        )),
        AiState::On => Ok(()),
    }
}

/// The gate for calls that are about the endpoint, not a workspace's data
/// (model discovery, Test): only the switch for the active workspace matters.
/// No workspace open = off = no call.
fn off_gate(ai: &AiSettings, connection_id: Option<&str>) -> Result<(), AppError> {
    if dest::enabled_for(ai, connection_id) {
        Ok(())
    } else {
        Err(AppError::Unsupported(
            "The assistant is off for this workspace. Turn it on in Settings → AI assistant."
                .into(),
        ))
    }
}

fn rows_refusal() -> AppError {
    AppError::Unsupported("Row data is never sent from a production workspace.".into())
}

/// The dialect named in `[system]`: `PostgreSQL 16.4`.
pub fn dialect(engine: Engine, server_version: &str) -> String {
    let name = match engine {
        Engine::Postgres => "PostgreSQL",
        Engine::Mysql => "MySQL",
        Engine::Sqlite => "SQLite",
        Engine::Mssql => "SQL Server",
        Engine::Clickhouse => "ClickHouse",
        _ => "SQL",
    };
    // The first version-looking word, wherever the engine put it.
    let version = server_version
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|w| w.trim_end_matches([',', ';']));
    match version {
        Some(v) => format!("{name} {v}"),
        None => name.to_string(),
    }
}

/// Convert introspected metadata into the snapshot the prompt prints.
pub fn table_snap(name: &str, meta: &TableMeta) -> TableSnap {
    let unique_single = |col: &str| {
        meta.indexes
            .iter()
            .any(|i| i.unique && !i.primary && i.columns.len() == 1 && i.columns[0] == col)
    };
    TableSnap {
        name: name.to_string(),
        comment: meta.comment.clone(),
        columns: meta
            .columns
            .iter()
            .map(|c| ColumnSnap {
                name: c.name.clone(),
                data_type: c.data_type.clone(),
                pk: c.pk,
                unique: !c.pk && unique_single(&c.name),
                fk: c.fk.as_ref().map(|f| format!("{}.{}", f.table, f.column)),
                comment: c.comment.clone(),
            })
            .collect(),
        indexes: meta
            .indexes
            .iter()
            .map(|i| IndexSnap {
                name: i.name.clone(),
                primary: i.primary,
            })
            .collect(),
    }
}

fn plan_lines(columns: &[String], rows: &[Vec<serde_json::Value>], text: bool) -> Vec<String> {
    let cell = |v: &serde_json::Value| match v {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if text {
        return rows
            .iter()
            .flat_map(|r| {
                r.first()
                    .map(cell)
                    .unwrap_or_default()
                    .split('\n')
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .collect();
    }
    rows.iter()
        .map(|r| {
            columns
                .iter()
                .zip(r)
                .filter(|(_, v)| !v.is_null())
                .map(|(c, v)| format!("{c}={}", cell(v)))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect()
}

/// Introspect every base table of `schema` (briefly cached unless `fresh`).
pub async fn snapshot(
    manager: &ConnectionManager,
    cache: &SnapshotCache,
    handle: &ConnectionHandleId,
    schema: &str,
    fresh: bool,
) -> Result<SchemaSnapshot, AppError> {
    if !fresh {
        if let Some(snap) = cache.get(handle, schema).await {
            return Ok(snap);
        }
    }
    let conn = manager.get_sql(handle).await?;
    let tables = conn.list_tables(schema).await?;
    // Futures are built up front (owned data only) so the buffered stream
    // holds no borrowing closure — that keeps the command future `Send`.
    let futures: Vec<_> = tables
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let conn = Arc::clone(&conn);
            let schema = schema.to_string();
            let name = t.name.clone();
            async move {
                // A table whose metadata can't be read still appears by name;
                // the prompt just lists no columns for it.
                let meta = conn.table_meta(&schema, &name).await.unwrap_or_default();
                (i, table_snap(&name, &meta))
            }
        })
        .collect();
    let mut metas: Vec<(usize, TableSnap)> = stream::iter(futures)
        .buffer_unordered(META_CONCURRENCY)
        .collect()
        .await;
    metas.sort_by_key(|(i, _)| *i);
    let snap = SchemaSnapshot {
        name: schema.to_string(),
        tables: metas.into_iter().map(|(_, t)| t).collect(),
    };
    cache.put(handle, &snap).await;
    Ok(snap)
}

/// The drawer's view of the schema: names and columns, never rows.
pub async fn schema_tables(
    manager: &ConnectionManager,
    cache: &SnapshotCache,
    handle: &ConnectionHandleId,
    schema: &str,
) -> Result<Vec<SchemaTable>, AppError> {
    let snap = snapshot(manager, cache, handle, schema, false).await?;
    Ok(snap
        .tables
        .into_iter()
        .map(|t| SchemaTable {
            name: t.name,
            columns: t.columns.into_iter().map(|c| c.name).collect(),
            indexes: t
                .indexes
                .into_iter()
                .filter(|i| !i.primary)
                .map(|i| i.name)
                .collect(),
        })
        .collect())
}

/// Build the exact prompt for one message. Introspects; sends nothing.
pub async fn prepare(
    manager: &ConnectionManager,
    cache: &SnapshotCache,
    ai: &AiSettings,
    ws: &Workspace,
    req: &PrepareRequest,
) -> Result<Prompt, AppError> {
    gate(ai, ws)?;
    let wants_rows = req.row_data && req.kind == PromptKind::Ask;
    if wants_rows && !dest::rows_allowed(ws.production) {
        return Err(rows_refusal());
    }
    let conn = manager.get_sql(&req.handle_id).await?;
    let info = conn.engine_info();
    let engine = dialect(info.engine, &info.server_version);
    let schema = snapshot(manager, cache, &req.handle_id, &req.schema, true).await?;
    let focused = prompt::focus_scope(&schema, &req.focus);
    let scope = if focused.is_empty() {
        req.scope.clone()
    } else {
        focused
    };

    let samples: Option<Vec<RowSample>> = if wants_rows {
        let scope = prompt::scoped(&schema, &scope);
        let prev = req.prev_sql.clone().unwrap_or_default();
        let names = prompt::row_tables_for(&scope, &[&req.request, &req.sql, &prev]);
        let mut out = Vec::new();
        for table in names {
            let page = conn
                .fetch_rows(FetchRowsRequest {
                    schema: req.schema.clone(),
                    table: table.clone(),
                    sort: None,
                    filter: None,
                    offset: 0,
                    limit: ai.ai_sample.clamp(1, 50),
                })
                .await?;
            out.push(RowSample {
                table,
                total: page.total_rows,
                rows: page.rows,
            });
        }
        Some(out)
    } else {
        None
    };

    let plan = if matches!(req.kind, PromptKind::Plan | PromptKind::Index) {
        // Plan-only: the assistant never executes the user's statement.
        Some(
            match crate::features::explain::application::raw(
                manager,
                &req.handle_id,
                &req.sql,
                Some(req.schema.clone()),
                false,
            )
            .await
            {
                Ok(raw) => PlanText::Lines {
                    label: "EXPLAIN · plan only, nothing was executed".into(),
                    lines: plan_lines(&raw.columns, &raw.rows, raw.text),
                },
                Err(e) => PlanText::Unavailable(e.to_string()),
            },
        )
    } else {
        None
    };

    Ok(prompt::build_prompt(
        req.kind,
        &schema,
        &PromptInput {
            engine: &engine,
            scope: &scope,
            request: &req.request,
            sql: &req.sql,
            prev_sql: req.prev_sql.as_deref(),
            error: &req.error,
            comments: ai.ai_comments,
            sample_n: ai.ai_sample,
            rows: samples.as_deref(),
            plan: plan.as_ref(),
        },
    ))
}

fn key_for(secrets: &dyn SecretStore, d: &Dest) -> Result<Option<String>, AppError> {
    match d.key_account {
        Some(account) => secrets.get(account),
        None => Ok(None),
    }
}

/// Send a parked prompt and stream the reply through `sink`, stopping when
/// `cancel` fires (dropping the stream aborts the HTTP request).
// Each collaborator is a distinct port the caller must choose explicitly (same
// reasoning as `generate_run`).
#[allow(clippy::too_many_arguments)]
pub async fn send(
    factory: &dyn ProviderFactory,
    secrets: &dyn SecretStore,
    log: &dyn PromptLog,
    ai: &AiSettings,
    ws: &Workspace,
    parked: Parked,
    cancel: CancellationToken,
    sink: &(dyn Fn(StreamEvent) + Send + Sync),
) -> Result<(), AppError> {
    gate(ai, ws)?;
    if parked.rows && !dest::rows_allowed(ws.production) {
        return Err(rows_refusal());
    }
    let d = dest::dest(ai);
    if !d.ready {
        sink(StreamEvent::error(
            "setup",
            "The model endpoint isn't fully set up, so nothing was sent.",
        ));
        return Ok(());
    }
    let key = key_for(secrets, &d)?;
    if d.kind != ProviderKind::Ollama && d.key_account.is_some() && key.is_none() && !d.custom {
        sink(StreamEvent::error(
            "setup",
            "No API key is saved, so nothing was sent.",
        ));
        return Ok(());
    }
    let provider = factory.build(&d, key)?;

    let t0 = Instant::now();
    let result = provider.complete(&parked.text).await;
    // Logged once the request reached the provider: an unreachable host never
    // received the prompt, so there is nothing to record.
    if ai.ai_log && !matches!(result, Err(ProviderError::Unreachable(_))) {
        let _ = log.append(&LogEntry {
            time: chrono::Local::now().to_rfc3339(),
            kind: parked.kind.as_str().into(),
            tokens: parked.tokens,
            host: d.host.clone(),
            rows: parked.rows,
            text: parked.text.clone(),
        });
    }
    match result {
        Err(e) => sink(StreamEvent::provider(e)),
        Ok(mut tokens) => loop {
            tokio::select! {
                _ = cancel.cancelled() => { sink(StreamEvent::Cancelled); break; }
                item = tokens.next() => match item {
                    Some(Ok(text)) => sink(StreamEvent::Token { text }),
                    Some(Err(e)) => { sink(StreamEvent::provider(e)); break; }
                    None => {
                        sink(StreamEvent::Done { ms: t0.elapsed().as_millis() as u64 });
                        break;
                    }
                },
            }
        },
    }
    Ok(())
}

/// `list_models()` for the current destination. No call at all while the
/// assistant is off — not even model discovery.
pub async fn models(
    factory: &dyn ProviderFactory,
    secrets: &dyn SecretStore,
    ai: &AiSettings,
    connection_id: Option<&str>,
) -> Result<ModelsReport, AppError> {
    off_gate(ai, connection_id)?;
    let d = dest::dest(ai);
    let unreachable = |error: ProviderError| ModelsReport {
        reachable: false,
        models: Vec::new(),
        error: Some(error),
    };
    if !dest::host_of(&d.base_url).ok {
        return Ok(unreachable(ProviderError::Failed(
            "That isn't a full URL.".into(),
        )));
    }
    let key = key_for(secrets, &d)?;
    if d.kind == ProviderKind::Anthropic && key.is_none() {
        return Ok(unreachable(ProviderError::Auth(
            "No API key is saved.".into(),
        )));
    }
    let provider = factory.build(&d, key)?;
    Ok(match provider.list_models().await {
        Ok(models) => ModelsReport {
            reachable: true,
            models,
            error: None,
        },
        Err(e) => unreachable(e),
    })
}

/// Settings' Test button: a key provider is pinged; a model endpoint gets a
/// one-word prompt (logged like any other) and is timed to first token.
pub async fn test(
    factory: &dyn ProviderFactory,
    secrets: &dyn SecretStore,
    log: &dyn PromptLog,
    ai: &AiSettings,
    connection_id: Option<&str>,
) -> Result<TestReport, AppError> {
    off_gate(ai, connection_id)?;
    let failed = |error: ProviderError| TestReport {
        ok: false,
        ms: 0,
        error: Some(error),
    };
    let d = dest::dest(ai);
    if !d.ready {
        return Ok(failed(ProviderError::Failed(
            "The endpoint isn't fully set up.".into(),
        )));
    }
    let key = key_for(secrets, &d)?;
    if ai.ai_provider == "key" && key.is_none() {
        return Ok(failed(ProviderError::Auth("No API key is saved.".into())));
    }
    let provider = factory.build(&d, key)?;
    let t0 = Instant::now();
    if ai.ai_provider == "key" {
        let r = provider.ping().await;
        return Ok(TestReport {
            ok: r.is_ok(),
            ms: t0.elapsed().as_millis() as u64,
            error: r.err(),
        });
    }
    const TEST_PROMPT: &str = "Reply with the single word: ok";
    let result = provider.complete(TEST_PROMPT).await;
    if ai.ai_log && !matches!(result, Err(ProviderError::Unreachable(_))) {
        let _ = log.append(&LogEntry {
            time: chrono::Local::now().to_rfc3339(),
            kind: "test".into(),
            tokens: 8,
            host: d.host.clone(),
            rows: false,
            text: TEST_PROMPT.into(),
        });
    }
    let first = match result {
        Ok(mut s) => s.next().await.unwrap_or(Ok(String::new())).map(|_| ()),
        Err(e) => Err(e),
    };
    Ok(TestReport {
        ok: first.is_ok(),
        ms: t0.elapsed().as_millis() as u64,
        error: first.err(),
    })
}

fn check_account(account: &str) -> Result<(), AppError> {
    if KEY_ACCOUNTS.contains(&account) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("Unknown key '{account}'.")))
    }
}

/// A key's status for the UI, from the key index — NOT the keychain, whose
/// reads can prompt for the user's password. An account the index has never
/// seen (a key saved before the index existed) is read from the keychain once
/// and recorded, so that prompt happens at most once; an account with no key
/// has no keychain item and never prompts.
pub fn key_info(
    secrets: &dyn SecretStore,
    index: &dyn KeyIndex,
    account: &str,
) -> Result<KeyInfo, AppError> {
    check_account(account)?;
    let masked = match index.get(account)? {
        Some(recorded) => recorded,
        None => {
            let label = secrets.get(account)?.map(|k| mask_key(&k));
            index.set(account, label.clone())?;
            label
        }
    };
    Ok(KeyInfo {
        account: account.into(),
        masked,
        keychain: keychain_name(),
    })
}

pub fn key_set(
    secrets: &dyn SecretStore,
    index: &dyn KeyIndex,
    account: &str,
    key: &str,
) -> Result<KeyInfo, AppError> {
    check_account(account)?;
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::Invalid("The key is empty.".into()));
    }
    secrets.set(account, key)?;
    index.set(account, Some(mask_key(key)))?;
    key_info(secrets, index, account)
}

pub fn key_remove(
    secrets: &dyn SecretStore,
    index: &dyn KeyIndex,
    account: &str,
) -> Result<KeyInfo, AppError> {
    check_account(account)?;
    secrets.delete(account)?;
    index.set(account, None)?;
    key_info(secrets, index, account)
}

pub fn log_read(log: &dyn PromptLog, limit: usize) -> Result<LogPage, AppError> {
    let (entries, total) = log.read_last(limit)?;
    Ok(LogPage { total, entries })
}

pub fn log_clear(log: &dyn PromptLog) -> Result<(), AppError> {
    log.clear()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::super::infrastructure::InMemoryKeyIndex;
    use super::super::ports::TokenStream;
    use super::*;
    use crate::features::connections::secrets::InMemorySecretStore;

    #[derive(Default)]
    struct MemLog(Mutex<Vec<LogEntry>>);
    impl PromptLog for MemLog {
        fn append(&self, e: &LogEntry) -> Result<(), AppError> {
            self.0.lock().unwrap().push(e.clone());
            Ok(())
        }
        fn read_last(&self, limit: usize) -> Result<(Vec<LogEntry>, usize), AppError> {
            let all = self.0.lock().unwrap();
            Ok((all.iter().rev().take(limit).cloned().collect(), all.len()))
        }
        fn clear(&self) -> Result<(), AppError> {
            self.0.lock().unwrap().clear();
            Ok(())
        }
    }

    /// Streams `n` tokens, one every 20 ms; records the prompt it was handed.
    struct FakeProvider {
        n: usize,
        seen: Arc<Mutex<Vec<String>>>,
        unreachable: bool,
    }
    #[async_trait]
    impl ModelProvider for FakeProvider {
        async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
            Ok(vec![])
        }
        async fn ping(&self) -> Result<(), ProviderError> {
            Ok(())
        }
        async fn complete(&self, prompt: &str) -> Result<TokenStream, ProviderError> {
            if self.unreachable {
                return Err(ProviderError::Unreachable(
                    "Can't reach gateway.example".into(),
                ));
            }
            self.seen.lock().unwrap().push(prompt.to_string());
            Ok(stream::iter(0..self.n)
                .then(|i| async move {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    Ok(format!("t{i} "))
                })
                .boxed())
        }
    }

    /// The fake factory plus the fake keychain and log one test uses.
    #[derive(Default)]
    struct Rig {
        built: Arc<AtomicUsize>,
        seen: Arc<Mutex<Vec<String>>>,
        n: usize,
        unreachable: bool,
        secrets: InMemorySecretStore,
        log: MemLog,
    }
    impl ProviderFactory for Rig {
        fn build(&self, _d: &Dest, _k: Option<String>) -> Result<Box<dyn ModelProvider>, AppError> {
            self.built.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeProvider {
                n: self.n,
                seen: Arc::clone(&self.seen),
                unreachable: self.unreachable,
            }))
        }
    }

    impl Rig {
        fn new(n: usize, unreachable: bool) -> Self {
            Self {
                n,
                unreachable,
                ..Self::default()
            }
        }
        async fn send(
            &self,
            ai: &AiSettings,
            ws: &Workspace,
            parked: Parked,
            cancel: CancellationToken,
        ) -> (Result<(), AppError>, Vec<StreamEvent>) {
            let ev = Arc::new(Mutex::new(Vec::new()));
            let e2 = Arc::clone(&ev);
            let sink = move |e| e2.lock().unwrap().push(e);
            let r = super::send(
                self,
                &self.secrets,
                &self.log,
                ai,
                ws,
                parked,
                cancel,
                &sink,
            )
            .await;
            let events = ev.lock().unwrap().clone();
            (r, events)
        }
        fn built(&self) -> usize {
            self.built.load(Ordering::SeqCst)
        }
    }

    /// Switched on for the workspaces the tests use ("c1", and "p1" below).
    fn on() -> AiSettings {
        AiSettings {
            ai_enabled_for: [("c1".to_string(), true), ("p1".to_string(), true)].into(),
            ..AiSettings::default()
        }
    }

    /// A dev workspace on connection "c1".
    fn ws() -> Workspace {
        Workspace {
            production: false,
            connection_id: Some("c1".into()),
        }
    }

    fn parked(rows: bool) -> Parked {
        let built = Prompt {
            parts: vec![],
            text: "[system]\nexact bytes".into(),
            tokens: 6,
            tables: 1,
            cols: 1,
            row_tables: if rows { vec!["orders".into()] } else { vec![] },
        };
        Parked::new(
            PromptKind::Ask,
            ConnectionHandleId("h".into()),
            None,
            &built,
        )
    }

    #[tokio::test]
    async fn streams_the_exact_parked_text_and_logs_it() {
        let r = Rig::new(3, false);
        let (res, ev) = r
            .send(&on(), &ws(), parked(false), CancellationToken::new())
            .await;
        res.unwrap();
        assert_eq!(ev.len(), 4);
        assert_eq!(ev[0], StreamEvent::Token { text: "t0 ".into() });
        assert!(matches!(ev[3], StreamEvent::Done { .. }));
        assert_eq!(r.seen.lock().unwrap()[0], "[system]\nexact bytes");
        assert_eq!(r.log.0.lock().unwrap()[0].text, "[system]\nexact bytes");
    }

    #[tokio::test]
    async fn cancel_stops_the_stream_mid_way() {
        let r = Rig::new(50, false);
        let token = CancellationToken::new();
        let t2 = token.clone();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(70)).await;
            t2.cancel();
        });
        let (res, ev) = r.send(&on(), &ws(), parked(false), token).await;
        res.unwrap();
        canceller.await.unwrap();
        assert_eq!(ev.last(), Some(&StreamEvent::Cancelled));
        assert!(ev.len() < 10, "stopped early: {} events", ev.len());
    }

    #[tokio::test]
    async fn off_means_no_provider_is_built_at_all() {
        let r = Rig::new(1, false);
        let off = AiSettings::default();
        let (res, _) = r
            .send(&off, &ws(), parked(false), CancellationToken::new())
            .await;
        assert!(res.is_err());
        assert!(models(&r, &r.secrets, &off, Some("c1")).await.is_err());
        assert!(test(&r, &r.secrets, &r.log, &off, Some("c1"))
            .await
            .is_err());
        // On for c1 does not mean on with no workspace, or on for another one.
        assert!(models(&r, &r.secrets, &on(), None).await.is_err());
        let (res, _) = r
            .send(
                &on(),
                &Workspace {
                    production: false,
                    connection_id: Some("other".into()),
                },
                parked(false),
                CancellationToken::new(),
            )
            .await;
        assert!(res.is_err());
        assert_eq!(r.built(), 0);
    }

    #[tokio::test]
    async fn production_is_locked_and_never_sends_rows() {
        let r = Rig::new(1, false);
        let prod = Workspace {
            production: true,
            connection_id: Some("p1".into()),
        };
        let (res, _) = r
            .send(&on(), &prod, parked(false), CancellationToken::new())
            .await;
        assert!(res.is_err(), "locked");

        let mut allowed = on();
        allowed.ai_allowed.insert("p1".into(), true);
        // A forged prompt carrying rows on an allowed production workspace.
        let (res, _) = r
            .send(&allowed, &prod, parked(true), CancellationToken::new())
            .await;
        let err = res.unwrap_err();
        assert!(err.to_string().contains("Row data"), "{err}");
        assert_eq!(r.built(), 0);

        let (res, _) = r
            .send(&allowed, &prod, parked(false), CancellationToken::new())
            .await;
        res.unwrap();
        assert_eq!(r.built(), 1);
    }

    #[tokio::test]
    async fn an_endpoint_that_is_not_set_up_sends_nothing() {
        let r = Rig::new(1, false);
        let s = AiSettings {
            ai_runtime: "custom".into(),
            ..on()
        };
        let (res, ev) = r
            .send(&s, &ws(), parked(false), CancellationToken::new())
            .await;
        res.unwrap();
        assert!(matches!(&ev[0], StreamEvent::Error { kind, .. } if kind == "setup"));
        assert_eq!(r.built(), 0);
    }

    #[tokio::test]
    async fn an_unreachable_host_is_typed_and_not_logged() {
        let r = Rig::new(1, true);
        let (res, ev) = r
            .send(&on(), &ws(), parked(false), CancellationToken::new())
            .await;
        res.unwrap();
        assert!(matches!(&ev[0], StreamEvent::Error { kind, .. } if kind == "unreachable"));
        assert!(r.log.0.lock().unwrap().is_empty());
    }

    /// Counts keychain reads, to prove showing a key's status doesn't read it.
    #[derive(Default)]
    struct CountingSecrets {
        inner: InMemorySecretStore,
        reads: AtomicUsize,
    }
    impl SecretStore for CountingSecrets {
        fn set(&self, a: &str, s: &str) -> Result<(), AppError> {
            self.inner.set(a, s)
        }
        fn get(&self, a: &str) -> Result<Option<String>, AppError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.inner.get(a)
        }
        fn delete(&self, a: &str) -> Result<(), AppError> {
            self.inner.delete(a)
        }
    }

    #[test]
    fn keys_are_masked_and_accounts_checked() {
        let secrets = CountingSecrets::default();
        let index = InMemoryKeyIndex::default();
        let info = key_set(&secrets, &index, "anthropic", "sk-ant-api03-secret3f9a").unwrap();
        assert_eq!(info.masked.as_deref(), Some("sk-ant-••••3f9a"));
        assert!(key_set(&secrets, &index, "bogus", "x").is_err());
        // Showing the status again and again never reads the keychain.
        for _ in 0..3 {
            key_info(&secrets, &index, "anthropic").unwrap();
        }
        assert_eq!(secrets.reads.load(Ordering::SeqCst), 0);
        assert_eq!(
            key_remove(&secrets, &index, "anthropic").unwrap().masked,
            None
        );
    }

    #[test]
    fn a_key_saved_before_the_index_is_read_once_then_remembered() {
        let secrets = CountingSecrets::default();
        secrets.inner.set("openai", "sk-old1234567881c2").unwrap();
        let index = InMemoryKeyIndex::default();
        for _ in 0..3 {
            let i = key_info(&secrets, &index, "openai").unwrap();
            assert_eq!(i.masked.as_deref(), Some("sk-••••81c2"));
        }
        assert_eq!(
            secrets.reads.load(Ordering::SeqCst),
            1,
            "one keychain read, ever"
        );
    }

    #[test]
    fn describe_reports_the_runtime_host_and_lock() {
        let s = AiSettings {
            ai_runtime: "lmstudio".into(),
            ai_lm_url: "http://192.168.1.4:1234/v1".into(),
            ..on()
        };
        let d = describe(&s, true, Some("p1"));
        assert_eq!(d.state, AiState::Locked);
        assert!(!d.rows_allowed);
        assert_eq!(d.runtime.host, "192.168.1.4:1234");
        assert!(!d.dest.local);
        assert!(d.custom.loopback);
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["state"], "locked");
        assert_eq!(json["runtime"]["loopback"], false);
        assert!(json["dest"].get("baseUrl").is_none(), "internals stay out");
    }

    #[test]
    fn dialect_names_engine_and_version() {
        assert_eq!(dialect(Engine::Postgres, "16.4"), "PostgreSQL 16.4");
        assert_eq!(
            dialect(Engine::Postgres, "PostgreSQL 16.4 on aarch64"),
            "PostgreSQL 16.4"
        );
        assert_eq!(dialect(Engine::Mysql, "8.0.36"), "MySQL 8.0.36");
        assert_eq!(dialect(Engine::Sqlite, ""), "SQLite");
    }

    #[test]
    fn tabular_plans_print_one_row_per_line() {
        let cols = vec!["id".to_string(), "table".to_string(), "type".to_string()];
        let rows = vec![vec![
            serde_json::json!(1),
            serde_json::json!("orders"),
            serde_json::json!("ALL"),
        ]];
        assert_eq!(
            plan_lines(&cols, &rows, false),
            vec!["id=1 table=orders type=ALL"]
        );
        let text = vec![vec![serde_json::json!("Seq Scan on orders\n  Filter: x")]];
        assert_eq!(plan_lines(&["QUERY PLAN".into()], &text, true).len(), 2);
    }
}
