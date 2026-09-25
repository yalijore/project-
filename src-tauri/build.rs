// Every app command gets an explicit permission, so each window can only call the commands
// its capability lists (see capabilities/). The focus bar, for example, cannot reach the
// database, files or integrations.
const COMMANDS: &[&str] = &[
    "db_execute",
    "db_query",
    "db_execute_script",
    "db_reset",
    "db_info",
    "backup_create",
    "backup_list",
    "backup_restore",
    "backup_export",
    "backup_import",
    "data_wipe",
    "file_save_text",
    "file_open_text",
    "file_open_binary",
    "app_environment",
    "integration_store_secret",
    "integration_has_secret",
    "integration_delete_secret",
    "integration_delete_secrets",
    "integration_fetch",
    "ics_fetch_account",
    "oauth_connect",
    "oauth_revoke",
    "focusbar_show",
    "focusbar_hide",
    "focusbar_is_visible",
    "focusbar_was_visible",
    "focusbar_reset_position",
    "focusbar_start_drag",
    "focusbar_focus_main",
    "update_status",
    "update_set_token",
    "update_forget_token",
    "update_check",
    "update_download",
    "update_pick_file",
    "update_install",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
