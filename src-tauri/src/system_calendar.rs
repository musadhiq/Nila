//! System calendar integration (Linux: evolution-data-server via D-Bus).
//!
//! Reads events from the desktop's system calendar — GNOME Calendar,
//! Evolution, and anything synced via GNOME Online Accounts — and turns
//! them into Nila reminders. No network, no accounts, no OAuth: EDS is
//! local and the D-Bus API needs no credentials.
//!
//! Design:
//! - Settings → Reminders → "Integrate with system calendar" toggle.
//! - When enabled, a poll task fetches events for [now, now+24h] from
//!   every enabled EDS calendar source, every 30 minutes.
//! - Events become one-time reminders (kind `"system_calendar"`,
//!   id `syscal-{uid}`), firing 15 minutes before the event.
//! - The sync diffs: new events create reminders, changed events update
//!   them, vanished events delete them. Disabling the toggle removes
//!   all system-calendar reminders.
//!
//! If EDS isn't running or has no calendars, the toggle stays on but
//! syncs nothing (logged, not an error).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------------------
// D-Bus: evolution-data-server
// ---------------------------------------------------------------------------

const EDS_SOURCES_BUS: &str = "org.gnome.evolution.dataserver.Sources5";
const EDS_SOURCES_PATH: &str = "/org/gnome/evolution/dataserver/SourceManager";
const EDS_CALENDAR_BUS: &str = "org.gnome.evolution.dataserver.Calendar8";
const EDS_CALENDAR_FACTORY_PATH: &str = "/org/gnome/evolution/dataserver/CalendarFactory";

/// A calendar source from EDS.
#[derive(Debug, Clone)]
pub struct CalendarSource {
    pub uid: String,
    pub display_name: String,
}

/// List calendar sources via the EDS SourceManager.
/// Returns an empty vec if EDS isn't reachable (not an error — the
/// machine may simply not use EDS).
pub fn list_sources() -> Vec<CalendarSource> {
    let Ok(conn) = zbus::blocking::Connection::session() else {
        eprintln!("nila: syscal: no session bus");
        return Vec::new();
    };
    let proxy = match zbus::blocking::Proxy::new(
        &conn,
        EDS_SOURCES_BUS,
        EDS_SOURCES_PATH,
        "org.freedesktop.DBus.ObjectManager",
    ) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("nila: syscal: EDS source manager unavailable: {e}");
            return Vec::new();
        }
    };
    // GetManagedObjects → { object_path → { interface → { prop → value } } }
    let objects: HashMap<
        zbus::zvariant::OwnedObjectPath,
        HashMap<String, HashMap<String, zbus::zvariant::OwnedValue>>,
    > = match proxy.call("GetManagedObjects", &()) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("nila: syscal: GetManagedObjects failed: {e}");
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for (_path, ifaces) in objects {
        // A calendar source has the Calendar extension interface.
        let Some(data) = ifaces.get("org.gnome.evolution.dataserver.Source") else {
            continue;
        };
        let has_calendar = ifaces.keys().any(|k| k.contains("Calendar"));
        if !has_calendar {
            continue;
        }
        let get_str = |key: &str| -> String {
            data.get(key)
                .and_then(|v| String::try_from(v.clone()).ok())
                .unwrap_or_default()
        };
        let uid = get_str("UID");
        let display_name = {
            let n = get_str("DisplayName");
            if n.is_empty() { uid.clone() } else { n }
        };
        let enabled = data
            .get("Enabled")
            .and_then(|v| bool::try_from(v.clone()).ok())
            .unwrap_or(true);
        if uid.is_empty() || !enabled {
            continue;
        }
        out.push(CalendarSource { uid, display_name });
    }
    out
}

/// Fetch raw ICS for one calendar source in [start, end].
/// Returns None on any failure (logged).
fn fetch_source_ics(
    conn: &zbus::blocking::Connection,
    source_uid: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Option<String> {
    // OpenCalendar(source_uid) → (object_path, bus_name)
    let factory = zbus::blocking::Proxy::new(
        conn,
        EDS_CALENDAR_BUS,
        EDS_CALENDAR_FACTORY_PATH,
        "org.gnome.evolution.dataserver.CalendarFactory",
    )
    .ok()?;
    let (obj_path, _bus_name): (zbus::zvariant::OwnedObjectPath, String) = factory
        .call("OpenCalendar", &source_uid)
        .map_err(|e| {
            eprintln!("nila: syscal: OpenCalendar({source_uid}) failed: {e}");
        })
        .ok()?;
    let cal = zbus::blocking::Proxy::new(
        conn,
        EDS_CALENDAR_BUS,
        obj_path,
        "org.gnome.evolution.dataserver.Calendar",
    )
    .ok()?;
    // Open the calendar for reading.
    let _: () = cal.call("Open", &()).map_err(|e| {
        eprintln!("nila: syscal: Calendar.Open failed: {e}");
    }).ok()?;
    // EDS S-expression: events occurring in the time range.
    // Times are UTC in basic ISO format.
    let fmt = |dt: DateTime<Utc>| dt.format("%Y%m%dT%H%M%SZ").to_string();
    let query = format!(
        "(occur-in-time-range? (make-time \"{}\") (make-time \"{}\"))",
        fmt(start),
        fmt(end)
    );
    let ics: String = cal
        .call("GetObjectList", &query)
        .map_err(|e| {
            eprintln!("nila: syscal: GetObjectList failed: {e}");
        })
        .ok()?;
    Some(ics)
}

// ---------------------------------------------------------------------------
// ICS parsing (VEVENT subset + RRULE expansion for the sync window)
// ---------------------------------------------------------------------------

// [ICS parser extracted from the former Google Calendar connector —
//  VEVENT unfold/parse, TZID, all-day, RRULE/EXDATE/RECURRENCE-ID.]

/// One content line: `NAME;PARAM=VAL:content`.
struct Prop {
    name: String,
    params: HashMap<String, String>,
    value: String,
}

fn parse_prop(line: &str) -> Option<Prop> {
    let (head, value) = line.split_once(':')?;
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_uppercase();
    if name.is_empty() {
        return None;
    }
    let mut params = HashMap::new();
    for p in parts {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        params.insert(k.trim().to_uppercase(), v.trim().to_string());
    }
    Some(Prop {
        name,
        params,
        value: value.to_string(),
    })
}

/// Unfold continuation lines per RFC 5545 §3.1.
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(prev) = out.last_mut() {
                prev.push_str(line[1..].trim_start_matches([' ', '\t']));
            }
        } else {
            out.push(line.to_string());
        }
    }
    out
}

#[derive(Debug, Clone)]
enum EventTime {
    Instant(DateTime<Utc>),
    Date(chrono::NaiveDate),
}

impl EventTime {
    fn to_utc(&self) -> DateTime<Utc> {
        match self {
            EventTime::Instant(dt) => *dt,
            EventTime::Date(d) => d
                .and_hms_opt(0, 0, 0)
                .map(|n| DateTime::<Utc>::from_naive_utc_and_offset(n, Utc))
                .unwrap_or_else(Utc::now),
        }
    }
}

fn parse_datetime(value: &str, params: &HashMap<String, String>) -> Option<EventTime> {
    use chrono::{NaiveDate, NaiveDateTime, TimeZone};
    let v = value.trim();
    if params.get("VALUE").map(|s| s.as_str()) == Some("DATE") {
        let d = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        return Some(EventTime::Date(d));
    }
    if v.len() == 8 && v.chars().all(|c| c.is_ascii_digit()) {
        let d = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        return Some(EventTime::Date(d));
    }
    if let Some(stripped) = v.strip_suffix('Z') {
        let ndt = NaiveDateTime::parse_from_str(stripped, "%Y%m%dT%H%M%S").ok()?;
        return Some(EventTime::Instant(
            DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc),
        ));
    }
    let ndt = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    if let Some(tzid) = params.get("TZID") {
        if let Ok(tz) = tzid.parse::<chrono_tz::Tz>() {
            if let Some(dt) = tz.from_local_datetime(&ndt).single() {
                return Some(EventTime::Instant(dt.with_timezone(&Utc)));
            }
        }
    }
    Some(EventTime::Instant(
        DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc),
    ))
}

fn parse_duration(value: &str) -> Option<chrono::Duration> {
    let v = value.trim().strip_prefix('P')?;
    let (date_part, time_part) = match v.split_once('T') {
        Some((d, t)) => (d, t),
        None => (v, ""),
    };
    let mut secs: i64 = 0;
    let mut num = String::new();
    let mut in_time = false;
    for c in format!("{date_part}T{time_part}").chars() {
        if c == 'T' {
            in_time = true;
            continue;
        }
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let n: i64 = num.parse().ok()?;
        num.clear();
        secs += match (in_time, c) {
            (false, 'W') => n * 7 * 86400,
            (false, 'D') => n * 86400,
            (true, 'H') => n * 3600,
            (true, 'M') => n * 60,
            (true, 'S') => n,
            _ => return None,
        };
    }
    if !num.is_empty() {
        return None;
    }
    Some(chrono::Duration::seconds(secs))
}

fn unescape_text(s: &str) -> String {
    s.replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

fn collect_vevents(lines: &[String]) -> Vec<Vec<Prop>> {
    let mut events = Vec::new();
    let mut current: Option<Vec<Prop>> = None;
    let mut depth: u32 = 0;
    for line in lines {
        let Some(prop) = parse_prop(line) else { continue };
        match prop.name.as_str() {
            "BEGIN" if prop.value.eq_ignore_ascii_case("VEVENT") => {
                depth += 1;
                if depth == 1 {
                    current = Some(Vec::new());
                }
            }
            "END" if prop.value.eq_ignore_ascii_case("VEVENT") => {
                if depth == 1 {
                    if let Some(ev) = current.take() {
                        events.push(ev);
                    }
                }
                depth = depth.saturating_sub(1);
            }
            _ => {
                if depth == 1 {
                    if let Some(ev) = current.as_mut() {
                        ev.push(prop);
                    }
                }
            }
        }
    }
    events
}

#[derive(Debug, Clone, Default)]
struct RawEvent {
    uid: String,
    summary: String,
    location: Option<String>,
    status: String,
    dtstart: Option<EventTime>,
    dtend: Option<EventTime>,
    duration: Option<chrono::Duration>,
    rrule: Option<String>,
    exdates: Vec<DateTime<Utc>>,
    recurrence_id: Option<DateTime<Utc>>,
    all_day: bool,
}

fn raw_event(props: &[Prop]) -> Option<RawEvent> {
    let mut raw = RawEvent::default();
    for p in props {
        match p.name.as_str() {
            "UID" => raw.uid = p.value.trim().to_string(),
            "SUMMARY" => raw.summary = unescape_text(p.value.trim()),
            "LOCATION" => {
                let loc = unescape_text(p.value.trim());
                if !loc.is_empty() {
                    raw.location = Some(loc);
                }
            }
            "STATUS" => raw.status = p.value.trim().to_uppercase(),
            "DTSTART" => {
                if let Some(t) = parse_datetime(&p.value, &p.params) {
                    raw.all_day = matches!(t, EventTime::Date(_));
                    raw.dtstart = Some(t);
                }
            }
            "DTEND" => {
                if let Some(t) = parse_datetime(&p.value, &p.params) {
                    raw.dtend = Some(t);
                }
            }
            "DURATION" => raw.duration = parse_duration(&p.value),
            "RRULE" => raw.rrule = Some(p.value.trim().to_string()),
            "EXDATE" => {
                for part in p.value.split(',') {
                    if let Some(t) = parse_datetime(part.trim(), &p.params) {
                        raw.exdates.push(t.to_utc());
                    }
                }
            }
            "RECURRENCE-ID" => {
                if let Some(t) = parse_datetime(&p.value, &p.params) {
                    raw.recurrence_id = Some(t.to_utc());
                }
            }
            _ => {}
        }
    }
    if raw.uid.is_empty() || raw.uid.len() > 512 {
        return None;
    }
    if raw.status == "CANCELLED" {
        return None;
    }
    if raw.dtstart.is_none() {
        return None;
    }
    Some(raw)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone)]
struct ParsedRRule {
    freq: Freq,
    interval: i64,
    count: Option<i64>,
    until: Option<DateTime<Utc>>,
    byday: Vec<chrono::Weekday>,
}

fn parse_rrule(value: &str) -> Option<ParsedRRule> {
    use chrono::{NaiveDateTime, Weekday};
    let mut freq = None;
    let mut interval = 1i64;
    let mut count = None;
    let mut until = None;
    let mut byday = Vec::new();
    for part in value.split(';') {
        let (k, v) = part.split_once('=')?;
        match k.trim().to_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match v.trim().to_uppercase().as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                });
            }
            "INTERVAL" => interval = v.trim().parse::<i64>().ok()?.max(1),
            "COUNT" => count = Some(v.trim().parse::<i64>().ok()?.max(1)),
            "UNTIL" => {
                let ndt = NaiveDateTime::parse_from_str(
                    v.trim().strip_suffix('Z').unwrap_or(v.trim()),
                    "%Y%m%dT%H%M%S",
                )
                .ok()?;
                until = Some(DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc));
            }
            "BYDAY" => {
                for d in v.split(',') {
                    let day = d.trim().trim_start_matches(['+', '-'])
                        .trim_start_matches(|c: char| c.is_ascii_digit());
                    let wd = match day {
                        "MO" => Some(Weekday::Mon),
                        "TU" => Some(Weekday::Tue),
                        "WE" => Some(Weekday::Wed),
                        "TH" => Some(Weekday::Thu),
                        "FR" => Some(Weekday::Fri),
                        "SA" => Some(Weekday::Sat),
                        "SU" => Some(Weekday::Sun),
                        _ => None,
                    };
                    if let Some(w) = wd {
                        if !byday.contains(&w) {
                            byday.push(w);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Some(ParsedRRule {
        freq: freq?,
        interval,
        count,
        until,
        byday,
    })
}

fn days_in_month(year: i32, month: u32) -> u32 {
    use chrono::NaiveDate;
    let (y, m) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(y, m, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

fn expand_rrule(
    dtstart: DateTime<Utc>,
    duration: chrono::Duration,
    rule: &ParsedRRule,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    use chrono::{Datelike, NaiveDate};
    let mut out = Vec::new();
    let mut seen: i64 = 0;
    let mut candidates: Vec<NaiveDate> = Vec::new();
    let start_date = dtstart.date_naive();
    match rule.freq {
        Freq::Daily => {
            let mut d = start_date;
            for _ in 0..400 {
                candidates.push(d);
                d = d.succ_opt().unwrap_or(d);
            }
        }
        Freq::Weekly => {
            let days = if rule.byday.is_empty() {
                vec![dtstart.weekday()]
            } else {
                rule.byday.clone()
            };
            let back = start_date.weekday().num_days_from_monday() as i64;
            let week_start = start_date - chrono::Duration::days(back);
            for w in 0..60 {
                let base = week_start + chrono::Duration::days(w * 7 * rule.interval);
                for wd in &days {
                    let d = base + chrono::Duration::days(wd.num_days_from_monday() as i64);
                    if d >= start_date {
                        candidates.push(d);
                    }
                }
            }
        }
        Freq::Monthly => {
            let mut y = start_date.year();
            let mut m = start_date.month() as i64;
            for _ in 0..36 {
                let mu = m as u32;
                let day = start_date.day().min(days_in_month(y, mu));
                if let Some(d) = NaiveDate::from_ymd_opt(y, mu, day) {
                    if d >= start_date {
                        candidates.push(d);
                    }
                }
                m += rule.interval;
                while m > 12 {
                    m -= 12;
                    y += 1;
                }
            }
        }
        Freq::Yearly => {
            for n in 0..5i64 {
                let y = start_date.year() + (n * rule.interval) as i32;
                let day = start_date.day().min(days_in_month(y, start_date.month()));
                if let Some(d) = NaiveDate::from_ymd_opt(y, start_date.month(), day) {
                    candidates.push(d);
                }
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    for date in candidates {
        if seen >= 500 {
            break;
        }
        let inst_start = date.and_time(dtstart.time()).and_utc();
        if inst_start < dtstart {
            continue;
        }
        if let Some(until) = rule.until {
            if inst_start > until {
                break;
            }
        }
        seen += 1;
        if let Some(count) = rule.count {
            if seen > count {
                break;
            }
        }
        let inst_end = inst_start + duration;
        if inst_end >= window_start && inst_start <= window_end {
            out.push((inst_start, inst_end));
        }
        if inst_start > window_end && out.len() > 32 {
            break;
        }
    }
    out
}

/// A system-calendar event ready for reminder sync.
#[derive(Debug, Clone)]
pub struct SysCalEvent {
    pub id: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub location: Option<String>,
    pub calendar_name: String,
    pub all_day: bool,
}

/// Parse ICS text into events overlapping the window.
pub fn parse_ics(
    text: &str,
    calendar_name: &str,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Vec<SysCalEvent> {
    let lines = unfold(text);
    let mut by_uid: HashMap<String, Vec<RawEvent>> = HashMap::new();
    for props in collect_vevents(&lines) {
        if let Some(raw) = raw_event(&props) {
            by_uid.entry(raw.uid.clone()).or_default().push(raw);
        }
    }
    let mut out = Vec::new();
    for (uid, raws) in &by_uid {
        let (base, overrides): (Vec<&RawEvent>, Vec<&RawEvent>) =
            raws.iter().partition(|r| r.recurrence_id.is_none());
        let Some(base) = base.first() else { continue };
        let Some(start) = base.dtstart.as_ref().map(|t| t.to_utc()) else {
            continue
        };
        let end = base
            .dtend
            .as_ref()
            .map(|t| t.to_utc())
            .or_else(|| base.duration.map(|d| start + d))
            .unwrap_or(start);
        if end <= start {
            continue;
        }
        let duration = end - start;
        let title = if base.summary.trim().is_empty() {
            "(no title)".to_string()
        } else {
            base.summary.clone()
        };
        let mut instances: Vec<(DateTime<Utc>, DateTime<Utc>)> = Vec::new();
        if let Some(rule_text) = &base.rrule {
            if let Some(rule) = parse_rrule(rule_text) {
                let ex: HashSet<DateTime<Utc>> = base.exdates.iter().cloned().collect();
                for (s, e) in expand_rrule(start, duration, &rule, window_start, window_end) {
                    if !ex.contains(&s) {
                        instances.push((s, e));
                    }
                }
            } else {
                instances.push((start, end));
            }
        } else if start <= window_end && end >= window_start {
            instances.push((start, end));
        }
        let mut overridden: HashSet<DateTime<Utc>> = HashSet::new();
        for ov in overrides {
            if let Some(rid) = ov.recurrence_id {
                overridden.insert(rid);
                let o_start = ov.dtstart.as_ref().map(|t| t.to_utc()).unwrap_or(rid);
                let o_end = ov
                    .dtend
                    .as_ref()
                    .map(|t| t.to_utc())
                    .or_else(|| ov.duration.map(|d| o_start + d))
                    .unwrap_or(o_start + duration);
                if o_end > o_start && o_start <= window_end && o_end >= window_start {
                    let o_title = if ov.summary.trim().is_empty() {
                        title.clone()
                    } else {
                        ov.summary.clone()
                    };
                    out.push(SysCalEvent {
                        id: format!("syscal-{uid}@{}", o_start.to_rfc3339()),
                        title: o_title,
                        start: o_start,
                        end: o_end,
                        location: ov.location.clone().or_else(|| base.location.clone()),
                        calendar_name: calendar_name.to_string(),
                        all_day: base.all_day,
                    });
                }
            }
        }
        for (s, e) in instances {
            if overridden.contains(&s) {
                continue;
            }
            let id = if base.rrule.is_some() {
                format!("syscal-{uid}@{}", s.to_rfc3339())
            } else {
                format!("syscal-{uid}")
            };
            out.push(SysCalEvent {
                id,
                title: title.clone(),
                start: s,
                end: e,
                location: base.location.clone(),
                calendar_name: calendar_name.to_string(),
                all_day: base.all_day,
            });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

/// Minutes before an event the reminder fires.
const REMIND_MINUTES: i64 = 15;
/// How far ahead to look for events.
const WINDOW_HOURS: i64 = 24;
/// Poll cadence while enabled.
const POLL_SECS: u64 = 30 * 60;

pub struct SysCalState {
    notify: Arc<tokio::sync::Notify>,
    generation: AtomicU64,
    last_error: Mutex<Option<String>>,
    last_sync: Mutex<Option<String>>,
}

impl SysCalState {
    pub fn new() -> Self {
        SysCalState {
            notify: Arc::new(tokio::sync::Notify::new()),
            generation: AtomicU64::new(0),
            last_error: Mutex::new(None),
            last_sync: Mutex::new(None),
        }
    }
    fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

impl Default for SysCalState {
    fn default() -> Self {
        Self::new()
    }
}

fn get_setting(app: &AppHandle, key: &str) -> Option<String> {
    let state = app.try_state::<crate::db::DbState>()?;
    let conn = state.0.lock().ok()?;
    crate::db::get_setting(&conn, key).ok().flatten()
}

fn set_setting(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let state = app
        .try_state::<crate::db::DbState>()
        .ok_or("settings unavailable".to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::db::set_setting(&conn, key, value).map_err(|e| e.to_string())
}

pub fn is_enabled(app: &AppHandle) -> bool {
    get_setting(app, "syscal_enabled")
        .map(|v| v == "true")
        .unwrap_or(false)
}

/// Fetch events from all EDS calendars. Blocking; call off the async runtime.
fn fetch_all_events() -> Vec<SysCalEvent> {
    let sources = list_sources();
    if sources.is_empty() {
        return Vec::new();
    }
    let Ok(conn) = zbus::blocking::Connection::session() else {
        return Vec::new();
    };
    let now = Utc::now();
    let window_end = now + chrono::Duration::hours(WINDOW_HOURS);
    let mut out = Vec::new();
    for src in sources {
        if let Some(ics) = fetch_source_ics(&conn, &src.uid, now, window_end) {
            out.extend(parse_ics(&ics, &src.display_name, now, window_end));
        }
    }
    out
}

/// One sync pass: diff EDS events against `system_calendar` reminders.
fn sync_once(app: &AppHandle) {
    let events = fetch_all_events();
    let now = Utc::now();
    let db_state = match app.try_state::<crate::db::DbState>() {
        Some(s) => s,
        None => return,
    };
    let conn = match db_state.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    // Current system_calendar reminder ids.
    let existing: HashSet<String> = crate::db::list_reminders(&conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.kind == "system_calendar")
        .map(|r| r.id)
        .collect();
    let mut seen = HashSet::new();
    let mut changed = false;
    for ev in &events {
        // Skip all-day events (no specific time to remind about) and
        // events whose reminder time already passed.
        if ev.all_day || ev.end <= now {
            continue;
        }
        let remind_at = ev.start - chrono::Duration::minutes(REMIND_MINUTES);
        if remind_at <= now {
            continue;
        }
        seen.insert(ev.id.clone());
        let message = match &ev.location {
            Some(loc) => format!("{} · {}", ev.calendar_name, loc),
            None => ev.calendar_name.clone(),
        };
        let schedule = serde_json::json!({
            "type": "once",
            "at": remind_at.to_rfc3339(),
        })
        .to_string();
        let reminder = crate::db::Reminder {
            id: ev.id.clone(),
            title: ev.title.chars().take(80).collect(),
            message,
            kind: "system_calendar".to_string(),
            schedule,
            enabled: true,
        };
        // Upsert: creates new rows, updates changed events in place.
        if crate::db::upsert_reminder(&conn, &reminder).is_ok() {
            changed = true;
        }
    }
    // Delete reminders for events that vanished.
    for id in existing.difference(&seen) {
        let _ = crate::db::delete_reminder(&conn, id);
        changed = true;
    }
    drop(conn);
    let stamp = Utc::now().to_rfc3339();
    let _ = set_setting(app, "syscal_last_sync", &stamp);
    if let Some(state) = app.try_state::<SysCalState>() {
        *state.last_sync.lock().expect("syscal poisoned") = Some(stamp);
        state
            .last_error
            .lock()
            .expect("syscal poisoned")
            .take();
    }
    if changed {
        crate::scheduler::notify_data_changed(app);
    }
    eprintln!("nila: syscal: sync: {} event(s)", events.len());
}

/// Start the poll task (idempotent: retires any previous task).
pub fn spawn_poll(app: AppHandle) {
    let Some(state) = app.try_state::<SysCalState>() else {
        return;
    };
    let generation = state.bump_generation();
    let notify = state.notify.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let current = app
                .try_state::<SysCalState>()
                .map(|s| s.generation())
                .unwrap_or(u64::MAX);
            if current != generation {
                break;
            }
            let app_clone = app.clone();
            // D-Bus + SQLite are blocking: keep them off the runtime.
            let _ = tokio::task::spawn_blocking(move || sync_once(&app_clone)).await;
            let current = app
                .try_state::<SysCalState>()
                .map(|s| s.generation())
                .unwrap_or(u64::MAX);
            if current != generation {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(POLL_SECS)) => {}
                _ = notify.notified() => {}
            }
        }
    });
}

pub fn request_stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<SysCalState>() {
        state.bump_generation();
        state.notify.notify_one();
    }
}

/// Startup: resume polling if the toggle is on.
pub fn maybe_start(app: &AppHandle) {
    if is_enabled(app) {
        spawn_poll(app.clone());
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct SysCalStatus {
    pub enabled: bool,
    pub calendar_count: usize,
    pub last_sync: Option<String>,
    pub last_error: Option<String>,
}

#[tauri::command]
pub fn syscal_get_status(app: AppHandle) -> Result<SysCalStatus, String> {
    let state = app
        .try_state::<SysCalState>()
        .ok_or("system calendar unavailable".to_string())?;
    // Counting calendars touches D-Bus; do it off the hot path only
    // when enabled.
    let enabled = is_enabled(&app);
    let calendar_count = if enabled { list_sources().len() } else { 0 };
    Ok(SysCalStatus {
        enabled,
        calendar_count,
        last_sync: state.last_sync.lock().map_err(|e| e.to_string())?.clone(),
        last_error: state.last_error.lock().map_err(|e| e.to_string())?.clone(),
    })
}

#[tauri::command]
pub fn syscal_set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_setting(&app, "syscal_enabled", if enabled { "true" } else { "false" })?;
    if enabled {
        spawn_poll(app.clone());
        if let Some(state) = app.try_state::<SysCalState>() {
            state.notify();
        }
    } else {
        request_stop(&app);
        // Remove all system-calendar reminders; the toggle owns them.
        if let Some(db_state) = app.try_state::<crate::db::DbState>() {
            if let Ok(conn) = db_state.0.lock() {
                let _ = crate::db::delete_reminders_by_kind(&conn, "system_calendar");
                drop(conn);
                crate::scheduler::notify_data_changed(&app);
            }
        }
    }
    let _ = app.emit("syscal:status", syscal_get_status(app.clone()).ok());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap()
    }

    const SAMPLE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:evt-1\r\nDTSTART:20261004T100000Z\r\nDTEND:20261004T110000Z\r\nSUMMARY:Team standup\r\nLOCATION:Room 3\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:evt-2\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T093000Z\r\nSUMMARY:Daily sync\r\nRRULE:FREQ=DAILY;COUNT=10\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn parses_and_expands() {
        let events = parse_ics(&SAMPLE, "Personal", utc(2026, 10, 4, 0, 0), utc(2026, 10, 4, 23, 59));
        assert_eq!(events.len(), 2);
        let single = events.iter().find(|e| e.id == "syscal-evt-1").unwrap();
        assert_eq!(single.title, "Team standup");
        assert_eq!(single.calendar_name, "Personal");
        let daily = events.iter().find(|e| e.id.starts_with("syscal-evt-2@")).unwrap();
        assert_eq!(daily.start, utc(2026, 10, 4, 9, 0));
    }

    #[test]
    fn cancelled_is_dropped() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:c1\r\nDTSTART:20261004T100000Z\r\nDTEND:20261004T110000Z\r\nSUMMARY:X\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_ics(&ics, "P", utc(2026, 10, 4, 0, 0), utc(2026, 10, 4, 23, 59));
        assert!(events.is_empty());
    }
}
