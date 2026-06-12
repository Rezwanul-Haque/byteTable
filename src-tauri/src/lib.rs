pub mod engines;
pub mod features;
pub mod shared;

use std::sync::Arc;

use tauri::Manager;

use engines::sqlite::SqliteConnector;
use features::connections::application::{ConnectionManager, ConnectorRegistry};
use features::connections::commands::ConnectionsState;
use features::connections::infrastructure::JsonFileConnectionRepository;
use features::preferences::commands::PreferencesState;
use features::preferences::infrastructure::JsonFilePreferencesStore;
use shared::engine::Engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opener plugin: lets the frontend open external links (donate modal)
        // in the OS default browser. Scoped to https URLs in
        // capabilities/default.json.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Composition root: the only place concrete adapters are chosen.
            let config_dir = app.path().app_config_dir()?;

            let store = JsonFilePreferencesStore::new(config_dir.join("preferences.json"));
            app.manage(PreferencesState::new(Box::new(store)));

            // Connections slice: JSON registry + per-engine connectors.
            // Engines without a registered connector (MySQL/Postgres until
            // M12) get a human "arrives in a later milestone" error.
            let repository = JsonFileConnectionRepository::new(config_dir.join("connections.json"));
            let mut registry = ConnectorRegistry::new();
            registry.register(Engine::Sqlite, Arc::new(SqliteConnector));
            app.manage(ConnectionsState::new(
                Box::new(repository),
                registry,
                ConnectionManager::new(),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            features::preferences::commands::prefs_get,
            features::preferences::commands::prefs_set,
            features::connections::commands::connection_list,
            features::connections::commands::connection_save,
            features::connections::commands::connection_delete,
            features::connections::commands::connection_test,
            features::connections::commands::connection_open,
            features::connections::commands::connection_close,
            features::connections::commands::connection_schemas,
            features::connections::commands::connection_tables,
            features::connections::commands::query_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
