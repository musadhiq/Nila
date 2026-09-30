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
        return Err("തലക്കെട്ട് 1–80 അക്ഷരങ്ങൾ ആയിരിക്കണം".into());
    }
    if input.message.trim().is_empty() || input.message.chars().count() > 280 {
        return Err("സന്ദേശം 1–280 അക്ഷരങ്ങൾ ആയിരിക്കണം".into());
    }
    let schedule: serde_json::Value =
        serde_json::from_str(&input.schedule).map_err(|_| "ഷെഡ്യൂൾ തെറ്റാണ്".to_string())?;
    match schedule.get("type").and_then(|t| t.as_str()) {
        Some("once") | Some("daily") | Some("weekly") | Some("interval") => {}
        _ => return Err("ഷെഡ്യൂൾ തരം തെറ്റാണ്".into()),
    }
    const KINDS: &[&str] = &["water", "food", "break", "move", "sleep", "custom"];
    if !KINDS.contains(&input.kind.as_str()) {
        return Err("റിമൈൻഡർ തരം തെറ്റാണ്".into());
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
    let obj = settings.as_object().ok_or("ക്രമീകരണം തെറ്റാണ്")?;
    if obj.len() > 64 {
        return Err("കൂടുതൽ ക്രമീകരണങ്ങൾ".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for (k, v) in obj {
        if k.len() > 64 {
            return Err("ക്രമീകരണത്തിന്റെ പേര് വലുതാണ്".into());
        }
        let val = v.as_str().unwrap_or("").to_string();
        if val.len() > 4096 {
            return Err("ക്രമീകരണത്തിന്റെ മൂല്യം വലുതാണ്".into());
        }
        db::set_setting(&conn, k, &val).map_err(|e| e.to_string())?;
    }
    scheduler::notify_data_changed(&app);
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
        return Err("ഐഡി തെറ്റാണ്".into());
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
        return Err("ഐഡി തെറ്റാണ്".into());
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
        return Err("സ്നൂസ് മൂല്യം തെറ്റാണ്".into());
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
            return Err("പോസ് ദൈർഘ്യം തെറ്റാണ്".into());
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
    scheduler::notify_data_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn resume_all(app: AppHandle, db: State<'_, db::DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "paused_until", "").map_err(|e| e.to_string())?;
    scheduler::notify_data_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn test_reminder(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;
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
        return Err("ഐഡി തെറ്റാണ്".into());
    }
    if !["dismissed", "completed", "skipped"].contains(&action.as_str()) {
        return Err("പ്രവർത്തനം തെറ്റാണ്".into());
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
        return Err("ഫയൽ നിലയുടേതല്ല".into());
    }
    if data.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err("പതിപ്പ് പിന്തുണയ്ക്കുന്നില്ല".into());
    }
    let reminders = data
        .get("reminders")
        .and_then(|r| r.as_array())
        .ok_or("റിമൈൻഡറുകൾ കാണുന്നില്ല")?;
    if reminders.len() > 500 {
        return Err("റിമൈൻഡറുകൾ കൂടുതലാണ്".into());
    }
    let mut count = 0;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for item in reminders {
        let input: ReminderInput =
            serde_json::from_value(item.clone()).map_err(|_| "റിമൈൻഡർ തെറ്റാണ്".to_string())?;
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
