//! Keel updates, only when the user asks: find a newer release of Keel on GitHub, download its
//! installer and check it against the release's SHA256SUMS.txt, or take an installer the user
//! downloaded; then start the installer and close Keel.
//!
//! The repository is private, so looking for releases needs a read-only GitHub token. It is
//! kept in the OS credential store (account "keel-updates") and sent only to api.github.com.
//! GitHub answers an asset download with a redirect to its download host; that request is
//! made without the token, and only to an allow-listed host.
//!
//! The web view never passes a URL or a path: the repository is fixed here, downloads go to
//! `<data dir>/updates`, and a user-chosen installer comes from a native file dialog.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime};
use url::Url;

use crate::error::{Error, Result};
use crate::secrets::{self, StoredSecret};

/// Where releases are published (see .github/workflows/release.yml).
pub const REPO: &str = "yalijore/project-";
const API: &str = "https://api.github.com";
const TOKEN_ACCOUNT: &str = "keel-updates";
/// Hosts GitHub redirects release-asset downloads to.
const DOWNLOAD_HOSTS: &[&str] = &[
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
];
const MAX_INSTALLER_BYTES: u64 = 300 * 1024 * 1024;
pub const PROGRESS_EVENT: &str = "update:progress";

/// Test hook: the E2E suite serves releases from a local mock. Only when KEEL_E2E is set.
fn e2e_base() -> Option<Url> {
    std::env::var_os("KEEL_E2E")?;
    Url::parse(&std::env::var("KEEL_E2E_UPDATE_BASE").ok()?).ok()
}

fn api_base() -> String {
    e2e_base()
        .map(|u| u.as_str().trim_end_matches('/').to_string())
        .unwrap_or_else(|| API.to_string())
}

// ---------------------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------------------

/// "0.2.0" or "v0.2.0" → (0, 2, 0).
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let core = v.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let out = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(out)
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    matches!((parse_version(candidate), parse_version(current)), (Some(a), Some(b)) if a > b)
}

/// The version in an installer's file name: "Keel_0.2.0_x64-setup.exe" → "0.2.0".
pub fn version_from_file_name(name: &str) -> Option<String> {
    let rest = name.strip_prefix("Keel_")?;
    let v = rest.split('_').next()?;
    parse_version(v).map(|_| v.to_string())
}

/// The installer to use from a release: the per-user NSIS setup (no admin rights needed).
pub fn pick_installer(assets: &[Asset]) -> Option<&Asset> {
    assets
        .iter()
        .find(|a| a.name.starts_with("Keel_") && a.name.ends_with("-setup.exe"))
}

/// The expected SHA-256 of `name` in a SHA256SUMS.txt ("<hex>  <name>" per line).
pub fn checksum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        (file == name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

/// Download redirects may only go to GitHub's download hosts (or the E2E mock).
pub fn allowed_download(url: &Url) -> bool {
    if let Some(base) = e2e_base() {
        if url.origin() == base.origin() {
            return true;
        }
    }
    url.scheme() == "https" && url.host_str().is_some_and(|h| DOWNLOAD_HOSTS.contains(&h))
}

/// A file name safe to create inside the updates folder.
fn safe_name(name: &str) -> Result<String> {
    let ok = !name.is_empty()
        && name.len() <= 120
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(name.to_string())
    } else {
        Err(Error::msg(format!("unexpected installer name: {name}")))
    }
}

pub fn valid_token(token: &str) -> bool {
    (20..=255).contains(&token.len())
        && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// ---------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: u64,
    pub name: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    html_url: String,
    assets: Vec<Asset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub current: String,
    pub version: String,
    pub newer: bool,
    pub title: String,
    pub notes: String,
    pub published_at: Option<String>,
    pub page_url: String,
    pub installer: Option<Asset>,
    pub checksums: Option<Asset>,
}

fn token() -> Result<String> {
    secrets::load(TOKEN_ACCOUNT)?
        .and_then(|s| s.api_token)
        .ok_or_else(|| Error::msg("Add a GitHub token first."))
}

pub fn set_token(token: &str) -> Result<()> {
    let token = token.trim();
    if !valid_token(token) {
        return Err(Error::msg("That does not look like a GitHub token."));
    }
    secrets::save(
        TOKEN_ACCOUNT,
        &StoredSecret {
            provider: "github-updates".into(),
            api_token: Some(token.into()),
            ..Default::default()
        },
    )
}

pub fn has_token() -> Result<bool> {
    Ok(secrets::load(TOKEN_ACCOUNT)?
        .and_then(|s| s.api_token)
        .is_some())
}

pub fn forget_token() -> Result<()> {
    secrets::delete(TOKEN_ACCOUNT)
}

fn github(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    accept: &str,
) -> reqwest::RequestBuilder {
    client
        .get(url)
        .bearer_auth(token)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
}

fn explain(status: reqwest::StatusCode) -> Error {
    Error::msg(match status.as_u16() {
        401 => "GitHub did not accept the token. Create a new one and add it again.".to_string(),
        403 => "GitHub refused the request (the token may lack read access to Keel's repository, or the rate limit was hit).".to_string(),
        404 => format!("No release found. Check that the token can read {REPO}."),
        s => format!("GitHub answered {s}."),
    })
}

pub async fn check(current: &str) -> Result<ReleaseInfo> {
    let token = token()?;
    let client = no_redirect_client()?;
    let url = format!("{}/repos/{REPO}/releases/latest", api_base());
    let res = github(&client, &url, &token, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| Error::msg(format!("Could not reach GitHub: {e}")))?;
    if !res.status().is_success() {
        return Err(explain(res.status()));
    }
    let body = res
        .text()
        .await
        .map_err(|e| Error::msg(format!("Could not read GitHub's answer: {e}")))?;
    let r: GhRelease = serde_json::from_str(&body)
        .map_err(|e| Error::msg(format!("Unexpected answer from GitHub: {e}")))?;
    let version = r.tag_name.trim_start_matches('v').to_string();
    let installer = pick_installer(&r.assets).cloned();
    let checksums = r
        .assets
        .iter()
        .find(|a| a.name == "SHA256SUMS.txt")
        .cloned();
    Ok(ReleaseInfo {
        current: current.to_string(),
        newer: is_newer(&version, current),
        title: r.name.unwrap_or_else(|| format!("Keel {version}")),
        version,
        notes: r.body.unwrap_or_default(),
        published_at: r.published_at,
        page_url: r.html_url,
        installer,
        checksums,
    })
}

fn no_redirect_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .connect_timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("Keel/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::msg(format!("HTTP client error: {e}")))
}

/// Starts an asset download: the API answers with a redirect to GitHub's download host,
/// which is then fetched without the token.
async fn open_asset(client: &reqwest::Client, token: &str, id: u64) -> Result<reqwest::Response> {
    let url = format!("{}/repos/{REPO}/releases/assets/{id}", api_base());
    let res = github(client, &url, token, "application/octet-stream")
        .send()
        .await
        .map_err(|e| Error::msg(format!("Could not reach GitHub: {e}")))?;
    if res.status().is_redirection() {
        let location = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| Error::msg("GitHub sent a redirect without a location."))?;
        let target = Url::parse(location).map_err(|_| Error::msg("Bad download location."))?;
        if !allowed_download(&target) {
            return Err(Error::msg(format!(
                "Refusing to download from an unexpected host ({}).",
                target.host_str().unwrap_or("?")
            )));
        }
        let res = client
            .get(target)
            .send()
            .await
            .map_err(|e| Error::msg(format!("Download failed: {e}")))?;
        return if res.status().is_success() {
            Ok(res)
        } else {
            Err(explain(res.status()))
        };
    }
    if res.status().is_success() {
        Ok(res)
    } else {
        Err(explain(res.status()))
    }
}

// ---------------------------------------------------------------------------------------
// Staging and installing
// ---------------------------------------------------------------------------------------

/// The installer the wizard will run: downloaded and verified, or picked by the user.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    #[serde(skip)]
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub version: Option<String>,
    /// Matched the release's SHA256SUMS.txt.
    pub verified: bool,
}

pub struct Updates {
    dir: PathBuf,
    staged: Mutex<Option<Staged>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    received: u64,
    total: u64,
}

impl Updates {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("updates"),
            staged: Mutex::new(None),
        }
    }

    fn stage(&self, s: Staged) -> Staged {
        *self.staged.lock().unwrap_or_else(|e| e.into_inner()) = Some(s.clone());
        s
    }

    /// Removes downloaded installers (after Delete all data, or a finished update).
    pub fn clear(&self) {
        *self.staged.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let _ = std::fs::remove_dir_all(&self.dir);
    }

    pub async fn download<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        installer: &Asset,
        checksums: &Asset,
        version: &str,
    ) -> Result<Staged> {
        let name = safe_name(&installer.name)?;
        if installer.size > MAX_INSTALLER_BYTES {
            return Err(Error::msg("The installer is unexpectedly large."));
        }
        let token = token()?;
        let client = no_redirect_client()?;

        let sums = open_asset(&client, &token, checksums.id)
            .await?
            .text()
            .await
            .map_err(|e| Error::msg(format!("Download failed: {e}")))?;
        let expected = checksum_for(&sums, &name).ok_or_else(|| {
            Error::msg("The release's SHA256SUMS.txt does not list its installer.")
        })?;

        std::fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(&name);
        let partial = self.dir.join(format!("{name}.part"));
        let mut res = open_asset(&client, &token, installer.id).await?;
        let total = res.content_length().unwrap_or(installer.size);
        let mut file = std::fs::File::create(&partial)?;
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| Error::msg(format!("Download failed: {e}")))?
        {
            received += chunk.len() as u64;
            if received > MAX_INSTALLER_BYTES {
                let _ = std::fs::remove_file(&partial);
                return Err(Error::msg("The installer is unexpectedly large."));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)?;
            let _ = app.emit(PROGRESS_EVENT, Progress { received, total });
        }
        file.flush()?;
        drop(file);
        let sha256 = hex(&hasher.finalize());
        if sha256 != expected {
            let _ = std::fs::remove_file(&partial);
            return Err(Error::msg(
                "The downloaded installer does not match the release's checksum; it was deleted.",
            ));
        }
        std::fs::rename(&partial, &path)?;
        Ok(self.stage(Staged {
            path,
            name,
            size: received,
            sha256,
            version: Some(version.to_string()),
            verified: true,
        }))
    }

    /// An installer the user downloaded themselves, chosen in a native dialog.
    pub fn use_file(&self, path: PathBuf) -> Result<Staged> {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let lower = name.to_ascii_lowercase();
        if !(lower.ends_with(".exe") || lower.ends_with(".msi")) {
            return Err(Error::msg("Choose a Keel installer (.exe or .msi)."));
        }
        let size = std::fs::metadata(&path)?.len();
        if size > MAX_INSTALLER_BYTES {
            return Err(Error::msg("That file is too large to be a Keel installer."));
        }
        Ok(self.stage(Staged {
            sha256: file_sha256(&path)?,
            version: version_from_file_name(&name),
            path,
            name,
            size,
            verified: false,
        }))
    }

    /// Starts the staged installer and returns; the caller then closes Keel so the
    /// installer can replace its files. Windows only.
    pub fn launch(&self) -> Result<()> {
        let staged = self
            .staged
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| Error::msg("No installer is ready."))?;
        // The file must still be the one that was checked.
        if file_sha256(&staged.path)? != staged.sha256 {
            return Err(Error::msg(
                "The installer changed since it was checked; start again.",
            ));
        }
        launch_installer(&staged.path)
    }
}

#[cfg(windows)]
fn launch_installer(path: &Path) -> Result<()> {
    use std::process::Command;
    let is_msi = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("msi"));
    let spawned = if is_msi {
        Command::new("msiexec").arg("/i").arg(path).spawn()
    } else {
        Command::new(path).spawn()
    };
    spawned
        .map(|_| ())
        .map_err(|e| Error::msg(format!("Could not start the installer: {e}")))
}

#[cfg(not(windows))]
fn launch_installer(_path: &Path) -> Result<()> {
    Err(Error::msg(
        "Installing updates from Keel is available on Windows. On this system, install the new version from the release page.",
    ))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("v0.2.0"), Some((0, 2, 0)));
        assert_eq!(parse_version("1.10.3-beta.1"), Some((1, 10, 3)));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("v1.0.0", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
        assert!(!is_newer("nonsense", "0.2.0"));
    }

    #[test]
    fn installer_names() {
        assert_eq!(
            version_from_file_name("Keel_0.2.0_x64-setup.exe").as_deref(),
            Some("0.2.0")
        );
        assert_eq!(
            version_from_file_name("Keel_0.2.0_x64_en-US.msi").as_deref(),
            Some("0.2.0")
        );
        assert_eq!(version_from_file_name("setup.exe"), None);
        let assets = vec![
            Asset {
                id: 1,
                name: "Keel_0.3.0_x64_en-US.msi".into(),
                size: 1,
            },
            Asset {
                id: 2,
                name: "Keel_0.3.0_x64-setup.exe".into(),
                size: 1,
            },
            Asset {
                id: 3,
                name: "SHA256SUMS.txt".into(),
                size: 1,
            },
        ];
        assert_eq!(pick_installer(&assets).map(|a| a.id), Some(2));
        assert!(safe_name("Keel_0.3.0_x64-setup.exe").is_ok());
        assert!(safe_name("../evil.exe").is_err());
        assert!(safe_name("a b.exe").is_err());
    }

    #[test]
    fn checksums() {
        let h = "a".repeat(64);
        let sums = format!(
            "{h}  Keel_0.3.0_x64-setup.exe\n{}  Keel_0.3.0_x64_en-US.msi\n",
            "b".repeat(64)
        );
        assert_eq!(checksum_for(&sums, "Keel_0.3.0_x64-setup.exe"), Some(h));
        assert_eq!(checksum_for(&sums, "other.exe"), None);
        assert_eq!(checksum_for("xyz  Keel.exe", "Keel.exe"), None);
        // As written by the release workflow on Windows (PowerShell, CRLF line ends).
        let crlf = format!(
            "{}  Keel_0.2.0_x64-setup.exe\r\n{}  SHA256SUMS.txt\r\n",
            "c".repeat(64),
            "d".repeat(64)
        );
        assert_eq!(
            checksum_for(&crlf, "Keel_0.2.0_x64-setup.exe"),
            Some("c".repeat(64))
        );
    }

    #[test]
    fn download_hosts() {
        let ok =
            Url::parse("https://objects.githubusercontent.com/github-production-release-asset/1")
                .unwrap();
        let other = Url::parse("https://evil.example.com/file").unwrap();
        let plain = Url::parse("http://objects.githubusercontent.com/file").unwrap();
        assert!(allowed_download(&ok));
        assert!(!allowed_download(&other));
        assert!(!allowed_download(&plain));
    }

    #[test]
    fn tokens() {
        assert!(valid_token(
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"
        ));
        assert!(valid_token("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
        assert!(!valid_token("short"));
        assert!(!valid_token("has space in it and is long enough"));
    }

    #[test]
    fn a_user_chosen_file_is_hashed_and_not_verified() {
        let dir = std::env::temp_dir().join(format!("keel-upd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Keel_9.9.9_x64-setup.exe");
        std::fs::write(&path, b"installer bytes").unwrap();
        let u = Updates::new(&dir);
        let s = u.use_file(path.clone()).unwrap();
        assert_eq!(s.version.as_deref(), Some("9.9.9"));
        assert!(!s.verified);
        assert_eq!(s.sha256, hex(&Sha256::digest(b"installer bytes")));
        // A file swapped after the check is refused.
        std::fs::write(&path, b"something else").unwrap();
        assert!(u.launch().is_err());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(u.use_file(dir.join("notes.txt")).is_err());
    }
}
