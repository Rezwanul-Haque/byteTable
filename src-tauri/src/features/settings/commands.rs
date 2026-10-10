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

    /// The store, for the few backend paths that must honour a user setting
    /// rather than only mirror the renderer's copy — the connect timeout (M28
    /// follow-up) is read here by the connections slice's commands.
    pub fn store(&self) -> &(dyn SettingsStore + Send + Sync) {
        self.store.as_ref()
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

/// Where a custom Liquid Glass wallpaper lives, inside the app's config dir.
/// One fixed name: there is only ever one wallpaper, and replacing it should
/// not leave the old file behind.
fn wallpaper_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    use tauri::Manager as _;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Io(format!("No config directory: {e}")))?;
    Ok(dir.join("wallpaper"))
}

/// Copy the user's chosen image into the app's config directory and return the
/// stored path.
///
/// The image is COPIED rather than referenced in place for two reasons: the
/// original may sit on a volume that is not mounted next time, and the webview
/// can only load files the asset protocol is allowed to reach. Keeping the
/// bytes out of `settings.json` is the other half — a phone photo inlined as a
/// data URL would bloat the preferences file that every other setting shares.
#[tauri::command]
pub fn wallpaper_set(app: tauri::AppHandle, source: String) -> Result<String, AppError> {
    let src = std::path::PathBuf::from(&source);
    let dest = wallpaper_path(&app)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Io(format!("Could not create {parent:?}: {e}")))?;
    }
    std::fs::copy(&src, &dest)
        .map_err(|e| AppError::Invalid(format!("Could not read that image: {e}")))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// The stored wallpaper's path, or `None` when the user has never set one.
/// Checked on every apply, so a file deleted behind our back falls back to the
/// bundled image instead of rendering an empty window.
#[tauri::command]
pub fn wallpaper_path_get(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    let path = wallpaper_path(&app)?;
    Ok(path.exists().then(|| path.to_string_lossy().into_owned()))
}
