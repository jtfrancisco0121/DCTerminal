//! Where the ClickUp tokens are kept: the OS keychain (macOS Keychain,
//! Windows Credential Manager, the Secret Service on Linux), behind
//! [`SecretStore`] so tests use memory and never touch the real keychain.
//!
//! There is one token per Claude account, because each account works in its
//! own ClickUp workspace (work and personal). The keychain item's account
//! field is the Claude account id, so one window's account can never read
//! another's token.
//!
//! `DCT_CLICKUP_TOKEN`, when set, wins over the keychain for the first Claude
//! account only (as `DCT_CLAUDE_CONFIG_DIR` does) and is read-only. It is
//! taken out of the process environment at startup, so no PTY shell,
//! `claude` stage or `gh` call inherits it.

use super::ClickUpToken;
use std::sync::OnceLock;

/// The env override. Read once at startup, then removed from the env.
pub const TOKEN_ENV: &str = "DCT_CLICKUP_TOKEN";

/// Keychain item service; the item's account field is the Claude account id.
const KEYCHAIN_SERVICE: &str = "com.jtfrancisco.dcterminal.clickup";

/// One token slot per Claude account id. Errors are plain English and never
/// hold the token.
pub trait SecretStore: Send + Sync {
    fn get(&self, account_id: &str) -> Result<Option<ClickUpToken>, String>;
    fn set(&self, account_id: &str, token: &ClickUpToken) -> Result<(), String>;
    /// Clearing an empty slot is fine.
    fn clear(&self, account_id: &str) -> Result<(), String>;
}

/// The OS keychain, through the `keyring` crate.
pub struct KeychainStore;

impl KeychainStore {
    fn entry(account_id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account_id).map_err(|err| keychain_error(&err))
    }
}

/// What went wrong, by kind only. Some keyring errors carry the stored bytes
/// (`BadEncoding`), so the error's own text is never used.
fn keychain_error(err: &keyring::Error) -> String {
    use keyring::Error;
    let what = match err {
        Error::NoStorageAccess(_) => "DCTerminal was not allowed to use it",
        Error::NoDefaultStore => "this system has no keychain DCTerminal can use",
        Error::BadEncoding(_) | Error::BadDataFormat(..) => "the saved item is unreadable",
        Error::PlatformFailure(_) => "the keychain reported an error",
        _ => "the keychain refused the request",
    };
    format!("Could not use the system keychain: {what}.")
}

impl SecretStore for KeychainStore {
    fn get(&self, account_id: &str) -> Result<Option<ClickUpToken>, String> {
        match Self::entry(account_id)?.get_password() {
            Ok(saved) => Ok(ClickUpToken::parse(&saved).ok()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(keychain_error(&err)),
        }
    }

    fn set(&self, account_id: &str, token: &ClickUpToken) -> Result<(), String> {
        Self::entry(account_id)?
            .set_password(token.expose())
            .map_err(|err| keychain_error(&err))
    }

    fn clear(&self, account_id: &str) -> Result<(), String> {
        match Self::entry(account_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(keychain_error(&err)),
        }
    }
}

/// In-memory slots for tests, keyed by account id like the keychain.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    pub slots: std::sync::Mutex<std::collections::HashMap<String, ClickUpToken>>,
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, account_id: &str) -> Result<Option<ClickUpToken>, String> {
        Ok(self
            .slots
            .lock()
            .map_err(|e| e.to_string())?
            .get(account_id)
            .cloned())
    }

    fn set(&self, account_id: &str, token: &ClickUpToken) -> Result<(), String> {
        self.slots
            .lock()
            .map_err(|e| e.to_string())?
            .insert(account_id.to_string(), token.clone());
        Ok(())
    }

    fn clear(&self, account_id: &str) -> Result<(), String> {
        self.slots
            .lock()
            .map_err(|e| e.to_string())?
            .remove(account_id);
        Ok(())
    }
}

/// Where the token in use comes from. Shown in Settings; never the token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    Keychain,
    Env,
    None,
}

impl TokenSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
            Self::Env => "env",
            Self::None => "none",
        }
    }
}

static ENV_TOKEN: OnceLock<Option<ClickUpToken>> = OnceLock::new();

/// Reads `name` into a token and removes it from this process's env.
fn take_env_var(name: &str) -> Option<ClickUpToken> {
    let raw = std::env::var(name).ok();
    if raw.is_some() {
        std::env::remove_var(name);
    }
    raw.and_then(|raw| ClickUpToken::parse(&raw).ok())
}

/// Moves `DCT_CLICKUP_TOKEN` out of the env, so children never inherit it.
/// Must run on the main thread before any other thread exists, like
/// `shell_env::scrub_parent_claude_session`.
pub fn take_env_token() {
    let _ = ENV_TOKEN.set(take_env_var(TOKEN_ENV));
}

/// The env override taken at startup, if any.
pub fn env_token() -> Option<ClickUpToken> {
    ENV_TOKEN.get().cloned().flatten()
}

/// The token `account_id` uses and where it came from: the env override
/// when this is the first account, else that account's keychain item.
pub fn resolve(
    account_id: &str,
    first_account: bool,
    env: Option<ClickUpToken>,
    store: &dyn SecretStore,
) -> Result<(Option<ClickUpToken>, TokenSource), String> {
    if let Some(token) = env.filter(|_| first_account) {
        return Ok((Some(token), TokenSource::Env));
    }
    Ok(match store.get(account_id)? {
        Some(token) => (Some(token), TokenSource::Keychain),
        None => (None, TokenSource::None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_env_override_wins_for_the_first_account_only() {
        let store = MemoryStore::default();
        assert_eq!(
            resolve("default", true, None, &store).unwrap().1,
            TokenSource::None
        );
        store
            .set("default", &ClickUpToken::parse("pk_keychain").unwrap())
            .unwrap();
        let (token, source) = resolve("default", true, None, &store).unwrap();
        assert_eq!(source, TokenSource::Keychain);
        assert_eq!(token.unwrap().expose(), "pk_keychain");
        let env = ClickUpToken::parse("pk_env").ok();
        let (token, source) = resolve("default", true, env.clone(), &store).unwrap();
        assert_eq!(source, TokenSource::Env);
        assert_eq!(token.unwrap().expose(), "pk_env");
        // Another account never gets the override.
        assert_eq!(
            resolve("work", false, env, &store).unwrap(),
            (None, TokenSource::None)
        );
        store.clear("default").unwrap();
        store.clear("default").unwrap();
        assert_eq!(store.get("default").unwrap(), None);
    }

    #[test]
    fn each_account_has_its_own_slot() {
        let store = MemoryStore::default();
        store
            .set("work", &ClickUpToken::parse("pk_work").unwrap())
            .unwrap();
        store
            .set("personal", &ClickUpToken::parse("pk_personal").unwrap())
            .unwrap();
        assert_eq!(store.get("work").unwrap().unwrap().expose(), "pk_work");
        assert_eq!(
            store.get("personal").unwrap().unwrap().expose(),
            "pk_personal"
        );
        store.clear("work").unwrap();
        assert_eq!(store.get("work").unwrap(), None);
        assert_eq!(
            store.get("personal").unwrap().unwrap().expose(),
            "pk_personal"
        );
    }

    #[test]
    fn the_env_token_is_removed_so_children_cannot_inherit_it() {
        // A name of its own, so no other test sees it come and go.
        let name = "DCT_CLICKUP_TOKEN_TEST_TAKE";
        std::env::set_var(name, " pk_from_env ");
        let token = take_env_var(name).unwrap();
        assert_eq!(token.expose(), "pk_from_env");
        assert!(std::env::var_os(name).is_none());
        let child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) {
                vec!["/C", "set"]
            } else {
                vec!["-c", "env"]
            })
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&child.stdout).contains("pk_from_env"));
        assert!(take_env_var(name).is_none());
    }

    #[test]
    fn keychain_errors_never_carry_the_stored_bytes() {
        let err = keychain_error(&keyring::Error::BadEncoding(b"pk_SECRET".to_vec()));
        assert!(!err.contains("pk_SECRET"));
        assert!(err.starts_with("Could not use the system keychain"));
    }
}
