use crate::commands::dev_session::SessionRegistry;
use crate::paths::folder_status_code;
use crate::store::{RolesStore, StateStore, TabRecord, TranscriptStore};
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
    pub folder_status: String,
    pub color: String,
    #[serde(default = "crate::store::state_types::default_tab_kind")]
    pub kind: String,
    #[serde(default)]
    pub terminal_launch: String,
    pub acp_session_id: Option<String>,
    /// Set when this terminal tab was opened with `agent --resume`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    /// Per-tab model override. The UI resolves the effective model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Branch of a worktree tab, read from its HEAD file (F3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTabSummary {
    pub id: String,
    pub label: String,
    pub role_id: String,
    pub cwd: String,
    pub color: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateSnapshot {
    pub active_tab_id: Option<String>,
    pub tabs: Vec<TabSummary>,
    pub closed_tabs: Vec<ClosedTabSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabDetail {
    pub tab: TabRecord,
}

#[tauri::command]
pub fn get_app_state(store: State<Mutex<StateStore>>) -> Result<AppStateSnapshot, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(snapshot_from_store(&store))
}

#[tauri::command]
pub fn get_tab(
    tab_id: String,
    store: State<Mutex<StateStore>>,
    transcripts: State<Mutex<TranscriptStore>>,
) -> Result<TabDetail, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let mut tab = store
        .tab_by_id(&tab_id)
        .cloned()
        .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
    let transcripts = transcripts.lock().map_err(|e| e.to_string())?;
    attach_transcript(&mut tab, &transcripts)?;
    Ok(TabDetail { tab })
}

#[tauri::command]
pub fn select_active_tab(
    tab_id: String,
    store: State<Mutex<StateStore>>,
    transcripts: State<Mutex<TranscriptStore>>,
) -> Result<TabDetail, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.set_active_tab(&tab_id)?;
    let mut tab = store
        .tab_by_id(&tab_id)
        .cloned()
        .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
    drop(store);
    let transcripts = transcripts.lock().map_err(|e| e.to_string())?;
    attach_transcript(&mut tab, &transcripts)?;
    Ok(TabDetail { tab })
}

#[tauri::command]
pub fn close_tab(
    tab_id: String,
    store: State<Mutex<StateStore>>,
    session: State<Mutex<SessionRegistry>>,
    terminals: State<Mutex<crate::pty::PtyRegistry>>,
) -> Result<AppStateSnapshot, String> {
    {
        let mut session = session.lock().map_err(|e| e.to_string())?;
        session.shutdown_tab(&tab_id);
    }
    crate::pty::kill_tab_pty(&terminals, &tab_id);
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
) -> Result<TabDetail, String> {
    let role = {
        let roles = roles.lock().map_err(|e| e.to_string())?;
        roles
            .role_by_id(&role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {role_id}"))
    }?;
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let tab_id = store.create_draft_tab(&role, cwd.trim(), true)?;
    let tab = store
        .tab_by_id(&tab_id)
        .cloned()
        .ok_or_else(|| "draft tab missing after create".to_string())?;
    Ok(TabDetail { tab })
}

const PIPELINE_ROLE_IDS: [&str; 3] = [
    "role_planner",
    "role_implementer",
    "role_pr_reviewer",
];

/// Phase 6: three draft tabs (Planner / Implementer / Reviewer) sharing cwd.
#[tauri::command]
pub fn create_pipeline_tabs(
    roles: State<Mutex<RolesStore>>,
    store: State<Mutex<StateStore>>,
) -> Result<AppStateSnapshot, String> {
    let cwd = {
        let store = store.lock().map_err(|e| e.to_string())?;
        store
            .data
            .active_tab_id
            .as_deref()
            .and_then(|id| store.tab_by_id(id))
            .map(|tab| tab.cwd.clone())
            .or_else(|| store.sorted_tabs().first().map(|tab| tab.cwd.clone()))
            .unwrap_or_default()
    };
    if cwd.trim().is_empty() {
        return Err("Pick a tab with a working folder first.".into());
    }
    let roles_guard = roles.lock().map_err(|e| e.to_string())?;
    let mut store = store.lock().map_err(|e| e.to_string())?;
    for role_id in PIPELINE_ROLE_IDS {
        let role = roles_guard
            .role_by_id(role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {role_id}"))?;
        store.create_draft_tab(&role, cwd.trim(), true)?;
    }
    Ok(snapshot_from_store(&store))
}

#[tauri::command]
pub fn sync_active_tab_form(
    tab_id: String,
    role_id: String,
    cwd: String,
    values: HashMap<String, String>,
    roles: State<Mutex<RolesStore>>,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
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

fn attach_transcript(tab: &mut TabRecord, transcripts: &TranscriptStore) -> Result<(), String> {
    let Some(loaded) = transcripts.load(&tab.id)? else {
        return Ok(());
    };
    if loaded.recovered_from_corrupt {
        let empty = tab
            .transcript
            .as_ref()
            .map(|text| text.trim().is_empty())
            .unwrap_or(true);
        if empty {
            tab.transcript =
                Some("This tab's transcript file was damaged and moved aside.".to_string());
        }
        return Ok(());
    }
    if !loaded.text.trim().is_empty() {
        tab.transcript = Some(loaded.text);
    }
    Ok(())
}

pub(crate) fn snapshot_from_store(store: &StateStore) -> AppStateSnapshot {
    let transcript_dir = store.path.parent().map(|parent| parent.join("transcripts"));
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
                has_transcript: t.transcript.as_ref().is_some_and(|s| !s.trim().is_empty())
                    || transcript_dir.as_ref().is_some_and(|dir| {
                        std::fs::metadata(dir.join(format!("{}.json", t.id)))
                            .map(|meta| meta.len() > 32)
                            .unwrap_or(false)
                    }),
                folder_status: folder_status_code(&t.cwd),
                color: t.color.clone().unwrap_or_default(),
                kind: t.kind.clone(),
                terminal_launch: t.terminal_launch.clone(),
                acp_session_id: t
                    .session
                    .as_ref()
                    .map(|session| session.acp_session_id.clone()),
                resume_session_id: t
                    .answers
                    .get("resumeSessionId")
                    .map(|id| id.trim().to_string())
                    .filter(|id| !id.is_empty()),
                model: t.model.clone(),
                worktree_branch: t.worktree.as_ref().map(|wt| {
                    crate::worktree::head_branch(std::path::Path::new(&wt.path))
                        .unwrap_or_else(|| wt.branch.clone())
                }),
                worktree_path: t.worktree.as_ref().map(|wt| wt.path.clone()),
            })
            .collect(),
        closed_tabs: store
            .data
            .closed_tabs
            .iter()
            .map(|t| ClosedTabSummary {
                id: t.id.clone(),
                label: t.label.clone(),
                role_id: t.role_id.clone(),
                cwd: t.cwd.clone(),
                color: t.color.clone().unwrap_or_default(),
            })
            .collect(),
    }
}

#[tauri::command]
pub fn reopen_closed_tab(
    tab_id: Option<String>,
    store: State<Mutex<StateStore>>,
    transcripts: State<Mutex<crate::store::TranscriptStore>>,
) -> Result<TabDetail, String> {
    let transcript = {
        let state = store.lock().map_err(|e| e.to_string())?;
        let id = match tab_id.as_deref() {
            Some(id) => state
                .data
                .closed_tabs
                .iter()
                .find(|t| t.id == id)
                .map(|t| t.id.clone())
                .ok_or_else(|| "that closed tab is no longer in the list".to_string())?,
            None => state
                .data
                .closed_tabs
                .first()
                .map(|t| t.id.clone())
                .ok_or_else(|| "no closed tab to reopen".to_string())?,
        };
        let transcripts = transcripts.lock().map_err(|e| e.to_string())?;
        transcripts.load(&id)?.and_then(|loaded| {
            if loaded.text.trim().is_empty() {
                None
            } else {
                Some(loaded.text)
            }
        })
    };
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let tab = store.reopen_closed_id(tab_id.as_deref(), transcript)?;
    Ok(TabDetail { tab })
}

#[tauri::command]
pub fn set_tab_label(
    tab_id: String,
    label: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.set_tab_label(&tab_id, &label)
}

#[tauri::command]
pub fn set_tab_color(
    tab_id: String,
    color: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.set_tab_color(&tab_id, &color)
}

#[tauri::command]
pub fn get_layout(store: State<Mutex<StateStore>>) -> Result<crate::store::LayoutState, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(store.layout().clone())
}

#[tauri::command]
pub fn set_layout(
    layout: crate::store::LayoutState,
    store: State<Mutex<StateStore>>,
) -> Result<crate::store::LayoutState, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.set_layout(layout)?;
    Ok(store.layout().clone())
}
