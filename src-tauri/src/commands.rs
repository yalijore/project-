//! Tauri commands exposed to the web view. Blocking work runs off the main thread.

use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager, State};

use crate::db::{BackupInfo, DbInfo, ExecResult, QueryResult, SharedDb};
use crate::error::{Error, Result};
use crate::files;
use crate::focusbar;
use crate::integrations::{self, FetchRequest, FetchResponse};
use crate::oauth;
use crate::secrets::{self, StoredSecret};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::msg(format!("background task failed: {e}")))?
}

#[tauri::command]
pub async fn db_execute(
    db: State<'_, SharedDb>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<ExecResult> {
    let db = db.inner().clone();
    blocking(move || db.execute(&sql, &params)).await
}

#[tauri::command]
pub async fn db_query(
    db: State<'_, SharedDb>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<QueryResult> {
    let db = db.inner().clone();
    blocking(move || db.query(&sql, &params)).await
}

#[tauri::command]
pub async fn db_execute_script(db: State<'_, SharedDb>, sql: String) -> Result<()> {
    let db = db.inner().clone();
    blocking(move || db.execute_script(&sql)).await
}

#[tauri::command]
pub async fn db_reset(db: State<'_, SharedDb>) -> Result<bool> {
    let db = db.inner().clone();
    blocking(move || db.reset()).await
}

#[tauri::command]
pub async fn db_info(db: State<'_, SharedDb>) -> Result<DbInfo> {
    let db = db.inner().clone();
    blocking(move || db.info()).await
}

#[tauri::command]
pub async fn backup_create(db: State<'_, SharedDb>, reason: String) -> Result<BackupInfo> {
    let db = db.inner().clone();
    blocking(move || db.create_backup(&reason)).await
}

#[tauri::command]
pub async fn backup_list(db: State<'_, SharedDb>) -> Result<Vec<BackupInfo>> {
    let db = db.inner().clone();
    blocking(move || db.list_backups()).await
}

/// Restores one of the automatic/manual backups in Keel's own backup folder.
#[tauri::command]
pub async fn backup_restore(
    db: State<'_, SharedDb>,
    file_name: String,
    max_supported_version: i64,
) -> Result<BackupInfo> {
    let db = db.inner().clone();
    blocking(move || {
        let path = db.resolve_backup(&file_name)?;
        db.restore_from(&path, max_supported_version)
    })
    .await
}

/// Exports a database copy to a location the user picks. Returns the path, or None if cancelled.
#[tauri::command]
pub async fn backup_export(
    app: AppHandle,
    db: State<'_, SharedDb>,
    suggested_name: String,
) -> Result<Option<String>> {
    let db = db.inner().clone();
    blocking(move || {
        let Some(path) = files::pick_save_path(
            &app,
            &suggested_name,
            "Keel backup",
            &["sqlite3".to_string()],
        ) else {
            return Ok(None);
        };
        db.vacuum_into(&path)?;
        Ok(Some(path.display().to_string()))
    })
    .await
}

/// Restores from a backup file the user picks. Returns None if cancelled.
#[tauri::command]
pub async fn backup_import(
    app: AppHandle,
    db: State<'_, SharedDb>,
    max_supported_version: i64,
) -> Result<Option<BackupInfo>> {
    let db = db.inner().clone();
    blocking(move || {
        let Some(path) = files::pick_open_path(&app, "Keel backup", &["sqlite3".to_string()])
        else {
            return Ok(None);
        };
        db.restore_from(&path, max_supported_version).map(Some)
    })
    .await
}

/// Permanently deletes the database and local backups. Integration secrets are removed by
/// the caller through `secrets_delete_all` before this runs.
#[tauri::command]
pub async fn data_wipe(
    app: AppHandle,
    db: State<'_, SharedDb>,
    confirmation: String,
) -> Result<()> {
    if confirmation != "DELETE" {
        return Err(Error::msg("confirmation text did not match"));
    }
    let _ = focusbar::hide(&app);
    app.state::<focusbar::FocusBar>().forget();
    let db = db.inner().clone();
    blocking(move || db.wipe()).await
}

#[tauri::command]
pub async fn file_save_text(
    app: AppHandle,
    suggested_name: String,
    filter_name: String,
    extensions: Vec<String>,
    contents: String,
) -> Result<Option<String>> {
    blocking(move || {
        let Some(path) = files::pick_save_path(&app, &suggested_name, &filter_name, &extensions)
        else {
            return Ok(None);
        };
        files::write_text(&path, &contents)?;
        Ok(Some(path.display().to_string()))
    })
    .await
}

#[tauri::command]
pub async fn file_open_text(
    app: AppHandle,
    filter_name: String,
    extensions: Vec<String>,
    lossy: Option<bool>,
) -> Result<Option<files::OpenedText>> {
    blocking(move || {
        let Some(path) = files::pick_open_path(&app, &filter_name, &extensions) else {
            return Ok(None);
        };
        files::read_text(path, lossy.unwrap_or(false)).map(Some)
    })
    .await
}

#[tauri::command]
pub fn app_environment() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "e2e": std::env::var_os("KEEL_E2E").is_some(),
        // Wayland compositors do not let apps grab global shortcuts or keep windows on top.
        "wayland": cfg!(target_os = "linux")
            && (std::env::var_os("WAYLAND_DISPLAY").is_some()
                || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland")),
    })
}

// ---------------------------------------------------------------------------------------
// Integrations (opt-in, networked)
// ---------------------------------------------------------------------------------------

/// Stores API-token credentials the user pasted. They are never returned to the web view.
#[tauri::command]
pub async fn integration_store_secret(account_id: String, secret: StoredSecret) -> Result<()> {
    blocking(move || integrations::store_token_secret(&account_id, secret)).await
}

#[tauri::command]
pub async fn integration_has_secret(account_id: String) -> Result<bool> {
    blocking(move || Ok(secrets::load(&account_id)?.is_some())).await
}

#[tauri::command]
pub async fn integration_delete_secret(account_id: String) -> Result<()> {
    blocking(move || secrets::delete(&account_id)).await
}

/// Removes the credentials of every given account (used by "Delete all data").
#[tauri::command]
pub async fn integration_delete_secrets(account_ids: Vec<String>) -> Result<()> {
    blocking(move || {
        for id in account_ids {
            secrets::delete(&id)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn integration_fetch(account_id: String, request: FetchRequest) -> Result<FetchResponse> {
    integrations::fetch(&account_id, request).await
}

#[tauri::command]
pub async fn ics_fetch_account(account_id: String) -> Result<String> {
    integrations::fetch_ics_account(&account_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn oauth_connect(
    app: AppHandle,
    account_id: String,
    provider: String,
    client_id: String,
    client_secret: Option<String>,
    tenant: Option<String>,
    scopes: Vec<String>,
) -> Result<oauth::Connected> {
    use tauri_plugin_opener::OpenerExt;
    let open = |url: &str| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| Error::msg(format!("could not open the browser: {e}")))
    };
    // Reconnecting (expired sign-in, or adding the write permission) reuses the client
    // details already stored for this account, since the web view cannot read them.
    let (client_id, client_secret, tenant) = if client_id.trim().is_empty() {
        let id = account_id.clone();
        let existing = blocking(move || secrets::load(&id))
            .await?
            .filter(|s| s.provider == provider)
            .ok_or_else(|| Error::msg("enter the client ID to connect this account"))?;
        (
            existing.client_id.unwrap_or_default(),
            existing.client_secret,
            existing.tenant,
        )
    } else {
        (client_id, client_secret, tenant)
    };
    oauth::connect(
        open,
        &account_id,
        &provider,
        &client_id,
        client_secret,
        tenant,
        scopes,
    )
    .await
}

#[tauri::command]
pub async fn oauth_revoke(account_id: String) -> Result<bool> {
    oauth::revoke(&account_id).await
}

// ---------------------------------------------------------------------------------------
// Floating focus bar (window management only; timer state is written by the main window)
// ---------------------------------------------------------------------------------------

// Window-creating commands are async: creating a window from a synchronous command can
// deadlock on Windows.

#[tauri::command]
pub async fn focusbar_show(app: AppHandle) -> Result<()> {
    focusbar::show(&app)
}

#[tauri::command]
pub async fn focusbar_hide(app: AppHandle) -> Result<()> {
    focusbar::hide(&app)
}

#[tauri::command]
pub async fn focusbar_is_visible(app: AppHandle) -> Result<bool> {
    Ok(focusbar::is_visible(&app))
}

/// Whether the bar was showing when Keel last exited.
#[tauri::command]
pub async fn focusbar_was_visible(app: AppHandle) -> Result<bool> {
    Ok(app.state::<focusbar::FocusBar>().was_visible())
}

#[tauri::command]
pub async fn focusbar_reset_position(app: AppHandle) -> Result<()> {
    focusbar::reset_position(&app);
    Ok(())
}

#[tauri::command]
pub async fn focusbar_start_drag(window: tauri::WebviewWindow) -> Result<()> {
    if window.label() != focusbar::LABEL {
        return Err(Error::msg("only the focus bar can be dragged this way"));
    }
    focusbar::start_drag(&window)
}

#[tauri::command]
pub async fn focusbar_focus_main(app: AppHandle) -> Result<()> {
    focusbar::focus_main(&app)
}
