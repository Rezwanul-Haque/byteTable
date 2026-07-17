pub mod engines;
pub mod features;
pub mod shared;

use std::sync::Arc;

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};

use engines::cassandra::CassandraConnector;
use engines::dynamo::DynamoConnector;
use engines::mongo::MongoConnector;
use engines::mssql::MssqlConnector;
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
use features::settings::commands::SettingsState;
use features::settings::infrastructure::JsonFileSettingsStore;
use shared::engine::Engine;

/// Bring the main window back to the foreground (from hidden/minimized tray state).
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
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
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        } else {
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// One saved connection as the tray's Workspaces submenu needs it: the
/// registry id (the menu-item payload), its display name, and whether a
/// workspace is currently open for it (so the item shows a check). The
/// frontend computes `open` by matching open workspaces to their saved id and
/// pushes the whole list via `tray_update` whenever it changes.
#[derive(serde::Deserialize)]
pub struct TrayWorkspace {
    id: String,
    name: String,
    open: bool,
}

/// Build the tray's right-click menu: Show, a "Workspaces" submenu (one
/// checkable item per saved connection — checked = a workspace is open for
/// it), then Quit. Reused at startup (empty list) and on every `tray_update`.
/// Workspace items carry the id `ws:<connectionId>`; the menu-event handler
/// strips that prefix to know which connection was picked.
fn build_tray_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    workspaces: &[TrayWorkspace],
) -> tauri::Result<Menu<R>> {
    let show = MenuItemBuilder::with_id("show", "Show ByteTable").build(manager)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit ByteTable").build(manager)?;

    let mut ws_sub = SubmenuBuilder::new(manager, "Workspaces");
    if workspaces.is_empty() {
        // A disabled placeholder so the submenu is never empty/confusing.
        let none = MenuItemBuilder::with_id("ws-none", "No saved connections")
            .enabled(false)
            .build(manager)?;
        ws_sub = ws_sub.item(&none);
    } else {
        for w in workspaces {
            let item = CheckMenuItemBuilder::with_id(format!("ws:{}", w.id), &w.name)
                .checked(w.open)
                .build(manager)?;
            ws_sub = ws_sub.item(&item);
        }
    }
    let ws_menu = ws_sub.build()?;

    MenuBuilder::new(manager)
        .item(&show)
        .item(&ws_menu)
        .separator()
        .item(&quit)
        .build()
}

/// Rebuild the tray menu from the frontend's current saved-connection list.
/// The tray-icon's menu-event handler (registered once at build) keeps working
/// across `set_menu`, so this only swaps the menu contents.
#[tauri::command]
fn tray_update(app: AppHandle, workspaces: Vec<TrayWorkspace>) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "tray icon not found".to_string())?;
    let menu = build_tray_menu(&app, &workspaces).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    Ok(())
}

/// macOS window-chrome hook for the custom title bar (spec §1). The macOS window
/// is configured statically (`tauri.macos.conf.json`) as an opaque, natively
/// decorated window with a hiddenInset ("Overlay") title bar — the OS draws the
/// traffic lights and rounds the corners, our custom bar overlays the inset
/// area. There is no runtime chrome switch, so this is a no-op kept only so the
/// renderer's settings-apply call has a stable target. No-op off macOS too.
#[tauri::command]
fn set_mac_chrome(_app: AppHandle, _mode: String) -> Result<(), String> {
    Ok(())
}

/// One-time migration of the local data directory after the bundle identifier
/// changed from `com.bytetable.app` to `com.bytetable.desktop` — the `.app`
/// suffix collides with the macOS application-bundle extension (signing /
/// notarization). Tauri keys `app_config_dir()` on the identifier, so without
/// this a user updating from an old build would land in a fresh, empty data dir
/// and appear to "lose" their saved connections, settings, saved queries and
/// schema-map layouts (the OS-keychain secrets survive untouched — their
/// service name is the constant `"ByteTable"`, not the identifier).
///
/// The legacy dir is a sibling of the new one under the same platform base
/// (`~/Library/Application Support/` on macOS, `~/.config/` on Linux,
/// `%APPDATA%` on Windows), so it is resolved by name. Files are COPIED, not
/// moved, so an old build keeps working if the user downgrades. A `.migrated`
/// sentinel makes this idempotent: it never re-copies over data the user has
/// since changed in the new build (e.g. after deleting every connection).
///
/// Migration failures are logged, never fatal — a data-carry-over hiccup must
/// not stop the app from launching.
fn migrate_legacy_config_dir(new_dir: &std::path::Path) {
    const LEGACY_IDENTIFIER: &str = "com.bytetable.app";

    let Some(old_dir) = new_dir.parent().map(|p| p.join(LEGACY_IDENTIFIER)) else {
        return;
    };
    // Nothing to carry over: identifier unchanged, or the old build never ran.
    if old_dir == new_dir || !old_dir.is_dir() {
        return;
    }
    let sentinel = new_dir.join(".migrated");
    if sentinel.exists() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(new_dir) {
        eprintln!("config migration: could not create {new_dir:?}: {e}");
        return;
    }

    let entries = match std::fs::read_dir(&old_dir) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("config migration: could not read {old_dir:?}: {e}");
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Skip hidden files and the JSON stores' atomic-write temp files.
        if name.starts_with('.') || name.ends_with(".tmp") {
            continue;
        }
        let dest = new_dir.join(name);
        // Never clobber data the new build already owns.
        if dest.exists() {
            continue;
        }
        if let Err(e) = std::fs::copy(&path, &dest) {
            eprintln!("config migration: failed to copy {name}: {e}");
        }
    }

    // Best-effort: record completion so we never copy again.
    let _ = std::fs::write(&sentinel, b"com.bytetable.app -> com.bytetable.desktop\n");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK (Linux Tauri webview) on X11 has a broken accelerated-compositing
    // path: virtualized data-grid rows are absolutely positioned and moved with
    // `transform: translateY`, and the DMABUF renderer fails to repaint the
    // transformed layers on fast scroll. The result is stale tiles — "ghost rows"
    // and columns that appear swapped for a few rows (the prior row's text bleeds
    // through), plus a blank/laggy grid while scrolling. Hovering a cell forces a
    // local repaint and the row "fixes itself", proving the DOM is correct and the
    // fault is purely in the native compositor. The opaque `background` on `.dg-tr`
    // (see DataGrid.css) only partially masks it because the child text layers are
    // still not repainted.
    //
    // Disabling the DMABUF renderer forces WebKitGTK onto a repaint path that works.
    // Gated to Linux + X11 only: Wayland and macOS repaint correctly and keep full
    // GPU compositing. Must run before the webview is created (i.e. before the
    // Tauri builder), because WebKitGTK reads these env vars at webview init.
    #[cfg(target_os = "linux")]
    {
        let is_x11 = std::env::var("XDG_SESSION_TYPE")
            .map(|s| s.eq_ignore_ascii_case("x11"))
            .unwrap_or(false)
            // Fallback for sessions that don't set XDG_SESSION_TYPE: DISPLAY set
            // and no Wayland socket => X11.
            || (std::env::var_os("WAYLAND_DISPLAY").is_none()
                && std::env::var_os("DISPLAY").is_some());
        if is_x11 {
            // Primary fix: disable the DMABUF renderer.
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            // Fallback: if tearing persists on some X11 drivers, also disabling
            // compositing mode resolves it (heavier — drops GPU compositing).
            // Uncomment to enable; kept off by default so the DMABUF fix can be
            // validated as a single variable first.
            // std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        // Single-instance guard (MUST be the first plugin registered): a second
        // launch — e.g. clicking the AppImage again — does not spawn another
        // process; instead this callback fires in the already-running instance
        // and brings its window to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // Opener plugin: lets the frontend open external links (donate modal)
        // in the OS default browser. Scoped to https URLs in
        // capabilities/default.json.
        .plugin(tauri_plugin_opener::init())
        // Dialog plugin: native file pickers — `dialog:allow-open` ("Open
        // SQLite file…" on the connect screen) and `dialog:allow-save` (the
        // M9 schema-map "Export diagram…" save dialog) are granted in
        // capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        // Updater + process plugins: the renderer checks GitHub releases for a
        // newer signed build, downloads/installs it, and relaunches. Updater is
        // desktop-only (no-op target on mobile, which we don't ship).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Composition root: the only place concrete adapters are chosen.
            let config_dir = app.path().app_config_dir()?;

            // One-time carry-over of local data after the bundle identifier
            // changed (`com.bytetable.app` -> `com.bytetable.desktop`). Must run
            // before any store below reads `config_dir`, so a user updating from
            // an old build sees their existing connections/settings/queries.
            migrate_legacy_config_dir(&config_dir);

            let store = JsonFilePreferencesStore::new(config_dir.join("preferences.json"));
            app.manage(PreferencesState::new(Box::new(store)));

            // Settings slice (M20): the full theme/font/size/behavior contract.
            // localStorage in the renderer is the source of truth; this JSON
            // file is a mirror so settings survive a localStorage clear and are
            // editable as a file.
            let settings_store = JsonFileSettingsStore::new(config_dir.join("settings.json"));
            app.manage(SettingsState::new(Box::new(settings_store)));

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
            // SQL Server (M21): a fourth relational engine (T-SQL, `tiberius`
            // TDS driver). Its connector returns an `OpenConnection::Sql`, so it
            // flows through the same relational workspace host as Postgres/MySQL/
            // SQLite — only the dialect differs.
            registry.register(Engine::Mssql, Arc::new(MssqlConnector));
            // Oracle (M23): a fifth relational engine (Oracle SQL / PL/SQL, OCI
            // `oracle` driver). OPTIONAL — only registered when the crate is
            // built with `--features engine-oracle` (the OCI adapter needs the
            // Oracle Instant Client at runtime). In the default build the engine
            // is fully present in the type system + UI, but opening a connection
            // returns the manager's "no connector registered" §5 message. See
            // `engines::oracle` and docs/M23-oracle-engine.md.
            #[cfg(feature = "engine-oracle")]
            registry.register(Engine::Oracle, Arc::new(engines::oracle::OracleConnector));
            // Redis (M13): a key-value engine. Its connector returns an
            // `OpenConnection::Kv`, kept apart from the SQL connections by the
            // manager's `get_sql` / `get_kv` kind seam.
            registry.register(Engine::Redis, Arc::new(RedisConnector));
            // DynamoDB (M17): a document-store engine. Its connector returns an
            // `OpenConnection::Document`, kept apart from SQL and Redis by the
            // manager's `get_document` kind seam.
            registry.register(Engine::Dynamodb, Arc::new(DynamoConnector));
            // MongoDB (M18): a document database. Its connector returns an
            // `OpenConnection::Mongo`, kept apart from SQL / Redis / DynamoDB by
            // the manager's `get_mongo` kind seam.
            registry.register(Engine::Mongodb, Arc::new(MongoConnector));
            // Cassandra (M19): a wide-column engine. Its connector returns an
            // `OpenConnection::WideColumn`, kept apart from SQL / Redis /
            // DynamoDB / MongoDB by the manager's `get_wide_column` kind seam.
            registry.register(Engine::Cassandra, Arc::new(CassandraConnector));
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

            // Generate slice (M16): per-run cancellation flags for fake-data
            // generation, keyed by the renderer's run id.
            app.manage(features::generate::commands::GenerateState::default());

            // System tray: persistent ByteTable icon. Left-click toggles the
            // window; right-click opens the menu (Show / Quit). The app keeps
            // running in the tray when the window is closed (see CloseRequested
            // below), so the tray is the way back in — and "Quit" is the only
            // path that actually exits (besides ⌘Q).
            // Starts with an empty Workspaces submenu; the frontend repopulates
            // it via `tray_update` once the saved-connection list loads (and on
            // every change after).
            let menu = build_tray_menu(app, &[])?;
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .tooltip("ByteTable")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    // A Workspaces item: bring the window forward and tell the
                    // frontend which saved connection was picked (it focuses an
                    // open workspace or opens one from the connection).
                    other => {
                        if let Some(connection_id) = other.strip_prefix("ws:") {
                            show_main_window(app);
                            let _ = app.emit("tray://select-workspace", connection_id.to_string());
                        }
                    }
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
                #[cfg(target_os = "macos")]
                let _ = window
                    .app_handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        })
        .invoke_handler(tauri::generate_handler![
            hide_to_tray,
            set_mac_chrome,
            tray_update,
            features::preferences::commands::prefs_get,
            features::preferences::commands::prefs_set,
            features::settings::commands::settings_load,
            features::settings::commands::settings_save,
            features::connections::commands::connection_list,
            features::connections::commands::engine_driver_status,
            features::connections::commands::connection_save,
            features::connections::commands::connection_delete,
            features::connections::commands::connection_test,
            features::connections::commands::connection_open,
            features::connections::commands::connection_close,
            features::connections::commands::connection_schemas,
            features::connections::commands::connection_tables,
            features::connections::commands::query_run,
            features::introspection::commands::table_meta,
            features::introspection::commands::list_objects,
            features::introspection::commands::object_definition,
            features::introspection::commands::drop_object,
            features::introspection::commands::run_object_ddl,
            features::browse::commands::rows_fetch,
            features::browse::commands::row_lookup,
            features::insights::commands::column_stats,
            features::mutate::commands::row_update,
            features::mutate::commands::rows_delete,
            features::mutate::commands::truncate_table,
            features::mutate::commands::drop_schema,
            features::mutate::commands::create_schema,
            features::export::commands::export_table,
            features::export::commands::export_schema,
            features::export::commands::export_save,
            features::export::commands::import_sql,
            features::export::commands::read_text_file,
            features::export::commands::execute_script_text,
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
            features::dynamo::commands::dynamo_list_table_names,
            features::dynamo::commands::dynamo_list_tables,
            features::dynamo::commands::dynamo_describe_table,
            features::dynamo::commands::dynamo_scan,
            features::dynamo::commands::dynamo_query,
            features::dynamo::commands::dynamo_get_item,
            features::dynamo::commands::dynamo_put_item,
            features::dynamo::commands::dynamo_delete_item,
            features::dynamo::commands::dynamo_batch_write,
            features::dynamo::commands::dynamo_batch_delete,
            features::dynamo::commands::dynamo_execute_statement,
            features::mongo::commands::mongo_list_databases,
            features::mongo::commands::mongo_list_collections,
            features::mongo::commands::mongo_find,
            features::mongo::commands::mongo_count,
            features::mongo::commands::mongo_aggregate,
            features::mongo::commands::mongo_explain,
            features::mongo::commands::mongo_infer_schema,
            features::mongo::commands::mongo_list_indexes,
            features::mongo::commands::mongo_insert_one,
            features::mongo::commands::mongo_replace_one,
            features::mongo::commands::mongo_delete_one,
            features::mongo::commands::mongo_delete_many,
            features::mongo::commands::mongo_insert_many,
            features::mongo::commands::mongo_create_index,
            features::mongo::commands::mongo_set_validator,
            features::cassandra::commands::cassandra_list_keyspaces,
            features::cassandra::commands::cassandra_list_tables,
            features::cassandra::commands::cassandra_table_meta,
            features::cassandra::commands::cassandra_cluster_status,
            features::cassandra::commands::cassandra_query,
            features::cassandra::commands::cassandra_insert_row,
            features::cassandra::commands::cassandra_update_row,
            features::cassandra::commands::cassandra_delete_row,
            features::cassandra::commands::cassandra_delete_rows,
            features::cassandra::commands::cassandra_run_cql,
            features::cassandra::commands::cassandra_describe_table,
            features::cassandra::commands::cassandra_create_index,
            features::cassandra::commands::cassandra_drop_index,
            features::cassandra::commands::cassandra_create_mv,
            features::cassandra::commands::cassandra_drop_mv,
            features::cassandra::commands::cassandra_create_keyspace,
            features::cassandra::commands::cassandra_create_table,
            features::generate::commands::generate_preview,
            features::generate::commands::generate_run,
            features::generate::commands::generate_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Teardown hook: `RunEvent::ExitRequested` is the reliable app-level
        // signal for a single-window app — it fires once when the last
        // window closes (and on programmatic `app.exit()`), unlike
        // `WindowEvent::Destroyed`, which is per-window and also fires
        // during window re-creation. `block_on` (not spawn) so every
        // connection's `close()` completes before the process exits.
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } => {
                let state = app_handle.state::<ConnectionsState>();
                tauri::async_runtime::block_on(state.manager().close_all());
            }
            // macOS: clicking the Dock icon when no window is visible fires
            // Reopen. Since close-to-tray hides (not destroys) the window, the
            // Dock click must bring it back — without this the tray icon is the
            // only way in. `has_visible_windows` is false exactly when hidden.
            // `Reopen` only exists on macOS, so gate the arm to that target.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } if !has_visible_windows => {
                show_main_window(app_handle);
            }
            _ => {}
        });
}

#[cfg(test)]
mod migration_tests {
    use super::migrate_legacy_config_dir;
    use std::fs;

    /// Lay out a fake platform base with the legacy `com.bytetable.app` dir
    /// populated, returning `(base, old_dir, new_dir)`. `new_dir` is the sibling
    /// the current build would resolve from its identifier.
    fn scaffold(files: &[(&str, &str)]) -> (tempfile::TempDir, std::path::PathBuf) {
        let base = tempfile::tempdir().expect("tempdir");
        let old_dir = base.path().join("com.bytetable.app");
        fs::create_dir_all(&old_dir).expect("old dir");
        for (name, body) in files {
            fs::write(old_dir.join(name), body).expect("seed file");
        }
        let new_dir = base.path().join("com.bytetable.desktop");
        (base, new_dir)
    }

    #[test]
    fn copies_user_files_and_writes_sentinel() {
        let (_base, new_dir) = scaffold(&[
            ("connections.json", "[conn]"),
            ("settings.json", "{settings}"),
            ("saved_queries.json", "[q]"),
        ]);

        migrate_legacy_config_dir(&new_dir);

        assert_eq!(
            fs::read_to_string(new_dir.join("connections.json")).unwrap(),
            "[conn]"
        );
        assert_eq!(
            fs::read_to_string(new_dir.join("settings.json")).unwrap(),
            "{settings}"
        );
        assert_eq!(
            fs::read_to_string(new_dir.join("saved_queries.json")).unwrap(),
            "[q]"
        );
        assert!(new_dir.join(".migrated").exists());
    }

    #[test]
    fn skips_temp_and_hidden_files() {
        let (_base, new_dir) = scaffold(&[
            ("connections.json", "[conn]"),
            ("connections.json.tmp", "half-written"),
            (".DS_Store", "junk"),
        ]);

        migrate_legacy_config_dir(&new_dir);

        assert!(new_dir.join("connections.json").exists());
        assert!(!new_dir.join("connections.json.tmp").exists());
        assert!(!new_dir.join(".DS_Store").exists());
    }

    #[test]
    fn never_clobbers_data_the_new_build_already_owns() {
        let (_base, new_dir) = scaffold(&[("connections.json", "[legacy]")]);
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(new_dir.join("connections.json"), "[fresh]").unwrap();

        migrate_legacy_config_dir(&new_dir);

        // The new build's own data wins; legacy never overwrites it.
        assert_eq!(
            fs::read_to_string(new_dir.join("connections.json")).unwrap(),
            "[fresh]"
        );
    }

    #[test]
    fn is_idempotent_once_sentinel_exists() {
        let (_base, new_dir) = scaffold(&[("connections.json", "[legacy]")]);
        migrate_legacy_config_dir(&new_dir);

        // User deletes a connection in the new build; the file must NOT come back.
        fs::remove_file(new_dir.join("connections.json")).unwrap();
        migrate_legacy_config_dir(&new_dir);

        assert!(!new_dir.join("connections.json").exists());
    }

    #[test]
    fn no_op_when_legacy_dir_absent() {
        let base = tempfile::tempdir().expect("tempdir");
        let new_dir = base.path().join("com.bytetable.desktop");

        migrate_legacy_config_dir(&new_dir);

        // Fresh install: nothing created, no sentinel.
        assert!(!new_dir.exists());
    }
}
