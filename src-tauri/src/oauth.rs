//! OAuth 2.0 for desktop apps (RFC 8252): the system browser + a one-shot loopback listener,
//! with PKCE (RFC 7636) and a random `state`. Only calendar scopes are permitted.

use std::time::Duration;

use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use crate::error::{Error, Result};
use crate::integrations::{apply_token, client, TokenResponse};
use crate::secrets::{self, StoredSecret};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

pub struct OAuthProvider {
    pub auth_url: String,
    pub token_url: String,
    pub allowed_scopes: &'static [&'static str],
    pub redirect_host: &'static str,
    pub extra: &'static [(&'static str, &'static str)],
}

pub fn provider(id: &str, tenant: Option<&str>) -> Option<OAuthProvider> {
    match id {
        "google" => Some(OAuthProvider {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            allowed_scopes: &[
                "openid",
                "email",
                "https://www.googleapis.com/auth/calendar.readonly",
                "https://www.googleapis.com/auth/calendar.events",
            ],
            redirect_host: "127.0.0.1",
            // Offline access yields a refresh token; consent forces it on reconnect.
            extra: &[("access_type", "offline"), ("prompt", "consent")],
        }),
        "microsoft" => {
            let tenant = tenant
                .filter(|t| {
                    !t.is_empty()
                        && t.chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
                })
                .unwrap_or("common");
            Some(OAuthProvider {
                auth_url: format!(
                    "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"
                ),
                token_url: format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"),
                allowed_scopes: &[
                    "offline_access",
                    "User.Read",
                    "Calendars.Read",
                    "Calendars.ReadWrite",
                ],
                redirect_host: "localhost",
                extra: &[("response_mode", "query"), ("prompt", "select_account")],
            })
        }
        _ => None,
    }
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn random_token(len: usize) -> String {
    let mut buf = vec![0u8; len];
    rand::rng().fill_bytes(&mut buf);
    b64url(&buf)
}

pub fn pkce_challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

pub fn build_auth_url(
    p: &OAuthProvider,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    state: &str,
    challenge: &str,
) -> Result<String> {
    let mut url = Url::parse(&p.auth_url).map_err(|_| Error::msg("bad auth URL"))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", &scopes.join(" "))
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256");
        for (k, v) in p.extra {
            q.append_pair(k, v);
        }
    }
    Ok(url.into())
}

#[derive(Debug, PartialEq)]
pub enum Callback {
    Code(String),
    Denied(String),
    Ignore,
}

/// Parses the request line of the redirect, e.g. `GET /?code=…&state=… HTTP/1.1`.
pub fn parse_callback(request: &str, expected_state: &str) -> Result<Callback> {
    let line = request.lines().next().unwrap_or_default();
    let mut parts = line.split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return Ok(Callback::Ignore);
    };
    let url =
        Url::parse(&format!("http://loopback{target}")).map_err(|_| Error::msg("bad callback"))?;
    if url.path() != "/" {
        return Ok(Callback::Ignore); // e.g. /favicon.ico
    }
    let get = |k: &str| {
        url.query_pairs()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.into_owned())
    };
    if let Some(err) = get("error") {
        return Ok(Callback::Denied(get("error_description").unwrap_or(err)));
    }
    let (Some(code), Some(state)) = (get("code"), get("state")) else {
        return Ok(Callback::Ignore);
    };
    if state != expected_state {
        return Err(Error::msg(
            "sign-in response did not match this request (state mismatch)",
        ));
    }
    Ok(Callback::Code(code))
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Keel</title><body style=\"font:15px system-ui;padding:3rem;color:#1d2221\"><h2>You can close this tab.</h2><p>Return to Keel to finish connecting your calendar.</p>";

async fn serve_one(listener: &TcpListener, expected_state: &str) -> Result<Option<Callback>> {
    let (mut stream, _) = listener.accept().await?;
    let mut buf = vec![0u8; 8192];
    let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf))
        .await
        .map_err(|_| Error::msg("timed out reading the sign-in response"))??;
    let request = String::from_utf8_lossy(&buf[..n]).into_owned();
    let result = parse_callback(&request, expected_state);
    let (status, body) = match &result {
        Ok(Callback::Ignore) => ("404 Not Found", ""),
        Ok(_) => ("200 OK", DONE_PAGE),
        Err(_) => ("400 Bad Request", DONE_PAGE),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    match result? {
        Callback::Ignore => Ok(None),
        other => Ok(Some(other)),
    }
}

/// Waits for the browser redirect on either loopback listener.
pub async fn wait_for_code(
    v4: TcpListener,
    v6: Option<TcpListener>,
    expected_state: &str,
    timeout: Duration,
) -> Result<String> {
    let run = async {
        loop {
            let got = match &v6 {
                Some(v6) => tokio::select! {
                    r = serve_one(&v4, expected_state) => r,
                    r = serve_one(v6, expected_state) => r,
                },
                None => serve_one(&v4, expected_state).await,
            };
            match got? {
                Some(Callback::Code(code)) => return Ok(code),
                Some(Callback::Denied(reason)) => {
                    return Err(Error::msg(format!("sign-in was cancelled: {reason}")))
                }
                _ => continue,
            }
        }
    };
    tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| Error::msg("timed out waiting for the browser sign-in (5 minutes)"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub scope: Option<String>,
}

pub async fn connect(
    open_browser: impl FnOnce(&str) -> Result<()>,
    account_id: &str,
    provider_id: &str,
    client_id: &str,
    client_secret: Option<String>,
    tenant: Option<String>,
    scopes: Vec<String>,
) -> Result<Connected> {
    let p = provider(provider_id, tenant.as_deref())
        .ok_or_else(|| Error::msg("this provider does not use OAuth sign-in"))?;
    if client_id.trim().is_empty() {
        return Err(Error::msg(
            "a client ID is required (see README → Integrations)",
        ));
    }
    if scopes.is_empty()
        || scopes
            .iter()
            .any(|s| !p.allowed_scopes.contains(&s.as_str()))
    {
        return Err(Error::msg("requested permissions are not allowed"));
    }
    let v4 = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = v4.local_addr()?.port();
    let v6 = TcpListener::bind(("::1", port)).await.ok();
    let redirect_uri = format!("http://{}:{port}", p.redirect_host);
    let verifier = random_token(48);
    let state = random_token(24);
    let url = build_auth_url(
        &p,
        client_id.trim(),
        &redirect_uri,
        &scopes,
        &state,
        &pkce_challenge(&verifier),
    )?;
    open_browser(&url)?;
    let code = wait_for_code(v4, v6, &state, CALLBACK_TIMEOUT).await?;

    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id.trim().to_string()),
        ("code_verifier", verifier),
    ];
    if let Some(cs) = client_secret.as_ref().filter(|s| !s.trim().is_empty()) {
        form.push(("client_secret", cs.trim().to_string()));
    }
    let res = client()?
        .post(&p.token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| Error::msg(format!("NETWORK: {e}")))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::msg(format!(
            "the provider refused the sign-in ({status}): {}",
            body.chars().take(300).collect::<String>()
        )));
    }
    let token: TokenResponse = serde_json::from_str(&body)?;
    let mut secret = StoredSecret {
        provider: provider_id.to_string(),
        client_id: Some(client_id.trim().to_string()),
        client_secret: client_secret.filter(|s| !s.trim().is_empty()),
        tenant,
        ..Default::default()
    };
    apply_token(&mut secret, token);
    if secret.refresh_token.is_none() {
        return Err(Error::msg(
            "the provider did not grant offline access (no refresh token)",
        ));
    }
    let scope = secret.scope.clone();
    secrets::save(account_id, &secret)?;
    Ok(Connected { scope })
}

/// Revokes Google tokens at the provider. Microsoft has no revocation endpoint for public
/// clients; users remove access at https://myapps.microsoft.com.
pub async fn revoke(account_id: &str) -> Result<bool> {
    let Some(secret) = secrets::load(account_id)? else {
        return Ok(false);
    };
    if secret.provider != "google" {
        return Ok(false);
    }
    let token = secret
        .refresh_token
        .or(secret.access_token)
        .unwrap_or_default();
    let res = client()?
        .post("https://oauth2.googleapis.com/revoke")
        .form(&[("token", token)])
        .send()
        .await
        .map_err(|e| Error::msg(format!("NETWORK: {e}")))?;
    Ok(res.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_appendix_b() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(random_token(48).len(), 64);
        assert_ne!(random_token(24), random_token(24));
    }

    #[test]
    fn builds_google_auth_url() {
        let p = provider("google", None).unwrap();
        let url = build_auth_url(
            &p,
            "cid",
            "http://127.0.0.1:5000",
            &["openid".into(), "email".into()],
            "st",
            "ch",
        )
        .unwrap();
        let u = Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid");
        assert_eq!(q["scope"], "openid email");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5000");
    }

    #[test]
    fn microsoft_tenant_is_sanitized() {
        assert!(provider("microsoft", Some("contoso.onmicrosoft.com"))
            .unwrap()
            .auth_url
            .contains("/contoso.onmicrosoft.com/"));
        assert!(provider("microsoft", Some("../evil"))
            .unwrap()
            .auth_url
            .contains("/common/"));
        assert!(provider("todoist", None).is_none());
    }

    #[test]
    fn parses_callbacks() {
        assert_eq!(
            parse_callback("GET /?code=abc&state=s1 HTTP/1.1\r\n", "s1").unwrap(),
            Callback::Code("abc".into())
        );
        assert!(parse_callback("GET /?code=abc&state=zz HTTP/1.1\r\n", "s1").is_err());
        assert_eq!(
            parse_callback("GET /favicon.ico HTTP/1.1\r\n", "s1").unwrap(),
            Callback::Ignore
        );
        assert_eq!(
            parse_callback("GET /?error=access_denied HTTP/1.1\r\n", "s1").unwrap(),
            Callback::Denied("access_denied".into())
        );
    }

    #[tokio::test]
    async fn loopback_listener_returns_the_code_and_ignores_noise() {
        let v4 = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = v4.local_addr().unwrap().port();
        let waiter = tokio::spawn(wait_for_code(v4, None, "state-1", Duration::from_secs(5)));
        let send = |req: &'static str| async move {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            s.write_all(req.as_bytes()).await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        };
        let favicon = send("GET /favicon.ico HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(favicon.starts_with("HTTP/1.1 404"));
        let ok = send("GET /?code=the-code&state=state-1 HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(ok.starts_with("HTTP/1.1 200") && ok.contains("close this tab"));
        assert_eq!(waiter.await.unwrap().unwrap(), "the-code");
    }

    #[tokio::test]
    async fn loopback_rejects_forged_state() {
        let v4 = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = v4.local_addr().unwrap().port();
        let waiter = tokio::spawn(wait_for_code(v4, None, "good", Duration::from_secs(5)));
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        s.write_all(b"GET /?code=x&state=bad HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        assert!(waiter.await.unwrap().is_err());
    }
}
