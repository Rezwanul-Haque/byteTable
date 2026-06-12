//! Tauri command handlers: the thin presentation layer of the slice.
//! Deserialize → use-case → serialize; no logic lives here.

use tauri::State;

use crate::shared::error::AppError;

use super::application;
use super::domain::Preferences;
use super::infrastructure::JsonFilePreferencesStore;

/// Managed state holding the slice's store adapter, registered in `lib.rs`.
pub struct PreferencesState {
    store: JsonFilePreferencesStore,
}

impl PreferencesState {
    pub fn new(store: JsonFilePreferencesStore) -> Self {
        Self { store }
    }
}

#[tauri::command]
pub fn prefs_get(state: State<'_, PreferencesState>) -> Result<Preferences, AppError> {
    application::get_preferences(&state.store)
}

#[tauri::command]
pub fn prefs_set(
    state: State<'_, PreferencesState>,
    preferences: Preferences,
) -> Result<(), AppError> {
    application::set_preferences(&state.store, preferences)
}
