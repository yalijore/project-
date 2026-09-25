//! Authorized HTTP for opt-in integrations.
//!
//! The web view asks Rust to call a provider API on behalf of an account. Rust loads that
//! account's credentials from the OS credential store, checks the URL against the provider's
//! fixed host allow-list, attaches authentication, refreshes OAuth tokens when needed, and
//! returns only the response. Tokens therefore never enter the web view, and a token can
//! only ever be sent to the provider it was issued by.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{Error, Result};
use crate::secrets::{self, StoredSecret};

const MAX_BODY_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AuthKind {
    OAuthBearer,
    BearerToken,
    JiraBasic,
    TrelloQuery,
}

#[derive(Debug, Clone)]
pub struct ProviderPolicy {
    pub id: &'static str,
    pub auth: AuthKind,
    pub hosts: &'static [&'static str],
}

pub fn policy(provider: &str) -> Option<ProviderPolicy> {
    let p = |id, auth, hosts| Some(ProviderPolicy { id, auth, hosts });
    match provider {
        "google" => p(
            "google",
            AuthKind::OAuthBearer,
            &["www.googleapis.com", "openidconnect.googleapis.com"],
        ),
        "microsoft" => p("microsoft", AuthKind::OAuthBearer, &["graph.microsoft.com"]),
        "todoist" => p("todoist", AuthKind::BearerToken, &["api.todoist.com"]),
        "asana" => p("asana", AuthKind::BearerToken, &["app.asana.com"]),
        "notion" => p("notion", AuthKind::BearerToken, &["api.notion.com"]),
        "trello" => p("trello", AuthKind::TrelloQuery, &["api.trello.com"]),
        // Jira's host is the user's own site; validated separately to *.atlassian.net.
        "jira" => p("jira", AuthKind::JiraBasic, &[]),
        _ => None,
    }
}

/// Test hook: lets the E2E suite point providers at a local mock server. Honoured only when
/// KEEL_E2E is set in the process environment (never settable from the web view).
fn e2e_base() -> Option<Url> {
    std::env::var_os("KEEL_E2E")?;
    let base = std::env::var("KEEL_E2E_PROVIDER_BASE").ok()?;
    Url::parse(&base).ok()
}

pub fn valid_jira_site(site: &str) -> bool {
    let site = site.trim().to_ascii_lowercase();
    site.ends_with(".atlassian.net")
        && site
            .trim_end_matches(".atlassian.net")
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !site.starts_with('.')
}

/// Checks that `url` may carry credentials for `secret.provider`.
pub fn check_url(secret: &StoredSecret, url: &Url) -> Result<()> {
    let policy =
        policy(&secret.provider).ok_or_else(|| Error::msg("unknown integration provider"))?;
    if let Some(base) = e2e_base() {
        if url.scheme() == base.scheme()
            && url.host_str() == base.host_str()
            && url.port_or_known_default() == base.port_or_known_default()
        {
            return Ok(());
        }
    }
    if url.scheme() != "https" {
        return Err(Error::msg("integrations only use HTTPS"));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let allowed = match policy.auth {
        AuthKind::JiraBasic => secret
            .site
            .as_deref()
            .map(|s| s.trim().eq_ignore_ascii_case(&host) && valid_jira_site(s))
            .unwrap_or(false),
        _ => policy.hosts.iter().any(|h| *h == host),
    };
    if !allowed {
        return Err(Error::msg(format!(
            "{} credentials may not be sent to {host}",
            policy.id
        )));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("Keel/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| Error::msg(format!("HTTP client error: {e}")))
}

pub fn token_url(secret: &StoredSecret) -> Option<String> {
    match secret.provider.as_str() {
        "google" => Some("https://oauth2.googleapis.com/token".into()),
        "microsoft" => Some(format!(
            "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
            secret.tenant.as_deref().unwrap_or("common")
        )),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub scope: Option<String>,
}

/// Applies a token endpoint response to the stored secret.
pub fn apply_token(secret: &mut StoredSecret, t: TokenResponse) {
    secret.access_token = Some(t.access_token);
    if t.refresh_token.is_some() {
        secret.refresh_token = t.refresh_token;
    }
    secret.expires_at = t.expires_in.map(|s| now_secs() + s);
    if t.scope.is_some() {
        secret.scope = t.scope;
    }
}

async fn refresh(
    client: &reqwest::Client,
    account_id: &str,
    secret: &mut StoredSecret,
) -> Result<()> {
    let url = token_url(secret).ok_or_else(|| Error::msg("provider has no token endpoint"))?;
    let refresh_token = secret
        .refresh_token
        .clone()
        .ok_or_else(|| Error::msg("REAUTH: no refresh token; reconnect the account"))?;
    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token),
        ("client_id", secret.client_id.clone().unwrap_or_default()),
    ];
    if let Some(cs) = &secret.client_secret {
        form.push(("client_secret", cs.clone()));
    }
    let res = client
        .post(url)
        .form(&form)
        .send()
        .await
        .map_err(|e| Error::msg(format!("NETWORK: {e}")))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::msg(format!(
            "REAUTH: token refresh failed ({status}); reconnect the account"
        )));
    }
    let t: TokenResponse = serde_json::from_str(&body)?;
    apply_token(secret, t);
    secrets::save(account_id, secret)
}

fn authorize(
    req: reqwest::RequestBuilder,
    secret: &StoredSecret,
) -> Result<reqwest::RequestBuilder> {
    let policy = policy(&secret.provider).ok_or_else(|| Error::msg("unknown provider"))?;
    Ok(match policy.auth {
        AuthKind::OAuthBearer => req.bearer_auth(
            secret
                .access_token
                .as_deref()
                .ok_or_else(|| Error::msg("REAUTH: not connected"))?,
        ),
        AuthKind::BearerToken => req.bearer_auth(
            secret
                .api_token
                .as_deref()
                .ok_or_else(|| Error::msg("REAUTH: missing API token"))?,
        ),
        AuthKind::JiraBasic => {
            let raw = format!(
                "{}:{}",
                secret.email.as_deref().unwrap_or_default(),
                secret.api_token.as_deref().unwrap_or_default()
            );
            req.header(
                "Authorization",
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(raw)
                ),
            )
        }
        AuthKind::TrelloQuery => req.query(&[
            ("key", secret.api_key.as_deref().unwrap_or_default()),
            ("token", secret.api_token.as_deref().unwrap_or_default()),
        ]),
    })
}

const FORBIDDEN_HEADERS: &[&str] = &["authorization", "cookie", "proxy-authorization", "host"];
const RETURNED_HEADERS: &[&str] = &[
    "content-type",
    "retry-after",
    "etag",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "link",
];

pub async fn fetch(account_id: &str, req: FetchRequest) -> Result<FetchResponse> {
    let mut secret = secrets::load(account_id)?
        .ok_or_else(|| Error::msg("REAUTH: this account is not connected"))?;
    let url = Url::parse(&req.url).map_err(|_| Error::msg("invalid URL"))?;
    check_url(&secret, &url)?;
    let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| Error::msg("invalid HTTP method"))?;
    let client = client()?;

    let oauth = policy(&secret.provider).map(|p| p.auth) == Some(AuthKind::OAuthBearer);
    if oauth
        && secret
            .expires_at
            .map(|e| e <= now_secs() + 60)
            .unwrap_or(false)
    {
        refresh(&client, account_id, &mut secret).await?;
    }

    for attempt in 0..2 {
        let mut rb = client.request(method.clone(), url.clone());
        for (k, v) in &req.headers {
            if FORBIDDEN_HEADERS.contains(&k.to_ascii_lowercase().as_str()) {
                return Err(Error::msg(format!("header {k} may not be set")));
            }
            rb = rb.header(k, v);
        }
        if let Some(body) = &req.body {
            rb = rb.body(body.clone());
        }
        let res = authorize(rb, &secret)?
            .send()
            .await
            .map_err(|e| Error::msg(format!("NETWORK: {e}")))?;
        let status = res.status().as_u16();
        if status == 401 && oauth && attempt == 0 && secret.refresh_token.is_some() {
            refresh(&client, account_id, &mut secret).await?;
            continue;
        }
        let mut headers = HashMap::new();
        for name in RETURNED_HEADERS {
            if let Some(v) = res.headers().get(*name).and_then(|v| v.to_str().ok()) {
                headers.insert((*name).to_string(), v.to_string());
            }
        }
        let bytes = res
            .bytes()
            .await
            .map_err(|e| Error::msg(format!("NETWORK: {e}")))?;
        if bytes.len() > MAX_BODY_BYTES {
            return Err(Error::msg("response too large"));
        }
        return Ok(FetchResponse {
            status,
            headers,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }
    Err(Error::msg("REAUTH: the provider rejected the credentials"))
}

/// Downloads a subscribed iCalendar feed. No credentials are attached; `webcal://` is
/// treated as HTTPS.
pub async fn fetch_ics(url: &str) -> Result<String> {
    let normalized = if let Some(rest) = url.trim().strip_prefix("webcal://") {
        format!("https://{rest}")
    } else {
        url.trim().to_string()
    };
    let parsed = Url::parse(&normalized).map_err(|_| Error::msg("invalid calendar URL"))?;
    let e2e_ok = e2e_base()
        .map(|b| {
            parsed.host_str() == b.host_str()
                && parsed.port_or_known_default() == b.port_or_known_default()
        })
        .unwrap_or(false);
    if parsed.scheme() != "https" && !e2e_ok {
        return Err(Error::msg(
            "calendar subscriptions must use https:// or webcal://",
        ));
    }
    let res = client()?
        .get(parsed)
        .header("Accept", "text/calendar, */*;q=0.5")
        .send()
        .await
        .map_err(|e| Error::msg(format!("NETWORK: {e}")))?;
    let status = res.status();
    if !status.is_success() {
        return Err(Error::msg(format!("the calendar server answered {status}")));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| Error::msg(format!("NETWORK: {e}")))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(Error::msg("calendar feed is too large (limit 20 MB)"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Validates and stores API-token credentials entered by the user.
pub fn store_token_secret(account_id: &str, secret: StoredSecret) -> Result<()> {
    let policy =
        policy(&secret.provider).ok_or_else(|| Error::msg("unknown integration provider"))?;
    let has = |v: &Option<String>| v.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    match policy.auth {
        AuthKind::OAuthBearer => {
            return Err(Error::msg(
                "this provider connects through its sign-in page",
            ))
        }
        AuthKind::BearerToken if !has(&secret.api_token) => {
            return Err(Error::msg("an API token is required"))
        }
        AuthKind::TrelloQuery if !has(&secret.api_token) || !has(&secret.api_key) => {
            return Err(Error::msg("both a Trello API key and token are required"))
        }
        AuthKind::JiraBasic => {
            if !has(&secret.api_token) || !has(&secret.email) {
                return Err(Error::msg("a Jira email and API token are required"));
            }
            if !secret.site.as_deref().map(valid_jira_site).unwrap_or(false) {
                return Err(Error::msg(
                    "the Jira site must look like your-team.atlassian.net",
                ));
            }
        }
        _ => {}
    }
    let clean = StoredSecret {
        provider: policy.id.to_string(),
        api_token: secret.api_token.map(|s| s.trim().to_string()),
        api_key: secret.api_key.map(|s| s.trim().to_string()),
        email: secret.email.map(|s| s.trim().to_string()),
        site: secret.site.map(|s| s.trim().to_ascii_lowercase()),
        ..Default::default()
    };
    secrets::save(account_id, &clean)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(provider: &str) -> StoredSecret {
        StoredSecret {
            provider: provider.into(),
            ..Default::default()
        }
    }

    #[test]
    fn tokens_only_go_to_their_provider() {
        let google = secret("google");
        assert!(check_url(
            &google,
            &Url::parse("https://www.googleapis.com/calendar/v3/x").unwrap()
        )
        .is_ok());
        assert!(check_url(&google, &Url::parse("https://evil.example.com/").unwrap()).is_err());
        assert!(check_url(&google, &Url::parse("http://www.googleapis.com/").unwrap()).is_err());
        assert!(check_url(
            &google,
            &Url::parse("https://graph.microsoft.com/v1.0/me").unwrap()
        )
        .is_err());
        let todoist = secret("todoist");
        assert!(check_url(
            &todoist,
            &Url::parse("https://api.todoist.com/api/v1/tasks").unwrap()
        )
        .is_ok());
        assert!(check_url(
            &secret("unknown"),
            &Url::parse("https://api.todoist.com/").unwrap()
        )
        .is_err());
    }

    #[test]
    fn jira_is_restricted_to_the_users_atlassian_site() {
        let mut jira = secret("jira");
        jira.site = Some("acme.atlassian.net".into());
        assert!(check_url(
            &jira,
            &Url::parse("https://acme.atlassian.net/rest/api/3/myself").unwrap()
        )
        .is_ok());
        assert!(check_url(
            &jira,
            &Url::parse("https://other.atlassian.net/rest").unwrap()
        )
        .is_err());
        jira.site = Some("evil.com".into());
        assert!(check_url(&jira, &Url::parse("https://evil.com/").unwrap()).is_err());
        assert!(valid_jira_site("my-team.atlassian.net"));
        assert!(!valid_jira_site("atlassian.net.evil.com"));
        assert!(!valid_jira_site("a.b.atlassian.net"));
    }

    #[test]
    fn validates_token_secrets() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("KEEL_E2E", "1");
        std::env::set_var("KEEL_E2E_SECRET_DIR", dir.path());
        assert!(store_token_secret("a1", secret("todoist")).is_err());
        assert!(store_token_secret("a1", secret("google")).is_err());
        let mut ok = secret("todoist");
        ok.api_token = Some("  tok  ".into());
        ok.access_token = Some("smuggled".into());
        store_token_secret("a1", ok).unwrap();
        let stored = secrets::load("a1").unwrap().unwrap();
        assert_eq!(stored.api_token.as_deref(), Some("tok"));
        assert_eq!(
            stored.access_token, None,
            "only fields for the provider's auth are kept"
        );
        let mut jira = secret("jira");
        jira.api_token = Some("t".into());
        jira.email = Some("me@example.com".into());
        jira.site = Some("evil.com".into());
        assert!(store_token_secret("a2", jira.clone()).is_err());
        jira.site = Some("Acme.atlassian.net".into());
        store_token_secret("a2", jira).unwrap();
        assert_eq!(
            secrets::load("a2").unwrap().unwrap().site.as_deref(),
            Some("acme.atlassian.net")
        );
        secrets::delete("a1").unwrap();
        assert!(secrets::load("a1").unwrap().is_none());
    }

    #[test]
    fn applies_token_responses_keeping_old_refresh_token() {
        let mut s = secret("google");
        s.refresh_token = Some("r1".into());
        apply_token(
            &mut s,
            TokenResponse {
                access_token: "a".into(),
                refresh_token: None,
                expires_in: Some(3600),
                scope: None,
            },
        );
        assert_eq!(s.access_token.as_deref(), Some("a"));
        assert_eq!(s.refresh_token.as_deref(), Some("r1"));
        assert!(s.expires_at.unwrap() > now_secs() + 3500);
    }
}
