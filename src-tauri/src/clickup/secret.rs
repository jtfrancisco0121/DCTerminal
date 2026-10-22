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
use std::ffi::OsStr;
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

/// What `DCT_CLICKUP_TOKEN` held at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvToken {
    Absent,
    Token(ClickUpToken),
    /// Set, but not a token (not UTF-8, empty, or not token-shaped). It is
    /// not used, and Settings says so rather than showing "No token yet".
    Rejected,
}

static ENV_TOKEN: OnceLock<EnvToken> = OnceLock::new();

/// What an env value means as a token. Pure, so tests need no `set_var`.
fn classify_env_value(raw: Option<&OsStr>) -> EnvToken {
    match raw {
        None => EnvToken::Absent,
        Some(raw) => raw
            .to_str()
            .and_then(|raw| ClickUpToken::parse(raw).ok())
            .map_or(EnvToken::Rejected, EnvToken::Token),
    }
}

/// Reads `name` and removes it from this process's env whenever it is set,
/// a value that is not UTF-8 or not a token included: a rejected value can
/// still be a real token with a stray byte, so no child may inherit it.
fn take_env_var(name: &str) -> EnvToken {
    let raw = std::env::var_os(name);
    if raw.is_some() {
        std::env::remove_var(name);
    }
    classify_env_value(raw.as_deref())
}

/// Moves `DCT_CLICKUP_TOKEN` out of the env, so children never inherit it.
/// Must run on the main thread before any other thread or child process
/// exists: it is the first of `STARTUP_ENV_STEPS` in `lib.rs`.
pub fn take_env_token() {
    let _ = ENV_TOKEN.set(take_env_var(TOKEN_ENV));
}

/// The env override taken at startup, if any.
pub fn env_token() -> Option<ClickUpToken> {
    match ENV_TOKEN.get() {
        Some(EnvToken::Token(token)) => Some(token.clone()),
        _ => None,
    }
}

/// Whether `DCT_CLICKUP_TOKEN` was set at startup but was not a token.
pub fn env_token_rejected() -> bool {
    matches!(ENV_TOKEN.get(), Some(EnvToken::Rejected))
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
    fn an_env_value_that_is_not_a_token_is_rejected_not_used() {
        assert_eq!(classify_env_value(None), EnvToken::Absent);
        assert_eq!(
            classify_env_value(Some(OsStr::new(" pk_from_env "))),
            EnvToken::Token(ClickUpToken::parse("pk_from_env").unwrap())
        );
        for bad in ["", "  ", "pk_1 2", "pk_é"] {
            assert_eq!(
                classify_env_value(Some(OsStr::new(bad))),
                EnvToken::Rejected,
                "{bad:?}"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            assert_eq!(
                classify_env_value(Some(OsStr::from_bytes(b"pk_\xff"))),
                EnvToken::Rejected
            );
        }
    }

    /// Set by [`the_env_token_is_removed_so_children_cannot_inherit_it`] for
    /// the copy of this test binary it starts.
    const CHILD_MARKER: &str = "DCT_CLICKUP_SECRET_TEST_CHILD";
    /// A name of its own, so a real `DCT_CLICKUP_TOKEN` is never involved.
    const CHILD_VAR: &str = "DCT_CLICKUP_TOKEN_TEST_TAKE";

    /// Runs `child_takes_the_env_var` in a fresh copy of this test binary,
    /// with `value` in its env. Changing the env of this process would race
    /// the other tests' threads, so only the child's env is set, by `Command`.
    fn run_child(value: &OsStr) {
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "clickup::secret::tests::child_takes_the_env_var",
                "--ignored",
                "--test-threads=1",
                "--nocapture",
            ])
            .env(CHILD_MARKER, "1")
            .env(CHILD_VAR, value)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            out.status.success() && stdout.contains("1 passed"),
            "child failed: {stdout}{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn the_env_token_is_removed_so_children_cannot_inherit_it() {
        run_child(OsStr::new(" pk_from_env "));
        run_child(OsStr::new("not a token"));
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            run_child(OsStr::from_bytes(b"pk_from_env\xff"));
        }
    }

    /// Only does anything inside [`run_child`]'s child, which runs this one
    /// test on one thread, so `take_env_var`'s `remove_var` races nothing.
    #[test]
    #[ignore = "run by the_env_token_is_removed_so_children_cannot_inherit_it"]
    fn child_takes_the_env_var() {
        if std::env::var_os(CHILD_MARKER).is_none() {
            return;
        }
        let taken = take_env_var(CHILD_VAR);
        assert_ne!(taken, EnvToken::Absent);
        assert!(std::env::var_os(CHILD_VAR).is_none());
        let child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) {
                vec!["/C", "set"]
            } else {
                vec!["-c", "env"]
            })
            .output()
            .unwrap();
        let env = String::from_utf8_lossy(&child.stdout);
        assert!(!env.contains(CHILD_VAR) && !env.contains("pk_from_env"));
        assert_eq!(take_env_var(CHILD_VAR), EnvToken::Absent);
    }

    #[test]
    fn keychain_errors_never_carry_the_stored_bytes() {
        let err = keychain_error(&keyring::Error::BadEncoding(b"pk_SECRET".to_vec()));
        assert!(!err.contains("pk_SECRET"));
        assert!(err.starts_with("Could not use the system keychain"));
    }
}
