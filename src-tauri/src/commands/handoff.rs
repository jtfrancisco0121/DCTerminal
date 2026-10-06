//! Save and reload Planner hand-offs from app data.

use crate::store::{HandoffRecord, HandoffStore, NewHandoff};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffSaveInput {
    pub source_tab_id: String,
    pub source_role_id: String,
    pub source_label: String,
    pub target_role_id: String,
    pub title: String,
    pub cwd: String,
    pub scope: String,
    pub plan_text: String,
    pub truncated: bool,
    pub warning: Option<String>,
    pub plan_field: Option<String>,
}

#[tauri::command]
pub fn handoff_save(
    input: HandoffSaveInput,
    store: State<Mutex<HandoffStore>>,
) -> Result<HandoffRecord, String> {
    if input.plan_text.trim().is_empty() {
        return Err("There is no plan to send.".into());
    }
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.insert(NewHandoff {
        source_tab_id: input.source_tab_id,
        source_role_id: input.source_role_id,
        source_label: input.source_label,
        target_role_id: input.target_role_id,
        title: input.title,
        cwd: input.cwd,
        scope: input.scope,
        plan_text: input.plan_text,
        truncated: input.truncated,
        warning: input.warning,
        plan_field: input.plan_field,
    })
}

#[tauri::command]
pub fn handoff_bind_tab(
    id: String,
    tab_id: String,
    store: State<Mutex<HandoffStore>>,
) -> Result<HandoffRecord, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.bind_target(&id, &tab_id)
}

#[tauri::command]
pub fn handoff_list(store: State<Mutex<HandoffStore>>) -> Result<Vec<HandoffRecord>, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(store.list())
}

#[tauri::command]
pub fn handoff_get(id: String, store: State<Mutex<HandoffStore>>) -> Result<HandoffRecord, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    store
        .get(&id)?
        .ok_or_else(|| format!("unknown hand-off: {id}"))
}
