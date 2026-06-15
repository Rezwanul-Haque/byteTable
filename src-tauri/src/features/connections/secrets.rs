//! Secret storage for server connections (M12 Task 3).
//!
//! Server connections need two secrets that must NOT live in the JSON registry
//! (`connections.json` holds only non-secret params): the **database password**
//! and, for a tunnelled connection, the **SSH secret** (the private-key
//! passphrase or the bastion password). Both go to the OS keychain, keyed by
//! the saved-connection id.
//!
//! ## Port / adapter split (mirrors the repository pattern)
//!
//! [`SecretStore`] is the port; [`KeyringSecretStore`] is the real OS-keychain
//! adapter (the `keyring` crate → macOS Keychain / Windows Credential Manager /
//! Secret Service). [`InMemorySecretStore`] is the test fake so the save/open/
//! delete orchestration is unit-testable without touching the OS keychain (the
//! real keychain may prompt or be unavailable in CI).
//!
//! ## Key derivation
//!
//! Service name: `"ByteTable"`. Account:
//! - `{connection_id}` — the database password.
//! - `{connection_id}:ssh` — the SSH key passphrase / bastion password.
//!
//! [`db_account`] / [`ssh_account`] are the single source of truth for these
//! keys; the save/open/delete flow and the tests both go through them.
//!
//! ## Policy (the secret flow)
//!
//! - `connection_save` — when the modal supplied a db password (and/or SSH
//!   secret), store them under the connection id; the JSON repo stores only
//!   non-secret params. Empty/absent secrets are left untouched (so re-saving
//!   without retyping keeps the stored secret).
//! - `connection_open(id)` — read the db password from `{id}` and the SSH
//!   secret from `{id}:ssh`; a transiently-typed password (first connect, before
//!   save) takes precedence so the modal works before anything is stored.
//! - `connection_test` — uses ONLY the transiently-typed secret (testing before
//!   save); never reads or writes the keychain.
//! - `connection_delete` — delete both keychain entries for the id (best
//!   effort: a missing entry is not an error).

use std::collections::HashMap;
use std::sync::Mutex;

use crate::shared::error::AppError;

/// The keychain service name for every ByteTable secret.
pub const SERVICE: &str = "ByteTable";

/// Keychain account for a connection's database password.
pub fn db_account(connection_id: &str) -> String {
    connection_id.to_string()
}

/// Keychain account for a connection's SSH secret (key passphrase / bastion
/// password). Distinct from the db password so the two never collide.
pub fn ssh_account(connection_id: &str) -> String {
    format!("{connection_id}:ssh")
}

/// A store for connection secrets (the port). Implementations key entries by
/// a `(service, account)` pair — see [`db_account`] / [`ssh_account`].
pub trait SecretStore: Send + Sync {
    /// Store (or overwrite) the secret for `account`.
    fn set(&self, account: &str, secret: &str) -> Result<(), AppError>;

    /// Read the secret for `account`, or `None` when there is none.
    fn get(&self, account: &str) -> Result<Option<String>, AppError>;

    /// Delete the secret for `account`. A missing entry is NOT an error.
    fn delete(&self, account: &str) -> Result<(), AppError>;
}

/// The real OS-keychain adapter (the `keyring` crate), with a process-lifetime
/// in-memory cache.
///
/// # Why the cache
///
/// Each OS-keychain *read* can pop an access dialog on macOS — and a dev build
/// (ad-hoc re-signed on every rebuild) is never added to the item's trusted-app
/// ACL, so the dialog reappears, sometimes more than once for a single open.
/// Caching the resolved value (hits AND misses) means the keychain is touched
/// at most once per account per app session: re-opening a workspace, switching
/// Redis dbs, or opening the CLI all reuse the cached secret instead of
/// re-prompting. The secret already lives in RAM for the session (the live
/// pool/connection holds it), so this adds no new exposure. A signed release
/// build prompts once ("Always Allow") and never again; the cache simply makes
/// the dev experience match that.
pub struct KeyringSecretStore {
    /// account → Some(secret) (a hit) / None (a known-missing entry).
    cache: Mutex<HashMap<String, Option<String>>>,
}

impl KeyringSecretStore {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn entry(account: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(|e| AppError::Io(format!("the OS keychain is unavailable ({e}).")))
    }
}

impl Default for KeyringSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeyringSecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), AppError> {
        Self::entry(account)?.set_password(secret).map_err(|e| {
            AppError::Io(format!("could not save a secret to the OS keychain ({e})."))
        })?;
        // Keep the cache coherent with the write so the next read serves it
        // without an OS round-trip (or prompt).
        self.cache
            .lock()
            .unwrap()
            .insert(account.to_string(), Some(secret.to_string()));
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        if let Some(cached) = self.cache.lock().unwrap().get(account) {
            return Ok(cached.clone());
        }
        let result = match Self::entry(account)?.get_password() {
            Ok(secret) => Some(secret),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                return Err(AppError::Io(format!(
                    "could not read a secret from the OS keychain ({e})."
                )))
            }
        };
        // Cache the outcome (hit or miss) so a repeat read never re-prompts.
        self.cache
            .lock()
            .unwrap()
            .insert(account.to_string(), result.clone());
        Ok(result)
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => {
                return Err(AppError::Io(format!(
                    "could not delete a secret from the OS keychain ({e})."
                )))
            }
        }
        // A deleted secret is now known-missing — drop any cached value.
        self.cache.lock().unwrap().insert(account.to_string(), None);
        Ok(())
    }
}

/// In-memory [`SecretStore`] fake for unit tests — no OS keychain. Lives at
/// module level (gated to test builds) so the connections application-layer
/// tests can use it to exercise the save/open/delete secret orchestration
/// without the real keychain.
#[cfg(test)]
#[derive(Default)]
pub struct InMemorySecretStore {
    map: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl SecretStore for InMemorySecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), AppError> {
        self.map
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        Ok(self.map.lock().unwrap().get(account).cloned())
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        self.map.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_derivation_is_distinct_and_stable() {
        assert_eq!(db_account("abc"), "abc");
        assert_eq!(ssh_account("abc"), "abc:ssh");
        assert_ne!(db_account("abc"), ssh_account("abc"));
    }

    #[test]
    fn in_memory_store_round_trips_and_delete_is_idempotent() {
        let store = InMemorySecretStore::default();
        assert_eq!(store.get("abc").unwrap(), None);
        store.set("abc", "hunter2").unwrap();
        assert_eq!(store.get("abc").unwrap().as_deref(), Some("hunter2"));
        // Overwrite.
        store.set("abc", "new").unwrap();
        assert_eq!(store.get("abc").unwrap().as_deref(), Some("new"));
        // Delete, then a second delete is still Ok (idempotent).
        store.delete("abc").unwrap();
        assert_eq!(store.get("abc").unwrap(), None);
        store.delete("abc").unwrap();
    }

    /// The REAL OS keychain round-trip, gated behind `BYTETABLE_TEST_KEYCHAIN=1`
    /// (the macOS Keychain may prompt / be unavailable in CI, so it is opt-in).
    /// Run in its OWN filter:
    /// `BYTETABLE_TEST_KEYCHAIN=1 cargo test --lib features::connections::secrets`.
    ///
    /// NOTE: run this in its own filter, not co-mingled with the whole gated
    /// suite. Running it inside a process that has also spun up many tokio
    /// runtimes / SSH-tunnel threads can make the macOS Security framework
    /// briefly report "A default keychain could not be found" — a harness/OS
    /// artifact (the GUI app always has a default keychain), not a code bug.
    #[test]
    fn real_keychain_round_trip() {
        if std::env::var("BYTETABLE_TEST_KEYCHAIN").as_deref() != Ok("1") {
            eprintln!("SKIP real_keychain_round_trip: BYTETABLE_TEST_KEYCHAIN=1 not set");
            return;
        }
        let store = KeyringSecretStore::new();
        // A fresh UUID account, so it is guaranteed absent — no clean-slate
        // delete needed (and reading an absent entry returns None, not error).
        let account = format!("bytetable-test-{}", uuid::Uuid::new_v4());
        assert_eq!(store.get(&account).unwrap(), None);
        // Set / get.
        store.set(&account, "s3cr3t-value").unwrap();
        assert_eq!(
            store.get(&account).unwrap().as_deref(),
            Some("s3cr3t-value")
        );
        // Overwrite.
        store.set(&account, "rotated").unwrap();
        assert_eq!(store.get(&account).unwrap().as_deref(), Some("rotated"));
        // Delete.
        store.delete(&account).unwrap();
        assert_eq!(store.get(&account).unwrap(), None);
    }
}
