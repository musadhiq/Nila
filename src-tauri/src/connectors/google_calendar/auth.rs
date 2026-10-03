//! Google OAuth 2.0 for installed (desktop) applications.
//!
//! Flow (RFC 8252 loopback + PKCE S256 — no client secret needed):
//!
//! 1. Bind 127.0.0.1 on an ephemeral port.
//! 2. Open the Google consent URL in the user's browser.
//! 3. Google redirects to `http://127.0.0.1:{port}/cb?code=…&state=…`.
//! 4. The code is exchanged for access + refresh tokens.
//! 5. Tokens are stored as one JSON blob in the OS keychain.
//!
//! The Google OAuth *client ID* comes from the user's own Google Cloud
//! "Desktop app" credential and lives in plain settings: for installed
//! apps the client ID is public by design. It is never hardcoded.
//!
//! Nothing here ever logs a token, code, or verifier.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use tauri::AppHandle;

use super::GcalError;

const KEYRING_SERVICE: &str = "nila";
const KEYRING_ACCOUNT: &str = "gcal-oauth";

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// Minimum scopes: read the calendar list (account email for the
/// status card) + full event CRUD (JEV voice actions). `calendar.events`
/// alone does not cover the calendar list, and `calendar.readonly`
/// would be broader than needed — `calendar.calendarlist.readonly`
/// is the narrowest scope that covers `calendarList.list`.
const SCOPE: &str =
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events";

/// How long we wait for the user to finish in the browser.
const AUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Per-connection read deadline while waiting for the redirect.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBundle {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix timestamp when the access token expires.
    pub expires_at: i64,
}

impl TokenBundle {
    /// True when the token should be refreshed (with a clock-skew margin).
    pub fn expired(&self) -> bool {
        chrono::Utc::now().timestamp() > self.expires_at - 120
    }
}

// ---------------------------------------------------------------------------
// Keychain token store (same error discipline as jev::credentials)
// ---------------------------------------------------------------------------

pub fn has_tokens() -> bool {
    load_bundle().ok().flatten().is_some()
}

fn load_bundle() -> Result<Option<TokenBundle>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    match entry.get_password() {
        Ok(raw) => {
            if raw.is_empty() {
                return Ok(None);
            }
            serde_json::from_str::<TokenBundle>(&raw)
                .map(Some)
                .map_err(|_| "stored credential is corrupt".to_string())
        }
        // No entry yet is a normal "not connected" state, not an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read credential: {e}")),
    }
}

fn store_bundle(bundle: &TokenBundle) -> Result<(), String> {
    if bundle.access_token.is_empty() || bundle.refresh_token.is_empty() {
        return Err("refusing to store an incomplete token bundle".to_string());
    }
    let raw = serde_json::to_string(bundle).map_err(|e| format!("serialize token: {e}"))?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    // The serialized blob (which contains the tokens) never appears in logs.
    entry
        .set_password(&raw)
        .map_err(|e| format!("could not store credential: {e}"))
}

pub fn delete_bundle() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting a non-existent entry is fine.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove credential: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/// A valid access token, refreshing first when the stored one is
/// expired. `AuthRequired` means the refresh token was rejected: the
/// stored bundle is deleted and the user must reconnect.
pub fn ensure_access_token(app: &AppHandle) -> Result<String, GcalError> {
    let bundle = load_bundle()
        .map_err(GcalError::Storage)?
        .ok_or(GcalError::NotConfigured)?;
    if !bundle.expired() {
        return Ok(bundle.access_token);
    }
    refresh(app, &bundle)
}

/// Refresh unconditionally (used after a 401 on a supposedly fresh token).
pub fn force_refresh(app: &AppHandle) -> Result<String, GcalError> {
    let bundle = load_bundle()
        .map_err(GcalError::Storage)?
        .ok_or(GcalError::NotConfigured)?;
    refresh(app, &bundle)
}

fn refresh(app: &AppHandle, bundle: &TokenBundle) -> Result<String, GcalError> {
    let Some(client_id) = super::client_id(app) else {
        return Err(GcalError::NotConfigured);
    };
    eprintln!("nila: gcal: refreshing access token");
    let client = http_client()?;
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", bundle.refresh_token.as_str()),
            ("client_id", client_id.as_str()),
        ])
        .send()
        .map_err(|e| GcalError::Network(redact(&e)))?;
    if resp.status() == reqwest::StatusCode::BAD_REQUEST {
        // invalid_grant: revoked or expired refresh token. The stored
        // bundle is useless — delete it so status flips to
        // "auth_required" instead of retrying forever.
        let _ = delete_bundle();
        return Err(GcalError::AuthRequired);
    }
    let token = parse_token_response(resp, Some(bundle))?;
    store_bundle(&token).map_err(GcalError::Storage)?;
    Ok(token.access_token)
}

fn http_client() -> Result<reqwest::blocking::Client, GcalError> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| GcalError::Network(format!("http client: {e}")))
}

/// Never let a URL (which could carry a code/token) into a log line.
fn redact(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    if let Some(url) = e.url() {
        s = s.replace(url.as_str(), "<url>");
    }
    s
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
}

/// Build the stored bundle from a token endpoint response. The
/// refresh endpoint usually omits `refresh_token`: keep the old one.
fn parse_token_response(
    resp: reqwest::blocking::Response,
    previous: Option<&TokenBundle>,
) -> Result<TokenBundle, GcalError> {
    let status = resp.status();
    if !status.is_success() {
        return Err(GcalError::Api(status.as_u16(), "token endpoint".into()));
    }
    let tr: TokenResponse = resp
        .json()
        .map_err(|e| GcalError::Api(status.as_u16(), format!("bad token response: {e}")))?;
    let refresh_token = match (tr.refresh_token, previous) {
        (Some(rt), _) if !rt.is_empty() => rt,
        (_, Some(prev)) => prev.refresh_token.clone(),
        _ => return Err(GcalError::Api(status.as_u16(), "no refresh token".into())),
    };
    Ok(TokenBundle {
        access_token: tr.access_token,
        refresh_token,
        expires_at: chrono::Utc::now().timestamp() + tr.expires_in,
    })
}

// ---------------------------------------------------------------------------
// Authorization flow (browser + loopback redirect)
// ---------------------------------------------------------------------------

/// Run the full browser flow on the calling thread (already a
/// background thread). Stores the token bundle on success.
pub fn run_auth_flow(app: &AppHandle, client_id: &str) -> Result<(), String> {
    let (verifier, challenge) = pkce_pair()?;
    let state = random_token(16)?;

    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("loopback bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("loopback addr: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/cb");

    let url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code\
         &scope={}&access_type=offline&prompt=consent\
         &code_challenge={}&code_challenge_method=S256&state={}",
        url_encode(client_id),
        url_encode(&redirect_uri),
        url_encode(SCOPE),
        url_encode(&challenge),
        url_encode(&state),
    );
    crate::commands::open_url(url).map_err(|e| format!("could not open browser: {e}"))?;
    eprintln!("nila: gcal: waiting for browser authorization…");

    let code = wait_for_code(&listener, &state)?;
    eprintln!("nila: gcal: authorization code received, exchanging…");

    let client = http_client().map_err(|e| format!("{e:?}"))?;
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .map_err(|e| format!("token exchange failed: {}", redact(&e)))?;
    if !resp.status().is_success() {
        return Err(format!(
            "token exchange rejected (HTTP {})",
            resp.status().as_u16()
        ));
    }
    let bundle = parse_token_response(resp, None).map_err(|e| format!("{e:?}"))?;
    if bundle.refresh_token.is_empty() {
        return Err("Google did not issue a refresh token; try again".to_string());
    }
    let _ = app; // (kept for future progress events)
    store_bundle(&bundle)?;
    Ok(())
}

/// Accept one loopback connection and extract the `code` query
/// parameter, validating `state` against CSRF substitution.
fn wait_for_code(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("loopback: {e}"))?;
    let deadline = Instant::now() + AUTH_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((stream, _)) => return handle_redirect(stream, expected_state),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err("authorization timed out; try again".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("loopback accept: {e}")),
        }
    }
}

fn handle_redirect(stream: TcpStream, expected_state: &str) -> Result<String, String> {
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(|e| format!("loopback: {e}"))?;
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| format!("reading redirect: {e}"))?;
    // Drain the headers so the browser isn't left hanging.
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if line.trim().is_empty() {
                    break;
                }
            }
        }
    }
    let query = request_line
        .split_whitespace()
        .nth(1)
        .and_then(|target| target.split_once('?').map(|(_, q)| q))
        .unwrap_or("");
    let params = parse_query(query);
    respond_html(&stream, params.get("error").is_none());

    if let Some(err) = params.get("error") {
        return Err(format!("Google authorization failed: {err}"));
    }
    match (params.get("code"), params.get("state")) {
        (Some(code), Some(state)) if state == expected_state => Ok(code.clone()),
        (Some(_), _) => Err("authorization state mismatch; try again".to_string()),
        _ => Err("no authorization code in redirect".to_string()),
    }
}

fn respond_html(mut stream: &TcpStream, ok: bool) {
    let body = if ok {
        "<html><body style=\"font-family:sans-serif;padding:2em\">\
         <h2>Nila is connected.</h2>\
         <p>You can close this tab and return to Nila.</p>\
         </body></html>"
    } else {
        "<html><body style=\"font-family:sans-serif;padding:2em\">\
         <h2>Authorization failed.</h2>\
         <p>Please close this tab and try again from Nila's settings.</p>\
         </body></html>"
    };
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
}

/// Parse a URL query string into key → value (first wins).
fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            out.entry(url_decode(k)).or_insert_with(|| url_decode(v));
        }
    }
    out
}

fn url_decode(s: &str) -> String {
    let mut out = String::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                if let (Some(h), Some(l)) = (
                    hex_val(bytes[i + 1]),
                    hex_val(bytes[i + 2]),
                ) {
                    out.push((h << 4 | l) as char);
                    i += 3;
                } else {
                    out.push('%');
                    i += 1;
                }
            }
            b => {
                out.push(b as char);
                i += 1;
            }
        }
    }
    out
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// PKCE + randomness (no extra rand crate: /dev/urandom, Linux-first)
// ---------------------------------------------------------------------------

fn pkce_pair() -> Result<(String, String), String> {
    let mut buf = [0u8; 32];
    read_urandom(&mut buf)?;
    let verifier = URL_SAFE_NO_PAD.encode(buf);
    let digest = sha2::Sha256::digest(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(digest);
    Ok((verifier, challenge))
}

fn random_token(nbytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; nbytes];
    read_urandom(&mut buf)?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

fn read_urandom(buf: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(buf))
        .map_err(|e| format!("could not gather randomness: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        // RFC 7636 Appendix B test vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let digest = sha2::Sha256::digest(verifier.as_bytes());
        assert_eq!(
            URL_SAFE_NO_PAD.encode(digest),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn pkce_pair_is_url_safe() {
        let (v, c) = pkce_pair().unwrap();
        assert!(!v.is_empty() && !c.is_empty());
        for s in [v, c] {
            assert!(s.bytes().all(|b| matches!(
                b,
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'
            )));
        }
    }

    #[test]
    fn query_parsing_handles_code_and_errors() {
        let p = parse_query("code=abc123&state=xyz");
        assert_eq!(p.get("code").map(String::as_str), Some("abc123"));
        assert_eq!(p.get("state").map(String::as_str), Some("xyz"));
        let p = parse_query("error=access_denied&state=xyz");
        assert_eq!(p.get("error").map(String::as_str), Some("access_denied"));
        assert!(parse_query("").is_empty());
    }

    #[test]
    fn url_roundtrip() {
        let s = "https://www.googleapis.com/auth/calendar.readonly a+b";
        assert_eq!(url_decode(&url_encode(s)), s);
        assert!(!url_encode("a/b:c").contains('/'));
    }

    #[test]
    fn bundle_expiry_margin() {
        let fresh = TokenBundle {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: chrono::Utc::now().timestamp() + 3600,
        };
        assert!(!fresh.expired());
        let stale = TokenBundle {
            expires_at: chrono::Utc::now().timestamp() - 1,
            ..fresh.clone()
        };
        assert!(stale.expired());
        // Inside the 120 s margin counts as expired.
        let edge = TokenBundle {
            expires_at: chrono::Utc::now().timestamp() + 60,
            ..fresh
        };
        assert!(edge.expired());
    }

    #[test]
    fn bundle_serializes_without_leaking_shape_assumptions() {
        let b = TokenBundle {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: 123,
        };
        let raw = serde_json::to_string(&b).unwrap();
        let back: TokenBundle = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.expires_at, 123);
    }
}
