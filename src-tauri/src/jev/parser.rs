//! Local rule-based intent parser.
//!
//! Jev's first brain: a deterministic parser that turns a FINAL
//! transcript into a [`JevResult`]. No ML, no network, no general
//! agency — pure pattern matching over the 12 supported intents.
//!
//! The parser is deliberately liberal: it only *proposes* structure.
//! [`crate::jev::schema::validate`] enforces the schema afterwards,
//! and the executor's allowlists decide what can actually happen. A
//! misparse degrades to `unknown`, never to an action.
//!
//! Partial transcripts never reach this module — only finalized STT.

use chrono::{DateTime, Local, TimeZone};

use super::executor::{is_known_app, is_known_folder};
use super::schema::{Intent, JevParams, JevResult};

pub struct LocalParser;

impl LocalParser {
    pub fn parse(&self, transcript: &str) -> JevResult {
        parse_transcript(transcript)
    }
}

fn jev(intent: Intent) -> JevResult {
    JevResult {
        intent,
        parameters: JevParams::default(),
        requires_confirmation: intent.needs_confirmation(),
        message: None,
    }
}

fn unknown() -> JevResult {
    let mut r = jev(Intent::Unknown);
    r.message = Some("I don't know how to do that yet.".to_string());
    r
}

/// Strip filler words STT often leaves at the edges.
fn tidy(s: &str) -> String {
    let mut s = s.trim().to_lowercase();
    for prefix in ["please ", "could you ", "can you "] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.trim().to_string();
        }
    }
    if let Some(rest) = s.strip_suffix(" please") {
        s = rest.trim().to_string();
    }
    s
}

fn strip_leading_article(s: &str) -> &str {
    for a in ["the ", "my ", "a "] {
        if let Some(rest) = s.strip_prefix(a) {
            return rest;
        }
    }
    s
}

/// Shell metacharacters (or line breaks) inside a target mean the
/// transcript is smuggling command syntax — "open firefox; rm -rf ~"
/// must degrade to `unknown`, never to an action. (The schema validator
/// repeats the equivalent check for the API path, where this parser
/// never runs.)
fn is_hostile_target(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, ';' | '|' | '&' | '$' | '`' | '\n' | '\r'))
}

fn parse_transcript(transcript: &str) -> JevResult {
    let text = tidy(transcript);
    if text.is_empty() {
        return unknown();
    }

    // "cancel that reminder" / "cancel the reminder" — before bare "cancel".
    if text.starts_with("cancel that reminder")
        || text.starts_with("cancel the reminder")
        || text.starts_with("cancel my reminder")
        || text.starts_with("delete that reminder")
    {
        return jev(Intent::CancelReminder);
    }
    // Bare interaction cancel.
    if matches!(text.as_str(), "cancel" | "never mind" | "nevermind" | "stop") {
        return jev(Intent::Cancel);
    }

    // "remind me to call mom at 7 pm"
    if let Some(rest) = text.strip_prefix("remind me to ") {
        return parse_reminder(rest);
    }

    // "close firefox" / "quit firefox"
    for verb in ["close ", "quit "] {
        if let Some(rest) = text.strip_prefix(verb) {
            let app = strip_leading_article(rest.trim()).trim().to_string();
            if app.is_empty() {
                return unknown();
            }
            let mut r = jev(Intent::CloseApplication);
            r.parameters.application = Some(app);
            return r;
        }
    }

    // "create a folder called projects"
    if let Some(rest) = text.strip_prefix("create ") {
        let rest = rest.trim();
        let rest = rest.strip_prefix("a ").unwrap_or(rest);
        if let Some(rest) = rest.strip_prefix("folder ") {
            let rest = rest.trim();
            let name = rest
                .strip_prefix("called ")
                .or_else(|| rest.strip_prefix("named "))
                .unwrap_or(rest)
                .trim()
                .trim_matches('"')
                .trim();
            if !name.is_empty() && !is_hostile_target(name) {
                let mut r = jev(Intent::CreateFolder);
                r.parameters.name = Some(name.to_string());
                return r;
            }
        }
        return unknown();
    }

    // "open X" / "launch X" / "start X" — disambiguated by registry.
    for verb in ["open ", "launch ", "start "] {
        if let Some(rest) = text.strip_prefix(verb) {
            let target = strip_leading_article(rest.trim()).trim().to_string();
            if target.is_empty() || is_hostile_target(&target) {
                return unknown();
            }
            if is_known_folder(&target) {
                let mut r = jev(Intent::OpenFolder);
                r.parameters.query = Some(target);
                return r;
            }
            if is_known_app(&target) {
                let mut r = jev(Intent::OpenApplication);
                r.parameters.application = Some(target);
                return r;
            }
            // "open the vlc app" — an application was meant but it isn't
            // in the allowlist: propose it anyway so the executor can
            // reject it with a proper "app not found" instead of
            // searching the filesystem for it. Word-boundary match so
            // "happy birthday video" doesn't count as an app.
            let looks_like_app = target == "app"
                || target.starts_with("app ")
                || target.ends_with(" app")
                || target.contains(" app ")
                || target.contains("application");
            if looks_like_app {
                let mut r = jev(Intent::OpenApplication);
                r.parameters.application = Some(target);
                return r;
            }
            // Otherwise it's a file reference ("open it" resolves the
            // pronoun via conversation context in the executor).
            let mut r = jev(Intent::OpenFile);
            r.parameters.query = Some(target);
            return r;
        }
    }

    // "find my resume" / "search for my resume" / "look for my resume"
    // "find all pdf files" → search_files.
    for verb in ["find ", "search for ", "look for ", "locate "] {
        if let Some(rest) = text.strip_prefix(verb) {
            let q = strip_leading_article(rest.trim()).trim().to_string();
            if q.is_empty() || is_hostile_target(&q) {
                return unknown();
            }
            // "all pdf files" / "pdf files" → extension search.
            let ext_q = q.strip_prefix("all ").unwrap_or(&q);
            if let Some(ext) = ext_q.strip_suffix(" files").or_else(|| ext_q.strip_suffix(" file")) {
                let ext = ext.trim();
                if !ext.is_empty() && !ext.contains(' ') {
                    let mut r = jev(Intent::SearchFiles);
                    r.parameters.extension = Some(ext.to_string());
                    return r;
                }
            }
            let mut r = jev(Intent::FindFile);
            r.parameters.query = Some(q);
            return r;
        }
    }

    // "how much ram am i using" / "cpu usage" / "disk space" / "battery"
    if text.contains("how much") || text.contains("usage") || text.contains("status") {
        let metric = if text.contains("ram") || text.contains("memory") {
            Some("ram")
        } else if text.contains("cpu") || text.contains("processor") {
            Some("cpu")
        } else if text.contains("disk") || text.contains("storage") || text.contains("space") {
            Some("disk")
        } else if text.contains("battery") {
            Some("battery")
        } else {
            None
        };
        if let Some(m) = metric {
            let mut r = jev(Intent::SystemInfo);
            r.parameters.metric = Some(m.to_string());
            return r;
        }
    }

    unknown()
}

fn parse_reminder(rest: &str) -> JevResult {
    // Split "call mom at 7 pm" / "check in in 10 minutes" on the LAST
    // separator so titles containing "at"/"in" survive.
    let (title, time_part) = rest
        .rsplit_once(" in ")
        .map(|(t, tm)| (t, format!("in {tm}")))
        .or_else(|| rest.rsplit_once(" at ").map(|(t, tm)| (t, tm.to_string())))
        .unwrap_or((rest, String::new()));
    let title = title.trim().trim_end_matches(" please").trim().to_string();
    if title.is_empty() || time_part.trim().is_empty() {
        return unknown();
    }
    let now = Local::now();
    let Some(at) = parse_reminder_time(&time_part, now) else {
        return unknown();
    };
    let mut r = jev(Intent::SetReminder);
    r.parameters.title = Some(title);
    r.parameters.datetime = Some(at.to_rfc3339());
    r
}

/// Parse "7 pm", "7:30 pm", "19:00", "tomorrow at 9", "in 10 minutes",
/// "noon", "midnight" into a future local datetime. Returns None when
/// the text isn't a recognizable time — the reminder then degrades to
/// `unknown` rather than guessing.
fn parse_reminder_time(s: &str, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let s = s.trim().to_lowercase();
    let s = s.strip_prefix("at ").unwrap_or(&s);

    // "in 10 minutes" / "in 2 hours" / "in an hour" / "in 30 seconds"
    if let Some(rest) = s.strip_prefix("in ") {
        let (num, unit) = if rest.starts_with("an ") || rest.starts_with("a ") {
            (1i64, rest.split_whitespace().nth(1).unwrap_or(""))
        } else {
            let mut parts = rest.split_whitespace();
            let num: i64 = parts.next()?.parse().ok()?;
            (num, parts.next().unwrap_or(""))
        };
        let secs = match unit.trim_end_matches('s') {
            "second" | "sec" => num,
            "minute" | "min" => num * 60,
            "hour" | "hr" => num * 3600,
            "day" => num * 86400,
            _ => return None,
        };
        return Some(now + chrono::Duration::seconds(secs));
    }

    // "tomorrow at 9 pm" / "tomorrow"
    let (s, add_day) = match s.strip_prefix("tomorrow ") {
        Some(rest) => (rest.trim(), true),
        None => (s, s == "tomorrow"),
    };
    if s == "tomorrow" || s.is_empty() {
        return Some(
            now.date_naive()
                .succ_opt()?
                .and_hms_opt(9, 0, 0)
                .map(|n| Local.from_local_datetime(&n).single())??,
        );
    }

    // "noon" / "midnight"
    if s == "noon" || s == "at noon" {
        let dt = today_at(now, 12, 0, add_day)?;
        return Some(shift_past_to_tomorrow(dt, now));
    }
    if s == "midnight" || s == "at midnight" {
        let dt = today_at(now, 0, 0, true)?; // next midnight
        return Some(dt);
    }

    // "7 pm" / "7:30 pm" / "19:00"
    let (time_part, meridiem) = if let Some(t) = s.strip_suffix(" pm") {
        (t, Some(false))
    } else if let Some(t) = s.strip_suffix("pm") {
        (t, Some(false))
    } else if let Some(t) = s.strip_suffix(" am") {
        (t, Some(true))
    } else if let Some(t) = s.strip_suffix("am") {
        (t, Some(true))
    } else {
        (s, None)
    };
    let (h, min) = match time_part.trim().split_once(':') {
        Some((h, m)) => (h.trim().parse::<u32>().ok()?, m.trim().parse::<u32>().ok()?),
        None => (time_part.trim().parse::<u32>().ok()?, 0),
    };
    if min > 59 {
        return None;
    }
    let hour24 = match meridiem {
        Some(true) => {
            if !(1..=12).contains(&h) {
                return None;
            }
            h % 12
        }
        Some(false) => {
            if !(1..=12).contains(&h) {
                return None;
            }
            h % 12 + 12
        }
        None => {
            if h > 23 {
                return None;
            }
            h
        }
    };
    let dt = today_at(now, hour24, min, add_day)?;
    Some(shift_past_to_tomorrow(dt, now))
}

fn today_at(now: DateTime<Local>, h: u32, m: u32, add_day: bool) -> Option<DateTime<Local>> {
    let mut date = now.date_naive();
    if add_day {
        date = date.succ_opt()?;
    }
    date.and_hms_opt(h, m, 0)
        .map(|n| Local.from_local_datetime(&n).single())?
}

/// A time that already passed today means tomorrow — "remind me at
/// 7 pm" said at 8 pm is never "an hour ago".
fn shift_past_to_tomorrow(dt: DateTime<Local>, now: DateTime<Local>) -> DateTime<Local> {
    if dt <= now {
        dt + chrono::Duration::days(1)
    } else {
        dt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::schema::validate;

    fn intent_of(transcript: &str) -> Intent {
        validate(&parse_transcript(transcript));
        parse_transcript(transcript).intent
    }

    #[test]
    fn spec_examples() {
        assert_eq!(intent_of("Open Firefox"), Intent::OpenApplication);
        assert_eq!(intent_of("Close Firefox"), Intent::CloseApplication);
        assert_eq!(intent_of("Find my resume"), Intent::FindFile);
        assert_eq!(intent_of("Find all PDF files"), Intent::SearchFiles);
        assert_eq!(intent_of("Open my resume"), Intent::OpenFile);
        assert_eq!(intent_of("Open Downloads"), Intent::OpenFolder);
        assert_eq!(intent_of("Create a folder called Projects"), Intent::CreateFolder);
        assert_eq!(
            intent_of("Remind me to call mom at 7 PM"),
            Intent::SetReminder
        );
        assert_eq!(intent_of("Cancel that reminder"), Intent::CancelReminder);
        assert_eq!(intent_of("How much RAM am I using?"), Intent::SystemInfo);
    }

    #[test]
    fn set_reminder_extracts_title_and_time() {
        let r = parse_transcript("Remind me to call mom at 7 PM");
        assert_eq!(r.intent, Intent::SetReminder);
        assert_eq!(r.parameters.title.as_deref(), Some("call mom"));
        let at = r.parameters.datetime.as_deref().unwrap();
        // 19:00 local.
        assert!(at.contains("T19:00:00"), "{at}");
        // And it validates (future datetime).
        assert!(matches!(
            validate(&r),
            crate::jev::schema::ValidatedAction::SetReminder { .. }
        ));
    }

    #[test]
    fn hostile_commands_are_unknown() {
        // The last three MUST NOT produce anything executable.
        for t in [
            "Delete everything",
            "Run sudo something",
            "bash -c something",
            "sudo rm -rf /",
            "open firefox; rm -rf ~",
        ] {
            assert_eq!(intent_of(t), Intent::Unknown, "{t}");
        }
    }

    #[test]
    fn open_variants() {
        let r = parse_transcript("Open it");
        assert_eq!(r.intent, Intent::OpenFile);
        assert_eq!(r.parameters.query.as_deref(), Some("it"));

        let r = parse_transcript("Launch the terminal");
        assert_eq!(r.intent, Intent::OpenApplication);
        assert_eq!(r.parameters.application.as_deref(), Some("terminal"));

        let r = parse_transcript("Open my documents");
        assert_eq!(r.intent, Intent::OpenFolder);
    }

    #[test]
    fn app_word_boundary_heuristic() {
        // An app was meant but isn't allowlisted: the executor rejects
        // it with "app not found" (allowlist), never the filesystem.
        let r = parse_transcript("Open the vlc app");
        assert_eq!(r.intent, Intent::OpenApplication);
        // But "happy" is not an app reference — that's a file search.
        let r = parse_transcript("Open happy birthday video");
        assert_eq!(r.intent, Intent::OpenFile);
    }

    #[test]
    fn hostile_targets_are_unknown() {
        for t in [
            "Open firefox; rm -rf ~",
            "Find my resume | cat /etc/passwd",
            "Create a folder called a; rm -rf ~",
        ] {
            assert_eq!(intent_of(t), Intent::Unknown, "{t}");
        }
    }

    #[test]
    fn nonexistent_app_still_parses_but_executor_rejects() {
        // The parser proposes; the allowlist disposes.
        let r = parse_transcript("Open an application that does not exist");
        assert_eq!(r.intent, Intent::OpenApplication);
    }

    #[test]
    fn time_parsing() {
        let now = Local.with_ymd_and_hms(2026, 10, 1, 12, 0, 0).single().unwrap();
        let at = |s: &str| parse_reminder_time(s, now).unwrap();

        assert_eq!(at("7 pm").format("%H:%M").to_string(), "19:00");
        assert_eq!(at("7:30 pm").format("%H:%M").to_string(), "19:30");
        assert_eq!(at("19:00").format("%H:%M").to_string(), "19:00");
        assert_eq!(at("noon").format("%H:%M").to_string(), "12:00");
        // 7 am already passed at noon → tomorrow.
        assert_eq!(at("7 am").date_naive().to_string(), "2026-10-02");
        assert_eq!(at("in 10 minutes").format("%H:%M").to_string(), "12:10");
        assert_eq!(at("tomorrow at 9").format("%Y-%m-%d %H:%M").to_string(), "2026-10-02 09:00");
        assert!(parse_reminder_time("sometime later", now).is_none());
        assert!(parse_reminder_time("25:00", now).is_none());
    }

    #[test]
    fn empty_and_cancel() {
        assert_eq!(intent_of(""), Intent::Unknown);
        assert_eq!(intent_of("cancel"), Intent::Cancel);
        assert_eq!(intent_of("never mind"), Intent::Cancel);
    }
}
