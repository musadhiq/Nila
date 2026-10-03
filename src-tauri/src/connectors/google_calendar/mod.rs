//! Google Calendar connector.
//!
//! Local-first design:
//!
//! ```text
//! Google Calendar → OAuth (OS keychain) → rolling-window poll
//!   → short-lived in-memory event cache → existing reminder scheduler
//!   → Nila notification dock
//! ```
//!
//! - No Nila backend: the desktop app talks to Google directly.
//! - No full calendar copy: only a 2-hour rolling window is ever
//!   fetched, and events leave the cache the moment they end, are
//!   cancelled, or fall outside the window.
//! - Credentials: the OAuth client ID lives in plain settings (public
//!   by design for installed apps); access/refresh tokens live in the
//!   OS keychain as one JSON blob and are never logged or returned to
//!   the frontend.
//! - The poll task is idle (30 min cadence) when nothing is upcoming
//!   and stops entirely when the connector is disconnected or
//!   reminders are disabled.

pub mod auth;
pub mod service;
pub mod sync;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub use service::GcalError;

pub mod events {
    pub const STATUS: &str = "gcal:status";
    pub const SYNC: &str = "gcal:sync";
}

/// Connector lifecycle state, managed by Tauri.
pub struct GcalState {
    /// Wakes the poll task early (settings changed, manual sync).
    notify: Arc<tokio::sync::Notify>,
    /// Bumps every time the poll task must be retired (disconnect,
    /// disable, settings change); the task exits when its captured
    /// generation no longer matches.
    generation: AtomicU64,
    /// True while the browser OAuth flow is in flight.
    connecting: AtomicBool,
    /// Short-lived event cache: Google event id → cached entry.
    /// In-memory only; rebuilt on every sync.
    pub(crate) cache: Mutex<HashMap<String, sync::CachedEvent>>,
    /// Last user-visible error (e.g. network failure during auth).
    last_error: Mutex<Option<String>>,
    /// Set when a token refresh fails: the user must reconnect.
    pub(crate) auth_failed: AtomicBool,
}

impl GcalState {
    pub fn new() -> Self {
        GcalState {
            notify: Arc::new(tokio::sync::Notify::new()),
            generation: AtomicU64::new(0),
            connecting: AtomicBool::new(false),
            cache: Mutex::new(HashMap::new()),
            last_error: Mutex::new(None),
            auth_failed: AtomicBool::new(false),
        }
    }

    pub fn notify(&self) {
        self.notify.notify_one();
    }

    /// Retire the current poll task; returns the new generation.
    fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn set_error(&self, e: Option<String>) {
        *self.last_error.lock().expect("gcal error poisoned") = e;
    }
}

impl Default for GcalState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Settings (flat keys, same convention as the rest of the settings table)
// ---------------------------------------------------------------------------

fn get_setting(app: &AppHandle, key: &str) -> Option<String> {
    let state = app.try_state::<crate::db::DbState>()?;
    let conn = state.0.lock().ok()?;
    crate::db::get_setting(&conn, key).ok().flatten()
}

fn set_setting(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let state = app
        .try_state::<crate::db::DbState>()
        .ok_or("settings unavailable".to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, key, value).map_err(|e| e.to_string())
}

/// OAuth client ID for the user's own Google Cloud "Desktop app".
pub fn client_id(app: &AppHandle) -> Option<String> {
    get_setting(app, "gcal_client_id").filter(|s| !s.trim().is_empty())
}

/// Calendar reminders master toggle. Defaults ON.
pub fn reminders_enabled(app: &AppHandle) -> bool {
    get_setting(app, "gcal_reminders_enabled")
        .map(|v| v == "true")
        .unwrap_or(true)
}

/// Minutes before an event the reminder fires. Defaults 15, clamped.
pub fn reminder_minutes(app: &AppHandle) -> i64 {
    get_setting(app, "gcal_reminder_minutes")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|m| m.clamp(1, 120))
        .unwrap_or(15)
}

/// All-day events never notify unless explicitly enabled.
pub fn allday_reminders_enabled(app: &AppHandle) -> bool {
    get_setting(app, "gcal_allday_reminders_enabled")
        .map(|v| v == "true")
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Token helper with one transparent refresh-and-retry
// ---------------------------------------------------------------------------

/// Run `f` with a valid access token, refreshing once on a 401 and
/// retrying. Centralizes the "expired mid-call" race for sync, JEV,
/// and the connection test.
pub fn with_fresh_token<T>(
    app: &AppHandle,
    f: impl Fn(&str) -> Result<T, GcalError>,
) -> Result<T, GcalError> {
    let mut token = auth::ensure_access_token(app)?;
    match f(&token) {
        Err(GcalError::Api(401, _)) => {
            token = auth::force_refresh(app)?;
            f(&token)
        }
        other => other,
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Start the poll task. The previous task (if any) is retired first,
/// so this is safe to call on settings changes.
pub fn spawn_poll(app: AppHandle) {
    let Some(state) = app.try_state::<GcalState>() else {
        return;
    };
    let generation = state.bump_generation();
    let notify = state.notify.clone();
    tauri::async_runtime::spawn(async move {
        eprintln!("nila: gcal: poll task started (gen {generation})");
        loop {
            let current = app
                .try_state::<GcalState>()
                .map(|s| s.generation())
                .unwrap_or(u64::MAX);
            if current != generation {
                break;
            }
            let app_clone = app.clone();
            // The sync does blocking HTTP + SQLite: keep it off the
            // async runtime.
            let next = tokio::task::spawn_blocking(move || sync::sync_once(&app_clone)).await;
            let interval_secs = match next {
                Ok(Some(s)) => s,
                // Disabled, disconnected, or panicked: stop the task.
                _ => break,
            };
            let current = app
                .try_state::<GcalState>()
                .map(|s| s.generation())
                .unwrap_or(u64::MAX);
            if current != generation {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(interval_secs)) => {}
                _ = notify.notified() => {
                    eprintln!("nila: gcal: poll woken early");
                }
            }
        }
        eprintln!("nila: gcal: poll task stopped (gen {generation})");
    });
}

/// Retire the poll task without starting a new one.
pub fn request_stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<GcalState>() {
        state.bump_generation();
        state.notify.notify_one();
    }
}

/// Startup entry point: resume polling only when the connector is
/// connected and reminders are enabled. Never touches the network
/// here — the first sync validates the token and degrades gracefully.
pub fn maybe_start(app: &AppHandle) {
    if reminders_enabled(app) && auth::has_tokens() {
        eprintln!("nila: gcal: resuming poll task");
        spawn_poll(app.clone());
    }
}

/// Drop all connector-owned state: keychain tokens, cached events,
/// and every reminder the connector scheduled.
fn full_disconnect(app: &AppHandle) -> Result<(), String> {
    auth::delete_bundle().map_err(|e| format!("credential store: {e}"))?;
    request_stop(app);
    if let Some(state) = app.try_state::<GcalState>() {
        state.cache.lock().expect("gcal cache poisoned").clear();
        state.set_error(None);
        state.auth_failed.store(false, Ordering::SeqCst);
    }
    let db_state = app
        .try_state::<crate::db::DbState>()
        .ok_or("reminder store unavailable".to_string())?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    let n = crate::db::delete_reminders_by_kind(&conn, "calendar").map_err(|e| e.to_string())?;
    drop(conn);
    if n > 0 {
        eprintln!("nila: gcal: removed {n} calendar reminder(s)");
    }
    let _ = set_setting(app, "gcal_account_email", "");
    crate::scheduler::notify_data_changed(app);
    emit_status(app);
    Ok(())
}

pub(crate) fn emit_status(app: &AppHandle) {
    if let Ok(status) = gcal_get_status(app.clone()) {
        let _ = app.emit(events::STATUS, status);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — Settings → Connectors → Google Calendar
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct GcalStatus {
    /// "disconnected" | "connecting" | "connected" |
    /// "auth_required" | "error"
    pub state: String,
    pub email: Option<String>,
    pub last_sync: Option<String>,
    pub last_error: Option<String>,
}

/// `gcal_get_status` — the ONLY status the frontend ever sees.
/// Tokens are never returned.
#[tauri::command]
pub fn gcal_get_status(app: AppHandle) -> Result<GcalStatus, String> {
    let state = app
        .try_state::<GcalState>()
        .ok_or("calendar connector unavailable".to_string())?;
    let connecting = state.connecting.load(Ordering::SeqCst);
    let auth_failed = state.auth_failed.load(Ordering::SeqCst);
    let last_error = state.last_error.lock().map_err(|e| e.to_string())?.clone();
    let tokens = auth::has_tokens();
    let state_str = if connecting {
        "connecting"
    } else if auth_failed {
        "auth_required"
    } else if tokens {
        "connected"
    } else if last_error.is_some() {
        "error"
    } else {
        "disconnected"
    };
    Ok(GcalStatus {
        state: state_str.to_string(),
        email: get_setting(&app, "gcal_account_email").filter(|s| !s.is_empty()),
        last_sync: get_setting(&app, "gcal_last_sync").filter(|s| !s.is_empty()),
        last_error,
    })
}

/// `gcal_set_client_id` — store the user's Google OAuth client ID
/// (Google Cloud Console → Desktop app). Public by design for
/// installed apps; kept in plain settings, never hardcoded.
#[tauri::command]
pub fn gcal_set_client_id(app: AppHandle, client_id: String) -> Result<(), String> {
    let id = client_id.trim();
    if id.is_empty() {
        return Err("client ID is empty".to_string());
    }
    if id.len() > 256 || id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("client ID looks invalid".to_string());
    }
    set_setting(&app, "gcal_client_id", id)?;
    emit_status(&app);
    Ok(())
}

/// `gcal_start_auth` — begin the browser OAuth flow. Returns
/// immediately; progress arrives as `gcal:status` events.
#[tauri::command]
pub fn gcal_start_auth(app: AppHandle) -> Result<(), String> {
    let Some(id) = client_id(&app) else {
        return Err("set your Google OAuth client ID first".to_string());
    };
    let state = app
        .try_state::<GcalState>()
        .ok_or("calendar connector unavailable".to_string())?;
    if state.connecting.swap(true, Ordering::SeqCst) {
        return Err("authorization already in progress".to_string());
    }
    state.set_error(None);
    state.auth_failed.store(false, Ordering::SeqCst);
    emit_status(&app);
    std::thread::spawn(move || {
        let outcome = auth::run_auth_flow(&app, &id);
        let state = app.try_state::<GcalState>();
        match outcome {
            Ok(()) => {
                eprintln!("nila: gcal: authorization succeeded");
                if let Some(s) = &state {
                    s.set_error(None);
                    s.auth_failed.store(false, Ordering::SeqCst);
                }
                // Cache the account email for the status card.
                match with_fresh_token(&app, service::primary_email) {
                    Ok(email) => {
                        let _ = set_setting(&app, "gcal_account_email", &email);
                    }
                    Err(e) => eprintln!("nila: gcal: email lookup failed: {e:?}"),
                }
                if reminders_enabled(&app) {
                    spawn_poll(app.clone());
                }
            }
            Err(e) => {
                eprintln!("nila: gcal: authorization failed: {e}");
                if let Some(s) = &state {
                    s.set_error(Some(e));
                }
            }
        }
        if let Some(s) = state {
            s.connecting.store(false, Ordering::SeqCst);
        }
        emit_status(&app);
    });
    Ok(())
}

/// `gcal_disconnect` — remove tokens, stop polling, delete every
/// calendar reminder, clear the cache.
#[tauri::command]
pub fn gcal_disconnect(app: AppHandle) -> Result<(), String> {
    full_disconnect(&app)
}

/// `gcal_test_connection` — lightweight authenticated probe.
#[tauri::command]
pub fn gcal_test_connection(app: AppHandle) -> Result<TestConnectionReport, String> {
    if !auth::has_tokens() {
        return Ok(TestConnectionReport {
            status: "not_configured",
        });
    }
    let status = match with_fresh_token(&app, service::primary_email) {
        Ok(_) => "connected",
        Err(GcalError::NotConfigured) | Err(GcalError::AuthRequired) => "auth_required",
        Err(GcalError::Network(_)) => "network_error",
        Err(GcalError::Api(_, _) | GcalError::Storage(_)) => "service_unavailable",
    };
    if let Some(state) = app.try_state::<GcalState>() {
        state
            .auth_failed
            .store(status == "auth_required", Ordering::SeqCst);
    }
    emit_status(&app);
    Ok(TestConnectionReport { status })
}

/// `gcal_settings_changed` — call after the frontend writes any
/// `gcal_*` setting: (re)starts or stops the poll task as needed and
/// wakes it for an immediate resync.
///
/// Note: `update_settings` already calls [`apply_settings_changed`]
/// itself when a `gcal_*` value changes, so this command is mostly a
/// manual override / back-compat entry point.
#[tauri::command]
pub fn gcal_settings_changed(app: AppHandle) -> Result<(), String> {
    apply_settings_changed(&app)
}

/// React to changed `gcal_*` settings: (re)start or stop the poll
/// task and wake it for an immediate resync. Extracted so
/// `update_settings` can run it in the same IPC call as the write —
/// the frontend saves fire-and-forget, so a separate "settings
/// changed" call could otherwise read stale values.
pub(crate) fn apply_settings_changed(app: &AppHandle) -> Result<(), String> {
    let start = reminders_enabled(app) && auth::has_tokens();
    if start {
        spawn_poll(app.clone());
        if let Some(state) = app.try_state::<GcalState>() {
            state.notify();
        }
    } else {
        // Disabled or disconnected: retire the task and drop
        // connector-owned reminders (a disabled connector must not
        // keep notifying).
        request_stop(app);
        if let Some(state) = app.try_state::<GcalState>() {
            state.cache.lock().expect("gcal cache poisoned").clear();
        }
        if let Some(db_state) = app.try_state::<crate::db::DbState>() {
            if let Ok(conn) = db_state.0.lock() {
                if let Ok(n) = crate::db::delete_reminders_by_kind(&conn, "calendar") {
                    if n > 0 {
                        eprintln!("nila: gcal: removed {n} calendar reminder(s)");
                    }
                }
                drop(conn);
                crate::scheduler::notify_data_changed(app);
            }
        }
    }
    emit_status(app);
    Ok(())
}

/// Wake the poll task for an immediate resync (e.g. after a JEV
/// calendar mutation). No-op when the task isn't running.
pub fn wake_poll(app: &AppHandle) {
    if let Some(state) = app.try_state::<GcalState>() {
        state.notify();
    }
}

/// `gcal_sync_now` — wake the poll task for an immediate sync.
#[tauri::command]
pub fn gcal_sync_now(app: AppHandle) -> Result<(), String> {
    wake_poll(&app);
    Ok(())
}

#[derive(Serialize)]
pub struct TestConnectionReport {
    /// "connected" | "auth_required" | "network_error" |
    /// "service_unavailable" | "not_configured"
    pub status: &'static str,
}
