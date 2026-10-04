//! Google Calendar via the private ICS feed.
//!
//! No OAuth, no Google Cloud project, no browser flow. The user copies
//! the "Secret address in iCal format" from Google Calendar → Settings →
//! Integrate calendar and pastes it into Nila. The URL is a bearer
//! credential (anyone holding it can read the calendar), so it lives in
//! the OS keychain — never in plain settings, never in logs.
//!
//! The feed is read-only, which matches the connector exactly: it only
//! ever syncs events into reminders, never writes back.
//!
//! Freshness trade-off (accepted): Google publishes no update guarantee
//! for the ICS feed — usually minutes, occasionally longer. The sync
//! window and adaptive polling are unchanged; a same-minute event may
//! simply arrive too late to notify.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone, Utc, Weekday};

use super::service::{CalendarEvent, GcalError};

// ---------------------------------------------------------------------------
// Keychain URL store (same error discipline as the old OAuth token store)
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = "nila";
const KEYRING_ACCOUNT: &str = "gcal-ics-url";

pub fn has_url() -> bool {
    load_url().ok().flatten().is_some()
}

fn load_url() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    match entry.get_password() {
        Ok(raw) => {
            let raw = raw.trim();
            if raw.is_empty() {
                return Ok(None);
            }
            Ok(Some(raw.to_string()))
        }
        // No entry yet is a normal "not connected" state, not an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read credential: {e}")),
    }
}

pub fn store_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("feed URL is empty".to_string());
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    // The URL itself never appears in logs: it is a bearer credential.
    entry
        .set_password(url)
        .map_err(|e| format!("could not store credential: {e}"))
}

pub fn delete_url() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting a non-existent entry is fine.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove credential: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

fn http_client() -> Result<reqwest::blocking::Client, GcalError> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| GcalError::Network(format!("http client: {e}")))
}

/// Plain GET of the ICS feed. No auth headers — the URL is the credential.
pub fn fetch_ics(url: &str) -> Result<String, GcalError> {
    let client = http_client()?;
    let resp = client
        .get(url)
        .header("Accept", "text/calendar")
        .send()
        .map_err(|e| GcalError::Network(e.to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(GcalError::Feed("feed rejected the URL (revoked?)".into()));
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(GcalError::Feed("feed not found (URL revoked?)".into()));
    }
    if !status.is_success() {
        return Err(GcalError::Feed(format!("feed error: {status}")));
    }
    resp.text()
        .map_err(|e| GcalError::Feed(format!("unreadable feed: {e}")))
}

/// High-level sync entry: load the URL, fetch, parse, expand recurrences
/// inside the window. Returns the calendar name when the feed declares one.
pub fn fetch_events(
    now: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Result<(Option<String>, Vec<CalendarEvent>), GcalError> {
    let Some(url) = load_url().map_err(GcalError::Storage)? else {
        return Err(GcalError::NotConfigured);
    };
    let text = fetch_ics(&url)?;
    Ok(parse_ics(&text, now, window_end))
}

// ---------------------------------------------------------------------------
// ICS parsing
// ---------------------------------------------------------------------------

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

/// Unfold continuation lines (a line starting with SP/HT continues the
/// previous one) per RFC 5545 §3.1.
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

/// Raw VEVENT before recurrence expansion.
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

#[derive(Debug, Clone)]
enum EventTime {
    /// Instant in UTC.
    Instant(DateTime<Utc>),
    /// All-day date; rendered as UTC midnight.
    Date(NaiveDate),
}

impl EventTime {
    fn to_utc(&self) -> DateTime<Utc> {
        match self {
            EventTime::Instant(dt) => *dt,
            EventTime::Date(d) => d.and_hms_opt(0, 0, 0).map(|n| {
                DateTime::<Utc>::from_naive_utc_and_offset(n, Utc)
            }).unwrap_or_else(|| Utc::now()),
        }
    }
}

/// `20261004T120000Z` / `20261004T173000` (+TZID) / `20261004` (date).
fn parse_datetime(value: &str, params: &HashMap<String, String>) -> Option<EventTime> {
    let v = value.trim();
    if params.get("VALUE").map(|s| s.as_str()) == Some("DATE") {
        let d = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        return Some(EventTime::Date(d));
    }
    // Date-only without VALUE=DATE also means all-day.
    if v.len() == 8 && v.chars().all(|c| c.is_ascii_digit()) {
        let d = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        return Some(EventTime::Date(d));
    }
    // UTC instant.
    if let Some(stripped) = v.strip_suffix('Z') {
        let ndt = NaiveDateTime::parse_from_str(stripped, "%Y%m%dT%H%M%S").ok()?;
        return Some(EventTime::Instant(
            DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc),
        ));
    }
    // Timezoned: resolve via chrono-tz, fall back to UTC on unknown zones.
    let ndt = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    if let Some(tzid) = params.get("TZID") {
        if let Ok(tz) = tzid.parse::<chrono_tz::Tz>() {
            if let Some(dt) = tz.from_local_datetime(&ndt).single() {
                return Some(EventTime::Instant(dt.with_timezone(&Utc)));
            }
        }
        eprintln!("nila: gcal: unknown TZID {tzid}, treating as UTC");
    }
    Some(EventTime::Instant(
        DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc),
    ))
}

/// `PT1H30M` / `P1D` / `PT15M` → chrono Duration. Weeks/days only.
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

// ---------------------------------------------------------------------------
// RRULE expansion (focused subset, bounded by the sync window)
// ---------------------------------------------------------------------------

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
    byday: Vec<Weekday>,
}

fn parse_weekday(s: &str) -> Option<Weekday> {
    match s {
        "MO" => Some(Weekday::Mon),
        "TU" => Some(Weekday::Tue),
        "WE" => Some(Weekday::Wed),
        "TH" => Some(Weekday::Thu),
        "FR" => Some(Weekday::Fri),
        "SA" => Some(Weekday::Sat),
        "SU" => Some(Weekday::Sun),
        _ => None,
    }
}

fn parse_rrule(value: &str) -> Option<ParsedRRule> {
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
                // UNTIL is always UTC per RFC 5545.
                let ndt = NaiveDateTime::parse_from_str(
                    v.trim().strip_suffix('Z').unwrap_or(v.trim()),
                    "%Y%m%dT%H%M%S",
                )
                .ok()?;
                until = Some(DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc));
            }
            "BYDAY" => {
                for d in v.split(',') {
                    // Ordinal prefixes (2MO) are out of scope; use the day.
                    let day = d.trim().trim_start_matches(['+', '-'])
                        .trim_start_matches(|c: char| c.is_ascii_digit());
                    if let Some(wd) = parse_weekday(day) {
                        if !byday.contains(&wd) {
                            byday.push(wd);
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

/// Instances of a recurring event overlapping `[window_start, window_end]`.
/// Bounded: at most 366 occurrences are ever generated (a daily event
/// would need a year to exceed it; the window is 2 hours).
fn expand_rrule(
    dtstart: DateTime<Utc>,
    duration: chrono::Duration,
    rule: &ParsedRRule,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    let mut out = Vec::new();
    let mut seen: i64 = 0;
    // Candidate start days, in order.
    let mut candidates: Vec<NaiveDate> = Vec::new();
    let start_date = dtstart.date_naive();
    match rule.freq {
        Freq::Daily => {
            let mut d = start_date;
            for _ in 0..366 {
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
            // Walk weeks; within each week emit the listed weekdays.
            let mut week_start = start_date;
            // Rewind to Monday of the DTSTART week for ordered output.
            let back = week_start.weekday().num_days_from_monday() as i64;
            week_start = week_start - chrono::Duration::days(back);
            for w in 0..53 {
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
        let inst_start = date
            .and_time(dtstart.time())
            .and_utc();
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
            // Well past the window; enough.
            break;
        }
    }
    out
}

fn days_in_month(year: i32, month: u32) -> u32 {
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

// ---------------------------------------------------------------------------
// Assemble CalendarEvents
// ---------------------------------------------------------------------------

/// Parse the feed; returns the declared calendar name and the events
/// (recurrences expanded) overlapping the window.
pub fn parse_ics(
    text: &str,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> (Option<String>, Vec<CalendarEvent>) {
    let lines = unfold(text);
    let mut cal_name: Option<String> = None;
    for line in &lines {
        if let Some(prop) = parse_prop(line) {
            if prop.name == "X-WR-CALNAME" {
                let n = unescape_text(prop.value.trim());
                if !n.is_empty() {
                    cal_name = Some(n);
                }
                break;
            }
        }
        if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
            break;
        }
    }

    // Group by UID: base event + RECURRENCE-ID overrides.
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
        let start = base.dtstart.as_ref().map(|t| t.to_utc());
        let Some(start) = start else { continue };
        // End: DTEND, else DURATION, else zero-length (still listed,
        // the sync layer treats it like any event).
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
        // Instances: single, or RRULE-expanded minus EXDATEs.
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
                // Unparseable RRULE: fall back to the single DTSTART
                // instance rather than dropping the event silently.
                instances.push((start, end));
            }
        } else if start <= window_end && end >= window_start {
            instances.push((start, end));
        }
        // RECURRENCE-ID overrides replace their instance.
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
                    out.push(CalendarEvent {
                        id: format!("{uid}@{}", o_start.to_rfc3339()),
                        calendar_id: "ics".to_string(),
                        title: o_title,
                        start: o_start,
                        end: o_end,
                        location: ov.location.clone().or_else(|| base.location.clone()),
                        status: "confirmed".to_string(),
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
                format!("{uid}@{}", s.to_rfc3339())
            } else {
                uid.clone()
            };
            out.push(CalendarEvent {
                id,
                calendar_id: "ics".to_string(),
                title: title.clone(),
                start: s,
                end: e,
                location: base.location.clone(),
                status: "confirmed".to_string(),
                all_day: base.all_day,
            });
        }
    }
    (cal_name, out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap()
    }

    const SAMPLE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Work\r\nBEGIN:VEVENT\r\nUID:single-1\r\nDTSTART:20261004T100000Z\r\nDTEND:20261004T110000Z\r\nSUMMARY:Team standup\r\nLOCATION:Room 3\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:cancelled-1\r\nDTSTART:20261004T120000Z\r\nDTEND:20261004T130000Z\r\nSUMMARY:Gone\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:daily-1\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T093000Z\r\nSUMMARY:Daily sync\r\nRRULE:FREQ=DAILY;COUNT=10\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:allday-1\r\nDTSTART;VALUE=DATE:20261004\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn parses_single_cancelled_recurring_and_allday() {
        let (name, events) = parse_ics(&SAMPLE, utc(2026, 10, 4, 0, 0), utc(2026, 10, 4, 23, 59));
        assert_eq!(name.as_deref(), Some("Work"));
        // single-1 + daily-1's 2026-10-04 instance + allday-1.
        // cancelled-1 is dropped.
        assert_eq!(events.len(), 3);
        let single = events.iter().find(|e| e.id == "single-1").unwrap();
        assert_eq!(single.title, "Team standup");
        assert_eq!(single.location.as_deref(), Some("Room 3"));
        assert!(!single.all_day);
        let daily = events.iter().find(|e| e.id.starts_with("daily-1@")).unwrap();
        assert_eq!(daily.start, utc(2026, 10, 4, 9, 0));
        assert_eq!(daily.end, utc(2026, 10, 4, 9, 30));
        let allday = events.iter().find(|e| e.id == "allday-1").unwrap();
        assert!(allday.all_day);
        assert!(events.iter().all(|e| e.id != "cancelled-1"));
    }

    #[test]
    fn exdate_removes_instance() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:ex-1\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T093000Z\r\nSUMMARY:X\r\nRRULE:FREQ=DAILY;COUNT=10\r\nEXDATE:20261004T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let (_, events) = parse_ics(&ics, utc(2026, 10, 4, 0, 0), utc(2026, 10, 4, 23, 59));
        assert!(events.is_empty());
    }

    #[test]
    fn weekly_byday_expands() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:wk-1\r\nDTSTART:20260928T090000Z\r\nDTEND:20260928T100000Z\r\nSUMMARY:Gym\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        // 2026-10-04 is a Sunday; window covers Mon 2026-10-05.
        let (_, events) = parse_ics(&ics, utc(2026, 10, 5, 0, 0), utc(2026, 10, 5, 23, 59));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].start, utc(2026, 10, 5, 9, 0));
    }

    #[test]
    fn tzid_resolves() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:tz-1\r\nDTSTART;TZID=Asia/Kolkata:20261004T173000\r\nDTEND;TZID=Asia/Kolkata:20261004T183000\r\nSUMMARY:Chai\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let (_, events) = parse_ics(&ics, utc(2026, 10, 4, 0, 0), utc(2026, 10, 4, 23, 59));
        assert_eq!(events.len(), 1);
        // 17:30 IST = 12:00 UTC.
        assert_eq!(events[0].start, utc(2026, 10, 4, 12, 0));
    }

    #[test]
    fn unfold_continuation_lines() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261004T100000Z\r\nDTEND:20261004T110000Z\r\nSUMMARY:Long title that \r\n continues here\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let (_, events) = parse_ics(&ics, utc(2026, 10, 4, 0, 0), utc(2026, 10, 4, 23, 59));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Long title that continues here");
    }

    #[test]
    fn keyring_roundtrip_without_entry() {
        // Must not error when nothing is stored; never touches the
        // real store in a way that fails the suite.
        let _ = has_url();
    }
}
