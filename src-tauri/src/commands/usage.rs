//! Read the in-memory Claude limit snapshot for the resolved config folder.

use crate::store::SettingsStore;
use crate::usage::{UsageSnapshot, UsageStore};
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn get_claude_usage(
    window_id: Option<String>,
    settings: State<Mutex<SettingsStore>>,
    state: State<Mutex<crate::store::StateStore>>,
    usage: State<Mutex<UsageStore>>,
) -> Result<UsageSnapshot, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.bind_window(window_id.as_deref());
    let account = state.account_for_window(state.focus_window());
    let settings = settings.lock().map_err(|e| e.to_string())?;
    let dir = crate::store::settings_store::resolved_account_config(
        &settings.providers().claude,
        &account,
    );
    let usage = usage.lock().map_err(|e| e.to_string())?;
    Ok(usage.snapshot(&dir.path))
}
