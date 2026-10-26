//! Tauri command handlers for connection bundles (M40): the thin presentation
//! layer of the slice. Deserialize → use-case → serialize; no logic here.
//!
//! The renderer owns both native dialogs (`save()` for export, `open()` for
//! import) and passes the resolved path down — these commands never pop a
//! dialog of their own, matching every other file-writing slice in the app.
//!
//! Each passphrase arrives as a plain `String` from the IPC layer and is
//! immediately moved into a [`Zeroizing`] so it is wiped when the command
//! returns rather than left in freed memory for the rest of the session.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;
use zeroize::Zeroizing;

use crate::features::connections::ports::ConnectionRepository;
use crate::features::connections::secrets::SecretStore;
use crate::shared::error::AppError;

use super::application;
use super::domain::{BundlePreview, ExportOutcome, ImportAction, ImportOutcome};

/// Managed state for the bundle slice, registered in `lib.rs`.
///
/// Holds the *same* `Arc`s the connections slice holds, not copies of the
/// adapters. That matters beyond tidiness for the secret store: its keychain
/// cache exists to stop macOS re-prompting for every read, and a second
/// instance would start cold and prompt once per connection being exported.
pub struct ConnectionBundleState {
    repository: Arc<dyn ConnectionRepository>,
    secret_store: Arc<dyn SecretStore>,
    /// The running app version, stamped into every bundle for support
    /// questions ("which build wrote this file?").
    app_version: String,
}

impl ConnectionBundleState {
    pub fn new(
        repository: Arc<dyn ConnectionRepository>,
        secret_store: Arc<dyn SecretStore>,
        app_version: String,
    ) -> Self {
        Self {
            repository,
            secret_store,
            app_version,
        }
    }
}

/// Write the selected connections to `path` as an encrypted bundle.
///
/// `ids` empty means every saved connection. `includeSecrets` controls whether
/// keychain material travels; the file is encrypted either way.
#[tauri::command]
pub async fn connection_bundle_export(
    state: State<'_, ConnectionBundleState>,
    path: String,
    ids: Vec<String>,
    passphrase: String,
    include_secrets: Option<bool>,
) -> Result<ExportOutcome, AppError> {
    let passphrase = Zeroizing::new(passphrase);
    application::export_bundle(
        state.repository.as_ref(),
        state.secret_store.as_ref(),
        &PathBuf::from(path),
        &ids,
        &passphrase,
        include_secrets.unwrap_or(true),
        &state.app_version,
    )
}

/// Decrypt a bundle and describe its contents, writing nothing. Powers the
/// import preview, so the user confirms against what is really in the file —
/// including id collisions and missing SSH keys — rather than a file name.
#[tauri::command]
pub async fn connection_bundle_inspect(
    state: State<'_, ConnectionBundleState>,
    path: String,
    passphrase: String,
) -> Result<BundlePreview, AppError> {
    let passphrase = Zeroizing::new(passphrase);
    application::inspect_bundle(state.repository.as_ref(), &PathBuf::from(path), &passphrase)
}

/// Apply a bundle. `actions` maps a bundle entry's id to what to do with it;
/// an entry absent from the map imports when its id is free and skips when it
/// collides.
#[tauri::command]
pub async fn connection_bundle_import(
    state: State<'_, ConnectionBundleState>,
    path: String,
    passphrase: String,
    actions: Option<HashMap<String, ImportAction>>,
) -> Result<ImportOutcome, AppError> {
    let passphrase = Zeroizing::new(passphrase);
    application::import_bundle(
        state.repository.as_ref(),
        state.secret_store.as_ref(),
        &PathBuf::from(path),
        &passphrase,
        &actions.unwrap_or_default(),
    )
}
