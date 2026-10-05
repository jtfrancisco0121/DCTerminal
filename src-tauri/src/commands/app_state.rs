use crate::store::{StateStore, TabRecord};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSummary {
    pub id: String,
    pub label: String,
    pub role_id: String,
    pub cwd: String,
    pub phase: String,
    pub merged_prompt_chars: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateSnapshot {
    pub active_tab_id: Option<String>,
    pub tabs: Vec<TabSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabDetail {
    pub tab: TabRecord,
}

#[tauri::command]
pub fn get_app_state(store: State<Mutex<StateStore>>) -> Result<AppStateSnapshot, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(AppStateSnapshot {
        active_tab_id: store.data.active_tab_id.clone(),
        tabs: store
            .data
            .tabs
            .iter()
            .map(|t| TabSummary {
                id: t.id.clone(),
                label: t.label.clone(),
                role_id: t.role_id.clone(),
                cwd: t.cwd.clone(),
                phase: t.phase.clone(),
                merged_prompt_chars: t.merged_prompt.len(),
            })
            .collect(),
    })
}

#[tauri::command]
pub fn get_tab(tab_id: String, store: State<Mutex<StateStore>>) -> Result<TabDetail, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let tab = store
        .tab_by_id(&tab_id)
        .cloned()
        .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
    Ok(TabDetail { tab })
}
