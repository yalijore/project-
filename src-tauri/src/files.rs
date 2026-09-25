//! File I/O at user-chosen locations.
//!
//! The web view never passes filesystem paths to Rust. Every save/open location comes from a
//! native dialog opened here, so a compromised page cannot read or write arbitrary files.
//!
//! For automated end-to-end tests (which cannot drive native dialogs), the launcher may set
//! `KEEL_E2E_DIALOG_DIR`: saves then go to `<dir>/<suggested name>` and opens read
//! `<dir>/<KEEL_E2E_OPEN_FILE>`. These variables are read from the process environment at
//! call time and cannot be set from the web view.

use std::fs;
use std::path::PathBuf;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::{Error, Result};

const MAX_TEXT_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn e2e_dir() -> Option<PathBuf> {
    std::env::var_os("KEEL_E2E_DIALOG_DIR").map(PathBuf::from)
}

pub fn pick_save_path(
    app: &AppHandle,
    suggested_name: &str,
    filter_name: &str,
    extensions: &[String],
) -> Option<PathBuf> {
    if let Some(dir) = e2e_dir() {
        return Some(dir.join(suggested_name));
    }
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    app.dialog()
        .file()
        .set_file_name(suggested_name)
        .add_filter(filter_name, &exts)
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
}

pub fn pick_open_path(
    app: &AppHandle,
    filter_name: &str,
    extensions: &[String],
) -> Option<PathBuf> {
    if let Some(dir) = e2e_dir() {
        return std::env::var_os("KEEL_E2E_OPEN_FILE").map(|f| dir.join(f));
    }
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    app.dialog()
        .file()
        .add_filter(filter_name, &exts)
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
}

#[derive(serde::Serialize)]
pub struct OpenedText {
    pub path: String,
    pub name: String,
    pub contents: String,
}

pub fn read_text(path: PathBuf) -> Result<OpenedText> {
    let meta = fs::metadata(&path)?;
    if meta.len() > MAX_TEXT_FILE_BYTES {
        return Err(Error::msg("file is too large (limit 64 MB)"));
    }
    let bytes = fs::read(&path)?;
    let contents = String::from_utf8(bytes).map_err(|_| Error::msg("file is not UTF-8 text"))?;
    Ok(OpenedText {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.display().to_string(),
        contents,
    })
}

/// Writes atomically: temp file in the same directory, then rename.
pub fn write_text(path: &PathBuf, contents: &str) -> Result<()> {
    let tmp = path.with_extension("keel-tmp");
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)?;
    Ok(())
}
