mod commands;
mod db;
mod error;
mod files;
mod integrations;
mod oauth;
mod secrets;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;

/// Where Keel keeps its database. `KEEL_DATA_DIR` overrides the platform default
/// (used by tests and for portable installs).
fn data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(dir) = std::env::var_os("KEEL_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(app.path().app_data_dir()?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Two windows writing the same database with separate in-memory caches would
        // diverge, so a second launch focuses the existing window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = data_dir(app)?;
            let db = db::Db::open(&dir)?;
            app.manage::<db::SharedDb>(Arc::new(db));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_execute,
            commands::db_query,
            commands::db_execute_script,
            commands::db_reset,
            commands::db_info,
            commands::backup_create,
            commands::backup_list,
            commands::backup_restore,
            commands::backup_export,
            commands::backup_import,
            commands::data_wipe,
            commands::file_save_text,
            commands::file_open_text,
            commands::app_environment,
            commands::integration_store_secret,
            commands::integration_has_secret,
            commands::integration_delete_secret,
            commands::integration_delete_secrets,
            commands::integration_fetch,
            commands::ics_fetch,
            commands::oauth_connect,
            commands::oauth_revoke,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Keel");
}
