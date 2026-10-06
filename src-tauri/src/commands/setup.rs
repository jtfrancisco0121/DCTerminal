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
