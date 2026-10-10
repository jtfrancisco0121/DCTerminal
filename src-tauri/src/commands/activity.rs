//! Agent activity log commands and the hooks the prompt worker and the
//! permission paths call. Recording never fails a turn: errors go to stderr.

use crate::permissions::activity::{decision_patch, patch_for_permission, patch_for_update};
use crate::permissions::ToolCallCache;
use crate::store::{ActivityEntry, ActivityPatch, ActivityStore};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn append(app: &AppHandle, patch: &ActivityPatch) {
    let Some(state) = app.try_state::<Mutex<ActivityStore>>() else {
        return;
    };
    let Ok(store) = state.lock() else {
        return;
    };
    if let Err(err) = store.append(patch) {
        eprintln!(
            "DCTerminal: activity log for {} failed: {err}",
            patch.tab_id
        );
    }
}

/// The line for a `tool_call` / `tool_call_update`, built while the caller
/// still holds the session (its cache has already observed `line`).
pub fn update_line(tab_id: &str, line: &Value, cache: &ToolCallCache) -> Option<ActivityPatch> {
    patch_for_update(tab_id, line, cache, &now())
}

pub fn write_line(app: &AppHandle, patch: Option<ActivityPatch>) {
    if let Some(patch) = patch {
        append(app, &patch);
    }
}

/// A permission request with its decision (`None` while the card is up).
pub fn record_permission(
    app: &AppHandle,
    tab_id: &str,
    json_rpc_id: u64,
    enriched_params: &Value,
    decision: Option<&str>,
) {
    let patch = patch_for_permission(tab_id, json_rpc_id, enriched_params, decision, &now());
    append(app, &patch);
}

/// JT's answer (or a cancel) for a row recorded earlier.
pub fn record_decision(app: &AppHandle, tab_id: &str, tool_call_id: &str, decision: &str) {
    append(app, &decision_patch(tab_id, tool_call_id, decision, &now()));
}

fn store_of(app: &AppHandle) -> Result<ActivityStore, String> {
    let state = app.state::<Mutex<ActivityStore>>();
    let store = state.lock().map_err(|e| e.to_string())?;
    Ok(store.clone())
}

/// Merged rows for a tab, oldest first (newest last).
#[tauri::command]
pub async fn activity_list(
    app: AppHandle,
    tab_id: String,
    limit: Option<usize>,
) -> Result<Vec<ActivityEntry>, String> {
    let store = store_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.list(&tab_id, limit))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn activity_clear(app: AppHandle, tab_id: String) -> Result<(), String> {
    let state = app.state::<Mutex<ActivityStore>>();
    let store = state.lock().map_err(|e| e.to_string())?;
    store.clear(&tab_id)
}
