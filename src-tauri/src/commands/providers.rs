//! Provider settings and the per-tab provider (Claude-first plan, Phase 2).

use crate::provider::claude_config::{ConfigDirInfo, CONFIG_DIR_ENV};
use crate::provider::claude_detect::{claude_login_status, resolve_claude};
use crate::cli_detect::LoginStatus;
use crate::provider::ProviderId;
use crate::store::settings_store::{resolved_account_config, ProvidersSettings};
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
/// that account's folder does not exist, so nothing is created.
#[tauri::command]
pub fn claude_account_logins(
    settings: State<Mutex<SettingsStore>>,
) -> Result<Vec<ClaudeAccountLogin>, String> {
    let settings = settings.lock().map_err(|err| err.to_string())?;
    let claude_bin = resolve_claude(settings.providers().claude.claude_path.as_deref());
    let claude = &settings.providers().claude;
    Ok(claude
        .accounts
        .iter()
        .map(|account| {
            let config = resolved_account_config(claude, &account.id);
            let login = claude_login_status(claude_bin.as_deref(), &config);
            ClaudeAccountLogin {
                id: account.id.clone(),
                name: account.name.clone(),
                config,
                login,
            }
        })
        .collect())
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
    let mut settings = settings.lock().map_err(|e| e.to_string())?;
    settings.set_providers(providers)?;
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.new_tab_provider = settings.default_provider();
    drop(state);
    let view = view(&settings);
    drop(settings);
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
