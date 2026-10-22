//! Provider settings and the per-tab provider (Claude-first plan, Phase 2).

use crate::cli_detect::LoginStatus;
use crate::provider::claude_config::{ConfigDirInfo, CONFIG_DIR_ENV};
use crate::provider::claude_detect::{claude_login_status, resolve_claude};
use crate::provider::ProviderId;
use crate::store::settings_store::{
    resolved_account_config, ClaudeProviderSettings, ProvidersSettings,
};
use crate::store::{SettingsStore, StateStore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsView {
    pub settings: ProvidersSettings,
    /// The first account's folder (env override included).
    pub claude_config_dir: ConfigDirInfo,
    /// Value of `DCT_CLAUDE_CONFIG_DIR` when set (the first account only).
    pub claude_config_dir_env: Option<String>,
    /// Each saved account with its resolved folder. Login is a separate call.
    pub claude_accounts: Vec<ResolvedClaudeAccount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedClaudeAccount {
    pub id: String,
    pub name: String,
    pub config: ConfigDirInfo,
    /// True only for the first account while `DCT_CLAUDE_CONFIG_DIR` is set.
    pub env_override: bool,
}

fn view(settings: &SettingsStore) -> ProviderSettingsView {
    let claude = &settings.providers().claude;
    let env = std::env::var(CONFIG_DIR_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty());
    let claude_accounts = claude
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            let config = resolved_account_config(claude, &account.id);
            ResolvedClaudeAccount {
                id: account.id.clone(),
                name: account.name.clone(),
                env_override: index == 0 && env.is_some(),
                config,
            }
        })
        .collect();
    let claude_config_dir = claude
        .accounts
        .first()
        .map(|account| resolved_account_config(claude, &account.id))
        .unwrap_or_else(|| resolved_account_config(claude, "default"));
    ProviderSettingsView {
        settings: settings.providers().clone(),
        claude_config_dir,
        claude_config_dir_env: env,
        claude_accounts,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountLogin {
    pub id: String,
    pub name: String,
    pub config: ConfigDirInfo,
    pub login: LoginStatus,
}

/// Signed-in email/org for every account. Skips `claude auth status` when
/// that account's folder does not exist, so nothing is created. Runs off the
/// main thread and without the settings lock: each check can take up to 20 s.
#[tauri::command]
pub async fn claude_account_logins(
    settings: State<'_, Mutex<SettingsStore>>,
) -> Result<Vec<ClaudeAccountLogin>, String> {
    let claude = claude_settings(&settings)?;
    tauri::async_runtime::spawn_blocking(move || account_logins(&claude))
        .await
        .map_err(|err| err.to_string())
}

fn claude_settings(settings: &Mutex<SettingsStore>) -> Result<ClaudeProviderSettings, String> {
    let settings = settings.lock().map_err(|err| err.to_string())?;
    Ok(settings.providers().claude.clone())
}

/// The command's work without an AppHandle, for tests.
#[cfg(all(test, unix))]
fn account_logins_from(settings: &Mutex<SettingsStore>) -> Result<Vec<ClaudeAccountLogin>, String> {
    Ok(account_logins(&claude_settings(settings)?))
}

/// Checks every account at once, so the slowest one sets the wait. Results
/// keep the accounts' order.
fn account_logins(claude: &ClaudeProviderSettings) -> Vec<ClaudeAccountLogin> {
    let claude_bin = resolve_claude(claude.claude_path.as_deref());
    std::thread::scope(|scope| {
        let checks: Vec<_> = claude
            .accounts
            .iter()
            .map(|account| {
                let config = resolved_account_config(claude, &account.id);
                let claude_bin = claude_bin.as_deref();
                let check = {
                    let config = config.clone();
                    scope.spawn(move || claude_login_status(claude_bin, &config))
                };
                (account, config, check)
            })
            .collect();
        checks
            .into_iter()
            .map(|(account, config, check)| ClaudeAccountLogin {
                id: account.id.clone(),
                name: account.name.clone(),
                config,
                login: check.join().unwrap_or_else(|_| LoginStatus {
                    state: "unknown".into(),
                    detail: Some("the login check failed".into()),
                    ..Default::default()
                }),
            })
            .collect()
    })
}

#[tauri::command]
pub fn get_provider_settings(
    settings: State<Mutex<SettingsStore>>,
) -> Result<ProviderSettingsView, String> {
    let settings = settings.lock().map_err(|e| e.to_string())?;
    Ok(view(&settings))
}

/// Save `providers` (app data `settings.json`). New tabs take the new default.
#[tauri::command]
pub fn set_provider_settings(
    app: tauri::AppHandle,
    providers: ProvidersSettings,
    settings: State<Mutex<SettingsStore>>,
    state: State<Mutex<StateStore>>,
) -> Result<ProviderSettingsView, String> {
    // Lock order: StateStore before SettingsStore (see store/mod.rs).
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let mut settings = settings.lock().map_err(|e| e.to_string())?;
    settings.set_providers(providers)?;
    state.new_tab_provider = settings.default_provider();
    let view = view(&settings);
    drop(settings);
    drop(state);
    crate::windows::retitle_open_windows(&app);
    Ok(view)
}

/// Start card provider chip: set this tab's provider. When `role_id` is
/// given (the chip was clicked for that role), remember the choice for it.
#[tauri::command]
pub fn set_tab_provider(
    tab_id: String,
    provider: ProviderId,
    role_id: Option<String>,
    settings: State<Mutex<SettingsStore>>,
    state: State<Mutex<StateStore>>,
) -> Result<(), String> {
    {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.set_tab_provider(&tab_id, provider)?;
    }
    let Some(role_id) = role_id.filter(|id| !id.trim().is_empty()) else {
        return Ok(());
    };
    let mut settings = settings.lock().map_err(|e| e.to_string())?;
    let mut next = settings.providers().clone();
    if next.role_provider.get(&role_id).map(String::as_str) == Some(provider.as_str()) {
        return Ok(());
    }
    next.role_provider
        .insert(role_id, provider.as_str().to_string());
    settings.set_providers(next)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::store::settings_store::ClaudeAccount;
    use crate::test_support::TempDir;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::{Duration, Instant};

    /// Env overrides would point the check at a real binary or folder.
    fn overridden() -> bool {
        ["DCT_CLAUDE_PATH", CONFIG_DIR_ENV]
            .iter()
            .any(|name| std::env::var_os(name).is_some())
    }

    /// Settings with a fake `claude` and one config folder per account.
    fn settings_with(dir: &TempDir, script: &str, accounts: &[&str]) -> Mutex<SettingsStore> {
        let fake = dir.join("claude");
        std::fs::write(&fake, script).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut store = SettingsStore::open(&dir.join("data")).unwrap();
        let mut providers = store.providers().clone();
        providers.claude.claude_path = Some(fake.display().to_string());
        providers.claude.accounts = accounts
            .iter()
            .map(|id| {
                let config = dir.join("accounts").join(id);
                std::fs::create_dir_all(&config).unwrap();
                ClaudeAccount {
                    id: id.to_string(),
                    name: id.to_string(),
                    config_dir: Some(config.display().to_string()),
                }
            })
            .collect();
        // `config_dir` mirrors the first account; leaving it unset would be
        // read as a legacy edit and point that account at ~/.claude.
        providers.claude.config_dir = providers.claude.accounts[0].config_dir.clone();
        store.set_providers(providers).unwrap();
        // Never let a check fall back to a real `claude` on PATH.
        let claude = &store.providers().claude;
        assert_eq!(
            resolve_claude(claude.claude_path.as_deref()),
            Some(fake.clone()),
            "claude resolved to something other than the fake"
        );
        // Never let the fake run against a real Claude folder.
        let root = std::fs::canonicalize(dir.path()).unwrap();
        for account in &claude.accounts {
            let config = resolved_account_config(claude, &account.id);
            assert!(
                std::fs::canonicalize(&config.path).is_ok_and(|path| path.starts_with(&root)),
                "account {} resolved outside the temp dir",
                account.id
            );
        }
        Mutex::new(store)
    }

    /// Creates the file when dropped, including on a failed assert.
    struct ReleaseOnDrop<'a>(&'a Path);

    impl Drop for ReleaseOnDrop<'_> {
        fn drop(&mut self) {
            let _ = std::fs::write(self.0, b"");
        }
    }

    fn wait_for(path: &Path, limit: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    // Regression: the settings lock was held for every account's
    // `claude auth status` (up to 20 s each), freezing Settings > Providers.
    #[test]
    fn account_logins_do_not_hold_the_settings_lock() {
        if overridden() {
            eprintln!("ignored: DCT_CLAUDE_PATH or DCT_CLAUDE_CONFIG_DIR is set");
            return;
        }
        let dir = TempDir::new("logins_lock");
        let started = dir.join("started");
        let release = dir.join("release");
        let script = format!(
            "#!/bin/sh\ntouch '{}'\nwhile [ ! -e '{}' ]; do sleep 0.02; done\nprintf '{{\"loggedIn\":true}}'\n",
            started.display(),
            release.display()
        );
        let settings = settings_with(&dir, &script, &["one"]);
        std::thread::scope(|scope| {
            // Releases the fake even if an assert below fails, so the scope's
            // join never waits out the fake's loop.
            let _release = ReleaseOnDrop(&release);
            let check = scope.spawn(|| account_logins_from(&settings));
            assert!(
                wait_for(&started, Duration::from_secs(5)),
                "fake claude started"
            );
            let free = settings.try_lock().is_ok();
            std::fs::write(&release, b"").unwrap();
            let logins = check.join().unwrap().unwrap();
            assert!(free, "settings lock is free while claude auth status runs");
            assert_eq!(logins[0].login.state, "loggedIn");
        });
    }

    // Regression: accounts were checked one after another, so N stuck
    // accounts froze the window for N x 20 s.
    #[test]
    fn account_logins_run_concurrently() {
        if overridden() {
            eprintln!("ignored: DCT_CLAUDE_PATH or DCT_CLAUDE_CONFIG_DIR is set");
            return;
        }
        let dir = TempDir::new("logins_parallel");
        // Each account marks itself started, then reports signed in only if
        // the other account started too within 3 s.
        let marks = dir.join("marks");
        std::fs::create_dir_all(&marks).unwrap();
        let script = format!(
            "#!/bin/sh\nm='{m}'\ntouch \"$m/started-$(basename \"$CLAUDE_CONFIG_DIR\")\"\nn=0\nwhile [ $n -lt 150 ]; do\n  if [ -e \"$m/started-one\" ] && [ -e \"$m/started-two\" ]; then printf '{{\"loggedIn\":true}}'; exit 0; fi\n  sleep 0.02; n=$((n+1))\ndone\nprintf '{{\"loggedIn\":false}}'\nexit 1\n",
            m = marks.display()
        );
        let settings = settings_with(&dir, &script, &["one", "two"]);
        let logins = account_logins_from(&settings).unwrap();
        let states: Vec<(&str, &str)> = logins
            .iter()
            .map(|login| (login.id.as_str(), login.login.state.as_str()))
            .collect();
        assert_eq!(states, [("one", "loggedIn"), ("two", "loggedIn")]);
    }
}
