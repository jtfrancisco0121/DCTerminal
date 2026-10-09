//! F8 first-run setup: whether to show it, and remembering it is done.
//! The flag lives in DCTerminal's `settings.json` (app data).

use crate::store::{first_run_needed, SettingsStore, StateStore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstRunStatus {
    pub needed: bool,
    pub completed: bool,
}

#[tauri::command]
pub fn first_run_status(
    settings: State<Mutex<SettingsStore>>,
    state: State<Mutex<StateStore>>,
) -> Result<FirstRunStatus, String> {
    let completed = settings
        .lock()
        .map_err(|e| e.to_string())?
        .setup_completed();
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(FirstRunStatus {
        needed: first_run_needed(completed, &state.data),
        completed,
    })
}

/// Finished or skipped: do not show setup again on its own.
#[tauri::command]
pub fn first_run_complete(settings: State<Mutex<SettingsStore>>) -> Result<(), String> {
    let mut settings = settings.lock().map_err(|e| e.to_string())?;
    settings.mark_setup_complete(&chrono::Utc::now().to_rfc3339())
}

/// Settings > Providers and first-run: what was found for one provider.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReport {
    pub status: crate::provider::ProviderStatus,
    pub login: crate::cli_detect::LoginStatus,
    /// Claude: the config folder used for `CLAUDE_CONFIG_DIR`.
    pub config_dir: Option<crate::provider::claude_config::ConfigDirInfo>,
    /// Claude: install command for the ACP adapter.
    pub adapter_install: Option<String>,
}

/// Detect a provider and ask its CLI whether it is signed in (read-only;
/// for Claude both calls run with `CLAUDE_CONFIG_DIR=<configDir>`).
#[tauri::command]
pub async fn provider_status(
    provider: crate::provider::ProviderId,
    settings: State<'_, Mutex<SettingsStore>>,
) -> Result<ProviderReport, String> {
    let providers = settings
        .lock()
        .map_err(|e| e.to_string())?
        .providers()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let provider = crate::provider::provider_for(provider, &providers);
        ProviderReport {
            status: provider.detect(),
            login: provider.login_status(),
            config_dir: provider.config_dir(),
            adapter_install: (provider.id() == crate::provider::ProviderId::Claude)
                .then(crate::provider::claude_detect::adapter_install_command),
        }
    })
    .await
    .map_err(|err| err.to_string())
}
