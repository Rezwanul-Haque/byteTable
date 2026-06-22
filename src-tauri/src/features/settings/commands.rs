//! Tauri command handlers: the thin presentation layer of the slice.
//! Deserialize → use-case → serialize; no logic lives here.

use tauri::State;

use crate::shared::error::AppError;

use super::application;
use super::domain::Settings;
use super::ports::SettingsStore;

/// Managed state holding the slice's store port, registered in `lib.rs`.
///
/// Commands depend only on the `SettingsStore` trait; the concrete adapter
/// (`JsonFileSettingsStore`) is chosen and wired exclusively in `lib.rs`.
/// `Send + Sync` is required because Tauri shares managed state across threads.
pub struct SettingsState {
    store: Box<dyn SettingsStore + Send + Sync>,
}

impl SettingsState {
    pub fn new(store: Box<dyn SettingsStore + Send + Sync>) -> Self {
        Self { store }
    }
}

/// Load the on-disk settings mirror. The renderer prefers its localStorage
/// copy and only falls back to this when localStorage is empty (e.g. after a
/// clear, or a fresh profile that still has the config file).
#[tauri::command]
pub fn settings_load(state: State<'_, SettingsState>) -> Result<Settings, AppError> {
    application::get_settings(state.store.as_ref())
}

/// Mirror the renderer's settings to disk so they survive a localStorage clear
/// and are editable as a file.
#[tauri::command]
pub fn settings_save(state: State<'_, SettingsState>, settings: Settings) -> Result<(), AppError> {
    application::set_settings(state.store.as_ref(), settings)
}
