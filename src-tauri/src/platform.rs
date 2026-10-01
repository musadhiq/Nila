// Platform providers behind small traits so Linux desktop specifics
// stay isolated. V1 targets Linux.

use tauri::{AppHandle, Emitter};

pub trait Notifier: Send + Sync {
    fn notify(&self, title: &str, body: &str);
}

pub trait StartupManager: Send + Sync {
    fn set_launch_at_login(&self, enabled: bool) -> Result<(), String>;
    fn launch_at_login(&self) -> bool;
}

pub trait DisplayInfo: Send + Sync {
    /// Visible bounds of all monitors: (x, y, width, height).
    fn monitor_bounds(&self) -> Vec<(i32, i32, u32, u32)>;
}

/// Integration point for a future OS sleep/wake hook (e.g. listening for
/// PrepareForSleep on org.freedesktop.login1 via D-Bus).
///
/// Nothing calls these today and nothing listens for the events: recovery
/// after wake currently works implicitly — `tokio::time::sleep` uses a
/// monotonic clock, so a suspended sleep completes on wake and the
/// scheduler recomputes deadlines from the current time.
pub fn emit_sleep(app: &AppHandle) {
    let _ = app.emit("SYSTEM_SLEEP", ());
}

pub fn emit_wake(app: &AppHandle) {
    let _ = app.emit("SYSTEM_WAKE", ());
}
