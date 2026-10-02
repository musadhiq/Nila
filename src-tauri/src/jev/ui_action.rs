//! UIActionHandler — voice-triggered UI navigation.
//!
//! Handles the [`ResponseType::UiAction`] intents by emitting a
//! `jev:ui_action` event. The frontend owns the surface from there:
//! it opens the existing dialog/page/navigation and completes the
//! voice pipeline. Nothing here creates, deletes, or modifies data —
//! the user always reviews in the UI before anything is saved.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::schema::ValidatedAction;

/// Event the frontend listens for. `action` names the UI to open;
/// `prefill` carries best-effort initial values (the dialog still
/// requires explicit user confirmation before saving).
pub const UI_ACTION_EVENT: &str = "jev:ui_action";

#[derive(Serialize, Clone)]
struct UiActionPayload {
    #[serde(rename = "type")]
    kind: &'static str,
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    prefill: Option<serde_json::Value>,
}

pub struct UIActionHandler;

impl UIActionHandler {
    pub fn handle(app: &AppHandle, action: &ValidatedAction) {
        let payload = match action {
            ValidatedAction::UiNewReminder { title } => UiActionPayload {
                kind: "jev:ui_action",
                action: "open_new_reminder",
                prefill: Some(serde_json::json!({
                    "title": title.clone().unwrap_or_default(),
                })),
            },
            ValidatedAction::UiShowReminders => UiActionPayload {
                kind: "jev:ui_action",
                action: "open_reminders",
                prefill: None,
            },
            ValidatedAction::UiOpenSettings => UiActionPayload {
                kind: "jev:ui_action",
                action: "open_settings",
                prefill: None,
            },
            ValidatedAction::UiHelp => UiActionPayload {
                kind: "jev:ui_action",
                action: "open_help",
                prefill: None,
            },
            // Not a UI action: emit nothing. The pipeline treats a
            // missing ui_action as a no-op rather than opening UI.
            _ => {
                eprintln!("nila: jev: UIActionHandler got non-UI action; ignoring");
                return;
            }
        };
        eprintln!("nila: jev: ui_action -> {}", payload.action);
        let _ = app.emit(UI_ACTION_EVENT, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_action_event_name_is_stable() {
        // The frontend listens for exactly this string.
        assert_eq!(UI_ACTION_EVENT, "jev:ui_action");
    }
}
