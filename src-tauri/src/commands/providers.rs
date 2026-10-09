//! Provider settings and the per-tab provider (Claude-first plan, Phase 2).

use crate::provider::claude_config::{resolve_claude_config_dir, ConfigDirInfo, CONFIG_DIR_ENV};
use crate::provider::ProviderId;
use crate::store::settings_store::ProvidersSettings;
use crate::store::{SettingsStore, StateStore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsView {
    pub settings: ProvidersSettings,
    /// The Claude config folder every Claude process gets as
    /// `CLAUDE_CONFIG_DIR`, with where it came from.
    pub claude_config_dir: ConfigDirInfo,
    /// Value of `DCT_CLAUDE_CONFIG_DIR` when set (the setting is then ignored).
    pub claude_config_dir_env: Option<String>,
}

fn view(settings: &SettingsStore) -> ProviderSettingsView {
    ProviderSettingsView {
        settings: settings.providers().clone(),
        claude_config_dir: resolve_claude_config_dir(
            settings.providers().claude.config_dir.as_deref(),
        ),
        claude_config_dir_env: std::env::var(CONFIG_DIR_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty()),
    }
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
    providers: ProvidersSettings,
    settings: State<Mutex<SettingsStore>>,
    state: State<Mutex<StateStore>>,
) -> Result<ProviderSettingsView, String> {
    let mut settings = settings.lock().map_err(|e| e.to_string())?;
    settings.set_providers(providers)?;
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.new_tab_provider = settings.default_provider();
    Ok(view(&settings))
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
