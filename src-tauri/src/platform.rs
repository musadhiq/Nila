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

/// Subscribe to OS sleep/wake and re-emit as app events so the
/// scheduler can recalculate instead of replaying missed reminders.
///
/// Linux: listen for PrepareForSleep on org.freedesktop.login1 via D-Bus.
/// Tray: AppIndicator / StatusNotifier; degrade gracefully when absent.
pub fn watch_sleep_wake(app: AppHandle) {
    // Phase 11: logind D-Bus hook + tray integration.
    let _ = app;
}

/// Emit from platform hooks; the scheduler listens for these.
pub fn emit_sleep(app: &AppHandle) {
    let _ = app.emit("SYSTEM_SLEEP", ());
}

pub fn emit_wake(app: &AppHandle) {
    let _ = app.emit("SYSTEM_WAKE", ());
}
