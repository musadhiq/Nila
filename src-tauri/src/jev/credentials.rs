//! Secure storage for the Jev API token.
//!
//! Security contract (from the spec):
//!
//! - The token is NEVER hardcoded, NEVER in frontend source, NEVER
//!   committed to git, NEVER in a bundled `.env`.
//! - The frontend NEVER persists the raw token (no localStorage,
//!   IndexedDB, settings JSON). It only ever holds the token in memory
//!   for the duration of the "add token" form.
//! - Rust owns the credential. Storage is the OS keychain via the
//!   `keyring` crate: Secret Service on Linux, Keychain on macOS,
//!   Credential Manager on Windows.
//! - The raw token is NEVER returned to the frontend after storage and
//!   NEVER written to logs.
//!
//! The [`SecureStore`] trait keeps this testable: production uses
//! [`KeyringStore`], tests use [`MemoryStore`].

use std::sync::Mutex;

/// Abstract credential storage so tests never touch the real keychain.
pub trait SecureStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, token: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// OS keychain storage. Service/account names are fixed so there is
/// exactly one place the token can live.
pub struct KeyringStore;

const KEYRING_SERVICE: &str = "nila";
const KEYRING_ACCOUNT: &str = "jev-api-token";

impl SecureStore for KeyringStore {
    fn get(&self) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|e| format!("credential store unavailable: {e}"))?;
        match entry.get_password() {
            Ok(pw) => {
                if pw.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(pw))
                }
            }
            // No entry yet is a normal "not configured" state, not an error.
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("could not read credential: {e}")),
        }
    }

    fn set(&self, token: &str) -> Result<(), String> {
        if token.trim().is_empty() {
            return Err("token is empty".to_string());
        }
        if token.len() > 4096 {
            return Err("token is too long".to_string());
        }
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|e| format!("credential store unavailable: {e}"))?;
        // The token value itself never appears in any log line here.
        entry
            .set_password(token)
            .map_err(|e| format!("could not store credential: {e}"))
    }

    fn delete(&self) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|e| format!("credential store unavailable: {e}"))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Deleting a non-existent token is fine.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not remove credential: {e}")),
        }
    }
}

/// In-memory store for tests. Never used in production.
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<Option<String>>,
}

impl SecureStore for MemoryStore {
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.inner.lock().map_err(|e| e.to_string())?.clone())
    }

    fn set(&self, token: &str) -> Result<(), String> {
        if token.trim().is_empty() {
            return Err("token is empty".to_string());
        }
        *self.inner.lock().map_err(|e| e.to_string())? = Some(token.to_string());
        Ok(())
    }

    fn delete(&self) -> Result<(), String> {
        *self.inner.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let s = MemoryStore::default();
        assert_eq!(s.get().unwrap(), None);
        s.set("sekret-token").unwrap();
        assert_eq!(s.get().unwrap(), Some("sekret-token".to_string()));
        s.delete().unwrap();
        assert_eq!(s.get().unwrap(), None);
    }

    #[test]
    fn empty_token_rejected() {
        let s = MemoryStore::default();
        assert!(s.set("").is_err());
        assert!(s.set("   ").is_err());
        assert_eq!(s.get().unwrap(), None);
    }
}
