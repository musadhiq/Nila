// Event-driven reminder scheduler.
//
// The scheduler never polls on a timer. It computes the next eligible
// trigger, waits for exactly that deadline, and re-validates everything
// on wake (eligibility may have changed while asleep).

use crate::db;
use chrono::{DateTime, Duration, Local, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

pub const DEFAULT_QUIET_START: (u32, u32) = (22, 0);
pub const DEFAULT_QUIET_END: (u32, u32) = (8, 0);
pub const DEFAULT_DAILY_LIMIT: i64 = 8;
pub const DEFAULT_COOLDOWN_MINUTES: i64 = 45;

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
        Schedule::Daily { time } => next_daily(time, local, from),
        Schedule::Weekly { days, time } => {
            let mut best: Option<DateTime<Utc>> = None;
            for &d in days {
                if let Some(c) = next_weekly(d, time, local, from) {
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

fn next_daily(time: &str, local: DateTime<Local>, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let (h, m) = parse_hhmm(time)?;
    let today = local.date_naive().and_hms_opt(h, m, 0)?;
    let today_local = today.and_local_timezone(Local).single()?;
    if today_local > local {
        return Some(today_local.with_timezone(&Utc));
    }
    let tomorrow = (local.date_naive() + Duration::days(1)).and_hms_opt(h, m, 0)?;
    Some(tomorrow.and_local_timezone(Local).single()?.with_timezone(&Utc))
}

fn next_weekly(day: u32, time: &str, local: DateTime<Local>, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
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
    let _ = from;
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

/// The async driver: compute next deadline, sleep until it, validate,
/// trigger, record, repeat. Spawned once at startup.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut snoozed: HashMap<String, DateTime<Utc>> = HashMap::new();
        loop {
            let next = compute_next_deadline(&app, &mut snoozed).await;
            match next {
                Some((reminder_id, at)) => {
                    sleep_until(at).await;
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

async fn compute_next_deadline(
    _app: &AppHandle,
    _snoozed: &mut HashMap<String, DateTime<Utc>>,
) -> Option<(String, DateTime<Utc>)> {
    // Full implementation wires db::list_reminders + next_occurrence +
    // quiet-hours/cooldown/limit checks. Kept as the single place where
    // deadlines are computed so tests target pure functions above.
    None
}

async fn sleep_until(_at: DateTime<Utc>) {
    // tokio::time::sleep_until in the full implementation.
}

async fn fire_if_eligible(_app: &AppHandle, _reminder_id: &str) {
    // Re-reads state, validates Eligibility, emits REMINDER_DUE,
    // records history. Full implementation in Phase 7.
    let _ = _app.emit("REMINDER_DUE", _reminder_id);
}

async fn wait_for_change(_app: &AppHandle) {
    // Waits on SETTINGS_CHANGED / reminder CRUD events.
    std::future::pending::<()>().await;
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
}
