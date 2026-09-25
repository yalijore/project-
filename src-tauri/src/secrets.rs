//! Integration credentials, kept in the operating system's credential store:
//! Windows Credential Manager, macOS Keychain, or the Secret Service on Linux.
//!
//! Secrets are written by Rust (OAuth) or handed over once by the UI when the user pastes an
//! API token, and are never returned to the web view. The database only stores the account
//! id that keys the entry.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const SERVICE: &str = "app.keel.planner";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct StoredSecret {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds when `access_token` expires.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    /// Personal API token (Todoist, Asana, Notion, Jira, Trello token).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_token: Option<String>,
    /// Trello API key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Jira account email (basic auth).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Jira site host, e.g. "acme.atlassian.net".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

fn key(account_id: &str) -> Result<String> {
    if account_id.is_empty()
        || account_id.len() > 64
        || !account_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(Error::msg("invalid account id"));
    }
    Ok(format!("integration:{account_id}"))
}

/// Test-only file store, enabled when both KEEL_E2E and KEEL_E2E_SECRET_DIR are set, so the
/// end-to-end suite can run on machines without an unlocked credential store.
fn e2e_dir() -> Option<PathBuf> {
    std::env::var_os("KEEL_E2E")?;
    std::env::var_os("KEEL_E2E_SECRET_DIR").map(PathBuf::from)
}

pub fn load(account_id: &str) -> Result<Option<StoredSecret>> {
    let k = key(account_id)?;
    let raw = if let Some(dir) = e2e_dir() {
        match std::fs::read_to_string(dir.join(&k)) {
            Ok(s) => Some(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        }
    } else {
        let entry = keyring::Entry::new(SERVICE, &k).map_err(store_error)?;
        match entry.get_password() {
            Ok(s) => Some(s),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => return Err(store_error(e)),
        }
    };
    raw.map(|s| serde_json::from_str(&s).map_err(Error::from))
        .transpose()
}

pub fn save(account_id: &str, secret: &StoredSecret) -> Result<()> {
    let k = key(account_id)?;
    let raw = serde_json::to_string(secret)?;
    if let Some(dir) = e2e_dir() {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(&k), raw)?;
        return Ok(());
    }
    keyring::Entry::new(SERVICE, &k)
        .and_then(|e| e.set_password(&raw))
        .map_err(store_error)
}

pub fn delete(account_id: &str) -> Result<()> {
    let k = key(account_id)?;
    if let Some(dir) = e2e_dir() {
        let _ = std::fs::remove_file(dir.join(&k));
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, &k).map_err(store_error)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(store_error(e)),
    }
}

fn store_error(e: keyring::Error) -> Error {
    Error::msg(format!(
        "The system credential store is unavailable ({e}). On Windows this is Credential Manager; on Linux a Secret Service such as GNOME Keyring must be running and unlocked."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_account_ids() {
        assert!(key("abc-123").is_ok());
        assert!(key("../etc").is_err());
        assert!(key("").is_err());
        assert!(key(&"a".repeat(65)).is_err());
    }

    /// Round-trips through the real OS store. Always runs on Windows (Credential Manager);
    /// elsewhere only with KEEL_TEST_OS_STORE=1 (needs an unlocked Keychain/Secret Service).
    #[test]
    fn os_credential_store_round_trip() {
        if !cfg!(windows) && std::env::var_os("KEEL_TEST_OS_STORE").is_none() {
            return;
        }
        if std::env::var_os("KEEL_E2E_SECRET_DIR").is_some() {
            return; // another test switched this process to the file store
        }
        let id = format!("test-{}", std::process::id());
        let s = StoredSecret {
            provider: "todoist".into(),
            api_token: Some("secret-value".into()),
            ..Default::default()
        };
        save(&id, &s).expect("save to OS credential store");
        assert_eq!(load(&id).unwrap(), Some(s));
        delete(&id).unwrap();
        assert_eq!(load(&id).unwrap(), None);
        delete(&id).expect("deleting a missing entry is not an error");
    }

    #[test]
    fn secret_json_omits_empty_fields() {
        let s = StoredSecret {
            provider: "todoist".into(),
            api_token: Some("t".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"provider":"todoist","api_token":"t"}"#);
        let back: StoredSecret = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }
}
