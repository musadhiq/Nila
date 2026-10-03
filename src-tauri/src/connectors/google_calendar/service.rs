//! Thin Google Calendar API client.
//!
//! Blocking reqwest, same discipline as `jev::api`: short timeouts,
//! bearer token only in the `Authorization` header, errors mapped to
//! [`GcalError`] with no token material in any message.
//!
//! V1 scope is deliberately the PRIMARY calendar only: the connector
//! is a rolling-window reminder sync, not a calendar browser, and each
//! additional calendar would multiply polling cost. The calendar list
//! is read solely to resolve the account email for the status card.

use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};

const API: &str = "https://www.googleapis.com/calendar/v3";

/// Errors for every connector operation. The UI maps these to
/// localized status strings; raw HTTP bodies never leave this module.
#[derive(Debug)]
pub enum GcalError {
    NotConfigured,
    /// The refresh token was rejected: the user must reconnect.
    AuthRequired,
    Network(String),
    /// (HTTP status, short context). 401 is retried once with a fresh
    /// token by `with_fresh_token`.
    Api(u16, String),
    Storage(String),
}

impl std::fmt::Display for GcalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GcalError::NotConfigured => write!(f, "not connected"),
            GcalError::AuthRequired => write!(f, "authentication required"),
            GcalError::Network(e) => write!(f, "network error: {e}"),
            GcalError::Api(status, ctx) => write!(f, "calendar API error ({status}): {ctx}"),
            GcalError::Storage(e) => write!(f, "credential store: {e}"),
        }
    }
}

/// A calendar event in Nila's own shape. Google's JSON is parsed at
/// the boundary and never travels further.
#[derive(Debug, Clone)]
pub struct CalendarEvent {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub location: Option<String>,
    pub status: String,
    pub all_day: bool,
}

/// Fields for a partial event update. `None` = leave unchanged.
#[derive(Debug, Default)]
pub struct EventPatch {
    pub title: Option<String>,
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
}

fn http_client() -> Result<reqwest::blocking::Client, GcalError> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| GcalError::Network(format!("http client: {e}")))
}

fn check(resp: reqwest::blocking::Response, ctx: &str) -> Result<serde_json::Value, GcalError> {
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(GcalError::Api(401, ctx.to_string()));
    }
    if !status.is_success() {
        return Err(GcalError::Api(status.as_u16(), ctx.to_string()));
    }
    resp.json()
        .map_err(|e| GcalError::Api(status.as_u16(), format!("{ctx}: bad response: {e}")))
}

/// The account email, from the primary calendar list entry.
pub fn primary_email(access_token: &str) -> Result<String, GcalError> {
    let client = http_client()?;
    let v = check(
        client
            .get(format!("{API}/users/me/calendarList"))
            .query(&[("maxResults", "10")])
            .bearer_auth(access_token)
            .send()
            .map_err(|e| GcalError::Network(e.to_string()))?,
        "calendar list",
    )?;
    let items = v["items"].as_array().ok_or(GcalError::Api(200, "no calendars".into()))?;
    let primary = items
        .iter()
        .find(|c| c["primary"].as_bool().unwrap_or(false))
        .or_else(|| items.first());
    primary
        .and_then(|c| c["id"].as_str())
        .map(|s| s.to_string())
        .ok_or(GcalError::Api(200, "no primary calendar".into()))
}

/// Events in `[time_min, time_max]`, recurring events expanded.
pub fn list_events(
    access_token: &str,
    time_min: DateTime<Utc>,
    time_max: DateTime<Utc>,
) -> Result<Vec<CalendarEvent>, GcalError> {
    let client = http_client()?;
    let v = check(
        client
            .get(format!("{API}/calendars/primary/events"))
            .query(&[
                ("timeMin", time_min.to_rfc3339()),
                ("timeMax", time_max.to_rfc3339()),
                ("singleEvents", "true".to_string()),
                ("orderBy", "startTime".to_string()),
                ("maxResults", "100".to_string()),
            ])
            .bearer_auth(access_token)
            .send()
            .map_err(|e| GcalError::Network(e.to_string()))?,
        "list events",
    )?;
    let mut out = Vec::new();
    for item in v["items"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if let Some(e) = parse_event("primary", item) {
            out.push(e);
        }
    }
    Ok(out)
}

/// One event by id (for confirmation summaries and updates).
pub fn get_event(access_token: &str, event_id: &str) -> Result<CalendarEvent, GcalError> {
    let client = http_client()?;
    let v = check(
        client
            .get(format!("{API}/calendars/primary/events/{event_id}"))
            .bearer_auth(access_token)
            .send()
            .map_err(|e| GcalError::Network(e.to_string()))?,
        "get event",
    )?;
    parse_event("primary", &v).ok_or(GcalError::Api(200, "unparseable event".into()))
}

pub fn create_event(
    access_token: &str,
    title: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<CalendarEvent, GcalError> {
    let client = http_client()?;
    let v = check(
        client
            .post(format!("{API}/calendars/primary/events"))
            .bearer_auth(access_token)
            .json(&serde_json::json!({
                "summary": title,
                "start": { "dateTime": start.to_rfc3339() },
                "end": { "dateTime": end.to_rfc3339() },
            }))
            .send()
            .map_err(|e| GcalError::Network(e.to_string()))?,
        "create event",
    )?;
    parse_event("primary", &v).ok_or(GcalError::Api(200, "unparseable event".into()))
}

pub fn update_event(
    access_token: &str,
    event_id: &str,
    patch: &EventPatch,
) -> Result<CalendarEvent, GcalError> {
    let mut body = serde_json::Map::new();
    if let Some(t) = &patch.title {
        body.insert("summary".to_string(), serde_json::Value::String(t.clone()));
    }
    if let Some(s) = &patch.start {
        body.insert(
            "start".to_string(),
            serde_json::json!({ "dateTime": s.to_rfc3339() }),
        );
    }
    if let Some(e) = &patch.end {
        body.insert(
            "end".to_string(),
            serde_json::json!({ "dateTime": e.to_rfc3339() }),
        );
    }
    let client = http_client()?;
    let v = check(
        client
            .patch(format!("{API}/calendars/primary/events/{event_id}"))
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .map_err(|e| GcalError::Network(e.to_string()))?,
        "update event",
    )?;
    parse_event("primary", &v).ok_or(GcalError::Api(200, "unparseable event".into()))
}

pub fn delete_event(access_token: &str, event_id: &str) -> Result<(), GcalError> {
    let client = http_client()?;
    let resp = client
        .delete(format!("{API}/calendars/primary/events/{event_id}"))
        .bearer_auth(access_token)
        .send()
        .map_err(|e| GcalError::Network(e.to_string()))?;
    // A successful delete returns 204 No Content: there is no JSON
    // body, so the generic `check` helper (which parses one) must
    // not be used here.
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(GcalError::Api(401, "delete event".to_string()));
    }
    if !status.is_success() {
        return Err(GcalError::Api(status.as_u16(), "delete event".to_string()));
    }
    Ok(())
}

/// Google event JSON → [`CalendarEvent`]. Returns `None` for
/// cancelled or unparseable entries (never fatal to a sync).
fn parse_event(calendar_id: &str, v: &serde_json::Value) -> Option<CalendarEvent> {
    let id = v["id"].as_str()?;
    if id.is_empty() || id.len() > 256 {
        return None;
    }
    let status = v["status"].as_str().unwrap_or("confirmed");
    if status == "cancelled" {
        return None;
    }
    let (start, all_day) = parse_time(&v["start"])?;
    let (end, _) = parse_time(&v["end"])?;
    if end <= start {
        return None;
    }
    let title = v["summary"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("(no title)");
    Some(CalendarEvent {
        id: id.to_string(),
        calendar_id: calendar_id.to_string(),
        title: title.chars().take(80).collect(),
        start,
        end,
        location: v["location"].as_str().map(|s| s.to_string()),
        status: status.to_string(),
        all_day,
    })
}

/// Google's `start`/`end`: either `dateTime` (RFC 3339 with offset)
/// or `date` (all-day, interpreted as local midnight).
fn parse_time(v: &serde_json::Value) -> Option<(DateTime<Utc>, bool)> {
    if let Some(dt) = v["dateTime"].as_str() {
        let parsed = DateTime::parse_from_rfc3339(dt).ok()?;
        return Some((parsed.with_timezone(&Utc), false));
    }
    if let Some(d) = v["date"].as_str() {
        let date = NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?;
        let midnight = date.and_hms_opt(0, 0, 0)?;
        let local = Local.from_local_datetime(&midnight).single()?;
        return Some((local.with_timezone(&Utc), true));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn timed_event_json() -> serde_json::Value {
        serde_json::json!({
            "id": "evt123",
            "status": "confirmed",
            "summary": "Team Meeting",
            "location": "Room 4",
            "start": { "dateTime": "2026-10-04T10:00:00+05:30" },
            "end": { "dateTime": "2026-10-04T11:00:00+05:30" },
        })
    }

    #[test]
    fn parses_timed_event_with_timezone() {
        let e = parse_event("primary", &timed_event_json()).unwrap();
        assert_eq!(e.id, "evt123");
        assert_eq!(e.title, "Team Meeting");
        assert_eq!(e.location.as_deref(), Some("Room 4"));
        assert!(!e.all_day);
        // 10:00 +05:30 == 04:30 UTC.
        assert_eq!(e.start, Utc.with_ymd_and_hms(2026, 10, 4, 4, 30, 0).unwrap());
        assert_eq!(e.end, Utc.with_ymd_and_hms(2026, 10, 4, 5, 30, 0).unwrap());
    }

    #[test]
    fn parses_all_day_event() {
        let v = serde_json::json!({
            "id": "hol1",
            "status": "confirmed",
            "summary": "Diwali",
            "start": { "date": "2026-10-20" },
            "end": { "date": "2026-10-21" },
        });
        let e = parse_event("primary", &v).unwrap();
        assert!(e.all_day);
        // Local midnight converted to UTC (offset depends on TZ; just
        // assert the date survives the round trip in local time).
        assert_eq!(
            e.start.with_timezone(&Local).date_naive(),
            NaiveDate::from_ymd_opt(2026, 10, 20).unwrap()
        );
    }

    #[test]
    fn cancelled_and_broken_events_are_skipped() {
        let mut v = timed_event_json();
        v["status"] = serde_json::json!("cancelled");
        assert!(parse_event("primary", &v).is_none());
        assert!(parse_event("primary", &serde_json::json!({"id": "x"})).is_none());
        let mut v = timed_event_json();
        v["end"] = serde_json::json!({ "dateTime": "2026-10-04T09:00:00+05:30" });
        assert!(parse_event("primary", &v).is_none()); // end <= start
    }

    #[test]
    fn missing_summary_gets_placeholder() {
        let mut v = timed_event_json();
        v.as_object_mut().unwrap().remove("summary");
        let e = parse_event("primary", &v).unwrap();
        assert_eq!(e.title, "(no title)");
    }
}
