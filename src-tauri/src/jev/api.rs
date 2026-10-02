//! Jev API client.
//!
//! When a Jev API token is configured, the transcript is sent to the
//! Jev API for intent parsing; the structured response flows through
//! the SAME schema validation and the SAME allowlisted executor as the
//! local parser. The API never executes anything — it only parses.
//!
//! ```text
//! STT final transcript → Rust Jev service → secure credential store
//!   → Jev API request → structured Jev response → validate() → executor
//! ```
//!
//! Logging discipline: the token, the Authorization header, and full
//! request bodies are NEVER logged. Debug lines carry only the HTTP
//! status and byte counts.

use std::time::Duration;

use super::schema::JevResult;

/// Base URL of the Jev API.
///
/// TODO(musadhiq): fill in the real endpoint. The client assumes:
/// - `POST {base}/parse` with `{"transcript": "..."}` → `JevResult` JSON
/// - `GET  {base}/health` → 200 when the service is up
/// Both authenticated with `Authorization: Bearer <token>`.
pub const JEV_API_BASE_URL: &str = "https://api.jev.example/v1";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiError {
    Network,
    Timeout,
    InvalidToken,
    ServiceUnavailable,
    BadResponse,
}

impl ApiError {
    pub fn as_str(self) -> &'static str {
        match self {
            ApiError::Network => "network_error",
            ApiError::Timeout => "timeout",
            ApiError::InvalidToken => "invalid_token",
            ApiError::ServiceUnavailable => "service_unavailable",
            ApiError::BadResponse => "bad_response",
        }
    }
}

pub struct JevApiClient {
    base_url: String,
    http: reqwest::blocking::Client,
}

impl JevApiClient {
    pub fn new() -> Result<Self, String> {
        let http = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        Ok(JevApiClient {
            base_url: JEV_API_BASE_URL.trim_end_matches('/').to_string(),
            http,
        })
    }

    /// Parse a final transcript via the Jev API. The token travels only
    /// in the Authorization header; it is never logged and never
    /// returned to the frontend.
    pub fn parse(&self, token: &str, transcript: &str) -> Result<JevResult, ApiError> {
        let url = format!("{}/parse", self.base_url);
        // Debug log carries no header, no token, no body.
        eprintln!("nila: jev: api parse request → POST {url}");
        let resp = self
            .http
            .post(&url)
            .bearer_auth(token)
            .json(&serde_json::json!({ "transcript": transcript }))
            .send()
            .map_err(|e| {
                eprintln!("nila: jev: api request failed: {}", redact_reqwest_error(&e));
                if e.is_timeout() {
                    ApiError::Timeout
                } else {
                    ApiError::Network
                }
            })?;
        let status = resp.status();
        eprintln!("nila: jev: api parse response ← {}", status.as_u16());
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(ApiError::InvalidToken);
        }
        if !status.is_success() {
            return Err(if status.is_server_error() {
                ApiError::ServiceUnavailable
            } else {
                ApiError::BadResponse
            });
        }
        resp.json::<JevResult>().map_err(|e| {
            eprintln!("nila: jev: api returned invalid JevResult: {e}");
            ApiError::BadResponse
        })
    }

    /// Lightweight authenticated probe for "Test Connection".
    pub fn test_connection(&self, token: &str) -> Result<(), ApiError> {
        let url = format!("{}/health", self.base_url);
        eprintln!("nila: jev: api health check → GET {url}");
        let resp = self
            .http
            .get(&url)
            .bearer_auth(token)
            .timeout(HEALTH_TIMEOUT)
            .send()
            .map_err(|e| {
                eprintln!("nila: jev: health check failed: {}", redact_reqwest_error(&e));
                if e.is_timeout() {
                    ApiError::Timeout
                } else {
                    ApiError::Network
                }
            })?;
        let status = resp.status();
        eprintln!("nila: jev: api health check ← {}", status.as_u16());
        match status.as_u16() {
            200..=299 => Ok(()),
            401 | 403 => Err(ApiError::InvalidToken),
            500..=599 => Err(ApiError::ServiceUnavailable),
            _ => Err(ApiError::BadResponse),
        }
    }
}

/// reqwest errors can contain the URL; the URL has no secret, but the
/// error chain is still scrubbed to a one-line summary so nothing
/// sensitive can leak through Debug formatting.
fn redact_reqwest_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout".to_string()
    } else if e.is_connect() {
        "connection failed".to_string()
    } else if e.is_decode() {
        "invalid response body".to_string()
    } else {
        format!("http error ({})", e.status().map(|s| s.as_u16()).unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_strings_are_stable() {
        assert_eq!(ApiError::InvalidToken.as_str(), "invalid_token");
        assert_eq!(ApiError::Network.as_str(), "network_error");
    }

    #[test]
    fn base_url_has_no_trailing_slash() {
        let c = JevApiClient::new().unwrap();
        assert!(!c.base_url.ends_with('/'));
    }
}
