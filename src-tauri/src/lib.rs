//! Nila native backend library.
//
// Modules:
//   db             — SQLite schema, migrations, queries
//   scheduler      — event-driven reminder scheduling
//   system_monitor — battery / CPU / memory / disk health reminders
//   commands       — Tauri IPC command handlers
//   wakeword       — microphone wake-word listener (micro-wakeword)
//   voice          — post-wake voice-command pipeline (sherpa-onnx STT)
//   models         — manual download of the STT models into app-data

pub mod commands;
pub mod db;
pub mod jev;
pub mod models;
pub mod scheduler;
pub mod system_calendar;
pub mod system_monitor;
pub mod voice;
pub mod wakeword;

use tauri::Manager;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
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

/// Tray menu labels in the user's language (English / Manglish).
struct TrayStrings {
    show: &'static str,
    new_reminder: &'static str,
    settings: &'static str,
    pause: &'static str,
    resume: &'static str,
    autostart: &'static str,
    quit: &'static str,
    tooltip: &'static str,
    tooltip_starting: &'static str,
}

fn tray_strings(lang: &str) -> TrayStrings {
    match lang {
        "manglish" => TrayStrings {
            show: "Nila show cheyyuka",
            new_reminder: "Puthiya reminder",
            settings: "Settings",
            pause: "Reminders nirthuka",
            resume: "Reminders thudakkuka",
            autostart: "Startup-il Nila on aakkuka",
            quit: "Nila quit cheyyuka",
            tooltip: "Nila — reminder companion",
            tooltip_starting: "Nila starting aakunnu…",
        },
        _ => TrayStrings {
            show: "Show Nila",
            new_reminder: "New Reminder",
            settings: "Settings",
            pause: "Pause Reminders",
            resume: "Resume Reminders",
            autostart: "Launch Nila on startup",
            quit: "Quit Nila",
            tooltip: "Nila — reminder companion",
            tooltip_starting: "Nila is starting…",
        },
    }
}

/// True once the user has finished the first-run setup.
fn setup_complete(app: &tauri::AppHandle) -> bool {
    app.try_state::<db::DbState>()
        .and_then(|st| {
            // The lock guard must not escape this closure (it borrows `st`).
            let conn = st.0.lock().ok()?;
            db::get_setting(&conn, "setup_complete").ok().flatten()
        })
        .map(|v| v == "true")
        .unwrap_or(false)
}

/// Which panel a launch should open: the setup flow on first run,
/// the settings afterwards.
fn launch_mode(app: &tauri::AppHandle) -> &'static str {
    if setup_complete(app) {
        "settings"
    } else {
        "setup"
    }
}

/// Read the current settings language from the database.
fn current_language(app: &tauri::AppHandle) -> String {
    app.try_state::<db::DbState>()
        .and_then(|st| {
            // The lock guard must not escape this closure (it borrows `st`).
            let conn = st.0.lock().ok()?;
            db::get_setting(&conn, "language").unwrap_or(None)
        })
        .unwrap_or_default()
}

/// True while reminders are paused (paused_until is a future timestamp).
fn reminders_paused(app: &tauri::AppHandle) -> bool {
    app.try_state::<db::DbState>()
        .and_then(|st| {
            // The lock guard must not escape this closure (it borrows `st`).
            let conn = st.0.lock().ok()?;
            db::get_setting(&conn, "paused_until").ok().flatten()
        })
        .filter(|s| !s.is_empty())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
        .map(|d| d.with_timezone(&chrono::Utc) > chrono::Utc::now())
        .unwrap_or(false)
}

/// True when the "launch at login" preference is on.
fn autostart_on(app: &tauri::AppHandle) -> bool {
    app.try_state::<db::DbState>()
        .and_then(|st| {
            let conn = st.0.lock().ok()?;
            db::get_setting(&conn, "start_at_login").ok().flatten()
        })
        .map(|v| v == "true")
        .unwrap_or(false)
}

/// Flip the "launch at login" preference from the tray checkbox:
/// apply it to the OS immediately and persist it, then rebuild the menu.
fn toggle_autostart(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let enable = !autostart_on(app);
    let m = app.autolaunch();
    let _ = if enable { m.enable() } else { m.disable() };
    if let Some(st) = app.try_state::<db::DbState>() {
        if let Ok(conn) = st.0.lock() {
            let _ = db::set_setting(
                &conn,
                "start_at_login",
                if enable { "true" } else { "false" },
            );
        }
        // conn is dropped here; refresh_tray_menu locks the DB again.
    }
    refresh_tray_menu(app);
    // Tell the frontend so an open settings panel doesn't keep a stale
    // checkbox (a later save would overwrite the new value).
    app.emit("TRAY_AUTOSTART", enable).ok();
}

/// Build the tray menu for a language.
fn tray_menu(app: &tauri::AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let s = tray_strings(lang);
    let show = MenuItem::with_id(app, "show", s.show, true, None::<&str>)?;
    let new_reminder =
        MenuItem::with_id(app, "new-reminder", s.new_reminder, true, None::<&str>)?;
    // The pause item reflects live state: "Pause Reminders" ↔ "Resume Reminders".
    let pause_label = if reminders_paused(app) { s.resume } else { s.pause };
    let pause = MenuItem::with_id(app, "pause", pause_label, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", s.settings, true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        s.autostart,
        true,
        autostart_on(app),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", s.quit, true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &show,
            &new_reminder,
            &pause,
            &settings,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

/// Rebuild the tray menu in the current language.
/// Called from `update_settings` when the language changes.
pub fn refresh_tray_menu(app: &tauri::AppHandle) {
    let lang = current_language(app);
    if let Ok(menu) = tray_menu(app, &lang) {
        if let Some(tray) = app.tray_by_id("nila-tray") {
            let _ = tray.set_menu(Some(menu));
            let _ = tray.set_tooltip(Some(tray_strings(&lang).tooltip));
        }
    }
}

/// Decode the tray icon PNG into raw RGBA pixels (Tauri's `Image` takes
/// raw pixels, so the PNG is decoded first). The tray uses the Nila
/// wordmark logo (wide aspect suits the top bar). Shared by the normal
/// and loading (dimmed) icon variants.
fn tray_icon_rgba() -> image::RgbaImage {
    let icon_png = include_bytes!("../../character/nila-logo.png");
    image::load_from_memory(icon_png)
        .expect("failed to decode tray icon PNG")
        .to_rgba8()
}

/// The normal tray icon.
fn tray_icon() -> tauri::image::Image<'static> {
    let rgba = tray_icon_rgba();
    let (w, h) = (rgba.width(), rgba.height());
    tauri::image::Image::new_owned(rgba.into_raw(), w, h)
}

/// A dimmed (grayscale, 60% brightness) version of the tray icon, shown
/// while Nila is initializing (mic check, model load). No extra binary
/// asset needed — derived programmatically from the normal icon.
fn tray_icon_loading() -> tauri::image::Image<'static> {
    let mut rgba = tray_icon_rgba();
    for px in rgba.chunks_exact_mut(4) {
        let gray =
            (px[0] as u32 * 30 + px[1] as u32 * 59 + px[2] as u32 * 11) / 100;
        let dimmed = (gray * 60 / 100) as u8;
        px[0] = dimmed;
        px[1] = dimmed;
        px[2] = dimmed;
        // Alpha channel untouched — transparency preserved.
    }
    let (w, h) = (rgba.width(), rgba.height());
    tauri::image::Image::new_owned(rgba.into_raw(), w, h)
}

/// Switch the tray from the loading state to the ready state: the full
/// Nila icon and the normal tooltip. Idempotent — safe to call on every
/// listener rebuild.
pub fn set_tray_ready(app: &tauri::AppHandle) {
    let lang = current_language(app);
    if let Some(tray) = app.tray_by_id("nila-tray") {
        let _ = tray.set_icon(Some(tray_icon()));
        let _ = tray.set_tooltip(Some(tray_strings(&lang).tooltip));
        eprintln!("nila: tray: ready");
    }
    // The frontend can also react (e.g. dismiss a loading veil if the
    // window happens to be open).
    let _ = app.emit("nila://ready", ());
}

/// appears when a reminder is due (or when opened from this menu).
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let lang = current_language(app);
    let menu = tray_menu(app, &lang)?;

    TrayIconBuilder::with_id("nila-tray")
        // Loading state until the wake-word listener reports ready
        // (mic verified, detector running) via set_tray_ready().
        .icon(tray_icon_loading())
        .tooltip(tray_strings(&lang).tooltip_starting)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => show_window(app, "companion"),
            "new-reminder" => show_window(app, "new-reminder"),
            "settings" => show_window(app, "settings"),
            // The frontend owns pause state and toggles it; no window needed.
            "pause" => {
                app.emit("TRAY_PAUSE", ()).ok();
            }
            "autostart" => toggle_autostart(app),
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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Second launch while Nila is running: focus the existing
        // instance instead of spawning another process (and tray icon).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app, launch_mode(app));
        }))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            // Open (and migrate) the local database on startup.
            let conn = db::open(&db_path).expect("failed to open Nila database");
            db::migrate(&conn).expect("failed to migrate Nila database");
            // Prefs the backend applies itself, read before the connection
            // moves into managed state.
            let autostart_on = db::get_setting(&conn, "start_at_login")
                .unwrap_or(None)
                .map(|v| v == "true")
                .unwrap_or(true);
            // Wake-word toggle: defaults ON so the feature works out of
            // the box; the user can switch it off in settings, which
            // releases the microphone entirely (see wakeword::run_forever).
            let wake_word_on = db::get_setting(&conn, "wake_word_enabled")
                .unwrap_or(None)
                .map(|v| v == "true")
                .unwrap_or(true);
            app.manage(db::DbState::new(conn));

            // Scheduler generation counter (wakes the driver on changes).
            app.manage(scheduler::SchedulerGen::new());

            // Jev action layer: conversation context, secure token store.
            app.manage(jev::JevState::new());

            // System calendar integration state.
            app.manage(system_calendar::SysCalState::new());

            // Startup sequence: load → validate → recover → compute the
            // first deadline → resume. The driver recomputes on every
            // wake, but doing it once here makes a failed resume visible
            // in the logs instead of silent.
            //
            // System health reminders are seeded before validation so a
            // fresh install (or an update adding new ones) always has
            // them; seeding never overwrites an existing row, so a user's
            // toggle stays as they left it.
            scheduler::seed_system_reminders(app.handle());
            let issues = scheduler::validate_store(app.handle());
            for issue in &issues {
                eprintln!(
                    "nila: startup: reminder '{}' invalid: {}",
                    issue.reminder_id, issue.reason
                );
            }
            let recovered = scheduler::recover_missed(app.handle());
            for id in &recovered {
                eprintln!("nila: startup: recovered missed one-time reminder '{id}'");
            }
            match scheduler::compute_next_deadline(app.handle()) {
                Some((id, at)) => eprintln!("nila: startup: next reminder '{id}' at {at}"),
                None => eprintln!("nila: startup: no reminders scheduled"),
            }
            if !issues.is_empty() || !recovered.is_empty() {
                eprintln!(
                    "nila: startup: {} invalid reminder(s), {} missed reminder(s) recovered",
                    issues.len(),
                    recovered.len()
                );
            }

            // Hand the scheduler its dependencies and let it run.
            scheduler::spawn(app.handle().clone());
            // System health monitor (battery / CPU / memory / disk).
            system_monitor::spawn(app.handle().clone());
            // Wake-word listener: microphone -> micro-wakeword ->
            // `nila://wake-detected`. Audio is never recorded or saved;
            // the detector consumes transient 10 ms blocks only. The
            // settings toggle flips the worker live (mic released while
            // off); the initial value comes from the DB read above.
            wakeword::spawn(app.handle(), wake_word_on);
            // Voice-command worker: subscribes to the wake-word
            // detector's `nila://wake-detected` event, parks the wake
            // listener while a command is captured, and transcribes it
            // locally with sherpa-onnx (INT8 Conformer-CTC). Audio is
            // never recorded or saved; inference runs only during a
            // post-wake session, never while idle. The STT models are not
            // bundled — the user downloads them once, manually, from
            // Settings (see models.rs); Nila works without them.
            voice::spawn(app.handle());

            // System calendar: resume the poll task if the toggle is on.
            system_calendar::maybe_start(app.handle());

            // Menu-bar tray: the character window stays hidden until a
            // reminder is due (or the user opens it from the tray).
            build_tray(app.handle()).expect("failed to build Nila tray icon");

            // Apply the saved autostart preference to the OS on every
            // launch — the settings toggle persists it; this enforces it.
            {
                use tauri_plugin_autostart::ManagerExt;
                let m = app.handle().autolaunch();
                let _ = if autostart_on { m.enable() } else { m.disable() };
            }
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
            commands::startup_report,
            commands::record_reminder_action,
            commands::export_data,
            commands::import_data,
            commands::stt_models_status,
            commands::download_stt_models,
            commands::delete_stt_models,
            jev::jev_get_status,
            jev::jev_set_token,
            jev::jev_remove_token,
            jev::jev_test_connection,
            jev::process_voice_command,
            commands::open_url,
            system_calendar::syscal_get_status,
            system_calendar::syscal_set_enabled,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Nila");
    // Stop the voice and wake-word workers before the process exits.
    // Each honors its flag between blocking calls; see
    // voice::request_stop and wakeword::request_stop.
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            voice::request_stop(app);
            wakeword::request_stop(app);
            system_calendar::request_stop(app);
        }
    });
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
