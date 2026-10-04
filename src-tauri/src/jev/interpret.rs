//! Intent interpretation and conversational recovery layer.
//!
//! The STT model is probabilistic: it drops words, merges them, and
//! mishears them. The old pipeline treated the raw transcript as the
//! exact command, so "battery" (STT's rendering of "show my battery
//! level") fell through to `unknown` and Nila answered "I don't know
//! how to do that." This module sits between the STT text and Jev's
//! structured actions:
//!
//! ```text
//! transcript_final
//!   → normalize_transcript        (this module)
//!   → interpret                   (this module: registry + scoring)
//!   → decide                      (this module: confidence + safety policy)
//!   → pending conversation state  (this module)
//!   → JevResult → validate → executor → response   (existing)
//! ```
//!
//! This is a RECOVERY layer, not a replacement: the deterministic
//! [`crate::jev::parser::LocalParser`] (and the Jev API when a token is
//! configured) still runs first. Only transcripts they reject as
//! `unknown` reach the interpreter. Nothing here executes anything
//! directly — it only ever produces a [`JevResult`], which the
//! existing schema validator and allowlisted executor still gate.
//!
//! Design rules:
//! - Deterministic, local, lightweight: phrase/keyword matching over a
//!   closed intent registry. No ML model, no network.
//! - Conservative normalization: fixes are word-level and limited to
//!   the command vocabulary. Arbitrary user text (titles, queries) is
//!   never rewritten.
//! - Confidence-gated by safety class: read-only intents tolerate
//!   partial transcripts; destructive intents never execute from a
//!   fuzzy match — Nila asks first, and the user's "yes" resolves
//!   through short-lived pending state.
//! - Debug logging behind `NILA_JEV_DEBUG=1` only. Transcript text is
//!   never logged in normal operation.

use std::time::{Duration, Instant};

use chrono::Local;
use tauri::AppHandle;

use super::executor::{is_known_app, is_known_folder};
use super::parser::parse_reminder_time;
use super::schema::{Intent, JevParams, JevResult, ValidatedAction};
use super::ui_action::UIActionHandler;
use super::{emit_action_detected, emit_interpret_result, execute_validated, unknown_result, JevState};

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

/// `NILA_JEV_DEBUG=1` enables interpretation diagnostics on stderr.
/// Off by default: transcript text never appears in normal logs.
macro_rules! idebug {
    ($($arg:tt)*) => {
        if std::env::var("NILA_JEV_DEBUG").as_deref() == Ok("1") {
            eprintln!("nila: interpret: {}", format!($($arg)*));
        }
    };
}

// ---------------------------------------------------------------------------
// 1. Transcript normalization
// ---------------------------------------------------------------------------

/// Conservative, command-vocabulary-aware normalization of STT output.
///
/// Handles: case, surrounding whitespace, STT punctuation, filler words
/// at the edges ("please", "could you", "uh"), doubled words ("show
/// show my battery"), and a small map of common mishearings limited to
/// words in the command vocabulary ("batter" → "battery").
///
/// What it does NOT do: rewrite arbitrary text, guess at homophones
/// outside the vocabulary, or touch non-Latin script. Titles and
/// search queries pass through with only case/whitespace cleanup.
pub fn normalize_transcript(raw: &str) -> String {
    // Control characters never survive into matching.
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let lowered = cleaned.to_lowercase();

    // Punctuation → space (so "battery,level" still tokenizes);
    // apostrophes are dropped ("what's" → "whats", matching the
    // registry's apostrophe-free phrases). Non-ASCII (Malayalam script
    // etc.) passes through untouched — combining marks like the virama
    // are not "alphanumeric" but must never be rewritten.
    let mut spaced = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        if c == '\'' || c == '\u{2019}' {
            continue;
        } else if !c.is_ascii() {
            spaced.push(c);
        } else if c.is_alphanumeric() || c.is_whitespace() {
            spaced.push(c);
        } else {
            spaced.push(' ');
        }
    }

    let mut words: Vec<&str> = spaced.split_whitespace().collect();
    words = strip_filler_edges(words);

    // STT stutter: "show show my battery".
    let mut dedup: Vec<&str> = Vec::with_capacity(words.len());
    for w in words {
        if dedup.last() != Some(&w) {
            dedup.push(w);
        }
    }

    dedup
        .iter()
        .map(|w| fix_vocab_word(w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Remove filler words STT leaves at the edges of an utterance.
fn strip_filler_edges(mut words: Vec<&str>) -> Vec<&str> {
    // Leading: "please show my battery", "could you check battery",
    // "uh battery level".
    loop {
        let drop_two = words.len() >= 2
            && matches!(
                (words[0], words[1]),
                ("could", "you")
                    | ("would", "you")
                    | ("can", "you")
                    | ("will", "you")
                    | ("hey", "nila")
                    | ("hi", "nila")
                    | ("okay", "nila")
                    | ("ok", "nila")
            );
        let drop_one = !words.is_empty()
            && matches!(
                words[0],
                "please" | "uh" | "um" | "umm" | "hmm" | "ah" | "er" | "nila"
            );
        if drop_two {
            words.drain(..2);
        } else if drop_one {
            words.drain(..1);
        } else {
            break;
        }
    }
    // Trailing "please".
    while words.last() == Some(&"please") {
        words.pop();
    }
    words
}

/// Word-level mishearing fixes, limited to the command vocabulary.
/// "batter" almost certainly means "battery" in Nila's domain; "better"
/// does NOT map (it's a real word with other meanings — rewriting it
/// would corrupt "show me better options").
fn fix_vocab_word(word: &str) -> &str {
    match word {
        "battry" | "batery" | "batter" => "battery",
        "remider" | "remaind" => "reminder",
        "remimd" => "remind",
        "setings" | "seting" => "settings",
        "set" => "set",
        "firfox" | "fierfox" => "firefox",
        "crom" => "chrome",
        "termnal" | "terminl" => "terminal",
        "helo" | "hellow" => "hello",
        "thnaks" | "thaks" => "thanks",
        "opem" | "oepn" => "open",
        "clsoe" => "close",
        "flie" | "faile" => "file",
        "serch" => "search",
        "gud" => "good",
        "mornin" => "morning",
        "wifii" => "wifi",
        _ => word,
    }
}

// ---------------------------------------------------------------------------
// 2. Intent registry + semantic matching
// ---------------------------------------------------------------------------

/// How much evidence a fuzzy match needs before it may execute.
/// Read-only intents tolerate partial transcripts; destructive ones
/// never execute from recovery — they ask first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyClass {
    /// battery, time, date, file search, list reminders.
    ReadOnly,
    /// open app/file/folder, create folder, set reminder.
    Config,
    /// close app, cancel reminder.
    Destructive,
}

impl SafetyClass {
    /// Minimum confidence for direct execution from a fuzzy match.
    fn execute_threshold(self) -> f32 {
        match self {
            SafetyClass::ReadOnly => 0.50,
            SafetyClass::Config => 0.70,
            // Unreachable in practice: recovery never scores that high,
            // so destructive intents always go through confirmation.
            SafetyClass::Destructive => 0.95,
        }
    }
}

/// Entities an intent may need. The interpreter extracts what it can;
/// anything missing becomes a clarification question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityKind {
    Application,
    Query,
    FolderName,
    ReminderTitle,
    ReminderTime,
}

/// One scored interpretation of the transcript.
#[derive(Debug, Clone)]
pub struct IntentCandidate {
    pub intent: Intent,
    pub confidence: f32,
    /// Higher wins near-ties: action verbs outrank bare nouns, so
    /// "remind me today" is a reminder, not a date query.
    pub priority: u8,
    pub entities: JevParams,
    /// Where the score came from — debug logging only.
    pub source: &'static str,
    pub safety: SafetyClass,
}

/// Shell metacharacters in the RAW transcript mean the text is
/// smuggling command syntax. The interpreter must not build entities
/// from it — degrade to unknown like the parser does.
fn is_hostile_raw(raw: &str) -> bool {
    raw.chars()
        .any(|c| matches!(c, ';' | '|' | '&' | '$' | '`' | '\n' | '\r'))
}

/// Whole-word containment: `contains_word("my battery", "battery")`.
fn contains_word(text: &str, word: &str) -> bool {
    text.split_whitespace().any(|w| w == word)
}

/// Word-boundary phrase containment.
fn contains_phrase(text: &str, phrase: &str) -> bool {
    if phrase.is_empty() {
        return false;
    }
    format!(" {text} ").contains(&format!(" {phrase} "))
}

// --- entity extraction ----------------------------------------------------

const OPEN_VERBS: &[&str] = &["open", "launch", "start"];
const CLOSE_VERBS: &[&str] = &["close", "quit", "kill"];
const ARTICLES: &[&str] = &["the", "a", "an", "my"];

/// Strip leading command verbs/articles: "open the firefox" → "firefox".
fn strip_leading_noise<'a>(words: &[&'a str], extra: &[&str]) -> Vec<&'a str> {
    let mut ws = words.to_vec();
    loop {
        let drop = match ws.first() {
            Some(w) if OPEN_VERBS.contains(w) => true,
            Some(w) if CLOSE_VERBS.contains(w) => true,
            Some(w) if ARTICLES.contains(w) => true,
            Some(w) if extra.contains(w) => true,
            Some(w) if *w == "please" => true,
            _ => false,
        };
        if drop {
            ws.remove(0);
        } else {
            break;
        }
    }
    // Trailing "app"/"application"/"please".
    while matches!(ws.last(), Some(w) if ["app", "application", "please"].contains(w)) {
        ws.pop();
    }
    ws
}

/// Find a known application name in the transcript (1–3 word windows,
/// so "visual studio code" matches). Returns the spoken name.
fn find_app_name(words: &[&str]) -> Option<String> {
    for len in (1..=3).rev() {
        if words.len() < len {
            continue;
        }
        for win in words.windows(len) {
            let name = win.join(" ");
            if is_known_app(&name) {
                return Some(name);
            }
        }
    }
    None
}

/// "in 10 minutes", "tomorrow at 9", "at 7 pm", "9:30", "noon" —
/// find the time expression at the TAIL of the transcript and return
/// the parsed datetime plus the remaining (title) text.
///
/// Only accepts tails that contain a time cue (at/in/tomorrow/am/pm/
/// noon/midnight/:). A bare number ("call john 2") is NOT a time —
/// guessing would corrupt titles.
fn extract_time_tail(text: &str) -> Option<(chrono::DateTime<Local>, String)> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    let now = Local::now();
    // Try suffixes up to 4 words, longest first. "<time> tomorrow"
    // (time words BEFORE tomorrow) is rewritten to "tomorrow <time>".
    for len in (1..=4.min(words.len())).rev() {
        let start = words.len() - len;
        let tail = words[start..].join(" ");
        for candidate in time_candidates(&tail) {
            if !has_time_cue(&candidate) {
                continue;
            }
            let digits = words_to_digits(&candidate);
            if let Some(at) = parse_reminder_time(&digits, now) {
                let rest = words[..start].join(" ");
                return Some((at, rest));
            }
        }
    }
    None
}

/// Candidate rewrites of a tail: as-is, plus "<time> tomorrow" →
/// "tomorrow <time>".
fn time_candidates(tail: &str) -> Vec<String> {
    let mut out = vec![tail.to_string()];
    if let Some((time_part, _)) = tail.rsplit_once(" tomorrow") {
        if !time_part.trim().is_empty() {
            out.push(format!("tomorrow {}", time_part.trim()));
        }
    }
    out
}

/// True when the text carries an explicit time cue.
fn has_time_cue(s: &str) -> bool {
    let p = format!(" {s} ");
    [" at ", " in ", " tomorrow ", " am", " pm", " noon", " midnight"]
        .iter()
        .any(|cue| p.contains(cue))
        || s.contains(':')
}

/// Number words → digits, for time expressions only ("nine tomorrow"
/// → "9 tomorrow"). Applied to the extracted time tail, never to the
/// whole transcript, so titles like "chapter two" are untouched.
fn words_to_digits(s: &str) -> String {
    s.split_whitespace()
        .map(|w| match w {
            "zero" => "0",
            "one" => "1",
            "two" => "2",
            "three" => "3",
            "four" => "4",
            "five" => "5",
            "six" => "6",
            "seven" => "7",
            "eight" => "8",
            "nine" => "9",
            "ten" => "10",
            "eleven" => "11",
            "twelve" => "12",
            "thirteen" => "13",
            "fourteen" => "14",
            "fifteen" => "15",
            "sixteen" => "16",
            "seventeen" => "17",
            "eighteen" => "18",
            "nineteen" => "19",
            "twenty" => "20",
            "thirty" => "30",
            "forty" => "40",
            "fifty" => "50",
            _ => w,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Split a reminder transcript into (title, datetime). Title words that
/// are pure command noise ("set", "remind me") are stripped.
fn extract_reminder_parts(text: &str) -> (Option<String>, Option<String>) {
    let (at, rest) = match extract_time_tail(text) {
        Some((at, rest)) => (Some(at.to_rfc3339()), rest),
        None => (None, text.to_string()),
    };
    let words: Vec<&str> = rest.split_whitespace().collect();
    let title_words = strip_leading_noise(
        &words,
        &[
            "set", "create", "add", "new", "remind", "reminder", "reminders", "me", "to", "about",
            "for",
        ],
    );
    let title = title_words.join(" ");
    let title = if title.trim().is_empty() {
        None
    } else {
        Some(title)
    };
    (title, at)
}

// --- per-family matchers ---------------------------------------------------

/// Score a phrase/keyword spec generically.
fn score_phrases_keywords(
    text: &str,
    words: &[&str],
    phrases: &[&str],
    keywords: &[&str],
    negative_words: &[&str],
) -> f32 {
    let mut best = 0.0f32;
    for p in phrases {
        if text == *p {
            best = best.max(1.0);
        } else if contains_phrase(text, p) {
            best = best.max(0.92);
        }
    }
    let hits = keywords.iter().filter(|k| contains_word(text, k)).count();
    if hits > 0 {
        // First keyword carries the signal; extras add a little.
        let kw = (0.50 + 0.12 * (hits as f32 - 1.0)).min(0.85);
        best = best.max(kw);
    }
    let _ = words;
    if negative_words.iter().any(|n| contains_word(text, n)) {
        best = best.min(0.30);
    }
    best
}

fn match_system_info(text: &str, words: &[&str]) -> Vec<IntentCandidate> {
    let mut out = Vec::new();
    // (metric, phrases, keywords, negative words)
    let specs: &[(&str, &[&str], &[&str], &[&str])] = &[
        (
            "battery",
            &[
                "battery level",
                "battery percentage",
                "my battery level",
                "show my battery",
                "show my battery level",
                "what is my battery",
                "how much battery",
                "check battery",
                "battery status",
                "my battery",
                "is my battery charging",
                "am i charging",
            ],
            &["battery", "batter", "charging"],
            &["charger"],
        ),
        (
            "ram",
            &["how much ram", "ram usage", "memory usage", "check ram"],
            &["ram", "memory"],
            &[],
        ),
        (
            "cpu",
            &["cpu usage", "how much cpu", "processor usage", "check cpu"],
            &["cpu", "processor"],
            &[],
        ),
        (
            "disk",
            &["disk space", "how much disk", "storage space", "disk usage"],
            &["disk", "storage"],
            &[],
        ),
        (
            "all",
            &["system status", "how is my system", "system info"],
            &[],
            &[],
        ),
    ];
    for (metric, phrases, keywords, negatives) in specs {
        let conf = score_phrases_keywords(text, words, phrases, keywords, negatives);
        if conf > 0.0 {
            let mut params = JevParams::default();
            params.metric = Some(metric.to_string());
            out.push(IntentCandidate {
                intent: Intent::SystemInfo,
                confidence: conf,
                priority: 1,
                entities: params,
                source: "system_info",
                safety: SafetyClass::ReadOnly,
            });
        }
    }
    out
}

fn match_time_date(text: &str, words: &[&str]) -> Vec<IntentCandidate> {
    let mut out = Vec::new();
    let time = score_phrases_keywords(
        text,
        words,
        &[
            "what time is it",
            "what is the time",
            "whats the time",
            "tell me the time",
            "current time",
            "the time",
            "time now",
            "what time",
        ],
        &["time"],
        &["timer", "times", "timeout"],
    );
    if time > 0.0 {
        out.push(IntentCandidate {
            intent: Intent::CurrentTime,
            confidence: time,
            priority: 1,
            entities: JevParams::default(),
            source: "time",
            safety: SafetyClass::ReadOnly,
        });
    }
    let date = score_phrases_keywords(
        text,
        words,
        &[
            "what is the date",
            "what date is it",
            "whats the date",
            "todays date",
            "current date",
            "what day is it",
        ],
        &["date", "today"],
        &["update"],
    );
    // "up to date" is an idiom, not a date question.
    let date = if contains_phrase(text, "up to date") {
        date.min(0.30)
    } else {
        date
    };
    if date > 0.0 {
        out.push(IntentCandidate {
            intent: Intent::CurrentDate,
            confidence: date,
            priority: 1,
            entities: JevParams::default(),
            source: "date",
            safety: SafetyClass::ReadOnly,
        });
    }
    out
}

fn match_applications(raw: &str, text: &str, words: &[&str]) -> Vec<IntentCandidate> {
    let mut out = Vec::new();
    if is_hostile_raw(raw) {
        return out;
    }
    let stripped: Vec<&str> = strip_leading_noise(words, &[]);
    let Some(app) = find_app_name(&stripped).or_else(|| find_app_name(words)) else {
        // "open the vlc app" — an app was meant but isn't allowlisted:
        // propose it so the executor rejects it with "app not found"
        // instead of searching the filesystem. Word-boundary match.
        if contains_word(text, "app") || contains_word(text, "application") {
            let target = stripped.join(" ");
            if !target.is_empty() {
                let mut params = JevParams::default();
                params.application = Some(target);
                out.push(IntentCandidate {
                    intent: Intent::OpenApplication,
                    confidence: 0.55,
                    priority: 2,
                    entities: params,
                    source: "app_word",
                    safety: SafetyClass::Config,
                });
            }
        }
        return out;
    };

    let has_open_verb = OPEN_VERBS.iter().any(|v| contains_word(text, v));
    let has_close_verb = CLOSE_VERBS.iter().any(|v| contains_word(text, v));

    // Extra content words beyond the app name + verbs ("firefox is
    // slow") mean this probably wasn't an open/close command at all.
    let app_words: usize = app.split_whitespace().count();
    let noise_words = words
        .iter()
        .filter(|w| {
            !OPEN_VERBS.contains(w)
                && !CLOSE_VERBS.contains(w)
                && !ARTICLES.contains(w)
                && !["app", "application", "please"].contains(w)
                && !app.split_whitespace().any(|a| a == **w)
        })
        .count();

    if has_close_verb {
        let mut params = JevParams::default();
        params.application = Some(app);
        let mut conf: f32 = 0.90;
        if noise_words > 0 {
            conf = conf.min(0.45);
        }
        out.push(IntentCandidate {
            intent: Intent::CloseApplication,
            confidence: conf,
            priority: 2,
            entities: params,
            source: "close_app",
            safety: SafetyClass::Destructive,
        });
    } else {
        let mut params = JevParams::default();
        params.application = Some(app.clone());
        // Verb + app ("open firefox", possibly with a dropped verb
        // recovered as a bare name): bare names still score enough to
        // ask, never to surprise-launch on noise.
        let mut conf: f32 = if has_open_verb { 0.90 } else { 0.62 };
        if noise_words > 0 {
            conf = conf.min(0.45);
        }
        // Sanity: the app name shouldn't dominate a long sentence.
        if words.len() > app_words + 3 {
            conf = conf.min(0.45);
        }
        out.push(IntentCandidate {
            intent: Intent::OpenApplication,
            confidence: conf,
            priority: 2,
            entities: params,
            source: "open_app",
            safety: SafetyClass::Config,
        });
    }
    out
}

/// "open X in Y" with STT noise — the parser handles the clean form;
/// this catches mangled variants ("open the nyla folder in crom").
/// The app name
/// must be allowlisted and sit at the tail after "in"; everything
/// between the verb and "in" is the target query.
fn match_open_in_app(raw: &str, words: &[&str]) -> Vec<IntentCandidate> {
    let mut out = Vec::new();
    if is_hostile_raw(raw) {
        return out;
    }
    let Some(in_pos) = words.iter().position(|w| *w == "in") else {
        return out;
    };
    let tail = &words[in_pos + 1..];
    let Some(app) = find_app_name(tail) else {
        return out;
    };
    let head = &words[..in_pos];
    if !head.iter().any(|w| OPEN_VERBS.contains(w)) {
        return out;
    }
    let query: String = head
        .iter()
        .filter(|w| {
            !OPEN_VERBS.contains(w)
                && !ARTICLES.contains(w)
                && **w != "please"
                && **w != "folder"
                && **w != "file"
        })
        .map(|w| w.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    if query.is_empty() {
        return out;
    }
    // The app should own the tail; trailing words are noise.
    let app_words = app.split_whitespace().count();
    let mut conf: f32 = 0.74;
    if tail.len() > app_words + 1 {
        conf = conf.min(0.55);
    }
    // A long target phrase is probably ramble, not a name.
    if query.split_whitespace().count() > 4 {
        conf = conf.min(0.55);
    }
    let mut params = JevParams::default();
    params.query = Some(query);
    params.application = Some(app);
    out.push(IntentCandidate {
        intent: Intent::OpenInApplication,
        confidence: conf,
        priority: 2,
        entities: params,
        source: "open_in_app",
        safety: SafetyClass::Config,
    });
    out
}

/// "close"/"quit" with no app name: not enough to act on, but enough
/// to ask which application.
fn match_close_no_app(text: &str) -> Vec<IntentCandidate> {
    let has_close_verb = CLOSE_VERBS.iter().any(|w| contains_word(text, w));
    if !has_close_verb {
        return Vec::new();
    }
    vec![IntentCandidate {
        intent: Intent::CloseApplication,
        confidence: 0.50,
        priority: 2,
        entities: JevParams::default(),
        source: "close_no_app",
        safety: SafetyClass::Destructive,
    }]
}

fn match_files_folders(raw: &str, text: &str, words: &[&str]) -> Vec<IntentCandidate> {
    let mut out = Vec::new();
    if is_hostile_raw(raw) {
        return out;
    }

    // Known folder named bare ("downloads") or after open verbs.
    {
        let stripped: Vec<&str> = strip_leading_noise(words, &["my"]);
        let joined = stripped.join(" ");
        if is_known_folder(&joined) && !joined.is_empty() {
            let mut params = JevParams::default();
            params.query = Some(joined);
            out.push(IntentCandidate {
                intent: Intent::OpenFolder,
                confidence: 0.70,
                priority: 2,
                entities: params,
                source: "folder",
                safety: SafetyClass::ReadOnly,
            });
        }
    }

    // "find my resume" / "search for X" / "look for X".
    let find_verbs = ["find", "search", "locate"];
    let has_find = find_verbs.iter().any(|v| contains_word(text, v))
        || contains_phrase(text, "look for");
    if has_find {
        let stripped = strip_leading_noise(
            words,
            &["find", "search", "locate", "look", "for", "me", "help"],
        );
        let query = stripped.join(" ");
        if !query.is_empty() {
            let mut params = JevParams::default();
            params.query = Some(query);
            out.push(IntentCandidate {
                intent: Intent::FindFile,
                confidence: 0.80,
                priority: 2,
                entities: params,
                source: "find_file",
                safety: SafetyClass::ReadOnly,
            });
        } else {
            // Verb with no query: "find" alone.
            out.push(IntentCandidate {
                intent: Intent::FindFile,
                confidence: 0.50,
                priority: 2,
                entities: JevParams::default(),
                source: "find_file_noquery",
                safety: SafetyClass::ReadOnly,
            });
        }
    }

    // "open <target>" where the target is neither app nor folder.
    // "settings" is owned by the settings matcher below.
    let has_open_verb = OPEN_VERBS.iter().any(|v| contains_word(text, v));
    if has_open_verb && find_app_name(words).is_none() {
        let stripped: Vec<&str> = strip_leading_noise(words, &["my"]);
        let target = stripped.join(" ");
        if target == "settings" {
            // Leave it to match_settings_help.
        } else if !target.is_empty() && !is_known_folder(&target) {
            let mut params = JevParams::default();
            params.query = Some(target);
            out.push(IntentCandidate {
                intent: Intent::OpenFile,
                confidence: 0.70,
                priority: 2,
                entities: params,
                source: "open_file",
                safety: SafetyClass::Config,
            });
        } else if target.is_empty() {
            out.push(IntentCandidate {
                intent: Intent::OpenFile,
                confidence: 0.45,
                priority: 2,
                entities: JevParams::default(),
                source: "open_file_notarget",
                safety: SafetyClass::Config,
            });
        }
    }
    out
}

fn match_create_folder(raw: &str, text: &str, words: &[&str]) -> Vec<IntentCandidate> {
    let mut out = Vec::new();
    if is_hostile_raw(raw) || !contains_word(text, "create") || !contains_word(text, "folder") {
        return out;
    }
    let stripped = strip_leading_noise(words, &["create", "called", "named", "my"]);
    // Drop the word "folder" itself wherever it sits.
    let name_words: Vec<&str> = stripped
        .into_iter()
        .filter(|w| *w != "folder" && *w != "folders")
        .collect();
    let name = name_words.join(" ");
    if name.is_empty() {
        out.push(IntentCandidate {
            intent: Intent::CreateFolder,
            confidence: 0.55,
            priority: 2,
            entities: JevParams::default(),
            source: "create_folder_noname",
            safety: SafetyClass::Config,
        });
    } else {
        let mut params = JevParams::default();
        params.name = Some(name);
        out.push(IntentCandidate {
            intent: Intent::CreateFolder,
            confidence: 0.80,
            priority: 2,
            entities: params,
            source: "create_folder",
            safety: SafetyClass::Config,
        });
    }
    out
}

fn match_reminders(text: &str, words: &[&str]) -> Vec<IntentCandidate> {
    let mut out = Vec::new();

    // "show my reminders" family → open the list (read-only).
    let show = score_phrases_keywords(
        text,
        words,
        &[
            "show my reminders",
            "list my reminders",
            "my reminders",
            "what reminders do i have",
            "show reminders",
        ],
        &["reminders"],
        &[],
    );
    if show > 0.0 {
        out.push(IntentCandidate {
            intent: Intent::ShowReminders,
            confidence: show,
            priority: 1,
            entities: JevParams::default(),
            source: "show_reminders",
            safety: SafetyClass::ReadOnly,
        });
    }

    // "cancel/delete/remove ... reminder" → NEVER executes from
    // recovery. The decision layer routes this to the reminder list
    // (the existing ambiguous-cancel behavior).
    let cancel_verb = ["cancel", "delete", "remove"]
        .iter()
        .any(|v| contains_word(text, v));
    let mentions_reminder =
        contains_word(text, "reminder") || contains_word(text, "reminders");
    if cancel_verb && mentions_reminder {
        out.push(IntentCandidate {
            intent: Intent::CancelReminder,
            confidence: 0.80,
            priority: 2,
            entities: JevParams::default(),
            source: "cancel_reminder",
            safety: SafetyClass::Destructive,
        });
    }

    // "remind me ..." / "set ... reminder" → create.
    let remind_score = score_phrases_keywords(
        text,
        words,
        &[
            "remind me to",
            "remind me",
            "set a reminder",
            "set reminder",
            "create a reminder",
            "add a reminder",
            "new reminder",
        ],
        &["remind", "reminder"],
        &[],
    );
    if remind_score > 0.0 && !(cancel_verb && mentions_reminder) {
        let (title, datetime) = extract_reminder_parts(text);
        let mut params = JevParams::default();
        params.title = title;
        params.datetime = datetime;
        // A bare "reminder" with nothing else is weak; verbs carry it.
        let conf = if params.title.is_some() || params.datetime.is_some() {
            remind_score.max(0.60)
        } else {
            remind_score.min(0.55)
        };
        out.push(IntentCandidate {
            intent: Intent::SetReminder,
            confidence: conf,
            priority: 2,
            entities: params,
            source: "set_reminder",
            safety: SafetyClass::Config,
        });
    }
    out
}

fn match_conversational(text: &str) -> Vec<IntentCandidate> {
    let mut out = Vec::new();
    // (intent, exact texts)
    let specs: &[(Intent, &[&str])] = &[
        (
            Intent::Greeting,
            &[
                "hi",
                "hello",
                "hey",
                "good morning",
                "good afternoon",
                "good evening",
            ],
        ),
        (Intent::HowAreYou, &["how are you", "how are you doing"]),
        (
            Intent::WhatIsYourName,
            &["what is your name", "whats your name", "your name"],
        ),
        (Intent::WhoAreYou, &["who are you"]),
        (Intent::Thanks, &["thanks", "thank you", "thank you very much"]),
        (
            Intent::Goodbye,
            &["bye", "goodbye", "good night", "see you", "see you later"],
        ),
    ];
    for (intent, texts) in specs {
        if texts.iter().any(|t| text == *t) {
            out.push(IntentCandidate {
                intent: *intent,
                confidence: 0.95,
                priority: 0,
                entities: JevParams::default(),
                source: "conversational",
                safety: SafetyClass::ReadOnly,
            });
        }
    }
    out
}

fn match_settings_help(text: &str, words: &[&str]) -> Vec<IntentCandidate> {
    let mut out = Vec::new();
    let settings = score_phrases_keywords(
        text,
        words,
        &["open settings", "go to settings", "show settings"],
        &["settings"],
        &[],
    );
    if settings > 0.0 {
        out.push(IntentCandidate {
            intent: Intent::OpenSettings,
            confidence: settings.max(0.60),
            priority: 1,
            entities: JevParams::default(),
            source: "settings",
            safety: SafetyClass::ReadOnly,
        });
    }
    if contains_word(text, "help") {
        out.push(IntentCandidate {
            intent: Intent::Help,
            confidence: 0.60,
            priority: 0,
            entities: JevParams::default(),
            source: "help",
            safety: SafetyClass::ReadOnly,
        });
    }
    out
}

/// Run every family matcher and return candidates sorted by
/// confidence (highest first), with near-tie ambiguity resolved by
/// priority.
pub fn interpret(raw: &str) -> Vec<IntentCandidate> {
    let text = normalize_transcript(raw);
    if text.is_empty() {
        return Vec::new();
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut cands = Vec::new();
    cands.extend(match_system_info(&text, &words));
    cands.extend(match_time_date(&text, &words));
    cands.extend(match_applications(raw, &text, &words));
    cands.extend(match_close_no_app(&text));
    cands.extend(match_open_in_app(raw, &words));
    cands.extend(match_files_folders(raw, &text, &words));
    cands.extend(match_create_folder(raw, &text, &words));
    cands.extend(match_reminders(&text, &words));
    cands.extend(match_conversational(&text));
    cands.extend(match_settings_help(&text, &words));

    cands.retain(|c| c.confidence >= 0.30);
    cands.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Ambiguity: two strong candidates within a hair of each other with
    // equal priority → neither is trustworthy. Cap the winner below
    // every execute threshold so the decision layer asks for a repeat
    // instead of guessing.
    if cands.len() >= 2 {
        let (a, b) = (&cands[0], &cands[1]);
        if b.confidence >= 0.40
            && a.confidence - b.confidence < 0.12
            && a.priority == b.priority
            && a.intent != b.intent
        {
            idebug!(
                "ambiguous: {} ({:.2}) vs {} ({:.2})",
                a.intent.as_str(),
                a.confidence,
                b.intent.as_str(),
                b.confidence
            );
            cands[0].confidence = cands[0].confidence.min(0.40);
        }
    }
    cands
}

// ---------------------------------------------------------------------------
// 3. Confidence + requirement evaluation
// ---------------------------------------------------------------------------

/// What the interpreter decided to do with the transcript.
#[derive(Debug, Clone)]
pub enum Decision {
    /// All required entities present, confidence clears the safety bar.
    Execute {
        intent: Intent,
        params: JevParams,
        confidence: f32,
    },
    /// Entities present but confidence is middling (or the intent is
    /// destructive): ask "Do you want me to …?" first.
    Confirm {
        intent: Intent,
        params: JevParams,
        question_key: &'static str,
        question_params: serde_json::Value,
    },
    /// An entity is missing: ask the smallest possible question and
    /// keep the conversation alive via pending state.
    Clarify {
        intent: Intent,
        params: JevParams,
        missing: EntityKind,
        question_key: &'static str,
        question_params: serde_json::Value,
    },
    /// Cancel-recovery: open the reminder list (never delete on a guess).
    ShowRemindersList,
    /// Weak signal: ask the user to repeat.
    AskRepeat,
    /// Genuinely nothing: fall through to the existing unknown path.
    Unknown,
}

/// Required entities per intent for the recovery path.
fn required_entities(intent: Intent) -> &'static [EntityKind] {
    match intent {
        Intent::OpenApplication | Intent::CloseApplication => &[EntityKind::Application],
        Intent::FindFile | Intent::OpenFile | Intent::OpenFolder => &[EntityKind::Query],
        Intent::OpenInApplication => &[EntityKind::Query, EntityKind::Application],
        Intent::CreateFolder => &[EntityKind::FolderName],
        Intent::SetReminder => &[EntityKind::ReminderTitle, EntityKind::ReminderTime],
        _ => &[],
    }
}

fn has_entity(params: &JevParams, kind: EntityKind) -> bool {
    match kind {
        EntityKind::Application => params.application.as_deref().is_some_and(|s| !s.is_empty()),
        EntityKind::Query => params.query.as_deref().is_some_and(|s| !s.is_empty()),
        EntityKind::FolderName => params.name.as_deref().is_some_and(|s| !s.is_empty()),
        EntityKind::ReminderTitle => params.title.as_deref().is_some_and(|s| !s.is_empty()),
        EntityKind::ReminderTime => params.datetime.as_deref().is_some_and(|s| !s.is_empty()),
    }
}

fn missing_entity(intent: Intent, params: &JevParams) -> Option<EntityKind> {
    required_entities(intent)
        .iter()
        .copied()
        .find(|k| !has_entity(params, *k))
}

/// The clarification question for a missing entity.
fn clarify_question(
    intent: Intent,
    missing: EntityKind,
    params: &JevParams,
) -> (&'static str, serde_json::Value) {
    match (intent, missing) {
        (Intent::OpenApplication, EntityKind::Application) => {
            ("convClarifyAppOpen", serde_json::json!({}))
        }
        (Intent::CloseApplication, EntityKind::Application) => {
            ("convClarifyAppClose", serde_json::json!({}))
        }
        (Intent::SetReminder, EntityKind::ReminderTitle) => {
            ("convClarifyReminderTitle", serde_json::json!({}))
        }
        (Intent::SetReminder, EntityKind::ReminderTime) => (
            "convClarifyReminderTime",
            serde_json::json!({ "title": params.title.clone().unwrap_or_default() }),
        ),
        (Intent::FindFile, EntityKind::Query) => {
            ("convClarifyFileQuery", serde_json::json!({}))
        }
        // "open" with no target: it could be an app or a file.
        (Intent::OpenFile, EntityKind::Query) => ("convClarifyOpenTarget", serde_json::json!({})),
        // "open X in Y" with the app missing: reuse the app question.
        (Intent::OpenInApplication, EntityKind::Application) => {
            ("convClarifyAppOpen", serde_json::json!({}))
        }
        // "open X in Y" with the target missing: reuse the target question.
        (Intent::OpenInApplication, EntityKind::Query) => {
            ("convClarifyOpenTarget", serde_json::json!({}))
        }
        (Intent::CreateFolder, EntityKind::FolderName) => {
            ("convClarifyFolderName", serde_json::json!({}))
        }
        _ => ("convAskRepeat", serde_json::json!({})),
    }
}

/// The confirmation question for a middling-confidence or destructive
/// intent whose entities are all present.
fn confirm_question(intent: Intent, params: &JevParams) -> (&'static str, serde_json::Value) {
    match intent {
        Intent::OpenApplication => (
            "convConfirmOpenApp",
            serde_json::json!({ "app": params.application.clone().unwrap_or_default() }),
        ),
        Intent::CloseApplication => (
            "convConfirmCloseApp",
            serde_json::json!({ "app": params.application.clone().unwrap_or_default() }),
        ),
        Intent::SetReminder => (
            "convConfirmReminder",
            serde_json::json!({ "title": params.title.clone().unwrap_or_default() }),
        ),
        Intent::OpenInApplication => (
            "convConfirmOpenInApp",
            serde_json::json!({
                "name": params.query.clone().unwrap_or_default(),
                "app": params.application.clone().unwrap_or_default(),
            }),
        ),
        _ => ("convAskRepeat", serde_json::json!({})),
    }
}

pub fn decide(candidates: &[IntentCandidate]) -> Decision {
    let Some(top) = candidates.first() else {
        return Decision::Unknown;
    };
    idebug!(
        "top candidate: {} conf={:.2} src={}",
        top.intent.as_str(),
        top.confidence,
        top.source
    );

    // Destructive intents never execute from recovery — not even at
    // high confidence. CancelReminder routes to the reminder list;
    // CloseApplication asks first.
    if top.intent == Intent::CancelReminder {
        return Decision::ShowRemindersList;
    }

    if let Some(missing) = missing_entity(top.intent, &top.entities) {
        if top.confidence >= 0.45 {
            let (key, qparams) = clarify_question(top.intent, missing, &top.entities);
            return Decision::Clarify {
                intent: top.intent,
                params: top.entities.clone(),
                missing,
                question_key: key,
                question_params: qparams,
            };
        }
        return Decision::AskRepeat;
    }

    if top.confidence >= top.safety.execute_threshold() {
        return Decision::Execute {
            intent: top.intent,
            params: top.entities.clone(),
            confidence: top.confidence,
        };
    }
    if top.confidence >= 0.55 && top.safety != SafetyClass::ReadOnly {
        let (key, qparams) = confirm_question(top.intent, &top.entities);
        // Intents with no meaningful confirmation question fall back
        // to asking for a repeat.
        if key == "convAskRepeat" {
            return Decision::AskRepeat;
        }
        return Decision::Confirm {
            intent: top.intent,
            params: top.entities.clone(),
            question_key: key,
            question_params: qparams,
        };
    }
    if top.confidence >= 0.30 {
        return Decision::AskRepeat;
    }
    Decision::Unknown
}

// ---------------------------------------------------------------------------
// 4. Short-term conversation state
// ---------------------------------------------------------------------------

/// How long a pending clarification/confirmation survives without a
/// follow-up. Deliberately short: this is a single conversational
/// beat, not memory.
const PENDING_TTL: Duration = Duration::from_secs(90);
const MAX_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone)]
pub enum PendingKind {
    AwaitingConfirmation,
    AwaitingEntity { missing: EntityKind },
}

#[derive(Debug, Clone)]
pub struct PendingInteraction {
    pub kind: PendingKind,
    pub intent: Intent,
    pub params: JevParams,
    pub attempts: u8,
    pub created_at: Instant,
}

impl PendingInteraction {
    pub fn awaiting_confirmation(intent: Intent, params: JevParams) -> Self {
        PendingInteraction {
            kind: PendingKind::AwaitingConfirmation,
            intent,
            params,
            attempts: 0,
            created_at: Instant::now(),
        }
    }

    pub fn awaiting_entity(intent: Intent, params: JevParams, missing: EntityKind) -> Self {
        PendingInteraction {
            kind: PendingKind::AwaitingEntity { missing },
            intent,
            params,
            attempts: 0,
            created_at: Instant::now(),
        }
    }

    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() >= PENDING_TTL
    }

    fn bumped(mut self) -> Self {
        self.attempts += 1;
        self
    }
}

/// What the pending state decided about this follow-up transcript.
#[derive(Debug)]
pub enum PendingResolution {
    /// The follow-up completed the intent: execute this.
    Execute(JevResult),
    /// Still missing something (or unparseable): re-ask the question,
    /// carrying the updated pending state.
    Reask {
        pending: PendingInteraction,
        question_key: &'static str,
        question_params: serde_json::Value,
        intent: Intent,
    },
    /// The user cancelled ("no", "never mind").
    Cancelled,
    /// Too many failed attempts: give up gracefully.
    GiveUp,
    /// Not a continuation — run the normal interpretation path.
    NotContinuation,
}

fn is_affirmative(text: &str) -> bool {
    matches!(
        text,
        "yes" | "yeah" | "yep" | "yup" | "sure" | "ok" | "okay" | "do it" | "go ahead"
            | "please do" | "correct" | "right" | "athe" | "shari" | "seri" | "mathi"
    ) || text.starts_with("yes ")
}

fn is_negative(text: &str) -> bool {
    matches!(
        text,
        "no" | "nope" | "nah" | "cancel" | "never mind" | "nevermind" | "stop" | "dont"
            | "venda" | "alla" | "no thanks"
    ) || text.starts_with("no ")
        || text.starts_with("dont ")
        || text.starts_with("do not ")
}

/// Try to resolve a follow-up transcript against pending state.
/// Called only for transcripts the main parser rejected, so "yes" and
/// "nine tomorrow" land here while real commands never do.
pub fn resolve_pending(pending: &PendingInteraction, raw: &str) -> PendingResolution {
    let text = normalize_transcript(raw);
    if text.is_empty() {
        // An unintelligible grunt ("uh") while Nila is awaiting an
        // entity: re-ask the question rather than dropping the thread.
        // While awaiting a yes/no it means nothing — not a continuation.
        return match &pending.kind {
            PendingKind::AwaitingEntity { .. } => reask_or_give_up(pending),
            PendingKind::AwaitingConfirmation => PendingResolution::NotContinuation,
        };
    }

    match &pending.kind {
        PendingKind::AwaitingConfirmation => {
            if is_affirmative(&text) {
                PendingResolution::Execute(JevResult {
                    intent: pending.intent,
                    parameters: pending.params.clone(),
                    message: None,
                })
            } else if is_negative(&text) {
                PendingResolution::Cancelled
            } else {
                PendingResolution::NotContinuation
            }
        }
        PendingKind::AwaitingEntity { missing } => {
            if is_negative(&text) {
                return PendingResolution::Cancelled;
            }
            if is_affirmative(&text) {
                // A bare "yes" is not a title, time, or name.
                return PendingResolution::NotContinuation;
            }
            let mut params = pending.params.clone();
            match missing {
                EntityKind::ReminderTitle => {
                    let (title, datetime) = extract_reminder_parts(&text);
                    // The follow-up may carry both ("call john at 9").
                    if let Some(t) = title {
                        params.title = Some(t);
                    }
                    if params.datetime.is_none() {
                        params.datetime = datetime;
                    }
                    if params.title.is_none() {
                        return reask_or_give_up(pending);
                    }
                }
                EntityKind::ReminderTime => {
                    match extract_time_tail(&text) {
                        Some((at, _)) => params.datetime = Some(at.to_rfc3339()),
                        None => return reask_or_give_up(pending),
                    }
                }
                EntityKind::Application => {
                    let words: Vec<&str> = text.split_whitespace().collect();
                    let stripped = strip_leading_noise(&words, &[]);
                    match find_app_name(&stripped).or_else(|| find_app_name(&words)) {
                        Some(app) => params.application = Some(app),
                        None => return reask_or_give_up(pending),
                    }
                }
                EntityKind::Query => {
                    let words: Vec<&str> = text.split_whitespace().collect();
                    let q = strip_leading_noise(
                        &words,
                        &["find", "search", "locate", "look", "for", "me", "my", "the", "a"],
                    )
                    .join(" ");
                    if q.is_empty() {
                        return reask_or_give_up(pending);
                    }
                    params.query = Some(q);
                }
                EntityKind::FolderName => {
                    let name = text.trim().to_string();
                    if name.is_empty() {
                        return reask_or_give_up(pending);
                    }
                    params.name = Some(name);
                }
            }
            // All required entities present? Execute. Otherwise ask for
            // the next missing one (e.g. title given, time still missing).
            match missing_entity(pending.intent, &params) {
                None => PendingResolution::Execute(JevResult {
                    intent: pending.intent,
                    parameters: params,
                    message: None,
                }),
                Some(next) => {
                    let (key, qparams) = clarify_question(pending.intent, next, &params);
                    let mut next_pending = pending.clone();
                    next_pending.params = params;
                    next_pending.kind = PendingKind::AwaitingEntity { missing: next };
                    PendingResolution::Reask {
                        pending: next_pending.bumped(),
                        question_key: key,
                        question_params: qparams,
                        intent: pending.intent,
                    }
                }
            }
        }
    }
}

fn reask_or_give_up(pending: &PendingInteraction) -> PendingResolution {
    if pending.attempts + 1 >= MAX_ATTEMPTS {
        return PendingResolution::GiveUp;
    }
    let missing = match &pending.kind {
        PendingKind::AwaitingEntity { missing } => *missing,
        PendingKind::AwaitingConfirmation => return PendingResolution::GiveUp,
    };
    let (key, qparams) = clarify_question(pending.intent, missing, &pending.params);
    PendingResolution::Reask {
        pending: pending.clone().bumped(),
        question_key: key,
        question_params: qparams,
        intent: pending.intent,
    }
}

// ---------------------------------------------------------------------------
// 5. Recovery entry point (wired into the pipeline in mod.rs)
// ---------------------------------------------------------------------------

/// Run the recovery interpreter for a transcript the main parser (or
/// Jev API) rejected. Emits the same `jev:result` / `jev:ui_action`
/// events the normal path uses, so the frontend needs no changes.
pub fn recover(app: &AppHandle, state: &JevState, raw_text: &str) {
    let normalized = normalize_transcript(raw_text);
    idebug!("raw={:?} normalized={:?}", raw_text, normalized);

    // Pending conversation first: "yes" / "nine tomorrow" only make
    // sense against the question Nila just asked.
    {
        let mut guard = state.pending.lock().expect("jev pending poisoned");
        if let Some(pending) = guard.take() {
            match resolve_pending(&pending, raw_text) {
                PendingResolution::Execute(result) => {
                    idebug!("pending resolved → execute {}", result.intent.as_str());
                    drop(guard);
                    let intent_str = result.intent.as_str();
                    emit_action_detected(app, intent_str);
                    execute_validated(app, state, &result);
                    return;
                }
                PendingResolution::Reask {
                    pending: next_pending,
                    question_key,
                    question_params,
                    intent: _,
                } => {
                    idebug!("pending re-ask {question_key}");
                    *guard = Some(next_pending);
                    drop(guard);
                    // A re-asked question is not the pending action: emit
                    // the "clarify" marker so the frontend keeps the
                    // conversation open instead of treating the pending
                    // action's intent (e.g. "new_reminder") as terminal.
                    emit_interpret_result(app, "clarify", question_key, question_params);
                    return;
                }
                PendingResolution::Cancelled => {
                    idebug!("pending cancelled by user");
                    drop(guard);
                    emit_interpret_result(app, "cancel", "convOkay", serde_json::json!({}));
                    return;
                }
                PendingResolution::GiveUp => {
                    idebug!("pending gave up after attempts");
                    drop(guard);
                    emit_interpret_result(app, "unknown", "convAskRepeat", serde_json::json!({}));
                    return;
                }
                PendingResolution::NotContinuation => {
                    // Keep the pending state: an uninterpretable mumble
                    // shouldn't kill the open question. It expires on its
                    // own, and any confident new command clears it.
                    *guard = Some(pending);
                }
            }
        }
    }

    let candidates = interpret(raw_text);
    for c in candidates.iter().take(4) {
        idebug!(
            "candidate {} conf={:.2} src={}",
            c.intent.as_str(),
            c.confidence,
            c.source
        );
    }
    let decision = decide(&candidates);
    idebug!("decision: {:?}", decision_kind(&decision));

    // A real interpretation supersedes any pending question.
    let mut guard = state.pending.lock().expect("jev pending poisoned");
    match decision {
        Decision::Execute {
            intent,
            params,
            confidence,
        } => {
            idebug!("execute {} conf={:.2}", intent.as_str(), confidence);
            *guard = None;
            drop(guard);
            let result = JevResult {
                intent,
                parameters: params,
                message: None,
            };
            emit_action_detected(app, intent.as_str());
            execute_validated(app, state, &result);
        }
        Decision::Confirm {
            intent,
            params,
            question_key,
            question_params,
        } => {
            *guard = Some(PendingInteraction::awaiting_confirmation(intent, params));
            drop(guard);
            // A confirmation question is not the action itself: emit the
            // "confirm" marker so the frontend keeps the conversation
            // open for the yes/no answer.
            emit_interpret_result(app, "confirm", question_key, question_params);
        }
        Decision::Clarify {
            intent,
            params,
            missing,
            question_key,
            question_params,
        } => {
            *guard = Some(PendingInteraction::awaiting_entity(intent, params, missing));
            drop(guard);
            // A clarification question is not the pending action: emit
            // the "clarify" marker so the frontend keeps the conversation
            // open instead of treating the pending action's intent (e.g.
            // "new_reminder") as terminal.
            emit_interpret_result(app, "clarify", question_key, question_params);
        }
        Decision::ShowRemindersList => {
            // The existing ambiguous-cancel behavior: open the list so
            // the user picks. Never delete on a fuzzy match.
            *guard = None;
            drop(guard);
            UIActionHandler::handle(app, &ValidatedAction::UiShowReminders);
        }
        Decision::AskRepeat => {
            drop(guard);
            emit_interpret_result(app, "unknown", "convAskRepeat", serde_json::json!({}));
        }
        Decision::Unknown => {
            drop(guard);
            // Genuinely nothing: the existing unknown path, unchanged.
            let result = unknown_result();
            emit_action_detected(app, result.intent.as_str());
            execute_validated(app, state, &result);
        }
    }
}

fn decision_kind(d: &Decision) -> &'static str {
    match d {
        Decision::Execute { .. } => "execute",
        Decision::Confirm { .. } => "confirm",
        Decision::Clarify { .. } => "clarify",
        Decision::ShowRemindersList => "show_reminders_list",
        Decision::AskRepeat => "ask_repeat",
        Decision::Unknown => "unknown",
    }
}

// ---------------------------------------------------------------------------
// Tests — the imperfect-STT suite (§20 of the spec).
//
// For each intended command: complete, shortened, missing words,
// misheard words, repeated words, partial phrases. Plus negative
// cases: destructive intents must never execute from a fuzzy match,
// and near-miss nouns must not auto-execute.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Interpret + decide, returning the decision for a transcript.
    fn decide_for(transcript: &str) -> Decision {
        let cands = interpret(transcript);
        decide(&cands)
    }

    fn executes_as(transcript: &str) -> Option<(Intent, JevParams)> {
        match decide_for(transcript) {
            Decision::Execute { intent, params, .. } => Some((intent, params)),
            _ => None,
        }
    }

    fn battery_execute(transcript: &str) -> JevParams {
        match executes_as(transcript) {
            Some((Intent::SystemInfo, p)) => {
                assert_eq!(p.metric.as_deref(), Some("battery"), "{transcript}");
                p
            }
            other => panic!("{transcript:?} should execute battery_status, got {other:?}"),
        }
    }

    // --- normalization ----------------------------------------------------

    #[test]
    fn normalization_basics() {
        assert_eq!(normalize_transcript("  Show MY battery level? "), "show my battery level");
        assert_eq!(normalize_transcript("Battery... level!"), "battery level");
        assert_eq!(normalize_transcript("what's the time"), "whats the time");
    }

    #[test]
    fn normalization_strips_fillers() {
        assert_eq!(normalize_transcript("please show my battery please"), "show my battery");
        assert_eq!(normalize_transcript("could you check battery"), "check battery");
        assert_eq!(normalize_transcript("uh battery level"), "battery level");
        assert_eq!(normalize_transcript("nila what time is it"), "what time is it");
    }

    #[test]
    fn normalization_dedupes_repeated_words() {
        assert_eq!(normalize_transcript("show show my battery"), "show my battery");
        assert_eq!(normalize_transcript("open open firefox"), "open firefox");
    }

    #[test]
    fn normalization_fixes_vocab_typos() {
        assert_eq!(normalize_transcript("batter level"), "battery level");
        assert_eq!(normalize_transcript("firfox"), "firefox");
        assert_eq!(normalize_transcript("helo"), "hello");
        assert_eq!(normalize_transcript("serch for my file"), "search for my file");
        assert_eq!(normalize_transcript("open crom"), "open chrome");
    }

    #[test]
    fn normalization_is_conservative() {
        // "better" is a real word — never rewritten to "battery".
        assert_eq!(normalize_transcript("show me better options"), "show me better options");
        // Titles keep their words (only case/whitespace cleaned).
        assert_eq!(normalize_transcript("Call chapter two"), "call chapter two");
        // Non-Latin script passes through untouched.
        assert_eq!(normalize_transcript("ബാറ്ററി"), "ബാറ്ററി");
    }

    // --- battery: the spec's headline example ------------------------------

    #[test]
    fn battery_variants_all_execute() {
        for t in [
            "show my battery level",
            "show my battery",
            "battery level",
            "my battery",
            "battery",
            "batter level",       // misheard
            "how much battery",
            "battery percentage",
            "Show My Battery Level?", // case + punctuation
            "please check battery",   // filler words
            "show show my battery",   // repeated words
        ] {
            battery_execute(t);
        }
    }

    #[test]
    fn battery_charger_does_not_execute() {
        // "battery charger" is about the charger hardware, not a status
        // request — it must never auto-execute battery_status.
        match decide_for("battery charger") {
            Decision::Execute { intent, .. } => {
                panic!("battery charger must not execute, got {intent:?}")
            }
            Decision::AskRepeat | Decision::Unknown => {}
            other => panic!("unexpected decision {other:?}"),
        }
    }

    // --- time / date --------------------------------------------------------

    #[test]
    fn time_variants_execute() {
        for t in [
            "what time is it",
            "whats the time",
            "tell me the time",
            "current time",
            "time",
        ] {
            assert!(
                matches!(executes_as(t), Some((Intent::CurrentTime, _))),
                "{t:?} should execute current_time"
            );
        }
    }

    #[test]
    fn date_variants_execute() {
        for t in [
            "what is the date",
            "whats the date",
            "todays date",
            "today",
        ] {
            assert!(
                matches!(executes_as(t), Some((Intent::CurrentDate, _))),
                "{t:?} should execute current_date"
            );
        }
    }

    // --- open in application --------------------------------------------------

    #[test]
    fn open_in_app_fuzzy_executes() {
        // STT-mangled "open X in Y" still resolves to the specific intent
        // (the clean form never reaches recovery — the parser owns it).
        match executes_as("open the nyla folder in crom") {
            Some((Intent::OpenInApplication, p)) => {
                assert_eq!(p.query.as_deref(), Some("nyla"));
                assert_eq!(p.application.as_deref(), Some("chrome"));
            }
            other => panic!("expected open_in_application execute, got {other:?}"),
        }
    }

    #[test]
    fn open_in_app_noisy_asks_first() {
        // Trailing ramble dilutes confidence below the execute bar →
        // confirmation instead of a surprise launch.
        match decide_for("open nila in code now now now") {
            Decision::Confirm { intent, .. } => {
                assert_eq!(intent, Intent::OpenInApplication)
            }
            other => panic!("expected confirm, got {other:?}"),
        }
    }

    #[test]
    fn open_in_app_unknown_app_not_matched() {
        // No allowlisted app after "in": not this intent.
        let cands = interpret("open nila in vlcplayer");
        assert!(
            !cands.iter().any(|c| c.intent == Intent::OpenInApplication),
            "unexpected open_in_application candidate"
        );
    }

    // --- applications ---------------------------------------------------------

    #[test]
    fn open_firefox_variants() {
        // Full command → execute.
        match executes_as("open firefox") {
            Some((Intent::OpenApplication, p)) => {
                assert_eq!(p.application.as_deref(), Some("firefox"))
            }
            other => panic!("unexpected {other:?}"),
        }
        // Bare app name → confirm, never surprise-launch.
        match decide_for("firefox") {
            Decision::Confirm { intent, question_key, .. } => {
                assert_eq!(intent, Intent::OpenApplication);
                assert_eq!(question_key, "convConfirmOpenApp");
            }
            other => panic!("bare app name should confirm, got {other:?}"),
        }
    }

    #[test]
    fn close_is_destructive_and_asks_first() {
        // Even the full "close firefox" never executes from recovery.
        match decide_for("close firefox") {
            Decision::Confirm { intent, question_key, .. } => {
                assert_eq!(intent, Intent::CloseApplication);
                assert_eq!(question_key, "convConfirmCloseApp");
            }
            other => panic!("close must confirm, got {other:?}"),
        }
        // "close" alone → which app?
        match decide_for("close") {
            Decision::Clarify { question_key, .. } => {
                assert_eq!(question_key, "convClarifyAppClose");
            }
            other => panic!("bare close should clarify, got {other:?}"),
        }
    }

    #[test]
    fn app_name_with_noise_does_not_execute() {
        // "firefox is slow" is a comment, not a command.
        match decide_for("firefox is slow") {
            Decision::Execute { .. } => panic!("must not execute on noise"),
            _ => {}
        }
    }

    // --- files ------------------------------------------------------------------

    #[test]
    fn find_file_variants() {
        match executes_as("find my resume") {
            Some((Intent::FindFile, p)) => assert_eq!(p.query.as_deref(), Some("resume")),
            other => panic!("unexpected {other:?}"),
        }
        // Partial verb drop still finds the verb.
        match executes_as("search resume") {
            Some((Intent::FindFile, p)) => assert_eq!(p.query.as_deref(), Some("resume")),
            other => panic!("unexpected {other:?}"),
        }
        // Verb with no query → ask which file.
        match decide_for("find") {
            Decision::Clarify { question_key, .. } => {
                assert_eq!(question_key, "convClarifyFileQuery")
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn open_with_no_target_asks() {
        match decide_for("open") {
            Decision::Clarify { question_key, .. } => {
                assert_eq!(question_key, "convClarifyOpenTarget")
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn hostile_transcript_never_builds_entities() {
        for t in [
            "open firefox; rm -rf ~",
            "find my resume | cat /etc/passwd",
            "close firefox && reboot",
        ] {
            match decide_for(t) {
                Decision::Execute { .. } => panic!("{t:?} must never execute"),
                Decision::Confirm { .. } => panic!("{t:?} must never confirm"),
                _ => {}
            }
        }
    }

    // --- reminders ----------------------------------------------------------------

    #[test]
    fn reminder_with_title_and_time_executes() {
        match executes_as("set reminder call john tomorrow at 9") {
            Some((Intent::SetReminder, p)) => {
                assert_eq!(p.title.as_deref(), Some("call john"));
                assert!(p.datetime.as_deref().is_some_and(|d| d.contains("T09:00:00")));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn reminder_missing_title_asks_for_it() {
        // Spec case 5: "Set a reminder for tomorrow at 9" → "reminder tomorrow 9".
        match decide_for("reminder tomorrow 9") {
            Decision::Clarify {
                intent,
                missing,
                question_key,
                params,
                ..
            } => {
                assert_eq!(intent, Intent::SetReminder);
                assert_eq!(missing, EntityKind::ReminderTitle);
                assert_eq!(question_key, "convClarifyReminderTitle");
                // The time was already extracted and is carried over.
                assert!(params.datetime.as_deref().is_some_and(|d| d.contains("T09:00:00")));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn reminder_missing_time_asks_for_it() {
        match decide_for("remind me to call john") {
            Decision::Clarify {
                intent,
                missing,
                question_key,
                ..
            } => {
                assert_eq!(intent, Intent::SetReminder);
                assert_eq!(missing, EntityKind::ReminderTime);
                assert_eq!(question_key, "convClarifyReminderTime");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn bare_number_is_not_a_time() {
        // "call john 2" — the 2 is part of the title, not 2 o'clock.
        let (title, datetime) = extract_reminder_parts("call john 2");
        assert_eq!(title.as_deref(), Some("call john 2"));
        assert_eq!(datetime, None);
    }

    #[test]
    fn number_words_become_times() {
        // Spec §11: "nine tomorrow" → 09:00 tomorrow.
        let (at, rest) = extract_time_tail("nine tomorrow").expect("should parse");
        assert_eq!(rest, "");
        assert_eq!(at.format("%H:%M").to_string(), "09:00");
        let tomorrow = (Local::now() + chrono::Duration::days(1)).date_naive();
        assert_eq!(at.date_naive(), tomorrow);
    }

    #[test]
    fn cancel_recovery_opens_list_never_deletes() {
        for t in ["cancel my reminder", "delete reminder", "remove my reminder"] {
            assert!(
                matches!(decide_for(t), Decision::ShowRemindersList),
                "{t:?} should open the list, never delete"
            );
        }
    }

    #[test]
    fn show_reminders_partial_executes() {
        assert!(matches!(
            executes_as("reminders"),
            Some((Intent::ShowReminders, _))
        ));
    }

    // --- conversational ---------------------------------------------------------

    #[test]
    fn greeting_typo_recovers() {
        assert!(matches!(
            executes_as("helo"),
            Some((Intent::Greeting, _))
        ));
    }

    #[test]
    fn help_me_find_my_file_is_a_search() {
        // The action verb outranks the bare "help" noun.
        match executes_as("help me find my file") {
            Some((Intent::FindFile, p)) => assert_eq!(p.query.as_deref(), Some("file")),
            other => panic!("unexpected {other:?}"),
        }
    }

    // --- pending conversation state -----------------------------------------------

    fn confirm_pending() -> PendingInteraction {
        let mut params = JevParams::default();
        params.application = Some("firefox".to_string());
        PendingInteraction::awaiting_confirmation(Intent::OpenApplication, params)
    }

    #[test]
    fn pending_confirmation_yes_executes() {
        match resolve_pending(&confirm_pending(), "yes") {
            PendingResolution::Execute(r) => {
                assert_eq!(r.intent, Intent::OpenApplication);
                assert_eq!(r.parameters.application.as_deref(), Some("firefox"));
            }
            other => panic!("unexpected {other:?}"),
        }
        // Manglish yes.
        assert!(matches!(
            resolve_pending(&confirm_pending(), "athe"),
            PendingResolution::Execute(_)
        ));
    }

    #[test]
    fn pending_confirmation_no_cancels() {
        assert!(matches!(
            resolve_pending(&confirm_pending(), "no"),
            PendingResolution::Cancelled
        ));
        assert!(matches!(
            resolve_pending(&confirm_pending(), "never mind"),
            PendingResolution::Cancelled
        ));
    }

    #[test]
    fn pending_confirmation_other_is_not_continuation() {
        assert!(matches!(
            resolve_pending(&confirm_pending(), "maybe later"),
            PendingResolution::NotContinuation
        ));
    }

    #[test]
    fn pending_entity_title_then_execute() {
        // "reminder tomorrow 9" → asked for title; user says "call john".
        let mut params = JevParams::default();
        params.datetime = Some("2030-05-01T09:00:00+05:30".to_string());
        let pending =
            PendingInteraction::awaiting_entity(Intent::SetReminder, params, EntityKind::ReminderTitle);
        match resolve_pending(&pending, "call john") {
            PendingResolution::Execute(r) => {
                assert_eq!(r.intent, Intent::SetReminder);
                assert_eq!(r.parameters.title.as_deref(), Some("call john"));
                assert!(r.parameters.datetime.is_some());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn pending_entity_time_nine_tomorrow() {
        // Spec §11: Nila asked "What time?", user says "nine tomorrow".
        let mut params = JevParams::default();
        params.title = Some("call john".to_string());
        let pending =
            PendingInteraction::awaiting_entity(Intent::SetReminder, params, EntityKind::ReminderTime);
        match resolve_pending(&pending, "nine tomorrow") {
            PendingResolution::Execute(r) => {
                let at = r.parameters.datetime.expect("datetime");
                assert!(at.contains("T09:00:00"), "{at}");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn pending_entity_bad_time_reasks_then_gives_up() {
        let params = JevParams::default();
        let pending =
            PendingInteraction::awaiting_entity(Intent::SetReminder, params, EntityKind::ReminderTitle);
        // Empty-ish follow-ups re-ask…
        assert!(matches!(
            resolve_pending(&pending, "uh"),
            PendingResolution::Reask { .. }
        ));
        // …until attempts run out.
        let mut p = pending;
        for _ in 0..MAX_ATTEMPTS {
            match resolve_pending(&p, "uh") {
                PendingResolution::Reask { pending: next, .. } => p = next,
                PendingResolution::GiveUp => return,
                other => panic!("unexpected {other:?}"),
            }
        }
        panic!("should have given up");
    }

    #[test]
    fn pending_expires() {
        let mut p = confirm_pending();
        p.created_at = Instant::now() - Duration::from_secs(3600);
        assert!(p.is_expired());
        assert!(!confirm_pending().is_expired());
    }

    #[test]
    fn pending_entity_chains_to_next_missing() {
        // Title given, time still missing → ask for time next.
        let params = JevParams::default();
        let pending =
            PendingInteraction::awaiting_entity(Intent::SetReminder, params, EntityKind::ReminderTitle);
        match resolve_pending(&pending, "call john") {
            PendingResolution::Reask {
                question_key,
                pending: next,
                ..
            } => {
                assert_eq!(question_key, "convClarifyReminderTime");
                assert!(matches!(
                    next.kind,
                    PendingKind::AwaitingEntity {
                        missing: EntityKind::ReminderTime
                    }
                ));
                assert_eq!(next.params.title.as_deref(), Some("call john"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    // --- ambiguity & safety ---------------------------------------------------------

    #[test]
    fn weak_signal_asks_for_repeat_not_execute() {
        // A mishearing with no command vocabulary ("butter") → unknown,
        // never an action. A faint-but-capped signal ("battery charger")
        // → ask for a repeat, never execute.
        assert!(matches!(decide_for("butter uh"), Decision::Unknown));
        assert!(matches!(
            decide_for("battery charger um"),
            Decision::AskRepeat | Decision::Unknown
        ));
    }

    #[test]
    fn genuine_nothing_stays_unknown() {
        assert!(matches!(decide_for("xylophone zebra"), Decision::Unknown));
        assert!(matches!(decide_for(""), Decision::Unknown));
    }

    #[test]
    fn calendar_phrases_stay_unknown() {
        // JEV is never involved with calendar/meetings.
        for t in [
            "whats on my calendar",
            "my next meeting",
            "cancel meeting",
            "schedule lunch tomorrow",
        ] {
            assert!(
                matches!(decide_for(t), Decision::Unknown | Decision::AskRepeat),
                "{t:?} must not become an action"
            );
        }
    }
}
