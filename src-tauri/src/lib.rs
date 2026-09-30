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

            // Hand the scheduler its dependencies and let it run.
            scheduler::spawn(app.handle().clone());
            platform::watch_sleep_wake(app.handle().clone());
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
    std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Application Support"))
        })
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}
