//! Read the in-memory Claude limit snapshot for the resolved config folder.

use crate::provider::claude_config::resolve_claude_config_dir;
use crate::store::SettingsStore;
use crate::usage::{UsageSnapshot, UsageStore};
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn get_claude_usage(
    settings: State<Mutex<SettingsStore>>,
    usage: State<Mutex<UsageStore>>,
) -> Result<UsageSnapshot, String> {
    let settings = settings.lock().map_err(|e| e.to_string())?;
    let dir = resolve_claude_config_dir(settings.providers().claude.config_dir.as_deref());
    let usage = usage.lock().map_err(|e| e.to_string())?;
    Ok(usage.snapshot(&dir.path))
}
