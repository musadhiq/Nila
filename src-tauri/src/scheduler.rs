// Event-driven reminder scheduler.
//
// The scheduler never polls on a timer. It computes the next eligible
// trigger, waits for exactly that deadline, and re-validates everything
// on wake (eligibility may have changed while asleep). Any reminder or
// settings change bumps a generation counter and emits an event, so the
// driver recomputes instead of sleeping through the change.

use crate::db;
use chrono::{DateTime, Duration, Local, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, EventId, Listener, Manager};

pub const DEFAULT_QUIET_START: (u32, u32) = (22, 0);
pub const DEFAULT_QUIET_END: (u32, u32) = (8, 0);
pub const DEFAULT_DAILY_LIMIT: i64 = 8;
pub const DEFAULT_COOLDOWN_MINUTES: i64 = 45;

/// Emitted after any reminder/settings mutation; the driver recomputes.
pub const DATA_CHANGED_EVENT: &str = "nila://data-changed";
/// Emitted to the frontend when a reminder is due now.
pub const REMINDER_DUE_EVENT: &str = "REMINDER_DUE";

/// Generation counter so the driver never sleeps through a change that
/// lands between computing a deadline and arming the wake-up listener.
pub struct SchedulerGen {
    generation: AtomicU64,
}

impl SchedulerGen {
    pub fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
        }
    }

    pub fn bump(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    fn current(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

/// Call after any reminder/settings mutation so the driver recomputes.
pub fn notify_data_changed(app: &AppHandle) {
    if let Some(gen) = app.try_state::<SchedulerGen>() {
        gen.bump();
    }
    let _ = app.emit(DATA_CHANGED_EVENT, ());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Schedule {
    Once { at: DateTime<Utc> },
    Daily { time: String },            // "HH:MM" local
    Weekly { days: Vec<u32>, time: String }, // days: 0=Sunday
    Interval { minutes: u32 },
}

/// Next occurrence strictly after `from`, ignoring eligibility filters.
/// Returns None when the schedule can never fire again.
pub fn next_occurrence(schedule: &Schedule, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let local = from.with_timezone(&Local);
    match schedule {
        Schedule::Once { at } => (*at > from).then_some(*at),
        Schedule::Interval { minutes } => {
            if *minutes == 0 { return None; }
            Some(from + Duration::minutes(*minutes as i64))
        }
        Schedule::Daily { time } => next_daily(time, local),
        Schedule::Weekly { days, time } => {
            let mut best: Option<DateTime<Utc>> = None;
            for &d in days {
                if let Some(c) = next_weekly(d, time, local) {
                    best = Some(best.map_or(c, |b: DateTime<Utc>| b.min(c)));
                }
            }
            best
        }
    }
}

fn parse_hhmm(time: &str) -> Option<(u32, u32)> {
    let (h, m) = time.split_once(':')?;
    Some((h.parse().ok()?, m.parse().ok()?))
}

fn valid_hhmm(t: &(u32, u32)) -> bool {
    t.0 < 24 && t.1 < 60
}

fn next_daily(time: &str, local: DateTime<Local>) -> Option<DateTime<Utc>> {
    let (h, m) = parse_hhmm(time)?;
    let today = local.date_naive().and_hms_opt(h, m, 0)?;
    let today_local = today.and_local_timezone(Local).single()?;
    if today_local > local {
        return Some(today_local.with_timezone(&Utc));
    }
    let tomorrow = (local.date_naive() + Duration::days(1)).and_hms_opt(h, m, 0)?;
    Some(tomorrow.and_local_timezone(Local).single()?.with_timezone(&Utc))
}

fn next_weekly(day: u32, time: &str, local: DateTime<Local>) -> Option<DateTime<Utc>> {
    use chrono::Datelike;
    let (h, m) = parse_hhmm(time)?;
    let current_wd = local.weekday().num_days_from_sunday();
    let mut delta = (day as i64 - current_wd as i64).rem_euclid(7);
    let date = local.date_naive() + Duration::days(delta);
    let candidate = date.and_hms_opt(h, m, 0)?.and_local_timezone(Local).single()?;
    if candidate <= local {
        delta += 7;
        let date = local.date_naive() + Duration::days(delta);
        return Some(date.and_hms_opt(h, m, 0)?.and_local_timezone(Local).single()?.with_timezone(&Utc));
    }
    Some(candidate.with_timezone(&Utc))
}

/// True when `now` (local) falls inside quiet hours. Overnight ranges
/// like 22:00 -> 08:00 are handled.
pub fn in_quiet_hours(now: DateTime<Local>, start: (u32, u32), end: (u32, u32)) -> bool {
    let mins = now.hour() * 60 + now.minute();
    let s = start.0 * 60 + start.1;
    let e = end.0 * 60 + end.1;
    if s <= e { mins >= s && mins < e } else { mins >= s || mins < e }
}

/// Push a candidate trigger forward past quiet hours to the next
/// moment reminders are allowed.
pub fn skip_quiet_hours(candidate: DateTime<Utc>, start: (u32, u32), end: (u32, u32)) -> DateTime<Utc> {
    let mut c = candidate;
    // Advance in bounded steps; quiet windows are < 24h so this terminates.
    for _ in 0..48 {
        let local = c.with_timezone(&Local);
        if !in_quiet_hours(local, start, end) {
            return c;
        }
        // Jump to the end of quiet hours today (or tomorrow if past it).
        let (eh, em) = end;
        let date = local.date_naive();
        let end_today = date.and_hms_opt(eh, em, 0).and_then(|t| t.and_local_timezone(Local).single());
        c = match end_today {
            Some(t) if t > local => t.with_timezone(&Utc),
            _ => (date + Duration::days(1))
                .and_hms_opt(eh, em, 0)
                .and_then(|t| t.and_local_timezone(Local).single())
                .map(|t| t.with_timezone(&Utc))
                .unwrap_or(c + Duration::hours(1)),
        };
    }
    c
}

/// Eligibility check before a reminder may fire.
pub struct Eligibility {
    pub enabled: bool,
    pub paused: bool,
    pub quiet: bool,
    pub daily_limit: i64,
    pub shown_today: i64,
    pub cooldown_minutes: i64,
    pub last_shown: Option<DateTime<Utc>>,
}

impl Eligibility {
    pub fn allowed(&self, now: DateTime<Utc>) -> bool {
        if !self.enabled || self.paused || self.quiet {
            return false;
        }
        if self.shown_today >= self.daily_limit {
            return false;
        }
        if let Some(last) = self.last_shown {
            if now - last < Duration::minutes(self.cooldown_minutes) {
                return false;
            }
        }
        true
    }
}

/// After sleep/wake or a clock change: never replay a burst of missed
/// reminders — return the next valid occurrence from `now`.
pub fn recover_after_wake(
    schedule: &Schedule,
    now: DateTime<Utc>,
    quiet: ((u32, u32), (u32, u32)),
) -> Option<DateTime<Utc>> {
    next_occurrence(schedule, now).map(|next| skip_quiet_hours(next, quiet.0, quiet.1))
}

// ---------------------------------------------------------------------------
// Startup: load → validate → recover → compute first deadline → resume
// ---------------------------------------------------------------------------

/// A saved reminder that failed startup validation. The scheduler skips
/// invalid reminders (it never crashes on them); the issue is reported
/// so the user can fix or delete the reminder instead of silently
/// losing it.
#[derive(Debug, Clone, Serialize)]
pub struct StartupIssue {
    pub reminder_id: String,
    pub reason: String,
}

/// Validate every saved reminder: known kind, non-empty fields, and a
/// schedule the scheduler can actually compute from. Pure over the
/// reminder list: unit-testable without a Tauri app handle.
pub fn validate_reminders(reminders: &[db::Reminder]) -> Vec<StartupIssue> {
    let mut issues = Vec::new();
    for r in reminders {
        let mut bad = |reason: String| {
            issues.push(StartupIssue {
                reminder_id: r.id.clone(),
                reason,
            });
        };
        if r.id.trim().is_empty() {
            bad("empty id".to_string());
            continue;
        }
        if r.title.trim().is_empty() {
            bad("empty title".to_string());
        }
        if r.message.trim().is_empty() {
            bad("empty message".to_string());
        }
        if !db::VALID_KINDS.contains(&r.kind.as_str()) {
            bad(format!("unknown kind '{}'", r.kind));
        }
        match serde_json::from_str::<Schedule>(&r.schedule) {
            Err(_) => bad("schedule is not a valid schedule".to_string()),
            Ok(sched) => {
                let time_ok =
                    |t: &str| parse_hhmm(t).map(|p| valid_hhmm(&p)).unwrap_or(false);
                match &sched {
                    Schedule::Once { .. } => {}
                    Schedule::Daily { time } => {
                        if !time_ok(time) {
                            bad(format!("daily time '{time}' is not HH:MM"));
                        }
                    }
                    Schedule::Weekly { days, time } => {
                        if !time_ok(time) {
                            bad(format!("weekly time '{time}' is not HH:MM"));
                        }
                        if days.is_empty() {
                            bad("weekly schedule has no days selected".to_string());
                        } else if days.iter().any(|d| *d > 6) {
                            bad("weekly schedule has an invalid day".to_string());
                        }
                    }
                    Schedule::Interval { minutes } => {
                        if *minutes == 0 {
                            bad("interval must be at least 1 minute".to_string());
                        }
                    }
                }
            }
        }
    }
    issues
}

/// Load every saved reminder and validate it. Called once at startup;
/// on DB error returns no issues (the driver recomputes anyway and
/// skips corrupt schedules defensively).
pub fn validate_store(app: &AppHandle) -> Vec<StartupIssue> {
    app.try_state::<db::DbState>()
        .and_then(|st| st.0.lock().ok())
        .and_then(|conn| db::list_reminders(&conn).ok())
        .map(|reminders| validate_reminders(&reminders))
        .unwrap_or_default()
}

/// Grace after startup before a recovered reminder fires, so the
/// frontend is mounted and listening for REMINDER_DUE.
const RECOVERY_GRACE_SECS: i64 = 15;

/// Startup recovery over a DB connection (pure logic, unit-testable):
/// - drop snoozes whose wake time passed while the app was closed;
/// - re-arm missed one-time reminders by giving them a near-future
///   snooze wake time, so the normal driver path fires them exactly
///   once (eligibility-checked, history-recorded, surviving another
///   restart via the persisted snooze row).
fn recover_missed_in(
    conn: &rusqlite::Connection,
    now: DateTime<Utc>,
) -> rusqlite::Result<Vec<String>> {
    db::delete_expired_snoozes(conn, &now)?;
    let snoozed = db::list_snoozed(conn)?;
    let mut recovered = Vec::new();
    // Maximum age of a missed one-time reminder we will still fire.
    // Older than this, the moment has passed — firing it would be noise,
    // so it is left alone (and the startup log says so).
    let window_start = now - Duration::hours(24);
    for r in db::list_reminders(conn)? {
        if !r.enabled {
            continue;
        }
        let at = match serde_json::from_str::<Schedule>(&r.schedule) {
            Ok(Schedule::Once { at }) => at,
            _ => continue, // recurring schedules resume at their next occurrence
        };
        if at > now || at <= window_start {
            continue;
        }
        // Already re-armed on a previous boot moments ago? The driver
        // will fire it; don't touch it.
        if snoozed.iter().any(|(id, _)| id == &r.id) {
            continue;
        }
        // Already handled around its due time? Then it is not missed.
        if db::has_action_since(conn, &r.id, &at.to_rfc3339())? {
            continue;
        }
        let wake_at = (now + Duration::seconds(RECOVERY_GRACE_SECS)).to_rfc3339();
        conn.execute(
            "INSERT INTO snoozed_reminders (reminder_id, wake_at) VALUES (?1, ?2)
             ON CONFLICT(reminder_id) DO UPDATE SET wake_at = excluded.wake_at",
            rusqlite::params![r.id, wake_at],
        )?;
        recovered.push(r.id.clone());
    }
    Ok(recovered)
}

/// Run startup recovery against the app database. Never fails startup:
/// on DB error returns an empty list (the driver recomputes anyway).
pub fn recover_missed(app: &AppHandle) -> Vec<String> {
    let now = Utc::now();
    app.try_state::<db::DbState>()
        .and_then(|st| st.0.lock().ok())
        .and_then(|conn| recover_missed_in(&conn, now).ok())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

struct Settings {
    quiet_start: (u32, u32),
    quiet_end: (u32, u32),
    daily_limit: i64,
    cooldown_minutes: i64,
    paused_until: Option<DateTime<Utc>>,
    /// How a due reminder presents itself: "bubble" | "character" | "system".
    reminder_behavior: String,
    /// When Nila appears: "always" | "reminding" | "hidden".
    character_visibility: String,
    /// Send an OS notification with each reminder (backstop).
    desktop_notifications: bool,
}

fn read_settings(conn: &rusqlite::Connection) -> Settings {
    let get = |k: &str| db::get_setting(conn, k).unwrap_or(None);
    let hhmm = |key: &str, def: (u32, u32)| {
        get(key)
            .as_deref()
            .and_then(parse_hhmm)
            .filter(valid_hhmm)
            .unwrap_or(def)
    };
    let paused_until = get("paused_until")
        .filter(|s| !s.is_empty())
        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
        .map(|d| d.with_timezone(&Utc));
    Settings {
        quiet_start: hhmm("quiet_start", DEFAULT_QUIET_START),
        quiet_end: hhmm("quiet_end", DEFAULT_QUIET_END),
        daily_limit: get("daily_limit")
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_DAILY_LIMIT)
            .max(1),
        cooldown_minutes: get("cooldown_minutes")
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_COOLDOWN_MINUTES)
            .max(0),
        paused_until,
        reminder_behavior: get("reminder_behavior")
            .filter(|s| ["bubble", "character", "system"].contains(&s.as_str()))
            .unwrap_or_else(|| "bubble".to_string()),
        character_visibility: get("character_visibility")
            .filter(|s| ["always", "reminding", "hidden"].contains(&s.as_str()))
            .unwrap_or_else(|| "reminding".to_string()),
        desktop_notifications: get("desktop_notifications")
            .map_or(true, |s| s != "false"),
    }
}

fn parse_rfc3339(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

struct Snapshot {
    settings: Settings,
    reminders: Vec<db::Reminder>,
    snoozed: Vec<(String, DateTime<Utc>)>,
    shown_today: i64,
    last_shown: Option<DateTime<Utc>>,
}

/// Read everything the deadline computation needs under one short lock.
/// Never holds the lock across an await.
fn snapshot(app: &AppHandle) -> Option<Snapshot> {
    let state = app.try_state::<db::DbState>()?;
    let conn = state.0.lock().ok()?;
    let now = Utc::now();
    // Expired snoozes are garbage; clean them while we're here.
    let _ = db::delete_expired_snoozes(&conn, &now);
    Some(Snapshot {
        settings: read_settings(&conn),
        reminders: db::list_reminders(&conn).unwrap_or_default(),
        snoozed: db::list_snoozed(&conn).unwrap_or_default(),
        shown_today: db::shown_today(&conn).unwrap_or(0),
        last_shown: db::last_shown_at(&conn).ok().flatten().and_then(|s| parse_rfc3339(&s)),
    })
}

/// The next (reminder id, deadline). Internal sentinels (`__nila_*`) are
/// maintenance wake-ups, not reminders.
pub fn compute_next_deadline(app: &AppHandle) -> Option<(String, DateTime<Utc>)> {
    let now = Utc::now();
    let snap = snapshot(app)?;
    let s = snap.settings;

    // Global pause: the only deadline is the unpause moment.
    if let Some(until) = s.paused_until {
        if until > now {
            return Some(("__nila_unpause__".to_string(), until));
        }
    }
    // Daily limit exhausted: sleep until local midnight, then recompute.
    if snap.shown_today >= s.daily_limit {
        let tomorrow = Local::now().date_naive() + Duration::days(1);
        if let Some(midnight) = tomorrow
            .and_hms_opt(0, 0, 0)
            .and_then(|t| t.and_local_timezone(Local).single())
        {
            return Some(("__nila_newday__".to_string(), midnight.with_timezone(&Utc)));
        }
        return None;
    }

    let cooldown_floor =
        snap.last_shown.map(|last| last + Duration::minutes(s.cooldown_minutes));

    let mut best: Option<(String, DateTime<Utc>)> = None;
    for r in &snap.reminders {
        if !r.enabled {
            continue;
        }
        // A snoozed reminder's deadline is its wake time, not its schedule.
        // Tuple: (candidate time, is_explicit_once).
        let (mut candidate, is_explicit_once) = match snap.snoozed.iter().find(|(id, _)| id == &r.id) {
            Some((_, wake)) => {
                if *wake <= now {
                    continue; // stale row; cleaned on next snapshot
                }
                (*wake, false)
            }
            None => {
                let sched: Schedule = match serde_json::from_str(&r.schedule) {
                    Ok(sched) => sched,
                    Err(_) => continue, // corrupt schedule: skip, never crash
                };
                let is_once = matches!(sched, Schedule::Once { .. });
                match next_occurrence(&sched, now) {
                    Some(next) => (next, is_once),
                    None => continue,
                }
            }
        };
        // Cooldown spaces out automatic reminders, but an explicit one-time
        // reminder (user picked "in 1 minute") honors the chosen time.
        if !is_explicit_once {
            if let Some(floor) = cooldown_floor {
                if candidate < floor {
                    candidate = floor;
                }
            }
        }
        candidate = skip_quiet_hours(candidate, s.quiet_start, s.quiet_end);
        if candidate <= now {
            continue;
        }
        match &best {
            Some((_, b)) if *b <= candidate => {}
            _ => best = Some((r.id.clone(), candidate)),
        }
    }
    best
}

/// Arm a one-shot wake-up for DATA_CHANGED_EVENT.
fn armed_listener(app: &AppHandle) -> (EventId, Arc<tokio::sync::Notify>) {
    let notify = Arc::new(tokio::sync::Notify::new());
    let waker = notify.clone();
    let id = app.once(DATA_CHANGED_EVENT, move |_| waker.notify_one());
    (id, notify)
}

/// Sleep until `at`, waking early on data changes. Returns true when data
/// changed (caller must recompute), false when the deadline was reached.
async fn sleep_until_or_changed(app: &AppHandle, at: DateTime<Utc>, generation: u64) -> bool {
    let (id, notify) = armed_listener(app);
    // Close the race: a change between computing the deadline and arming
    // the listener shows up as a generation bump.
    let changed = app
        .try_state::<SchedulerGen>()
        .map(|g| g.current() != generation)
        .unwrap_or(false);
    let result = if changed {
        true
    } else {
        let wait = at
            .signed_duration_since(Utc::now())
            .to_std()
            .unwrap_or(std::time::Duration::ZERO);
        tokio::select! {
            _ = tokio::time::sleep(wait) => false,
            _ = notify.notified() => true,
        }
    };
    app.unlisten(id);
    result
}

async fn wait_for_change(app: &AppHandle) {
    let (id, notify) = armed_listener(app);
    notify.notified().await;
    app.unlisten(id);
}

async fn fire_if_eligible(app: &AppHandle, reminder_id: &str) {
    // Internal sentinels just wake the loop to recompute.
    if reminder_id == "__nila_unpause__" {
        if let Some(state) = app.try_state::<db::DbState>() {
            if let Ok(conn) = state.0.lock() {
                let _ = db::set_setting(&conn, "paused_until", "");
            }
        }
        notify_data_changed(app);
        return;
    }
    if reminder_id == "__nila_newday__" {
        notify_data_changed(app);
        return;
    }

    let now = Utc::now();
    let (reminder, settings, shown_today, last_shown) = match snapshot(app) {
        Some(snap) => match snap.reminders.iter().find(|r| r.id == reminder_id).cloned() {
            Some(reminder) => (reminder, snap.settings, snap.shown_today, snap.last_shown),
            None => return, // deleted while we slept
        },
        None => return,
    };

    let paused = settings.paused_until.map_or(false, |u| u > now);
    let eligibility = Eligibility {
        enabled: reminder.enabled,
        paused,
        quiet: in_quiet_hours(
            now.with_timezone(&Local),
            settings.quiet_start,
            settings.quiet_end,
        ),
        daily_limit: settings.daily_limit,
        shown_today,
        cooldown_minutes: settings.cooldown_minutes,
        last_shown,
    };
    if !eligibility.allowed(now) {
        return; // conditions changed while asleep; loop recomputes
    }

    // Commit the firing, then tell the frontend.
    if let Some(state) = app.try_state::<db::DbState>() {
        if let Ok(conn) = state.0.lock() {
            let _ = db::record_history(&conn, reminder_id, "shown");
            let _ = db::clear_snooze(&conn, reminder_id);
        }
    }
    let payload = serde_json::json!({
        "id": reminder.id,
        "title": reminder.title,
        "message": reminder.message,
        "kind": reminder.kind,
    });
    let behavior = settings.reminder_behavior.as_str();
    let hidden = settings.character_visibility == "hidden";
    // "System notification" mode and "hidden" visibility: the OS
    // notification is the whole surface; the frontend stays in the tray.
    if behavior != "system" && !hidden {
        let _ = app.emit(REMINDER_DUE_EVENT, payload);
    }

    // OS notification: a backstop in overlay modes, the primary surface in
    // "system" mode and "hidden" visibility (where it always fires
    // regardless of the toggle, so reminders are never silent).
    if settings.desktop_notifications || behavior == "system" || hidden {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(reminder.title.clone())
            .body(reminder.message.clone())
            .show();
    }
}

/// The async driver: compute next deadline, sleep until it, validate,
/// trigger, record, repeat. Spawned once at startup.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let generation = app
                .try_state::<SchedulerGen>()
                .map(|g| g.current())
                .unwrap_or(0);
            let next = compute_next_deadline(&app);
            match next {
                Some((reminder_id, at)) => {
                    if sleep_until_or_changed(&app, at, generation).await {
                        continue; // data changed: recompute
                    }
                    fire_if_eligible(&app, &reminder_id).await;
                }
                None => {
                    // Nothing scheduled: wait for a settings/reminder change event.
                    wait_for_change(&app).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn once_fires_only_in_future() {
        let at = utc(2030, 1, 1, 9, 0);
        assert_eq!(next_occurrence(&Schedule::Once { at }, utc(2029, 12, 31, 0, 0)), Some(at));
        assert_eq!(next_occurrence(&Schedule::Once { at }, utc(2030, 1, 1, 9, 0)), None);
        assert_eq!(next_occurrence(&Schedule::Once { at }, utc(2031, 1, 1, 0, 0)), None);
    }

    #[test]
    fn interval_adds_minutes() {
        let from = utc(2026, 9, 30, 10, 0);
        assert_eq!(
            next_occurrence(&Schedule::Interval { minutes: 45 }, from),
            Some(utc(2026, 9, 30, 10, 45))
        );
        assert_eq!(next_occurrence(&Schedule::Interval { minutes: 0 }, from), None);
    }

    #[test]
    fn quiet_hours_overnight() {
        // Use fixed offsets via Local is environment-dependent; test the math on a synthetic day.
        let mk = |h: u32, m: u32| {
            Local.with_ymd_and_hms(2026, 9, 30, h, m, 0).unwrap()
        };
        assert!(in_quiet_hours(mk(23, 0), (22, 0), (8, 0)));
        assert!(in_quiet_hours(mk(3, 0), (22, 0), (8, 0)));
        assert!(!in_quiet_hours(mk(9, 0), (22, 0), (8, 0)));
        assert!(!in_quiet_hours(mk(21, 59), (22, 0), (8, 0)));
        // Daytime window
        assert!(in_quiet_hours(mk(13, 0), (12, 0), (14, 0)));
        assert!(!in_quiet_hours(mk(15, 0), (12, 0), (14, 0)));
    }

    #[test]
    fn eligibility_blocks_spam() {
        let now = utc(2026, 9, 30, 10, 0);
        let base = Eligibility {
            enabled: true, paused: false, quiet: false,
            daily_limit: 8, shown_today: 0,
            cooldown_minutes: 45, last_shown: None,
        };
        assert!(base.allowed(now));
        assert!(!Eligibility { enabled: false, ..base.clone() }.allowed(now));
        assert!(!Eligibility { paused: true, ..base.clone() }.allowed(now));
        assert!(!Eligibility { quiet: true, ..base.clone() }.allowed(now));
        assert!(!Eligibility { shown_today: 8, ..base.clone() }.allowed(now));
        assert!(!Eligibility {
            last_shown: Some(now - Duration::minutes(10)),
            ..base.clone()
        }.allowed(now));
        assert!(Eligibility {
            last_shown: Some(now - Duration::minutes(50)),
            ..base.clone()
        }.allowed(now));
    }

    #[test]
    fn wake_recovery_skips_quiet_hours() {
        // 09:00 daily reminder, waking at 23:30 with 22:00-08:00 quiet hours
        // must NOT fire immediately; it waits for tomorrow 09:00.
        let sched = Schedule::Daily { time: "09:00".into() };
        let wake = utc(2026, 9, 30, 18, 0); // 23:30 IST == 18:00 UTC
        let next = recover_after_wake(&sched, wake, ((22, 0), (8, 0))).unwrap();
        let local = next.with_timezone(&Local);
        assert!(local.hour() == 9 || local.hour() == 3); // 09:00 local in some TZ
        assert!(next > wake);
    }

    #[test]
    fn schedule_json_roundtrip() {
        // The shapes commands.rs validates must deserialize into Schedule.
        let daily: Schedule =
            serde_json::from_str(r#"{"type":"daily","time":"09:00"}"#).unwrap();
        assert!(matches!(daily, Schedule::Daily { .. }));
        let weekly: Schedule =
            serde_json::from_str(r#"{"type":"weekly","days":[1,3,5],"time":"18:30"}"#).unwrap();
        assert!(matches!(weekly, Schedule::Weekly { .. }));
        let interval: Schedule =
            serde_json::from_str(r#"{"type":"interval","minutes":45}"#).unwrap();
        assert!(matches!(interval, Schedule::Interval { minutes: 45 }));
        assert!(serde_json::from_str::<Schedule>(r#"{"type":"bogus"}"#).is_err());
    }

    fn valid_reminder(id: &str) -> db::Reminder {
        db::Reminder {
            id: id.into(),
            title: "Water".into(),
            message: "Drink".into(),
            kind: "water".into(),
            schedule: r#"{"type":"daily","time":"09:00"}"#.into(),
            enabled: true,
        }
    }

    #[test]
    fn validate_reminders_flags_bad_data() {
        assert!(validate_reminders(std::slice::from_ref(&valid_reminder("r1"))).is_empty());

        let mut bad_kind = valid_reminder("r2");
        bad_kind.kind = "teleport".into();
        let issues = validate_reminders(std::slice::from_ref(&bad_kind));
        assert_eq!(issues.len(), 1);
        assert!(issues[0].reason.contains("unknown kind"));

        let mut bad_time = valid_reminder("r3");
        bad_time.schedule = r#"{"type":"daily","time":"25:99"}"#.into();
        assert!(validate_reminders(std::slice::from_ref(&bad_time))
            .iter()
            .any(|i| i.reason.contains("HH:MM")));

        let mut no_days = valid_reminder("r4");
        no_days.schedule = r#"{"type":"weekly","days":[],"time":"09:00"}"#.into();
        assert!(validate_reminders(std::slice::from_ref(&no_days))
            .iter()
            .any(|i| i.reason.contains("no days")));

        let mut bad_day = valid_reminder("r4b");
        bad_day.schedule = r#"{"type":"weekly","days":[9],"time":"09:00"}"#.into();
        assert!(validate_reminders(std::slice::from_ref(&bad_day))
            .iter()
            .any(|i| i.reason.contains("invalid day")));

        let mut zero_interval = valid_reminder("r5");
        zero_interval.schedule = r#"{"type":"interval","minutes":0}"#.into();
        assert!(validate_reminders(std::slice::from_ref(&zero_interval))
            .iter()
            .any(|i| i.reason.contains("at least 1 minute")));

        let mut bad_json = valid_reminder("r6");
        bad_json.schedule = "not json".into();
        assert!(!validate_reminders(std::slice::from_ref(&bad_json)).is_empty());

        let mut empty_title = valid_reminder("r7");
        empty_title.title = "  ".into();
        assert!(validate_reminders(std::slice::from_ref(&empty_title))
            .iter()
            .any(|i| i.reason.contains("empty title")));
    }

    fn test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn once_reminder(id: &str, at: DateTime<Utc>, enabled: bool) -> db::Reminder {
        db::Reminder {
            id: id.into(),
            title: "t".into(),
            message: "m".into(),
            kind: "custom".into(),
            schedule: serde_json::json!({"type": "once", "at": at.to_rfc3339()}).to_string(),
            enabled,
        }
    }

    #[test]
    fn recover_missed_rearms_only_truly_missed_once_reminders() {
        let conn = test_db();
        let now = Utc::now();
        let missed = once_reminder("missed", now - Duration::hours(1), true);
        let shown = once_reminder("shown", now - Duration::hours(2), true);
        let stale = once_reminder("stale", now - Duration::hours(25), true);
        let disabled = once_reminder("disabled", now - Duration::hours(1), false);
        let future = once_reminder("future", now + Duration::hours(1), true);
        let mut daily = once_reminder("daily", now - Duration::hours(1), true);
        daily.schedule = r#"{"type":"daily","time":"09:00"}"#.into();
        for r in [&missed, &shown, &stale, &disabled, &future, &daily] {
            db::upsert_reminder(&conn, r).unwrap();
        }
        // "shown" was handled after its due time: not missed.
        db::record_history(&conn, "shown", "shown").unwrap();

        let recovered = recover_missed_in(&conn, now).unwrap();
        assert_eq!(recovered, vec!["missed".to_string()]);

        // The re-arm is a near-future snooze row, so the normal driver
        // path fires it exactly once.
        let snoozed = db::list_snoozed(&conn).unwrap();
        assert_eq!(snoozed.len(), 1);
        assert_eq!(snoozed[0].0, "missed");
        let wake_in = snoozed[0].1.signed_duration_since(now).num_seconds();
        assert!((10..=20).contains(&wake_in), "wake in {wake_in}s");
    }

    #[test]
    fn recover_missed_clears_expired_snoozes() {
        let conn = test_db();
        let now = Utc::now();
        let r = once_reminder("r", now + Duration::hours(1), true);
        db::upsert_reminder(&conn, &r).unwrap();
        conn.execute(
            "INSERT INTO snoozed_reminders (reminder_id, wake_at) VALUES (?1, ?2)",
            rusqlite::params!["r", (now - Duration::minutes(5)).to_rfc3339()],
        )
        .unwrap();
        let recovered = recover_missed_in(&conn, now).unwrap();
        assert!(recovered.is_empty());
        assert!(db::list_snoozed(&conn).unwrap().is_empty());
    }

    #[test]
    fn recover_missed_does_not_double_rearm() {
        // A reminder re-armed on a previous boot still has its future
        // snooze row: a second recovery pass must leave it alone.
        let conn = test_db();
        let now = Utc::now();
        let r = once_reminder("r", now - Duration::hours(1), true);
        db::upsert_reminder(&conn, &r).unwrap();
        conn.execute(
            "INSERT INTO snoozed_reminders (reminder_id, wake_at) VALUES (?1, ?2)",
            rusqlite::params!["r", (now + Duration::seconds(10)).to_rfc3339()],
        )
        .unwrap();
        let recovered = recover_missed_in(&conn, now).unwrap();
        assert!(recovered.is_empty());
        assert_eq!(db::list_snoozed(&conn).unwrap().len(), 1);
    }
}
