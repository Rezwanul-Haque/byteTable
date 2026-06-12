//! Tauri command handlers: the thin presentation layer of the slice.
//! Deserialize → use-case → serialize; no logic lives here.

use tauri::State;

use crate::shared::error::AppError;

use super::application;
use super::domain::Preferences;
use super::ports::PreferencesStore;

/// Managed state holding the slice's store port, registered in `lib.rs`.
///
/// Commands depend only on the `PreferencesStore` trait; the concrete adapter
/// (`JsonFilePreferencesStore`) is chosen and wired exclusively in `lib.rs`.
/// `Send + Sync` is required because Tauri shares managed state across
/// threads.
pub struct PreferencesState {
    store: Box<dyn PreferencesStore + Send + Sync>,
}

impl PreferencesState {
    pub fn new(store: Box<dyn PreferencesStore + Send + Sync>) -> Self {
        Self { store }
    }
}

#[tauri::command]
pub fn prefs_get(state: State<'_, PreferencesState>) -> Result<Preferences, AppError> {
    application::get_preferences(state.store.as_ref())
}

#[tauri::command]
pub fn prefs_set(
    state: State<'_, PreferencesState>,
    preferences: Preferences,
) -> Result<(), AppError> {
    application::set_preferences(state.store.as_ref(), preferences)
}
