//! Connectors — optional integrations with external services.
//!
//! Each connector is local-first: credentials live in the OS keychain,
//! data is fetched on demand into a short-lived local cache, and no
//! Nila backend is ever involved.

pub mod google_calendar;
