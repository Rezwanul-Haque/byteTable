//! Ports: what the assistant use-cases need from the outside world. Adapters
//! live in `infrastructure`; tests use fakes. API keys go through the
//! connections slice's `SecretStore` port (same keychain adapter, its own
//! service name) rather than a second, identical port.

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde::Serialize;

use crate::shared::error::AppError;

use super::domain::LogEntry;

/// A model on the destination, as `list_models()` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    /// Bytes on disk, when the runtime reports it (Ollama does).
    pub size: Option<u64>,
    /// e.g. a parameter count or quantization the runtime reports.
    pub tag: Option<String>,
}

/// Why a provider call failed, typed so the UI can say the right thing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "message")]
pub enum ProviderError {
    /// The host could not be reached (no network, nothing listening, DNS):
    /// the connection never opened, so **nothing was sent** (Task A12).
    Unreachable(String),
    /// The provider rejected the key.
    Auth(String),
    /// Any other HTTP/protocol failure.
    Failed(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(m) | Self::Auth(m) | Self::Failed(m) => f.write_str(m),
        }
    }
}

/// A stream of text fragments. Dropping it aborts the HTTP request — that is
/// the cancel handle.
pub type TokenStream = BoxStream<'static, Result<String, ProviderError>>;

/// One model endpoint (Task A2).
#[async_trait]
pub trait ModelProvider: Send + Sync {
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError>;
    /// Cheap reachability check: the endpoint answers.
    async fn ping(&self) -> Result<(), ProviderError>;
    /// Send `prompt` as one user message and stream the reply.
    async fn complete(&self, prompt: &str) -> Result<TokenStream, ProviderError>;
}

/// What the UI shows for each saved key — the masked label only, never the
/// key — so displaying "sk-ant-••••3f9a" never reads the OS keychain (a read
/// can prompt for the user's password on macOS). The keychain is touched only
/// when a key is actually used.
pub trait KeyIndex: Send + Sync {
    /// `None` = this account was never recorded; `Some(None)` = recorded as
    /// having no key; `Some(Some(label))` = a key is saved.
    fn get(&self, account: &str) -> Result<Option<Option<String>>, AppError>;
    fn set(&self, account: &str, masked: Option<String>) -> Result<(), AppError>;
}

/// The local prompt log (Task A11).
pub trait PromptLog: Send + Sync {
    fn append(&self, entry: &LogEntry) -> Result<(), AppError>;
    /// The newest `limit` entries, newest first, plus the total count.
    fn read_last(&self, limit: usize) -> Result<(Vec<LogEntry>, usize), AppError>;
    fn clear(&self) -> Result<(), AppError>;
}
