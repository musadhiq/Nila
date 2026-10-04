//! Shared types for the Google Calendar connector.
//!
//! The connector now reads the calendar's private ICS feed
//! (see [`super::ics`]); this module holds the event shape and the
//! error type used across fetch, parse, and sync. No Google API calls
//! live here anymore.

use chrono::{DateTime, Utc};

/// Errors for every connector operation. The UI maps these to
/// localized status strings; raw HTTP bodies and the feed URL never
/// leave the backend.
#[derive(Debug)]
pub enum GcalError {
    NotConfigured,
    Network(String),
    /// The feed itself failed: bad status, revoked URL, unparseable body.
    Feed(String),
    Storage(String),
}

impl std::fmt::Display for GcalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GcalError::NotConfigured => write!(f, "not connected"),
            GcalError::Network(e) => write!(f, "network error: {e}"),
            GcalError::Feed(e) => write!(f, "calendar feed: {e}"),
            GcalError::Storage(e) => write!(f, "credential store: {e}"),
        }
    }
}

/// A calendar event in Nila's own shape. The ICS feed is parsed at the
/// boundary and never travels further.
#[derive(Debug, Clone)]
pub struct CalendarEvent {
    /// UID, or `{uid}@{instance-start}` for recurring instances.
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub location: Option<String>,
    pub status: String,
    pub all_day: bool,
}
