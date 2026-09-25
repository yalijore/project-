mod commands;
mod db;
mod error;
mod files;
mod focusbar;
mod integrations;
mod oauth;
/// Public so the OS credential-store test can run in its own process (tests/).
#[doc(hidden)]
pub mod secrets;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, Runtime, WebviewWindowBuilder};

/// Where Keel keeps its database. `KEEL_DATA_DIR` overrides the platform default
/// (used by tests and for portable installs).
fn data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(dir) = std::env::var_os("KEEL_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(app.path().app_data_dir()?)
}

/// Windows debug builds under the end-to-end harness only: opens WebView2's DevTools port
/// (`KEEL_E2E_DEVTOOLS_PORT`) so msedgedriver can attach. WebView2 ignores its own environment
/// variable for this because wry sets browser arguments explicitly; wry's defaults are kept.
/// Every window must get the same arguments, since they share one WebView2 environment.
pub(crate) fn test_devtools<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(all(windows, debug_assertions))]
    if std::env::var_os("KEEL_E2E").is_some() {
        if let Some(port) = std::env::var("KEEL_E2E_DEVTOOLS_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
        {
            return builder.additional_browser_args(&format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
            ));
        }
    }
    builder
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let dir = data_dir(app)?;
            let db = db::Db::open(&dir)?;
            app.manage::<db::SharedDb>(Arc::new(db));
            app.manage(focusbar::FocusBar::new(&dir));
            focusbar::watch_displays(app.handle().clone());
            // The main window is declared in tauri.conf.json with `create: false` and built
            // here, so test runs can add WebView2 arguments to it.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("tauri.conf.json has no main window")?;
            test_devtools(WebviewWindowBuilder::from_config(app.handle(), &config)?).build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the planner closes the focus bar too, so Keel exits; a running timer
            // keeps its start time in the database and continues on the next launch.
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                focusbar::close_with_main(window.app_handle());
            }
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
            commands::file_open_binary,
            commands::app_environment,
            commands::integration_store_secret,
            commands::integration_has_secret,
            commands::integration_delete_secret,
            commands::integration_delete_secrets,
            commands::integration_fetch,
            commands::ics_fetch_account,
            commands::oauth_connect,
            commands::oauth_revoke,
            commands::focusbar_show,
            commands::focusbar_hide,
            commands::focusbar_is_visible,
            commands::focusbar_was_visible,
            commands::focusbar_reset_position,
            commands::focusbar_start_drag,
            commands::focusbar_focus_main,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Keel");
}
