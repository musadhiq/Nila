//! Google Calendar connector.
//!
//! Local-first design:
//!
//! ```text
//! Google Calendar → private ICS feed (OS keychain) → rolling-window poll
//!   → short-lived in-memory event cache → existing reminder scheduler
//!   → Nila notification dock
//! ```
//!
//! - No OAuth, no Google Cloud project, no browser flow: the user pastes
//!   the calendar's "Secret address in iCal format" once. The URL is a
//!   bearer credential and lives in the OS keychain, never in plain
//!   settings or logs.
//! - No Nila backend: the desktop app fetches the feed directly.
//! - No full calendar copy: only a 2-hour rolling window is ever
//!   parsed, and events leave the cache the moment they end, are
//!   cancelled, or fall outside the window.
//! - Read-only by construction: the ICS feed cannot be written to, and
//!   the connector never tries.
//! - The poll task is idle (30 min cadence) when nothing is upcoming
//!   and stops entirely when the connector is disconnected or
//!   reminders are disabled.

pub mod ics;
pub mod service;
pub mod sync;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
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
    /// Short-lived event cache: event id → cached entry.
    /// In-memory only; rebuilt on every sync.
    pub(crate) cache: Mutex<HashMap<String, sync::CachedEvent>>,
    /// Last user-visible error (e.g. network failure during a sync).
    last_error: Mutex<Option<String>>,
}

impl GcalState {
    pub fn new() -> Self {
        GcalState {
            notify: Arc::new(tokio::sync::Notify::new()),
            generation: AtomicU64::new(0),
            cache: Mutex::new(HashMap::new()),
            last_error: Mutex::new(None),
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

pub(crate) fn set_setting(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let state = app
        .try_state::<crate::db::DbState>()
        .ok_or("settings unavailable".to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, key, value).map_err(|e| e.to_string())
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

/// Startup entry point: resume polling only when the feed URL is set
/// and reminders are enabled. Never touches the network here — the
/// first sync validates the feed and degrades gracefully.
pub fn maybe_start(app: &AppHandle) {
    if reminders_enabled(app) && ics::has_url() {
        eprintln!("nila: gcal: resuming poll task");
        spawn_poll(app.clone());
    }
}

/// Drop all connector-owned state: keychain feed URL, cached events,
/// and every reminder the connector scheduled.
fn full_disconnect(app: &AppHandle) -> Result<(), String> {
    ics::delete_url().map_err(|e| format!("credential store: {e}"))?;
    request_stop(app);
    if let Some(state) = app.try_state::<GcalState>() {
        state.cache.lock().expect("gcal cache poisoned").clear();
        state.set_error(None);
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
    let _ = set_setting(app, "gcal_calendar_name", "");
    // Drop the stale OAuth-era client ID if it was ever saved.
    let _ = set_setting(app, "gcal_client_id", "");
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
    /// "disconnected" | "connected" | "error"
    pub state: String,
    pub calendar_name: Option<String>,
    pub last_sync: Option<String>,
    pub last_error: Option<String>,
}

/// `gcal_get_status` — the ONLY status the frontend ever sees.
/// The feed URL is never returned.
#[tauri::command]
pub fn gcal_get_status(app: AppHandle) -> Result<GcalStatus, String> {
    let state = app
        .try_state::<GcalState>()
        .ok_or("calendar connector unavailable".to_string())?;
    let last_error = state.last_error.lock().map_err(|e| e.to_string())?.clone();
    let connected = ics::has_url();
    let state_str = if connected {
        "connected"
    } else if last_error.is_some() {
        "error"
    } else {
        "disconnected"
    };
    Ok(GcalStatus {
        state: state_str.to_string(),
        calendar_name: get_setting(&app, "gcal_calendar_name").filter(|s| !s.is_empty()),
        last_sync: get_setting(&app, "gcal_last_sync").filter(|s| !s.is_empty()),
        last_error,
    })
}

/// Validate the pasted feed URL shape. The URL itself is opaque; we
/// only check it looks like an HTTPS ICS feed so typos fail fast.
fn validate_feed_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("feed URL is empty".to_string());
    }
    if url.len() > 2048 {
        return Err("feed URL is too long".to_string());
    }
    if url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("feed URL looks invalid".to_string());
    }
    let lower = url.to_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("webcal://")) {
        return Err("feed URL must start with https://".to_string());
    }
    Ok(url.to_string())
}

/// `gcal_set_feed_url` — store the calendar's private ICS feed URL
/// ("Secret address in iCal format") in the OS keychain, then start
/// syncing. Replaces any previous URL.
#[tauri::command]
pub fn gcal_set_feed_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = validate_feed_url(&url)?;
    // webcal:// is just https:// for calendar feeds.
    let url = url
        .strip_prefix("webcal://")
        .map(|rest| format!("https://{rest}"))
        .unwrap_or(url);
    ics::store_url(&url)?;
    if let Some(state) = app.try_state::<GcalState>() {
        state.set_error(None);
    }
    // Clear any stale calendar name; the first sync re-discovers it.
    let _ = set_setting(&app, "gcal_calendar_name", "");
    if reminders_enabled(&app) {
        spawn_poll(app.clone());
        if let Some(state) = app.try_state::<GcalState>() {
            state.notify();
        }
    }
    emit_status(&app);
    Ok(())
}

/// `gcal_disconnect` — remove the feed URL, stop polling, delete every
/// calendar reminder, clear the cache.
#[tauri::command]
pub fn gcal_disconnect(app: AppHandle) -> Result<(), String> {
    full_disconnect(&app)
}

/// `gcal_test_connection` — fetch the feed once and report.
#[tauri::command]
pub fn gcal_test_connection(app: AppHandle) -> Result<TestConnectionReport, String> {
    if !ics::has_url() {
        return Ok(TestConnectionReport {
            status: "not_configured",
        });
    }
    let now = chrono::Utc::now();
    let status = match ics::fetch_events(now, now + chrono::Duration::hours(2)) {
        Ok(_) => "connected",
        Err(GcalError::Network(_)) => "network_error",
        Err(GcalError::Feed(_)) => "service_unavailable",
        Err(_) => "service_unavailable",
    };
    if let Some(state) = app.try_state::<GcalState>() {
        state.set_error(None);
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
    let start = reminders_enabled(app) && ics::has_url();
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

/// Wake the poll task for an immediate resync. No-op when the task
/// isn't running.
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
    /// "connected" | "network_error" | "service_unavailable" |
    /// "not_configured"
    pub status: &'static str,
}
