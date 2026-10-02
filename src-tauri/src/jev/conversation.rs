//! ConversationHandler — Nila's conversational replies.
//!
//! Handles the [`ResponseType::Conversation`] intents: greetings,
//! identity, help, thanks, goodbye, and the local time/date. These
//! never touch the system and never open UI; they just produce a
//! `response_key` (+ params) that the frontend's i18n layer renders.
//!
//! Responses are kept short: they may eventually be sent to TTS.

use chrono::Local;

use super::executor::{ActionResult, ActionStatus};
use super::schema::ValidatedAction;

/// Turn a validated conversational action into Nila's reply.
pub struct ConversationHandler;

impl ConversationHandler {
    pub fn respond(action: &ValidatedAction) -> ActionResult {
        match action {
            ValidatedAction::Conversation { response_key } => {
                // Time/date are answered from the system clock — never
                // a remote service.
                match *response_key {
                    "convCurrentTime" => {
                        let now = Local::now();
                        ActionResult {
                            status: ActionStatus::Success,
                            response_key: "convCurrentTime",
                            response_params: serde_json::json!({
                                "time": now.format("%-I:%M %p").to_string(),
                            }),
                            data: None,
                        }
                    }
                    "convCurrentDate" => {
                        let now = Local::now();
                        ActionResult {
                            status: ActionStatus::Success,
                            response_key: "convCurrentDate",
                            response_params: serde_json::json!({
                                "date": now.format("%A, %B %-d").to_string(),
                            }),
                            data: None,
                        }
                    }
                    key => ActionResult {
                        status: ActionStatus::Success,
                        response_key: key,
                        response_params: serde_json::json!({}),
                        data: None,
                    },
                }
            }
            // Not a conversational action: never produce a reply for it.
            _ => ActionResult {
                status: ActionStatus::Error,
                response_key: "unknownCommand",
                response_params: serde_json::json!({}),
                data: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::schema::{Intent, JevParams, JevResult};

    fn conversational(intent: Intent) -> ValidatedAction {
        let r = JevResult {
            intent,
            parameters: JevParams::default(),
            requires_confirmation: false,
            message: None,
        };
        crate::jev::schema::validate(&r)
    }

    #[test]
    fn greeting_produces_response_key() {
        let r = ConversationHandler::respond(&conversational(Intent::Greeting));
        assert_eq!(r.status, ActionStatus::Success);
        assert_eq!(r.response_key, "convGreeting");
    }

    #[test]
    fn time_and_date_include_values() {
        let r = ConversationHandler::respond(&conversational(Intent::CurrentTime));
        assert_eq!(r.response_key, "convCurrentTime");
        assert!(r.response_params.get("time").is_some());

        let r = ConversationHandler::respond(&conversational(Intent::CurrentDate));
        assert_eq!(r.response_key, "convCurrentDate");
        assert!(r.response_params.get("date").is_some());
    }

    #[test]
    fn non_conversational_action_is_rejected() {
        let r = ConversationHandler::respond(&ValidatedAction::Unknown);
        assert_eq!(r.status, ActionStatus::Error);
    }
}
