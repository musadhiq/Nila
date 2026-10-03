//! Rolling-window sync for the Google Calendar connector.
//!
//! Strategy (from the spec):
//!
//! - Only a 2-hour rolling window (`[now, now + 2h]`) is ever fetched.
//! - A short-lived in-memory cache holds exactly the window's events.
//! - Every sync diffs fetched vs cached: new/modified/rescheduled
//!   events (re)schedule a reminder, cancelled/ended/out-of-window
//!   events lose theirs. The stable reminder id `gcal-{event_id}`
//!   makes repeat syncs idempotent — syncing twice never duplicates.
//! - Polling adapts to the nearest upcoming event; the task is idle
//!   (30 min) when nothing is coming up.
//!
//! Reminders go through the existing scheduler (`db::upsert_reminder`
//! + `scheduler::notify_data_changed`), never a second mechanism.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Local, TimeZone, Utc};
use tauri::{AppHandle, Emitter, Manager};

use super::service::{self, CalendarEvent, GcalError};
use super::{GcalState, events};

// ---------------------------------------------------------------------------
// Tunables (seconds unless noted) — all in one place for later tuning.
// ---------------------------------------------------------------------------

/// Rolling window: how far ahead each sync looks.
pub const WINDOW_SECS: i64 = 2 * 3600;
/// No upcoming event in the cache.
pub const POLL_IDLE_SECS: u64 = 30 * 60;
/// Nearest event more than an hour away.
pub const POLL_FAR_SECS: u64 = 30 * 60;
/// Nearest event within the hour.
pub const POLL_NEAR_SECS: u64 = 10 * 60;
/// Nearest event within 15 minutes.
pub const POLL_SOON_SECS: u64 = 3 * 60;
/// After a failed sync: retry on a calm cadence, never a tight loop.
pub const POLL_ERROR_SECS: u64 = 5 * 60;
/// A late-added event still gets a heads-up this far ahead.
const NUDGE_SECS: i64 = 60;
/// All-day reminders (opt-in) fire at this local time.
const ALLDAY_HOUR: u32 = 9;

/// Whether the cached event currently owns a reminder row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReminderState {
    Scheduled,
    /// Reminder time passed or event already started: nothing to do.
    Fired,
    /// All-day event with all-day reminders disabled.
    Suppressed,
}

#[derive(Debug, Clone)]
pub struct CachedEvent {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub location: Option<String>,
    pub status: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    /// When the reminder row fires (None when no row is wanted).
    pub remind_at: Option<DateTime<Utc>>,
    /// "starts in N minutes" label (None → all-day "is today").
    pub label_minutes: Option<i64>,
    pub state: ReminderState,
    pub last_updated: DateTime<Utc>,
}

/// What one sync must do to the reminder store.
#[derive(Debug)]
pub enum SyncAction {
    /// Create or update the `gcal-{id}` reminder row. `is_nudge` marks
    /// the late-added-event heads-up: it is only inserted when no row
    /// exists yet, so a restart can never re-fire an already-handled
    /// event (the row survives restarts; the in-memory cache doesn't).
    Schedule { event: CachedEvent, is_nudge: bool },
    /// Delete the `gcal-{id}` reminder row, if any.
    Unschedule { id: String },
}

pub struct DiffOutcome {
    pub actions: Vec<SyncAction>,
    pub cache: HashMap<String, CachedEvent>,
}

// ---------------------------------------------------------------------------
// Pure diff — the whole new/update/cancel/expire matrix, testable.
// ---------------------------------------------------------------------------

/// Diff the fetched window against the cache.
///
/// `now` is a parameter (not read inside) so tests can pin time.
/// Unchanged events produce no action, so a quiet sync is a no-op.
pub fn diff_events(
    cached: &HashMap<String, CachedEvent>,
    fetched: &[CalendarEvent],
    now: DateTime<Utc>,
    reminder_minutes: i64,
    allday_enabled: bool,
) -> DiffOutcome {
    let mut actions = Vec::new();
    let mut next_cache = HashMap::with_capacity(fetched.len());

    for event in fetched {
        // Ended already: drop from the cache; the reminder row (long
        // inert — a fired `Once` never refires) is deleted too.
        if event.end <= now {
            if cached.contains_key(&event.id) {
                actions.push(SyncAction::Unschedule { id: event.id.clone() });
            }
            continue;
        }
        let prev = cached.get(&event.id);
        let desired = desired_state(event, prev, now, reminder_minutes, allday_enabled);
        let entry = CachedEvent {
            id: event.id.clone(),
            calendar_id: event.calendar_id.clone(),
            title: event.title.clone(),
            location: event.location.clone(),
            status: event.status.clone(),
            start: event.start,
            end: event.end,
            all_day: event.all_day,
            remind_at: desired.remind_at,
            label_minutes: desired.label_minutes,
            state: desired.state,
            last_updated: now,
        };
        // `changed` covers everything that shapes the reminder row
        // (title, times, lead). `location`/`status` are cached for the
        // design's shape but don't alter the row, so a location-only
        // edit doesn't rewrite it.
        let changed = match prev {
            None => true,
            Some(p) => {
                p.title != entry.title
                    || p.start != entry.start
                    || p.end != entry.end
                    || p.all_day != entry.all_day
                    || p.remind_at != entry.remind_at
                    || p.label_minutes != entry.label_minutes
                    || p.state != entry.state
            }
        };
        if changed {
            match desired.state {
                ReminderState::Scheduled => {
                    debug_assert!(desired.remind_at.is_some());
                    actions.push(SyncAction::Schedule {
                        event: entry.clone(),
                        is_nudge: desired.is_nudge,
                    });
                }
                // Was scheduled before, now fired/suppressed: drop the row.
                ReminderState::Fired | ReminderState::Suppressed => {
                    if matches!(prev.map(|p| p.state), Some(ReminderState::Scheduled)) {
                        actions.push(SyncAction::Unschedule { id: event.id.clone() });
                    }
                }
            }
        }
        next_cache.insert(event.id.clone(), entry);
    }

    // In cache but not in the window: cancelled, deleted, or drifted
    // out of the rolling window. Either way it no longer notifies.
    for id in cached.keys() {
        if !next_cache.contains_key(id) {
            actions.push(SyncAction::Unschedule { id: id.clone() });
        }
    }

    DiffOutcome {
        actions,
        cache: next_cache,
    }
}

/// What the cache entry for one event should look like.
struct DesiredState {
    remind_at: Option<DateTime<Utc>>,
    label_minutes: Option<i64>,
    state: ReminderState,
    /// True only for the late-added-event heads-up (the configured
    /// lead already passed and the event wasn't previously known).
    is_nudge: bool,
}

fn desired_state(
    event: &CalendarEvent,
    prev: Option<&CachedEvent>,
    now: DateTime<Utc>,
    reminder_minutes: i64,
    allday_enabled: bool,
) -> DesiredState {
    if event.all_day {
        if !allday_enabled {
            return DesiredState {
                remind_at: None,
                label_minutes: None,
                state: ReminderState::Suppressed,
                is_nudge: false,
            };
        }
        // Opt-in: 09:00 local on the event day.
        let day = event.start.with_timezone(&Local).date_naive();
        let nine = day
            .and_hms_opt(ALLDAY_HOUR, 0, 0)
            .and_then(|n| Local.from_local_datetime(&n).single())
            .map(|l| l.with_timezone(&Utc));
        return match nine {
            Some(at) if at > now => DesiredState {
                remind_at: Some(at),
                label_minutes: None,
                state: ReminderState::Scheduled,
                is_nudge: false,
            },
            _ => DesiredState {
                remind_at: None,
                label_minutes: None,
                state: ReminderState::Fired,
                is_nudge: false,
            },
        };
    }
    let remind_at = event.start - chrono::Duration::minutes(reminder_minutes);
    if remind_at > now {
        return DesiredState {
            remind_at: Some(remind_at),
            label_minutes: Some(reminder_minutes),
            state: ReminderState::Scheduled,
            is_nudge: false,
        };
    }
    // The configured lead already passed.
    match prev {
        // Already handled (scheduled or nudged): don't re-nudge every sync.
        Some(p) if p.state == ReminderState::Scheduled => DesiredState {
            remind_at: p.remind_at,
            label_minutes: p.label_minutes,
            state: ReminderState::Scheduled,
            is_nudge: false,
        },
        _ if event.start > now => {
            // Late-added event: one heads-up a minute from now.
            let mins = (event.start - now).num_minutes().max(1);
            DesiredState {
                remind_at: Some(now + Duration::from_secs(NUDGE_SECS as u64)),
                label_minutes: Some(mins),
                state: ReminderState::Scheduled,
                is_nudge: true,
            }
        }
        _ => DesiredState {
            remind_at: None,
            label_minutes: None,
            state: ReminderState::Fired,
            is_nudge: false,
        },
    }
}

/// Adaptive interval from the nearest upcoming event start.
pub fn next_poll_secs(cache: &HashMap<String, CachedEvent>, now: DateTime<Utc>) -> u64 {
    let nearest = cache
        .values()
        .filter(|e| e.end > now)
        .map(|e| e.start)
        .min();
    match nearest {
        None => POLL_IDLE_SECS,
        Some(start) => {
            let secs = (start - now).num_seconds().max(0) as u64;
            if secs <= 15 * 60 {
                POLL_SOON_SECS
            } else if secs <= 3600 {
                POLL_NEAR_SECS
            } else {
                POLL_FAR_SECS
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Applying the diff to the reminder store
// ---------------------------------------------------------------------------

fn sanitize_id(id: &str) -> String {
    let clean: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    clean.chars().take(64).collect()
}

fn calendar_reminder(event: &CachedEvent) -> crate::db::Reminder {
    let remind_at = event
        .remind_at
        .expect("Schedule action without remind_at");
    let message = match event.label_minutes {
        Some(m) => format!("{} starts in {m} minutes · Google Calendar", event.title),
        None => format!("{} is today · Google Calendar", event.title),
    };
    crate::db::Reminder {
        id: format!("gcal-{}", sanitize_id(&event.id)),
        title: event.title.clone(),
        message,
        kind: "calendar".to_string(),
        schedule: serde_json::json!({
            "type": "once",
            "at": remind_at.to_rfc3339(),
        })
        .to_string(),
        enabled: true,
    }
}

fn apply_actions(app: &AppHandle, actions: &[SyncAction]) {
    let Some(db_state) = app.try_state::<crate::db::DbState>() else {
        eprintln!("nila: gcal: reminder store unavailable, skipping apply");
        return;
    };
    let Ok(conn) = db_state.0.lock() else {
        eprintln!("nila: gcal: could not lock reminder store");
        return;
    };
    for action in actions {
        let res: Result<(), rusqlite::Error> = (|| {
            match action {
                SyncAction::Schedule { event, is_nudge } => {
                    let r = calendar_reminder(event);
                    if *is_nudge && crate::db::reminder_exists(&conn, &r.id)? {
                        // Restart path: the row outlived the in-memory
                        // cache (it already fired or is still pending).
                        // Re-arming it here would notify twice for the
                        // same event.
                        return Ok(());
                    }
                    crate::db::upsert_reminder(&conn, &r)?;
                    // A rescheduled event must not inherit a stale snooze.
                    crate::db::clear_snooze(&conn, &r.id)?;
                }
                SyncAction::Unschedule { id } => {
                    crate::db::delete_reminder(&conn, &format!("gcal-{}", sanitize_id(id)))?;
                }
            }
            Ok(())
        })();
        if let Err(e) = res {
            eprintln!("nila: gcal: reminder store write failed: {e}");
        }
    }
    drop(conn);
    crate::scheduler::notify_data_changed(app);
}

// ---------------------------------------------------------------------------
// One sync: fetch → diff → apply → next interval
// ---------------------------------------------------------------------------

/// Run a single rolling-window sync. Returns the seconds until the
/// next poll, or `None` when the poll task should stop (disabled or
/// disconnected). Runs on a blocking thread.
pub fn sync_once(app: &AppHandle) -> Option<u64> {
    if !super::reminders_enabled(app) {
        eprintln!("nila: gcal: reminders disabled, stopping poll task");
        return None;
    }
    let minutes = super::reminder_minutes(app);
    let allday = super::allday_reminders_enabled(app);
    let now = Utc::now();
    let window_end = now + Duration::from_secs(WINDOW_SECS as u64);

    let fetched = match super::with_fresh_token(app, |t| {
        service::list_events(t, now, window_end)
    }) {
        Ok(events) => events,
        Err(GcalError::NotConfigured) => {
            eprintln!("nila: gcal: not connected, stopping poll task");
            return None;
        }
        Err(GcalError::AuthRequired) => {
            eprintln!("nila: gcal: authentication required, stopping poll task");
            if let Some(state) = app.try_state::<GcalState>() {
                state
                    .auth_failed
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            super::emit_status(app);
            return None;
        }
        Err(e) => {
            // Network/API failure: keep the cache and existing
            // reminders, retry on a calm cadence. No tight loop.
            eprintln!("nila: gcal: sync failed ({e}); keeping cache, retrying later");
            return Some(POLL_ERROR_SECS);
        }
    };

    let outcome = {
        let state = app.try_state::<GcalState>()?;
        let cache = state.cache.lock().expect("gcal cache poisoned");
        diff_events(&cache, &fetched, now, minutes, allday)
    };

    if !outcome.actions.is_empty() {
        eprintln!(
            "nila: gcal: sync: {} event(s), {} reminder action(s)",
            fetched.len(),
            outcome.actions.len()
        );
        apply_actions(app, &outcome.actions);
    }

    let next_secs = {
        let state = app.try_state::<GcalState>()?;
        let mut cache = state.cache.lock().expect("gcal cache poisoned");
        *cache = outcome.cache;
        next_poll_secs(&cache, now)
    };

    let _ = super::set_setting(app, "gcal_last_sync", &now.to_rfc3339());
    let _ = app.emit(
        events::SYNC,
        serde_json::json!({
            "events": fetched.len(),
            "actions": outcome.actions.len(),
            "next_poll_secs": next_secs,
        }),
    );
    Some(next_secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    fn event(id: &str, start: DateTime<Utc>, end: DateTime<Utc>) -> CalendarEvent {
        CalendarEvent {
            id: id.into(),
            calendar_id: "primary".into(),
            title: format!("Event {id}"),
            start,
            end,
            location: None,
            status: "confirmed".into(),
            all_day: false,
        }
    }

    fn cached(id: &str, start: DateTime<Utc>, now: DateTime<Utc>) -> CachedEvent {
        CachedEvent {
            id: id.into(),
            calendar_id: "primary".into(),
            title: format!("Event {id}"),
            location: None,
            status: "confirmed".into(),
            start,
            end: start + Duration::from_secs(3600),
            all_day: false,
            remind_at: None,
            label_minutes: None,
            state: ReminderState::Scheduled,
            last_updated: now,
        }
    }

    fn empty() -> HashMap<String, CachedEvent> {
        HashMap::new()
    }

    #[test]
    fn new_event_schedules_one_reminder() {
        // 10:00 meeting, now 09:00, 15-min lead → 09:45.
        let now = utc(2026, 10, 4, 9, 0);
        let out = diff_events(
            &empty(),
            &[event("a", utc(2026, 10, 4, 10, 0), utc(2026, 10, 4, 11, 0))],
            now,
            15,
            false,
        );
        assert_eq!(out.actions.len(), 1);
        match &out.actions[0] {
            SyncAction::Schedule { event, is_nudge } => {
                assert_eq!(event.remind_at, Some(utc(2026, 10, 4, 9, 45)));
                assert_eq!(event.label_minutes, Some(15));
                assert_eq!(event.state, ReminderState::Scheduled);
                assert!(!is_nudge);
            }
            _ => panic!("expected Schedule"),
        }
        assert_eq!(out.cache.len(), 1);
    }

    #[test]
    fn repeat_sync_of_unchanged_event_is_a_noop() {
        let now = utc(2026, 10, 4, 9, 0);
        let fetched = vec![event("a", utc(2026, 10, 4, 10, 0), utc(2026, 10, 4, 11, 0))];
        let first = diff_events(&empty(), &fetched, now, 15, false);
        // Second sync five minutes later, same event: no actions.
        let second = diff_events(&first.cache, &fetched, utc(2026, 10, 4, 9, 5), 15, false);
        assert!(second.actions.is_empty());
        assert_eq!(second.cache.len(), 1);
    }

    #[test]
    fn rescheduled_event_updates_in_place() {
        let now = utc(2026, 10, 4, 9, 0);
        let first = diff_events(
            &empty(),
            &[event("a", utc(2026, 10, 4, 10, 0), utc(2026, 10, 4, 11, 0))],
            now,
            15,
            false,
        );
        // Moved to 11:00 → new remind_at, still exactly one action.
        let second = diff_events(
            &first.cache,
            &[event("a", utc(2026, 10, 4, 11, 0), utc(2026, 10, 4, 12, 0))],
            now,
            15,
            false,
        );
        assert_eq!(second.actions.len(), 1);
        match &second.actions[0] {
            SyncAction::Schedule { event, .. } => {
                assert_eq!(event.remind_at, Some(utc(2026, 10, 4, 10, 45)));
            }
            _ => panic!("expected Schedule"),
        }
    }

    #[test]
    fn cancelled_event_loses_its_reminder() {
        let now = utc(2026, 10, 4, 9, 0);
        let first = diff_events(
            &empty(),
            &[event("a", utc(2026, 10, 4, 10, 0), utc(2026, 10, 4, 11, 0))],
            now,
            15,
            false,
        );
        // Event gone from the window (cancelled/deleted).
        let second = diff_events(&first.cache, &[], now, 15, false);
        assert_eq!(second.actions.len(), 1);
        assert!(matches!(&second.actions[0], SyncAction::Unschedule { id } if id == "a"));
        assert!(second.cache.is_empty());
    }

    #[test]
    fn ended_event_is_dropped() {
        let now = utc(2026, 10, 4, 12, 0);
        let first = diff_events(
            &empty(),
            &[event("a", utc(2026, 10, 4, 10, 0), utc(2026, 10, 4, 11, 0))],
            utc(2026, 10, 4, 9, 0),
            15,
            false,
        );
        let second = diff_events(&first.cache, &[event(
            "a",
            utc(2026, 10, 4, 10, 0),
            utc(2026, 10, 4, 11, 0),
        )], now, 15, false);
        assert_eq!(second.actions.len(), 1);
        assert!(second.cache.is_empty());
    }

    #[test]
    fn late_added_event_gets_one_nudge_not_repeated() {
        // Event starts in 10 min, lead is 15 → heads-up a minute from now.
        let now = utc(2026, 10, 4, 9, 50);
        let fetched = vec![event("a", utc(2026, 10, 4, 10, 0), utc(2026, 10, 4, 11, 0))];
        let first = diff_events(&empty(), &fetched, now, 15, false);
        match &first.actions[0] {
            SyncAction::Schedule { event, is_nudge } => {
                assert_eq!(event.remind_at, Some(now + Duration::from_secs(60)));
                assert_eq!(event.label_minutes, Some(10));
                assert!(is_nudge);
            }
            _ => panic!("expected Schedule"),
        }
        // Next sync: no second nudge.
        let second = diff_events(&first.cache, &fetched, utc(2026, 10, 4, 9, 52), 15, false);
        assert!(second.actions.is_empty());
    }

    #[test]
    fn all_day_suppressed_by_default() {
        let now = utc(2026, 10, 4, 9, 0);
        let mut e = event("h", utc(2026, 10, 4, 0, 0), utc(2026, 10, 5, 0, 0));
        e.all_day = true;
        let out = diff_events(&empty(), &[e], now, 15, false);
        assert!(out.actions.is_empty());
        assert_eq!(out.cache["h"].state, ReminderState::Suppressed);
    }

    #[test]
    fn adaptive_intervals_follow_nearest_event() {
        let now = utc(2026, 10, 4, 9, 0);
        assert_eq!(next_poll_secs(&empty(), now), POLL_IDLE_SECS);
        let mk = |start: DateTime<Utc>| {
            let mut m = HashMap::new();
            m.insert("a".to_string(), cached("a", start, now));
            m
        };
        assert_eq!(
            next_poll_secs(&mk(utc(2026, 10, 4, 12, 0)), now),
            POLL_FAR_SECS
        );
        assert_eq!(
            next_poll_secs(&mk(utc(2026, 10, 4, 9, 30)), now),
            POLL_NEAR_SECS
        );
        assert_eq!(
            next_poll_secs(&mk(utc(2026, 10, 4, 9, 10)), now),
            POLL_SOON_SECS
        );
    }

    #[test]
    fn reminder_id_is_stable_and_safe() {
        assert_eq!(sanitize_id("abcXYZ-123_"), "abcXYZ-123_");
        assert_eq!(sanitize_id("a b/c"), "a-b-c");
    }

    #[test]
    fn cache_carries_calendar_fields() {
        // location/status/calendar_id ride along from the API shape.
        let now = utc(2026, 10, 4, 9, 0);
        let mut e = event("a", utc(2026, 10, 4, 10, 0), utc(2026, 10, 4, 11, 0));
        e.location = Some("Room 4".into());
        e.status = "tentative".into();
        let out = diff_events(&empty(), &[e], now, 15, false);
        let entry = &out.cache["a"];
        assert_eq!(entry.calendar_id, "primary");
        assert_eq!(entry.location.as_deref(), Some("Room 4"));
        assert_eq!(entry.status, "tentative");
        // …but a location-only edit doesn't rewrite the reminder row.
        let mut e2 = event("a", utc(2026, 10, 4, 10, 0), utc(2026, 10, 4, 11, 0));
        e2.location = Some("Room 5".into());
        e2.status = "tentative".into();
        let second = diff_events(&out.cache, &[e2], utc(2026, 10, 4, 9, 5), 15, false);
        assert!(second.actions.is_empty());
        assert_eq!(second.cache["a"].location.as_deref(), Some("Room 5"));
    }

    #[test]
    fn calendar_reminder_row_shape() {
        let e = cached("evt1", utc(2026, 10, 4, 10, 0), utc(2026, 10, 4, 9, 0));
        let e = CachedEvent {
            title: "Team Meeting".into(),
            remind_at: Some(utc(2026, 10, 4, 9, 45)),
            label_minutes: Some(15),
            ..e
        };
        let r = calendar_reminder(&e);
        assert_eq!(r.id, "gcal-evt1");
        assert_eq!(r.kind, "calendar");
        assert!(r.message.contains("Team Meeting starts in 15 minutes"));
        assert!(r.message.contains("Google Calendar"));
        assert!(r.schedule.contains("2026-10-04T09:45:00"));
    }
}
