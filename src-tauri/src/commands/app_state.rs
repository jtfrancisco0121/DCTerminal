use crate::commands::dev_session::DevSessionState;
use crate::store::{RolesStore, StateStore, TabRecord};
use serde::Serialize;
use std::collections::HashMap;
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
    pub startup_prompt_sent: bool,
    pub has_transcript: bool,
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
            .sorted_tabs()
            .iter()
            .map(|t| TabSummary {
                id: t.id.clone(),
                label: t.label.clone(),
                role_id: t.role_id.clone(),
                cwd: t.cwd.clone(),
                phase: t.phase.clone(),
                merged_prompt_chars: t.merged_prompt.len(),
                startup_prompt_sent: t.startup_prompt_sent,
                has_transcript: t
                    .transcript
                    .as_ref()
                    .is_some_and(|s| !s.trim().is_empty()),
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

#[tauri::command]
pub fn select_active_tab(
    tab_id: String,
    store: State<Mutex<StateStore>>,
    session: State<Mutex<DevSessionState>>,
) -> Result<TabDetail, String> {
    let session = session.lock().map_err(|e| e.to_string())?;
    if session.client.is_some() {
        return Err("stop the current session before switching tabs".to_string());
    }
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.set_active_tab(&tab_id)?;
    let tab = store
        .tab_by_id(&tab_id)
        .cloned()
        .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
    Ok(TabDetail { tab })
}

#[tauri::command]
pub fn close_tab(
    tab_id: String,
    store: State<Mutex<StateStore>>,
    session: State<Mutex<DevSessionState>>,
) -> Result<AppStateSnapshot, String> {
    let session = session.lock().map_err(|e| e.to_string())?;
    if session.active_tab_id.as_deref() == Some(tab_id.as_str()) && session.client.is_some() {
        return Err("stop the session before closing this tab".to_string());
    }
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.close_tab(&tab_id)?;
    Ok(snapshot_from_store(&store))
}

#[tauri::command]
pub fn new_draft_tab(
    role_id: String,
    cwd: String,
    roles: State<Mutex<RolesStore>>,
    store: State<Mutex<StateStore>>,
    session: State<Mutex<DevSessionState>>,
) -> Result<TabDetail, String> {
    let make_active = {
        let session = session.lock().map_err(|e| e.to_string())?;
        session.client.is_none()
    };
    let role = {
        let roles = roles.lock().map_err(|e| e.to_string())?;
        roles
            .role_by_id(&role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {role_id}"))
    }?;
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let tab_id = store.create_draft_tab(&role, cwd.trim(), make_active)?;
    let tab = store
        .tab_by_id(&tab_id)
        .cloned()
        .ok_or_else(|| "draft tab missing after create".to_string())?;
    Ok(TabDetail { tab })
}

#[tauri::command]
pub fn sync_active_tab_form(
    tab_id: String,
    role_id: String,
    cwd: String,
    values: HashMap<String, String>,
    roles: State<Mutex<RolesStore>>,
    store: State<Mutex<StateStore>>,
    session: State<Mutex<DevSessionState>>,
) -> Result<(), String> {
    let session = session.lock().map_err(|e| e.to_string())?;
    if session.client.is_some() {
        return Ok(());
    }
    let role = {
        let roles = roles.lock().map_err(|e| e.to_string())?;
        roles
            .role_by_id(&role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {role_id}"))?
    };
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.sync_tab_form(&tab_id, &role, &values, cwd.trim())?;
    Ok(())
}

fn snapshot_from_store(store: &StateStore) -> AppStateSnapshot {
    AppStateSnapshot {
        active_tab_id: store.data.active_tab_id.clone(),
        tabs: store
            .sorted_tabs()
            .iter()
            .map(|t| TabSummary {
                id: t.id.clone(),
                label: t.label.clone(),
                role_id: t.role_id.clone(),
                cwd: t.cwd.clone(),
                phase: t.phase.clone(),
                merged_prompt_chars: t.merged_prompt.len(),
                startup_prompt_sent: t.startup_prompt_sent,
                has_transcript: t
                    .transcript
                    .as_ref()
                    .is_some_and(|s| !s.trim().is_empty()),
            })
            .collect(),
    }
}
