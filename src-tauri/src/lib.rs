pub mod shared;
pub mod slices;

use tauri::Manager;

use slices::preferences::commands::PreferencesState;
use slices::preferences::infrastructure::JsonFilePreferencesStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Composition root: the only place a concrete adapter is chosen.
            let config_dir = app.path().app_config_dir()?;
            let store = JsonFilePreferencesStore::new(config_dir.join("preferences.json"));
            app.manage(PreferencesState::new(Box::new(store)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            slices::preferences::commands::prefs_get,
            slices::preferences::commands::prefs_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
