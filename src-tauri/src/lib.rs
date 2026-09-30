// Nila native backend library.
//
// Modules:
//   db        — SQLite schema, migrations, queries
//   scheduler — event-driven reminder scheduling
//   platform  — OS providers (notifications, startup, sleep/wake, display)
//   commands  — Tauri IPC command handlers

pub mod commands;
pub mod db;
pub mod platform;
pub mod scheduler;

use tauri::Manager;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter,
};

/// Show the companion window and tell the frontend which view to open.
fn show_window(app: &tauri::AppHandle, mode: &str) {
    app.emit("TRAY_SHOW", mode).ok();
    if let Some(w) = app.get_webview_window("companion") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Build the menu-bar tray icon.
///
/// Nila lives in the tray by default: the floating character window only
/// appears when a reminder is due (or when opened from this menu).
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Nila", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let pause =
        MenuItem::with_id(app, "pause", "Pause / resume reminders", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Nila", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &settings,
            &pause,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../../character/idle.png"))
        .expect("failed to load tray icon");

    TrayIconBuilder::with_id("nila-tray")
        .icon(icon)
        .tooltip("Nila — reminder companion")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => show_window(app, "companion"),
            "settings" => show_window(app, "settings"),
            // The frontend owns pause state and toggles it; no window needed.
            "pause" => {
                app.emit("TRAY_PAUSE", ()).ok();
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let visible = app
                    .get_webview_window("companion")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
                if visible {
                    if let Some(w) = app.get_webview_window("companion") {
                        let _ = w.hide();
                    }
                    app.emit("TRAY_HIDDEN", ()).ok();
                } else {
                    show_window(app, "companion");
                }
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    let db_path = default_db_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            // Open (and migrate) the local database on startup.
            let conn = db::open(&db_path).expect("failed to open Nila database");
            db::migrate(&conn).expect("failed to migrate Nila database");
            app.manage(db::DbState::new(conn));

            // Scheduler generation counter (wakes the driver on changes).
            app.manage(scheduler::SchedulerGen::new());

            // Hand the scheduler its dependencies and let it run.
            scheduler::spawn(app.handle().clone());
            platform::watch_sleep_wake(app.handle().clone());

            // Menu-bar tray: the character window stays hidden until a
            // reminder is due (or the user opens it from the tray).
            build_tray(app.handle()).expect("failed to build Nila tray icon");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::list_reminders,
            commands::create_reminder,
            commands::update_reminder,
            commands::delete_reminder,
            commands::snooze_reminder,
            commands::pause_all,
            commands::resume_all,
            commands::test_reminder,
            commands::record_reminder_action,
            commands::export_data,
            commands::import_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nila");
}

fn default_db_path() -> std::path::PathBuf {
    let base = dirs_fallback();
    base.join("nila").join("nila.db")
}

fn dirs_fallback() -> std::path::PathBuf {
    // Linux (V1 target): XDG base directories.
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        return std::path::PathBuf::from(data_home);
    }
    if let Some(home) = std::env::var_os("HOME") {
        return std::path::PathBuf::from(home).join(".local/share");
    }
    std::path::PathBuf::from(".")
}
