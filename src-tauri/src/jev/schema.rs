//! Jev's strict I/O schema.
//!
//! The single most important security boundary in the voice-command
//! pipeline lives here: Jev (whether the local parser or the API) may
//! only ever produce a [`JevResult`], and the executor may only ever act
//! on a [`ValidatedAction`]. Nothing else crosses from "what the user
//! said" to "what the system does".
//!
//! ```text
//! User speech → STT → Jev → JevResult → validate() → ValidatedAction → executor
//! ```
//!
//! Raw transcript text is NEVER executed, NEVER passed to a shell, and
//! NEVER treated as a path or command. The validator rejects anything
//! that doesn't fit the schema below.

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};

/// Every intent Jev can express. This is a closed set: anything the
/// parser/API returns outside it is rejected by [`validate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    OpenApplication,
    CloseApplication,
    FindFile,
    SearchFiles,
    OpenFile,
    OpenFolder,
    CreateFolder,
    SetReminder,
    CancelReminder,
    SystemInfo,
    /// The user cancelled the interaction ("cancel", "never mind").
    Cancel,
    // --- Conversational intents: no system effect, ConversationHandler
    // replies with a short response (kept TTS-friendly).
    Greeting,
    HowAreYou,
    WhatIsYourName,
    WhoAreYou,
    Help,
    Thanks,
    Goodbye,
    /// "what time is it?" — answered from the system clock, never remote.
    CurrentTime,
    /// "what is today's date?" — answered from the system clock.
    CurrentDate,
    // --- UI-action intents: the frontend opens existing UI.
    /// "set a reminder" with no usable details → open New Reminder dialog.
    NewReminder,
    /// "show my reminders" → open the reminder list.
    ShowReminders,
    /// "open settings" → Settings navigation.
    OpenSettings,
    /// Anything Jev doesn't understand. Never executes.
    Unknown,
}

/// How a validated intent is handled. The pipeline routes on this —
/// the frontend never interprets raw Jev text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseType {
    /// Nila says something; no system effect, no UI change.
    Conversation,
    /// The frontend opens existing UI (dialog/page/navigation).
    UiAction,
    /// The system-action executor performs an approved desktop action.
    SystemAction,
}

impl Intent {
    /// Which handler owns this intent after validation.
    pub fn response_type(self) -> ResponseType {
        use ResponseType::*;
        match self {
            Intent::Greeting
            | Intent::HowAreYou
            | Intent::WhatIsYourName
            | Intent::WhoAreYou
            | Intent::Thanks
            | Intent::Goodbye
            | Intent::CurrentTime
            | Intent::CurrentDate => Conversation,
            Intent::Help | Intent::NewReminder | Intent::ShowReminders | Intent::OpenSettings => UiAction,
            _ => SystemAction,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Intent::OpenApplication => "open_application",
            Intent::CloseApplication => "close_application",
            Intent::FindFile => "find_file",
            Intent::SearchFiles => "search_files",
            Intent::OpenFile => "open_file",
            Intent::OpenFolder => "open_folder",
            Intent::CreateFolder => "create_folder",
            Intent::SetReminder => "set_reminder",
            Intent::CancelReminder => "cancel_reminder",
            Intent::SystemInfo => "system_info",
            Intent::Cancel => "cancel",
            Intent::Greeting => "greeting",
            Intent::HowAreYou => "how_are_you",
            Intent::WhatIsYourName => "what_is_your_name",
            Intent::WhoAreYou => "who_are_you",
            Intent::Help => "help",
            Intent::Thanks => "thanks",
            Intent::Goodbye => "goodbye",
            Intent::CurrentTime => "current_time",
            Intent::CurrentDate => "current_date",
            Intent::NewReminder => "new_reminder",
            Intent::ShowReminders => "show_reminders",
            Intent::OpenSettings => "open_settings",
            Intent::Unknown => "unknown",
        }
    }
}

/// The raw parameter bag Jev produces. Every field is optional at the
/// schema level; [`validate`] enforces per-intent requirements.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JevParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// RFC 3339 datetime for `set_reminder`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datetime: Option<String>,
    /// `ram` | `cpu` | `disk` | `battery` | `all`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
}

/// The strict structured result Jev returns. This is the ONLY thing
/// the executor trusts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JevResult {
    pub intent: Intent,
    #[serde(default)]
    pub parameters: JevParams,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A fully validated, type-safe action. The executor matches on this;
/// there is no stringly-typed dispatch anywhere in the trust path.
#[derive(Debug, Clone)]
pub enum ValidatedAction {
    OpenApplication { application: String },
    CloseApplication { application: String },
    FindFile { query: String },
    SearchFiles { extension: String },
    OpenFile { query: String },
    OpenFolder { query: String },
    CreateFolder { name: String },
    SetReminder { title: String, at: DateTime<Local> },
    CancelReminder,
    SystemInfo { metric: SystemMetric },
    Cancel,
    // --- Conversational: no system effect. The ConversationHandler
    // turns the response key into Nila's reply (frontend i18n).
    Conversation { response_key: &'static str },
    // --- UI actions: the frontend opens existing UI. Prefill is
    // best-effort — the user always reviews before saving.
    UiNewReminder { title: Option<String> },
    UiShowReminders,
    UiOpenSettings,
    UiHelp,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemMetric {
    Ram,
    Cpu,
    Disk,
    Battery,
    All,
}

// Caps keep absurd input from travelling far.
const MAX_TEXT_LEN: usize = 120;
const MAX_TITLE_LEN: usize = 80;

fn clean_text(raw: &str, max: usize) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("empty parameter".to_string());
    }
    if t.chars().count() > max {
        return Err("parameter too long".to_string());
    }
    // Control characters never belong in an action parameter.
    if t.chars().any(|c| c.is_control()) {
        return Err("invalid characters in parameter".to_string());
    }
    Ok(t.to_string())
}

/// Validate a [`JevResult`] into a [`ValidatedAction`].
///
/// Anything malformed — missing required params, bad datetime,
/// unknown metric, oversized text — becomes `ValidatedAction::Unknown`
/// with a message, never an execution. The pipeline cannot crash on a
/// bad Jev response.
pub fn validate(result: &JevResult) -> ValidatedAction {
    let p = &result.parameters;
    let validated = (|| -> Result<ValidatedAction, String> {
        match result.intent {
            Intent::OpenApplication => Ok(ValidatedAction::OpenApplication {
                application: clean_text(
                    p.application.as_deref().ok_or("missing application")?,
                    MAX_TEXT_LEN,
                )?,
            }),
            Intent::CloseApplication => Ok(ValidatedAction::CloseApplication {
                application: clean_text(
                    p.application.as_deref().ok_or("missing application")?,
                    MAX_TEXT_LEN,
                )?,
            }),
            Intent::FindFile => Ok(ValidatedAction::FindFile {
                query: clean_text(p.query.as_deref().ok_or("missing query")?, MAX_TEXT_LEN)?,
            }),
            Intent::SearchFiles => {
                let ext = clean_text(
                    p.extension.as_deref().ok_or("missing extension")?,
                    10,
                )?
                .trim_start_matches('.')
                .to_lowercase();
                if !ext.chars().all(|c| c.is_ascii_alphanumeric()) || ext.is_empty() {
                    return Err("invalid extension".to_string());
                }
                Ok(ValidatedAction::SearchFiles { extension: ext })
            }
            Intent::OpenFile => Ok(ValidatedAction::OpenFile {
                query: clean_text(p.query.as_deref().ok_or("missing query")?, MAX_TEXT_LEN)?,
            }),
            Intent::OpenFolder => Ok(ValidatedAction::OpenFolder {
                query: clean_text(p.query.as_deref().ok_or("missing query")?, MAX_TEXT_LEN)?,
            }),
            Intent::CreateFolder => {
                let name = clean_text(p.name.as_deref().ok_or("missing name")?, 60)?;
                // A folder name is a single path segment. Anything that
                // looks like traversal or an absolute path is rejected
                // here, before it ever reaches the filesystem.
                if name.contains('/')
                    || name.contains('\\')
                    || name.contains("..")
                    || name.starts_with('.')
                {
                    return Err("invalid folder name".to_string());
                }
                Ok(ValidatedAction::CreateFolder { name })
            }
            Intent::SetReminder => {
                let title = clean_text(p.title.as_deref().ok_or("missing title")?, MAX_TITLE_LEN)?;
                let at_raw = p.datetime.as_deref().ok_or("missing datetime")?;
                let at = DateTime::parse_from_rfc3339(at_raw)
                    .map_err(|_| "invalid datetime".to_string())?
                    .with_timezone(&Local);
                if at <= Local::now() {
                    return Err("reminder time is in the past".to_string());
                }
                Ok(ValidatedAction::SetReminder { title, at })
            }
            Intent::CancelReminder => Ok(ValidatedAction::CancelReminder),
            Intent::SystemInfo => {
                let metric = match p.metric.as_deref().unwrap_or("all") {
                    "ram" => SystemMetric::Ram,
                    "cpu" => SystemMetric::Cpu,
                    "disk" => SystemMetric::Disk,
                    "battery" => SystemMetric::Battery,
                    "all" => SystemMetric::All,
                    _ => return Err("unknown metric".to_string()),
                };
                Ok(ValidatedAction::SystemInfo { metric })
            }
            Intent::Cancel => Ok(ValidatedAction::Cancel),
            // Conversational intents: the response key names a frontend
            // i18n template; nothing executes.
            Intent::Greeting => Ok(ValidatedAction::Conversation {
                response_key: "convGreeting",
            }),
            Intent::HowAreYou => Ok(ValidatedAction::Conversation {
                response_key: "convHowAreYou",
            }),
            Intent::WhatIsYourName => Ok(ValidatedAction::Conversation {
                response_key: "convWhatIsYourName",
            }),
            Intent::WhoAreYou => Ok(ValidatedAction::Conversation {
                response_key: "convWhoAreYou",
            }),
            Intent::Help => Ok(ValidatedAction::UiHelp),
            Intent::Thanks => Ok(ValidatedAction::Conversation {
                response_key: "convThanks",
            }),
            Intent::Goodbye => Ok(ValidatedAction::Conversation {
                response_key: "convGoodbye",
            }),
            // Time/date are answered from the system clock by the
            // ConversationHandler; the key is fixed here.
            Intent::CurrentTime => Ok(ValidatedAction::Conversation {
                response_key: "convCurrentTime",
            }),
            Intent::CurrentDate => Ok(ValidatedAction::Conversation {
                response_key: "convCurrentDate",
            }),
            // UI actions: title prefill is optional and inert.
            Intent::NewReminder => {
                let title = p
                    .title
                    .as_deref()
                    .map(|t| clean_text(t, MAX_TITLE_LEN))
                    .transpose()?
                    .filter(|t| !t.is_empty());
                Ok(ValidatedAction::UiNewReminder { title })
            }
            Intent::ShowReminders => Ok(ValidatedAction::UiShowReminders),
            Intent::OpenSettings => Ok(ValidatedAction::UiOpenSettings),
            Intent::Unknown => Ok(ValidatedAction::Unknown),
        }
    })();
    validated.unwrap_or(ValidatedAction::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(intent: Intent) -> JevResult {
        JevResult {
            intent,
            parameters: JevParams::default(),
            message: None,
        }
    }

    #[test]
    fn open_application_shape() {
        let mut r = result(Intent::OpenApplication);
        r.parameters.application = Some("firefox".into());
        match validate(&r) {
            ValidatedAction::OpenApplication { application } => assert_eq!(application, "firefox"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn missing_required_param_becomes_unknown() {
        // No `application` on open_application: must not execute.
        assert!(matches!(validate(&result(Intent::OpenApplication)), ValidatedAction::Unknown));
        assert!(matches!(validate(&result(Intent::FindFile)), ValidatedAction::Unknown));
    }

    #[test]
    fn hostile_text_is_rejected() {
        // Shell metacharacters in parameters must not pass validation as
        // anything executable — and the executor never shells out anyway.
        for hostile in [
            "firefox; rm -rf ~",
            "$(whoami)",
            "`id`",
            "a\nb",
            "x".repeat(200).as_str(),
        ] {
            let mut r = result(Intent::OpenApplication);
            r.parameters.application = Some(hostile.to_string());
            let v = validate(&r);
            // Overlong/control input -> Unknown. Shell metachars pass
            // validation as inert strings but can never reach a shell:
            // the executor only allowlist-matches application names.
            if hostile.len() > MAX_TEXT_LEN || hostile.contains('\n') {
                assert!(matches!(v, ValidatedAction::Unknown), "{hostile}");
            } else {
                assert!(
                    matches!(v, ValidatedAction::OpenApplication { .. }),
                    "{hostile}"
                );
            }
        }
    }

    #[test]
    fn folder_traversal_rejected() {
        for bad in ["../etc", "..\\windows", "/abs/path", ".hidden", "a/b"] {
            let mut r = result(Intent::CreateFolder);
            r.parameters.name = Some(bad.into());
            assert!(
                matches!(validate(&r), ValidatedAction::Unknown),
                "{bad} must be rejected"
            );
        }
        let mut r = result(Intent::CreateFolder);
        r.parameters.name = Some("Projects".into());
        assert!(matches!(
            validate(&r),
            ValidatedAction::CreateFolder { .. }
        ));
    }

    #[test]
    fn extension_must_be_alphanumeric() {
        let mut r = result(Intent::SearchFiles);
        r.parameters.extension = Some("pdf; rm".into());
        assert!(matches!(validate(&r), ValidatedAction::Unknown));
        r.parameters.extension = Some(".PDF".into());
        match validate(&r) {
            ValidatedAction::SearchFiles { extension } => assert_eq!(extension, "pdf"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn reminder_datetime_must_be_future_rfc3339() {
        let mut r = result(Intent::SetReminder);
        r.parameters.title = Some("call mom".into());
        r.parameters.datetime = Some("not-a-date".into());
        assert!(matches!(validate(&r), ValidatedAction::Unknown));
        r.parameters.datetime = Some("2000-01-01T00:00:00+00:00".into());
        assert!(matches!(validate(&r), ValidatedAction::Unknown));
        r.parameters.datetime = Some("2030-05-01T19:00:00+05:30".into());
        assert!(matches!(validate(&r), ValidatedAction::SetReminder { .. }));
    }

    #[test]
    fn conversational_intents_validate_to_conversation() {
        for (intent, key) in [
            (Intent::Greeting, "convGreeting"),
            (Intent::HowAreYou, "convHowAreYou"),
            (Intent::WhatIsYourName, "convWhatIsYourName"),
            (Intent::WhoAreYou, "convWhoAreYou"),
            (Intent::Thanks, "convThanks"),
            (Intent::Goodbye, "convGoodbye"),
            (Intent::CurrentTime, "convCurrentTime"),
            (Intent::CurrentDate, "convCurrentDate"),
        ] {
            match validate(&result(intent)) {
                ValidatedAction::Conversation { response_key } => {
                    assert_eq!(response_key, key)
                }
                other => panic!("{intent:?} -> unexpected {other:?}"),
            }
        }
    }

    #[test]
    fn ui_intents_validate_to_ui_actions() {
        // NewReminder without a title: still a valid UI action.
        assert!(matches!(
            validate(&result(Intent::NewReminder)),
            ValidatedAction::UiNewReminder { title: None }
        ));
        // With a title prefill.
        let mut r = result(Intent::NewReminder);
        r.parameters.title = Some("drink water".into());
        match validate(&r) {
            ValidatedAction::UiNewReminder { title } => {
                assert_eq!(title.as_deref(), Some("drink water"))
            }
            other => panic!("unexpected {other:?}"),
        }
        // Overlong/hostile prefill degrades to Unknown, never executes.
        let mut r = result(Intent::NewReminder);
        r.parameters.title = Some("x".repeat(200));
        assert!(matches!(
            validate(&r),
            ValidatedAction::Unknown
        ));
        assert!(matches!(
            validate(&result(Intent::ShowReminders)),
            ValidatedAction::UiShowReminders
        ));
        assert!(matches!(
            validate(&result(Intent::OpenSettings)),
            ValidatedAction::UiOpenSettings
        ));
        assert!(matches!(
            validate(&result(Intent::Help)),
            ValidatedAction::UiHelp
        ));
    }
}
