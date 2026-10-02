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
    /// Anything Jev doesn't understand. Never executes.
    Unknown,
}

impl Intent {
    /// Intents that never need user confirmation (the V1 set). The
    /// `requires_confirmation` machinery exists for future
    /// destructive/sensitive actions; nothing sets it yet.
    pub fn needs_confirmation(self) -> bool {
        let _ = self;
        false
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
    #[serde(default)]
    pub requires_confirmation: bool,
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
    // A confirmation flag on an intent that doesn't support it is a
    // schema violation, not an execution.
    if result.requires_confirmation && !result.intent.needs_confirmation() {
        return ValidatedAction::Unknown;
    }
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
            requires_confirmation: false,
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
    fn unexpected_confirmation_flag_is_not_executed() {
        let mut r = result(Intent::OpenApplication);
        r.parameters.application = Some("firefox".into());
        r.requires_confirmation = true;
        assert!(matches!(validate(&r), ValidatedAction::Unknown));
    }
}
