//! Minimal temporary conversation context.
//!
//! Just enough memory for follow-ups like:
//!
//! ```text
//! User: "Find my resume"   → find_file → resume.pdf
//! User: "Open it"          → open_file resolves to that same path
//! ```
//!
//! Stored: last file, last search results, last application, last
//! reminder. Nothing else. The whole context expires after
//! [`CONTEXT_TTL`] of inactivity — this is deliberately NOT long-term
//! memory.

use std::path::PathBuf;
use std::time::{Duration, Instant};

/// How long context survives without a voice command.
const CONTEXT_TTL: Duration = Duration::from_secs(5 * 60);

/// One file hit from a search, kept so "open it" / "open the second
/// one" can resolve without searching again.
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct ConversationContext {
    pub last_file: Option<PathBuf>,
    pub last_search_results: Vec<SearchHit>,
    pub last_application: Option<String>,
    /// Reminder id created/cancelled via voice, for "cancel that reminder".
    pub last_reminder: Option<String>,
    updated_at: Option<Instant>,
}

impl ConversationContext {
    fn touch(&mut self) {
        self.updated_at = Some(Instant::now());
    }

    /// True when the context has expired and must be treated as empty.
    pub fn is_expired(&self) -> bool {
        match self.updated_at {
            None => true,
            Some(t) => t.elapsed() >= CONTEXT_TTL,
        }
    }

    /// Drop everything when expired. Called at the start of every
    /// command so stale context can never leak into a new session.
    pub fn expire_if_stale(&mut self) {
        if self.is_expired() {
            *self = ConversationContext::default();
        }
    }

    pub fn remember_search(&mut self, hits: Vec<SearchHit>) {
        self.last_search_results = hits.clone();
        self.last_file = hits.into_iter().next().map(|h| h.path);
        self.touch();
    }

    pub fn remember_file(&mut self, path: PathBuf) {
        self.last_file = Some(path);
        self.touch();
    }

    pub fn remember_application(&mut self, app: String) {
        self.last_application = Some(app);
        self.touch();
    }

    pub fn remember_reminder(&mut self, id: String) {
        self.last_reminder = Some(id);
        self.touch();
    }

    pub fn forget_reminder(&mut self) {
        self.last_reminder = None;
        self.touch();
    }

    /// Resolve "it" / "that" to the most recent file, if any.
    pub fn resolve_it(&self) -> Option<PathBuf> {
        if self.is_expired() {
            return None;
        }
        self.last_file.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pronoun_resolves_to_last_search_hit() {
        let mut ctx = ConversationContext::default();
        ctx.remember_search(vec![SearchHit {
            name: "resume.pdf".into(),
            path: PathBuf::from("/home/u/Documents/resume.pdf"),
        }]);
        assert_eq!(
            ctx.resolve_it(),
            Some(PathBuf::from("/home/u/Documents/resume.pdf"))
        );
    }

    #[test]
    fn context_starts_empty_and_expires() {
        let ctx = ConversationContext::default();
        assert!(ctx.is_expired());
        assert_eq!(ctx.resolve_it(), None);
    }

    #[test]
    fn expire_if_stale_clears() {
        let mut ctx = ConversationContext::default();
        ctx.remember_application("firefox".into());
        assert!(!ctx.is_expired());
        // Simulate staleness by backdating.
        ctx.updated_at = Some(Instant::now() - CONTEXT_TTL - Duration::from_secs(1));
        ctx.expire_if_stale();
        assert!(ctx.last_application.is_none());
        assert!(ctx.is_expired());
    }
}
