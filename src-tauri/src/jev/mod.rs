//! Jev — the voice-command action layer.
//!
//! Pipeline:
//!
//! ```text
//! voice:transcript_final (FINAL text only — partials never reach Jev)
//!   → jev:processing
//!   → JevResult (local parser, or Jev API when a token is configured)
//!   → jev:action_detected
//!   → schema validation (untrusted input → ValidatedAction)
//!   → ActionExecutor (allowlisted, shell-free) on a worker thread
//!   → jev:result {response_key, response_params}
//!   → Nila's response layer (frontend i18n) renders the message
//! ```
//!
//! Everything runs off the Tauri/UI thread: `process_voice_command`
//! spawns a worker and returns immediately.

pub mod api;
pub mod context;
pub mod conversation;
pub mod credentials;
pub mod executor;
pub mod parser;
pub mod schema;
pub mod ui_action;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use self::api::JevApiClient;
use self::context::ConversationContext;
use self::conversation::ConversationHandler;
use self::credentials::{KeyringStore, SecureStore};
use self::executor::{ActionExecutor, ActionResult, ActionStatus};
use self::parser::LocalParser;
use self::schema::{validate, Intent, JevParams, JevResult, ResponseType};
use self::ui_action::UIActionHandler;

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

/// How Jev turns transcripts into structured intents.
///
/// - `Hybrid` (default): the built-in local parser handles the V1
///   intents offline; when a Jev API token is configured, the API
///   takes over parsing (same schema, same executor).
/// - `ApiOnly`: without a token, voice commands get the "not
///   configured" notice (rate-limited) instead of executing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JevMode {
    Hybrid,
    ApiOnly,
}

const JEV_MODE: JevMode = JevMode::Hybrid;

/// Don't nag about the missing token on every voice attempt.
const NOT_CONFIGURED_COOLDOWN: Duration = Duration::from_secs(5 * 60);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

pub mod events {
    pub const PROCESSING: &str = "jev:processing";
    pub const ACTION_DETECTED: &str = "jev:action_detected";
    pub const RESULT: &str = "jev:result";
    pub const ERROR: &str = "jev:error";
}

#[derive(Serialize, Clone)]
struct ProcessingPayload<'a> {
    transcript: &'a str,
}

#[derive(Serialize, Clone)]
struct ActionDetectedPayload<'a> {
    intent: &'a str,
}

#[derive(Serialize, Clone)]
pub struct ActionCompletedPayload {
    pub intent: String,
    pub status: &'static str,
    pub response_key: String,
    pub response_params: serde_json::Value,
    pub data: Option<serde_json::Value>,
}

#[derive(Serialize, Clone)]
struct ErrorPayload<'a> {
    code: &'a str,
    response_key: &'a str,
}

// ---------------------------------------------------------------------------
// Service state
// ---------------------------------------------------------------------------

pub struct JevState {
    ctx: Mutex<ConversationContext>,
    store: Box<dyn SecureStore>,
    /// Last `jev_test_connection` outcome: None = never tested.
    last_test: Mutex<Option<bool>>,
    not_configured_notice: Mutex<Option<Instant>>,
}

impl JevState {
    pub fn new() -> Self {
        JevState {
            ctx: Mutex::new(ConversationContext::default()),
            store: Box::new(KeyringStore),
            last_test: Mutex::new(None),
            not_configured_notice: Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn with_store(store: Box<dyn SecureStore>) -> Self {
        JevState {
            ctx: Mutex::new(ConversationContext::default()),
            store,
            last_test: Mutex::new(None),
            not_configured_notice: Mutex::new(None),
        }
    }

    fn api_client(&self) -> Result<JevApiClient, String> {
        // Built fresh per use: cheap, and never held across a request.
        JevApiClient::new()
    }
}

impl Default for JevState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/// Entry point from `voice:transcript_final`. Spawns a worker thread and
/// returns immediately — never blocks the Tauri/UI thread.
pub fn spawn_jev_pipeline(app: AppHandle, text: String) {
    std::thread::spawn(move || {
        run_pipeline(&app, text.trim());
    });
}

fn run_pipeline(app: &AppHandle, text: &str) {
    let _ = app.emit(
        events::PROCESSING,
        ProcessingPayload { transcript: text },
    );

    let Some(state) = app.try_state::<JevState>() else {
        emit_error(app, "internal", "jevInternalError");
        return;
    };

    if text.is_empty() {
        emit_error(app, "empty_transcript", "emptyTranscript");
        return;
    }

    // Expire stale follow-up context before it can leak in.
    {
        let mut ctx = state.ctx.lock().expect("jev ctx poisoned");
        ctx.expire_if_stale();
    }

    // 1. Jev produces a structured result (local parser or API).
    let jev_result = produce_jev_result(app, &state, text);
    let Some(jev_result) = jev_result else {
        // produce_jev_result already emitted the error.
        return;
    };

    let _ = app.emit(
        events::ACTION_DETECTED,
        ActionDetectedPayload {
            intent: jev_result.intent.as_str(),
        },
    );

    // 2-3. Strict validation, then the intent router.
    execute_validated(app, state, &jev_result);
}

/// Validate a [`JevResult`] and route it to the conversation, UI, or
/// system-action handler.
fn execute_validated(app: &AppHandle, state: &JevState, jev_result: &JevResult) {
    // 3. Strict validation: untrusted Jev output → ValidatedAction.
    let action = validate(jev_result);

    // 4. Intent router: conversation / UI action / system action.
    //    The frontend never interprets raw Jev text — it only reacts
    //    to the structured events each handler emits.
    match jev_result.intent.response_type() {
        ResponseType::Conversation => {
            let result = ConversationHandler::respond(&action);
            emit_action_result(app, jev_result, &result);
        }
        ResponseType::UiAction => {
            // The frontend's jev:ui_action listener opens the existing
            // UI and completes the voice pipeline; no jev:result is
            // emitted (a UI opening needs no spoken response).
            UIActionHandler::handle(app, &action);
        }
        ResponseType::SystemAction => {
            // 5. Execute on this worker thread (bounded: search has its
            //    own deadline, the API has its own timeout).
            let result = {
                let mut ctx = state.ctx.lock().expect("jev ctx poisoned");
                ActionExecutor::execute(app, &mut ctx, action)
            };
            emit_action_result(app, jev_result, &result);
        }
    }
}

/// Emit the standard `jev:result` for a completed handler.
fn emit_action_result(app: &AppHandle, jev_result: &JevResult, result: &ActionResult) {
    let _ = app.emit(
        events::RESULT,
        ActionCompletedPayload {
            intent: jev_result.intent.as_str().to_string(),
            status: match result.status {
                ActionStatus::Success => "success",
                ActionStatus::Error => "error",
            },
            response_key: result.response_key.to_string(),
            response_params: result.response_params.clone(),
            data: result.data.clone(),
        },
    );
}

/// Returns None when the pipeline must stop (the error was emitted).
fn produce_jev_result(
    app: &AppHandle,
    state: &JevState,
    text: &str,
) -> Option<JevResult> {
    // The token is read here and lives only in this scope. It is never
    // logged, never put in an event payload, never returned anywhere.
    let token = match state.store.get() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("nila: jev: credential read failed: {e}");
            None
        }
    };

    match (JEV_MODE, token) {
        (_, Some(tok)) => {
            // A token is configured: the Jev API parses.
            let client = match state.api_client() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("nila: jev: api client: {e}");
                    emit_error(app, "internal", "jevInternalError");
                    return None;
                }
            };
            match client.parse(&tok, text) {
                Ok(r) => Some(r),
                Err(api::ApiError::InvalidToken) => {
                    emit_error(app, "invalid_token", "jevInvalidToken");
                    None
                }
                Err(api::ApiError::Network) | Err(api::ApiError::Timeout) => {
                    emit_error(app, "network_error", "jevNetworkError");
                    None
                }
                Err(api::ApiError::ServiceUnavailable) => {
                    emit_error(app, "service_unavailable", "jevServiceUnavailable");
                    None
                }
                Err(api::ApiError::BadResponse) => {
                    // The API returned something outside the schema:
                    // degrade to unknown, never execute.
                    Some(unknown_result())
                }
            }
        }
        (JevMode::ApiOnly, None) => {
            // Rate-limited "not configured" notice.
            let mut last = state
                .not_configured_notice
                .lock()
                .expect("jev notice poisoned");
            let now = Instant::now();
            let due = last.map(|t| now.duration_since(t) >= NOT_CONFIGURED_COOLDOWN).unwrap_or(true);
            if due {
                *last = Some(now);
                emit_error(app, "not_configured", "jevNotConfigured");
            }
            None
        }
        (JevMode::Hybrid, None) => Some(LocalParser.parse(text)),
    }
}

fn unknown_result() -> JevResult {
    JevResult {
        intent: Intent::Unknown,
        parameters: schema::JevParams::default(),
        message: Some("I don't know how to do that yet.".to_string()),
    }
}

fn emit_error(app: &AppHandle, code: &str, response_key: &str) {
    let _ = app.emit(events::ERROR, ErrorPayload { code, response_key });
}

// ---------------------------------------------------------------------------
// Tauri commands — Settings → AI / Jev
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct JevStatus {
    pub configured: bool,
    pub connected: bool,
}

/// `jev_get_status` — the ONLY status the frontend ever sees.
/// The raw token is never returned.
#[tauri::command]
pub fn jev_get_status(app: AppHandle) -> Result<JevStatus, String> {
    let state = app
        .try_state::<JevState>()
        .ok_or("jev unavailable".to_string())?;
    let configured = state
        .store
        .get()
        .map_err(|e| format!("credential store: {e}"))?
        .is_some();
    let last_test = state.last_test.lock().map_err(|e| e.to_string())?;
    // "connected" = a token is stored and no failed test is on record.
    let connected = configured && *last_test != Some(false);
    Ok(JevStatus {
        configured,
        connected,
    })
}

/// `jev_set_token` — store the token in the OS keychain. The value is
/// never logged and never persisted anywhere else.
#[tauri::command]
pub fn jev_set_token(app: AppHandle, token: String) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("token is empty".to_string());
    }
    if token.len() > 4096 {
        return Err("token is too long".to_string());
    }
    let state = app
        .try_state::<JevState>()
        .ok_or("jev unavailable".to_string())?;
    state.store.set(token.trim())?;
    // A new token invalidates the previous test outcome.
    *state.last_test.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// `jev_remove_token` — delete the token from the OS keychain.
#[tauri::command]
pub fn jev_remove_token(app: AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<JevState>()
        .ok_or("jev unavailable".to_string())?;
    state.store.delete()?;
    *state.last_test.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[derive(Serialize)]
pub struct TestConnectionReport {
    /// "connected" | "invalid_token" | "network_error" |
    /// "service_unavailable" | "not_configured"
    pub status: &'static str,
}

/// `jev_test_connection` — lightweight authenticated probe. Reports a
/// status enum; never exposes the token.
#[tauri::command]
pub fn jev_test_connection(app: AppHandle) -> Result<TestConnectionReport, String> {
    let state = app
        .try_state::<JevState>()
        .ok_or("jev unavailable".to_string())?;
    let token = state
        .store
        .get()
        .map_err(|e| format!("credential store: {e}"))?;
    let Some(token) = token else {
        return Ok(TestConnectionReport {
            status: "not_configured",
        });
    };
    let client = state.api_client()?;
    let status = match client.test_connection(&token) {
        Ok(()) => "connected",
        Err(api::ApiError::InvalidToken) => "invalid_token",
        Err(api::ApiError::Network) | Err(api::ApiError::Timeout) => "network_error",
        Err(api::ApiError::ServiceUnavailable) => "service_unavailable",
        Err(api::ApiError::BadResponse) => "service_unavailable",
    };
    *state.last_test.lock().map_err(|e| e.to_string())? = Some(status == "connected");
    Ok(TestConnectionReport { status })
}

/// `process_voice_command` — called by the frontend with the FINAL
/// transcript only. Fire-and-forget: results arrive as `jev:*` events.
#[tauri::command]
pub fn process_voice_command(app: AppHandle, text: String) -> Result<(), String> {
    spawn_jev_pipeline(app, text);
    Ok(())
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/// Entry point from `voice:transcript_final`. Spawns a worker thread and
/// returns immediately — never blocks the Tauri/UI thread.
pub fn spawn_jev_pipeline(app: AppHandle, text: String) {
    std::thread::spawn(move || {
        run_pipeline(&app, text.trim());
    });
}

fn run_pipeline(app: &AppHandle, text: &str) {
    let _ = app.emit(
        events::PROCESSING,
        ProcessingPayload { transcript: text },
    );

    let Some(state) = app.try_state::<JevState>() else {
        emit_error(app, "internal", "jevInternalError");
        return;
    };

    if text.is_empty() {
        emit_error(app, "empty_transcript", "emptyTranscript");
        return;
    }

    // Expire stale follow-up context before it can leak in.
    {
        let mut ctx = state.ctx.lock().expect("jev ctx poisoned");
        ctx.expire_if_stale();
    }

    // 1. Jev produces a structured result (local parser or API).
    let jev_result = produce_jev_result(app, &state, text);
    let Some(jev_result) = jev_result else {
        // produce_jev_result already emitted the error.
        return;
    };

    let _ = app.emit(
        events::ACTION_DETECTED,
        ActionDetectedPayload {
            intent: jev_result.intent.as_str(),
        },
    );

    // 2-3. Strict validation, then the intent router.
    execute_validated(app, state, &jev_result);
}

/// Validate a [`JevResult`] and route it to the conversation, UI, or
/// system-action handler.
fn execute_validated(app: &AppHandle, state: &JevState, jev_result: &JevResult) {
    // 3. Strict validation: untrusted Jev output → ValidatedAction.
    let action = validate(jev_result);

    // 4. Intent router: conversation / UI action / system action.
    //    The frontend never interprets raw Jev text — it only reacts
    //    to the structured events each handler emits.
    match jev_result.intent.response_type() {
        ResponseType::Conversation => {
            let result = ConversationHandler::respond(&action);
            emit_action_result(app, jev_result, &result);
        }
        ResponseType::UiAction => {
            // The frontend's jev:ui_action listener opens the existing
            // UI and completes the voice pipeline; no jev:result is
            // emitted (a UI opening needs no spoken response).
            UIActionHandler::handle(app, &action);
        }
        ResponseType::SystemAction => {
            // 5. Execute on this worker thread (bounded: search has its
            //    own deadline, the API has its own timeout).
            let result = {
                let mut ctx = state.ctx.lock().expect("jev ctx poisoned");
                ActionExecutor::execute(app, &mut ctx, action)
            };
            emit_action_result(app, jev_result, &result);
        }
    }
}

/// Emit the standard `jev:result` for a completed handler.
fn emit_action_result(app: &AppHandle, jev_result: &JevResult, result: &ActionResult) {
    let _ = app.emit(
        events::RESULT,
        ActionCompletedPayload {
            intent: jev_result.intent.as_str().to_string(),
            status: match result.status {
                ActionStatus::Success => "success",
                ActionStatus::Error => "error",
            },
            response_key: result.response_key.to_string(),
            response_params: result.response_params.clone(),
            data: result.data.clone(),
        },
    );
}

/// Returns None when the pipeline must stop (the error was emitted).
fn produce_jev_result(
    app: &AppHandle,
    state: &JevState,
    text: &str,
) -> Option<JevResult> {
    // The token is read here and lives only in this scope. It is never
    // logged, never put in an event payload, never returned anywhere.
    let token = match state.store.get() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("nila: jev: credential read failed: {e}");
            None
        }
    };

    match (JEV_MODE, token) {
        (_, Some(tok)) => {
            // A token is configured: the Jev API parses.
            let client = match state.api_client() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("nila: jev: api client: {e}");
                    emit_error(app, "internal", "jevInternalError");
                    return None;
                }
            };
            match client.parse(&tok, text) {
                Ok(r) => Some(r),
                Err(api::ApiError::InvalidToken) => {
                    emit_error(app, "invalid_token", "jevInvalidToken");
                    None
                }
                Err(api::ApiError::Network) | Err(api::ApiError::Timeout) => {
                    emit_error(app, "network_error", "jevNetworkError");
                    None
                }
                Err(api::ApiError::ServiceUnavailable) => {
                    emit_error(app, "service_unavailable", "jevServiceUnavailable");
                    None
                }
                Err(api::ApiError::BadResponse) => {
                    // The API returned something outside the schema:
                    // degrade to unknown, never execute.
                    Some(unknown_result())
                }
            }
        }
        (JevMode::ApiOnly, None) => {
            // Rate-limited "not configured" notice.
            let mut last = state
                .not_configured_notice
                .lock()
                .expect("jev notice poisoned");
            let now = Instant::now();
            let due = last.map(|t| now.duration_since(t) >= NOT_CONFIGURED_COOLDOWN).unwrap_or(true);
            if due {
                *last = Some(now);
                emit_error(app, "not_configured", "jevNotConfigured");
            }
            None
        }
        (JevMode::Hybrid, None) => Some(LocalParser.parse(text)),
    }
}

fn unknown_result() -> JevResult {
    JevResult {
        intent: Intent::Unknown,
        parameters: schema::JevParams::default(),
        message: Some("I don't know how to do that yet.".to_string()),
    }
}

fn emit_error(app: &AppHandle, code: &str, response_key: &str) {
    let _ = app.emit(events::ERROR, ErrorPayload { code, response_key });
}

// ---------------------------------------------------------------------------
// Tauri commands — Settings → AI / Jev
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct JevStatus {
    pub configured: bool,
    pub connected: bool,
}

/// `jev_get_status` — the ONLY status the frontend ever sees.
/// The raw token is never returned.
#[tauri::command]
pub fn jev_get_status(app: AppHandle) -> Result<JevStatus, String> {
    let state = app
        .try_state::<JevState>()
        .ok_or("jev unavailable".to_string())?;
    let configured = state
        .store
        .get()
        .map_err(|e| format!("credential store: {e}"))?
        .is_some();
    let last_test = state.last_test.lock().map_err(|e| e.to_string())?;
    // "connected" = a token is stored and no failed test is on record.
    let connected = configured && *last_test != Some(false);
    Ok(JevStatus {
        configured,
        connected,
    })
}

/// `jev_set_token` — store the token in the OS keychain. The value is
/// never logged and never persisted anywhere else.
#[tauri::command]
pub fn jev_set_token(app: AppHandle, token: String) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("token is empty".to_string());
    }
    if token.len() > 4096 {
        return Err("token is too long".to_string());
    }
    let state = app
        .try_state::<JevState>()
        .ok_or("jev unavailable".to_string())?;
    state.store.set(token.trim())?;
    // A new token invalidates the previous test outcome.
    *state.last_test.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// `jev_remove_token` — delete the token from the OS keychain.
#[tauri::command]
pub fn jev_remove_token(app: AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<JevState>()
        .ok_or("jev unavailable".to_string())?;
    state.store.delete()?;
    *state.last_test.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[derive(Serialize)]
pub struct TestConnectionReport {
    /// "connected" | "invalid_token" | "network_error" |
    /// "service_unavailable" | "not_configured"
    pub status: &'static str,
}

/// `jev_test_connection` — lightweight authenticated probe. Reports a
/// status enum; never exposes the token.
#[tauri::command]
pub fn jev_test_connection(app: AppHandle) -> Result<TestConnectionReport, String> {
    let state = app
        .try_state::<JevState>()
        .ok_or("jev unavailable".to_string())?;
    let token = state
        .store
        .get()
        .map_err(|e| format!("credential store: {e}"))?;
    let Some(token) = token else {
        return Ok(TestConnectionReport {
            status: "not_configured",
        });
    };
    let client = state.api_client()?;
    let status = match client.test_connection(&token) {
        Ok(()) => "connected",
        Err(api::ApiError::InvalidToken) => "invalid_token",
        Err(api::ApiError::Network) | Err(api::ApiError::Timeout) => "network_error",
        Err(api::ApiError::ServiceUnavailable) => "service_unavailable",
        Err(api::ApiError::BadResponse) => "service_unavailable",
    };
    *state.last_test.lock().map_err(|e| e.to_string())? = Some(status == "connected");
    Ok(TestConnectionReport { status })
}

/// `process_voice_command` — called by the frontend with the FINAL
/// transcript only. Fire-and-forget: results arrive as `jev:*` events.
#[tauri::command]
pub fn process_voice_command(app: AppHandle, text: String) -> Result<(), String> {
    spawn_jev_pipeline(app, text);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::credentials::MemoryStore;
    use super::*;
    use crate::jev::schema::ValidatedAction;

    fn state_with_token(token: Option<&str>) -> JevState {
        let s = JevState::with_store(Box::new(MemoryStore::default()));
        if let Some(t) = token {
            s.store.set(t).unwrap();
        }
        s
    }

    #[test]
    fn hybrid_mode_without_token_uses_local_parser() {
        // produce_jev_result needs an AppHandle for emits; the pure
        // parser path is covered in parser.rs tests. Here we pin the
        // mode contract instead.
        assert_eq!(JEV_MODE, JevMode::Hybrid);
        let s = state_with_token(None);
        assert!(s.store.get().unwrap().is_none());
    }

    #[test]
    fn empty_token_is_rejected_before_storage() {
        let s = state_with_token(None);
        assert!(s.store.set("").is_err());
        assert!(s.store.get().unwrap().is_none());
    }

    #[test]
    fn unknown_result_never_validates_to_action() {
        let action = validate(&unknown_result());
        assert!(matches!(action, ValidatedAction::Unknown));
    }

    #[test]
    fn result_payload_serializes() {
        let p = ActionCompletedPayload {
            intent: "open_application".to_string(),
            status: "success",
            response_key: "openingApp".to_string(),
            response_params: serde_json::json!({ "app": "Firefox" }),
            data: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["response_key"], "openingApp");
        assert_eq!(v["response_params"]["app"], "Firefox");
    }
}
