pub mod engines;
pub mod features;
pub mod shared;

use std::sync::Arc;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

use engines::mysql::MysqlConnector;
use engines::postgres::PostgresConnector;
use engines::redis::RedisConnector;
use engines::sqlite::SqliteConnector;
use features::connections::application::{ConnectionManager, ConnectorRegistry};
use features::connections::commands::ConnectionsState;
use features::connections::infrastructure::JsonFileConnectionRepository;
use features::connections::secrets::KeyringSecretStore;
use features::preferences::commands::PreferencesState;
use features::preferences::infrastructure::JsonFilePreferencesStore;
use features::saved_queries::commands::SavedQueriesState;
use features::saved_queries::infrastructure::JsonFileSavedQueryRepository;
use features::schema_map::commands::SchemaMapState;
use features::schema_map::infrastructure::JsonFileMapLayoutRepository;
use shared::engine::Engine;

/// Bring the main window back to the foreground (from hidden/minimized tray state).
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Tray left-click toggles the window: hide it if it's up front, otherwise restore it.
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        if visible && !minimized {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opener plugin: lets the frontend open external links (donate modal)
        // in the OS default browser. Scoped to https URLs in
        // capabilities/default.json.
        .plugin(tauri_plugin_opener::init())
        // Dialog plugin: native file pickers — `dialog:allow-open` ("Open
        // SQLite file…" on the connect screen) and `dialog:allow-save` (the
        // M9 schema-map "Export diagram…" save dialog) are granted in
        // capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Composition root: the only place concrete adapters are chosen.
            let config_dir = app.path().app_config_dir()?;

            let store = JsonFilePreferencesStore::new(config_dir.join("preferences.json"));
            app.manage(PreferencesState::new(Box::new(store)));

            // Connections slice: JSON registry + per-engine connectors.
            // Every engine now has a registered connector: SQLite (rusqlite),
            // Postgres (M12 Task 1, sqlx) and MySQL (M12 Task 2, sqlx). An
            // unregistered engine would get a human "arrives in a later
            // milestone" error, but none remain.
            let repository = JsonFileConnectionRepository::new(config_dir.join("connections.json"));
            let mut registry = ConnectorRegistry::new();
            registry.register(Engine::Sqlite, Arc::new(SqliteConnector));
            registry.register(Engine::Postgres, Arc::new(PostgresConnector));
            registry.register(Engine::Mysql, Arc::new(MysqlConnector));
            // Redis (M13): a key-value engine. Its connector returns an
            // `OpenConnection::Kv`, kept apart from the SQL connections by the
            // manager's `get_sql` / `get_kv` kind seam.
            registry.register(Engine::Redis, Arc::new(RedisConnector));
            app.manage(ConnectionsState::new(
                Box::new(repository),
                registry,
                ConnectionManager::new(),
                // Server-connection secrets (db password, SSH passphrase/
                // password) live in the OS keychain, never in the JSON
                // registry (M12 Task 3).
                Box::new(KeyringSecretStore::new()),
            ));

            // Saved-queries slice: a single global JSON store shared across
            // every workspace (save in workspace A, load from workspace B).
            let saved_queries =
                JsonFileSavedQueryRepository::new(config_dir.join("saved_queries.json"));
            app.manage(SavedQueriesState::new(Box::new(saved_queries)));

            // Schema-map slice: per-(connectionId, schema) ER-diagram layouts
            // in one local JSON store. The connectionId is the persisted
            // SavedConnection id, so layouts survive restarts.
            let map_layouts = JsonFileMapLayoutRepository::new(config_dir.join("map_layouts.json"));
            app.manage(SchemaMapState::new(Box::new(map_layouts)));

            // System tray: persistent ByteTable icon. Left-click toggles the
            // window; right-click opens the menu (Show / Quit). The app keeps
            // running in the tray when the window is closed (see CloseRequested
            // below), so the tray is the way back in — and "Quit" is the only
            // path that actually exits (besides ⌘Q).
            let show = MenuItemBuilder::with_id("show", "Show ByteTable").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit ByteTable").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .tooltip("ByteTable")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // Close-to-tray: the window close button hides the window instead of
        // quitting, so ByteTable lives on in the tray. ⌘Q / tray "Quit" still
        // exit the app (they go through RunEvent::ExitRequested, not this).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
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
            features::introspection::commands::table_meta,
            features::browse::commands::rows_fetch,
            features::browse::commands::row_lookup,
            features::insights::commands::column_stats,
            features::mutate::commands::row_update,
            features::mutate::commands::truncate_table,
            features::export::commands::export_table,
            features::export::commands::export_schema,
            features::export::commands::export_save,
            features::structure::commands::alter_preview,
            features::structure::commands::alter_apply,
            features::saved_queries::commands::saved_query_list,
            features::saved_queries::commands::saved_query_save,
            features::saved_queries::commands::saved_query_delete,
            features::schema_map::commands::map_layout_get,
            features::schema_map::commands::map_layout_save,
            features::schema_map::commands::diagram_export,
            features::keyvalue::commands::kv_server_info,
            features::keyvalue::commands::kv_server_stats,
            features::keyvalue::commands::kv_keyspace,
            features::keyvalue::commands::kv_scan,
            features::keyvalue::commands::kv_get_key,
            features::keyvalue::commands::kv_set_string,
            features::keyvalue::commands::kv_hash_set,
            features::keyvalue::commands::kv_hash_del,
            features::keyvalue::commands::kv_list_set,
            features::keyvalue::commands::kv_set_add,
            features::keyvalue::commands::kv_set_remove,
            features::keyvalue::commands::kv_zset_add,
            features::keyvalue::commands::kv_zset_remove,
            features::keyvalue::commands::kv_delete_key,
            features::keyvalue::commands::kv_rename_key,
            features::keyvalue::commands::kv_expire,
            features::keyvalue::commands::kv_persist,
            features::keyvalue::commands::kv_create_key,
            features::keyvalue::commands::kv_command,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Teardown hook: `RunEvent::ExitRequested` is the reliable app-level
        // signal for a single-window app — it fires once when the last
        // window closes (and on programmatic `app.exit()`), unlike
        // `WindowEvent::Destroyed`, which is per-window and also fires
        // during window re-creation. `block_on` (not spawn) so every
        // connection's `close()` completes before the process exits.
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<ConnectionsState>();
                tauri::async_runtime::block_on(state.manager().close_all());
            }
        });
}
