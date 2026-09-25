//! Tauri commands exposed to the web view. Blocking work runs off the main thread.

use serde_json::Value as JsonValue;
use tauri::{AppHandle, State};

use crate::db::{BackupInfo, DbInfo, ExecResult, QueryResult, SharedDb};
use crate::error::{Error, Result};
use crate::files;

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
pub async fn data_wipe(db: State<'_, SharedDb>, confirmation: String) -> Result<()> {
    if confirmation != "DELETE" {
        return Err(Error::msg("confirmation text did not match"));
    }
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
) -> Result<Option<files::OpenedText>> {
    blocking(move || {
        let Some(path) = files::pick_open_path(&app, &filter_name, &extensions) else {
            return Ok(None);
        };
        files::read_text(path).map(Some)
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
    })
}
