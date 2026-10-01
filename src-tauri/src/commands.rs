// Tauri IPC commands. Every command validates its inputs before
// touching the database; imported JSON is validated, never executed.

use crate::db::{self, Reminder};
use crate::scheduler;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Serialize, Deserialize)]
pub struct ReminderInput {
    pub title: String,
    pub message: String,
    pub kind: String,
    pub schedule: String, // JSON — validated below
    pub enabled: bool,
}

fn validate_input(input: &ReminderInput) -> Result<(), String> {
    if input.title.trim().is_empty() || input.title.chars().count() > 80 {
        return Err("Title must be 1–80 characters.".into());
    }
    if input.message.trim().is_empty() || input.message.chars().count() > 280 {
        return Err("Message must be 1–280 characters.".into());
    }
    let schedule: serde_json::Value =
        serde_json::from_str(&input.schedule).map_err(|_| "Invalid schedule.".to_string())?;
    match schedule.get("type").and_then(|t| t.as_str()) {
        Some("once") | Some("daily") | Some("weekly") | Some("interval") | Some("system") => {}
        _ => return Err("Invalid schedule type.".into()),
    }
    if !db::VALID_KINDS.contains(&input.kind.as_str()) {
        return Err("Invalid reminder type.".into());
    }
    Ok(())
}
#[tauri::command]
pub fn get_settings(db: State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(settings_json(&conn).map_err(|e| e.to_string())?)
}

/// Build the settings JSON object from an already-locked connection.
/// Used by `get_settings` and `export_data` so the latter never takes
/// the DB mutex twice (std Mutex is not re-entrant — that would deadlock).
fn settings_json(conn: &rusqlite::Connection) -> rusqlite::Result<serde_json::Value> {
    let mut map = serde_json::Map::new();
    for (k, v) in db::get_all_settings(conn)? {
        map.insert(k, serde_json::Value::String(v));
    }
    Ok(serde_json::Value::Object(map))
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    db: State<'_, db::DbState>,
    settings: serde_json::Value,
) -> Result<(), String> {
    let obj = settings.as_object().ok_or("Invalid settings.")?;
    if obj.len() > 64 {
        return Err("Too many settings.".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let prev_lang = db::get_setting(&conn, "language")
        .unwrap_or(None)
        .unwrap_or_default();
    for (k, v) in obj {
        if k.len() > 64 {
            return Err("Setting name too long.".into());
        }
        let val = v.as_str().unwrap_or("").to_string();
        if val.len() > 4096 {
            return Err("Setting value too long.".into());
        }
        db::set_setting(&conn, k, &val).map_err(|e| e.to_string())?;
    }
    // Compute the new language before releasing the lock.
    let new_lang = obj
        .get("language")
        .and_then(|v| v.as_str())
        .unwrap_or(prev_lang.as_str())
        .to_string();
    // The tray checkbox mirrors this preference too.
    let autostart_changed = obj.contains_key("start_at_login");
    // Release the DB lock BEFORE the tray refresh: refresh_tray_menu ->
    // current_language locks the DB again, and std::Mutex is not
    // re-entrant (holding `conn` here would deadlock the app on every
    // language change).
    drop(conn);
    scheduler::notify_data_changed(&app);
    // Rebuild the tray menu when the language changed or the
    // launch-at-login checkbox was toggled from settings.
    if new_lang != prev_lang || autostart_changed {
        crate::refresh_tray_menu(&app);
    }
    // Keep the wake-word worker in sync with its settings toggle:
    // switching it off releases the microphone, switching it on resumes
    // listening — no restart needed.
    if let Some(v) = obj.get("wake_word_enabled").and_then(|v| v.as_str()) {
        crate::wakeword::set_enabled(&app, v == "true");
    }
    Ok(())
}

#[tauri::command]
pub fn list_reminders(db: State<'_, db::DbState>) -> Result<Vec<Reminder>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::list_reminders(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_reminder(
    app: AppHandle,
    db: State<'_, db::DbState>,
    input: ReminderInput,
) -> Result<Reminder, String> {
    validate_input(&input)?;
    let reminder = Reminder {
        id: format!("r-{}", chrono::Utc::now().timestamp_millis()),
        title: input.title.trim().to_string(),
        message: input.message.trim().to_string(),
        kind: input.kind,
        schedule: input.schedule,
        enabled: input.enabled,
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::upsert_reminder(&conn, &reminder).map_err(|e| e.to_string())?;
    scheduler::notify_data_changed(&app);
    Ok(reminder)
}

#[tauri::command]
pub fn update_reminder(
    app: AppHandle,
    db: State<'_, db::DbState>,
    id: String,
    input: ReminderInput,
) -> Result<Reminder, String> {
    validate_input(&input)?;
    if id.len() > 64 {
        return Err("Invalid id.".into());
    }
    let reminder = Reminder {
        id,
        title: input.title.trim().to_string(),
        message: input.message.trim().to_string(),
        kind: input.kind,
        schedule: input.schedule,
        enabled: input.enabled,
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::upsert_reminder(&conn, &reminder).map_err(|e| e.to_string())?;
    // A stale snooze would override the edited schedule until it
    // expires; the edit itself is the user's latest intent.
    db::clear_snooze(&conn, &reminder.id).map_err(|e| e.to_string())?;
    scheduler::notify_data_changed(&app);
    Ok(reminder)
}

#[tauri::command]
pub fn delete_reminder(
    app: AppHandle,
    db: State<'_, db::DbState>,
    id: String,
) -> Result<(), String> {
    if id.len() > 64 {
        return Err("Invalid id.".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::delete_reminder(&conn, &id).map_err(|e| e.to_string())?;
    scheduler::notify_data_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn snooze_reminder(
    app: AppHandle,
    db: State<'_, db::DbState>,
    id: String,
    minutes: u32,
) -> Result<(), String> {
    if id.len() > 64 || ![10, 30, 60].contains(&minutes) {
        return Err("Invalid snooze duration.".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let wake_at = (chrono::Utc::now() + chrono::Duration::minutes(minutes as i64)).to_rfc3339();
    conn.execute(
        "INSERT INTO snoozed_reminders (reminder_id, wake_at) VALUES (?1, ?2)
         ON CONFLICT(reminder_id) DO UPDATE SET wake_at = excluded.wake_at",
        rusqlite::params![id, wake_at],
    )
    .map_err(|e| e.to_string())?;
    db::record_history(&conn, &id, "snoozed").map_err(|e| e.to_string())?;
    scheduler::notify_data_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn pause_all(
    app: AppHandle,
    db: State<'_, db::DbState>,
    minutes: Option<u32>,
) -> Result<(), String> {
    // minutes: Some(30|60) or None = until tomorrow
    if let Some(m) = minutes {
        if ![30, 60].contains(&m) {
            return Err("Invalid pause duration.".into());
        }
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let until = match minutes {
        Some(m) => chrono::Utc::now() + chrono::Duration::minutes(m as i64),
        None => {
            let tomorrow = chrono::Local::now().date_naive() + chrono::Duration::days(1);
            tomorrow
                .and_hms_opt(0, 0, 0)
                .and_then(|t| t.and_local_timezone(chrono::Local).single())
                .map(|t| t.with_timezone(&chrono::Utc))
                .unwrap_or_else(|| chrono::Utc::now() + chrono::Duration::hours(12))
        }
    };
    db::set_setting(&conn, "paused_until", &until.to_rfc3339()).map_err(|e| e.to_string())?;
    // Release the DB lock BEFORE the tray refresh (see update_settings).
    drop(conn);
    scheduler::notify_data_changed(&app);
    // The tray item flips between "Pause Reminders" / "Resume Reminders".
    crate::refresh_tray_menu(&app);
    Ok(())
}

#[tauri::command]
pub fn resume_all(app: AppHandle, db: State<'_, db::DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "paused_until", "").map_err(|e| e.to_string())?;
    drop(conn);
    scheduler::notify_data_changed(&app);
    crate::refresh_tray_menu(&app);
    Ok(())
}

/// Diagnostic: when is the next reminder scheduled to fire?
/// Returns {id, at} or null if nothing is scheduled.
#[tauri::command]
pub fn next_reminder(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let next = scheduler::compute_next_deadline(&app);
    Ok(next.map(|(id, at)| {
        serde_json::json!({
            "id": id,
            "at": at.to_rfc3339(),
        })
    }))
}

/// Startup report for the settings UI: validation issues found in the
/// saved reminders, plus the next computed deadline. Shows the user
/// that Nila loaded, validated, and resumed scheduling normally —
/// instead of a silently missed or broken reminder.
#[tauri::command]
pub fn startup_report(app: AppHandle) -> Result<serde_json::Value, String> {
    let issues = scheduler::validate_store(&app);
    let next = scheduler::compute_next_deadline(&app).map(|(id, at)| {
        serde_json::json!({
            "id": id,
            "at": at.to_rfc3339(),
        })
    });
    Ok(serde_json::json!({
        "issues": issues,
        "next": next,
    }))
}

#[tauri::command]
pub fn test_reminder(app: AppHandle, db: State<'_, db::DbState>) -> Result<(), String> {
    use tauri::Emitter;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let behavior = db::get_setting(&conn, "reminder_behavior")
        .map_err(|e| e.to_string())?;
    let visibility = db::get_setting(&conn, "character_visibility")
        .map_err(|e| e.to_string())?;
    // "System notification" mode and "hidden" visibility: the OS
    // notification is the whole surface.
    if behavior.as_deref() == Some("system") || visibility.as_deref() == Some("hidden") {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("Parikshanam")
            .body("Ithu oru parikshana ormmappeduthal aanu 🌸")
            .show();
        return Ok(());
    }
    app.emit("REMINDER_DUE", "test").map_err(|e| e.to_string())
}

/// Record a user action on a shown reminder (dismissed/completed/skipped).
/// History only; does not change scheduling.
#[tauri::command]
pub fn record_reminder_action(
    db: State<'_, db::DbState>,
    id: String,
    action: String,
) -> Result<(), String> {
    if id.len() > 64 {
        return Err("Invalid id.".into());
    }
    if !["dismissed", "completed", "skipped"].contains(&action.as_str()) {
        return Err("Invalid action.".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::record_history(&conn, &id, &action).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn export_data(db: State<'_, db::DbState>) -> Result<serde_json::Value, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let reminders = db::list_reminders(&conn).map_err(|e| e.to_string())?;
    let settings = settings_json(&conn).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "format": "nila-export",
        "version": 1,
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "reminders": reminders,
        "settings": settings,
    }))
}

#[tauri::command]
pub fn import_data(
    app: AppHandle,
    db: State<'_, db::DbState>,
    data: serde_json::Value,
) -> Result<usize, String> {
    // Strict validation: correct envelope, bounded sizes, valid schedules.
    if data.get("format").and_then(|f| f.as_str()) != Some("nila-export") {
        return Err("Not a Nila backup file.".into());
    }
    if data.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err("Unsupported backup version.".into());
    }
    let reminders = data
        .get("reminders")
        .and_then(|r| r.as_array())
        .ok_or("No reminders found in backup.")?;
    if reminders.len() > 500 {
        return Err("Too many reminders in backup.".into());
    }
    let mut count = 0;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for item in reminders {
        let input: ReminderInput =
            serde_json::from_value(item.clone()).map_err(|_| "Invalid reminder in backup.".to_string())?;
        validate_input(&input)?;
        let reminder = Reminder {
            id: format!("r-{}", chrono::Utc::now().timestamp_millis() + count as i64),
            title: input.title.trim().to_string(),
            message: input.message.trim().to_string(),
            kind: input.kind,
            schedule: input.schedule,
            enabled: input.enabled,
        };
        db::upsert_reminder(&conn, &reminder).map_err(|e| e.to_string())?;
        count += 1;
    }
    // Settings: only known keys, bounded values.
    if let Some(settings) = data.get("settings").and_then(|s| s.as_object()) {
        const KNOWN: &[&str] = &[
            "quiet_start", "quiet_end", "daily_limit", "cooldown_minutes",
            "character_size", "character_visibility", "animation", "appearance", "sound",
        ];
        for (k, v) in settings {
            if !KNOWN.contains(&k.as_str()) {
                continue;
            }
            let val = v.as_str().unwrap_or("");
            if val.len() <= 64 {
                db::set_setting(&conn, k, val).map_err(|e| e.to_string())?;
            }
        }
    }
    scheduler::notify_data_changed(&app);
    Ok(count)
}
