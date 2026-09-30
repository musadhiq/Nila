// Platform providers behind small traits so macOS/Windows specifics
// stay isolated. V1 targets macOS and Windows.

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
pub fn watch_sleep_wake(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        // Phase 11: NSWorkspace sleep/wake notifications via objc.
        let _ = app;
    }
    #[cfg(target_os = "windows")]
    {
        // Phase 11: WM_POWERBROADCAST via a hidden window hook.
        let _ = app;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
    }
}

/// Emit from platform hooks; the scheduler listens for these.
pub fn emit_sleep(app: &AppHandle) {
    let _ = app.emit("SYSTEM_SLEEP", ());
}

pub fn emit_wake(app: &AppHandle) {
    let _ = app.emit("SYSTEM_WAKE", ());
}
