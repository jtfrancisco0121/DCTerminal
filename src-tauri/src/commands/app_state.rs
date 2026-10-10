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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline_run_id: Option<String>,    /// Provider this tab uses (`claude` | `cursor`).
    pub provider: crate::provider::ProviderId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_notice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<crate::store::ChainRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_note: Option<String>,
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
pub fn get_app_state(
    window_id: Option<String>,
    store: State<Mutex<StateStore>>,
) -> Result<AppStateSnapshot, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.bind_window(window_id.as_deref());
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
    window_id: Option<String>,
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
    store.bind_window(window_id.as_deref());
    store.close_tab(&tab_id)?;
    Ok(snapshot_from_store(&store))
}

#[tauri::command]
pub fn new_draft_tab(
    role_id: String,
    cwd: String,
    window_id: Option<String>,
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
    store.bind_window(window_id.as_deref());
    let tab_id = store.create_draft_tab(&role, cwd.trim(), true, None)?;
    let tab = store
        .tab_by_id(&tab_id)
        .cloned()
        .ok_or_else(|| "draft tab missing after create".to_string())?;
    Ok(TabDetail { tab })
}

/// Clear the one-line provider notice after the user has seen it.
#[tauri::command]
pub fn ack_provider_notice(
    tab_id: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.set_provider_notice(&tab_id, None)
}

/// Tag or clear an Eagle-Eye chain on a tab that is not running.
/// `handoff_text` is what a hand-off along the chain sent into this tab;
/// the chain's run keeps it for the overview.
#[tauri::command]
pub fn set_tab_chain(
    app: tauri::AppHandle,
    tab_id: String,
    chain: Option<crate::store::ChainRef>,
    handoff_text: Option<String>,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    if store.tab_by_id(&tab_id).is_none() {
        return Err(format!("unknown tab: {tab_id}"));
    }
    // A chain is a label. Hand-off tags the next tab after it has started.
    crate::commands::chain_events::set_tab_chain_and_notify(
        &app,
        &mut store,
        &tab_id,
        chain,
        handoff_text.as_deref(),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainOverviewOpened {
    pub tab_id: String,
    pub state: AppStateSnapshot,
}

/// Show the overview tab of an Eagle-Eye chain, opening one if needed.
/// Only opens a tab; no session starts.
#[tauri::command]
pub fn open_chain_overview(
    chain_id: String,
    window_id: Option<String>,
    store: State<Mutex<StateStore>>,
) -> Result<ChainOverviewOpened, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.bind_window(window_id.as_deref());
    let tab_id = store.open_chain_overview(chain_id.trim())?;
    Ok(ChainOverviewOpened {
        tab_id,
        state: snapshot_from_store(&store),
    })
}

/// Open a Planner (Eagle-Eye 1) or Implementer (Eagle-Eye 2) draft at step 1.
#[tauri::command]
pub fn start_eagle_eye(
    app: tauri::AppHandle,
    kind: String,
    cwd: String,
    window_id: Option<String>,
    roles: State<Mutex<RolesStore>>,
    store: State<Mutex<StateStore>>,
) -> Result<TabDetail, String> {
    let kind = kind.trim().to_ascii_lowercase();
    let (role_id, total) = match kind.as_str() {
        "eagle1" => ("role_planner", 4u32),
        "eagle2" => ("role_implementer", 2u32),
        _ => return Err("Eagle-Eye kind must be eagle1 or eagle2.".to_string()),
    };
    let role = {
        let roles = roles.lock().map_err(|e| e.to_string())?;
        roles
            .role_by_id(role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {role_id}"))
    }?;
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.bind_window(window_id.as_deref());
    let tab_id = store.create_draft_tab(&role, cwd.trim(), true, None)?;
    let chain_id = format!(
        "ee_{}",
        chrono::Utc::now().timestamp_millis()
    );
    crate::commands::chain_events::set_tab_chain_and_notify(
        &app,
        &mut store,
        &tab_id,
        Some(crate::store::ChainRef {
            chain_id,
            kind,
            step: 1,
            total,
        }),
        None,
    )?;
    let tab = store
        .tab_by_id(&tab_id)
        .cloned()
        .ok_or_else(|| "draft tab missing after create".to_string())?;
    Ok(TabDetail { tab })
}

const FULL_PIPELINE_ROLE_IDS: [&str; 4] = [
    "role_planner",
    "role_plan_reviewer",
    "role_implementer",
    "role_pr_reviewer",
];

const EXECUTION_PIPELINE_ROLE_IDS: [&str; 2] = ["role_implementer", "role_pr_reviewer"];

fn pipeline_cwd(store: &StateStore) -> Result<String, String> {
    let cwd = store
        .active_for_window(store.focus_window())
        .as_deref()
        .and_then(|id| store.tab_by_id(id))
        .map(|tab| tab.cwd.clone())
        .or_else(|| {
            store
                .tabs_in_window(store.focus_window())
                .first()
                .map(|tab| tab.cwd.clone())
        })
        .unwrap_or_default();
    if cwd.trim().is_empty() {
        return Err("Pick a tab with a working folder first.".into());
    }
    Ok(cwd)
}

/// Full pipeline: worker tabs + eagle-eye overview (Planner → Plan Reviewer → Implementer → PR).
#[tauri::command]
pub fn create_pipeline_tabs(
    window_id: Option<String>,
    roles: State<Mutex<RolesStore>>,
    store: State<Mutex<StateStore>>,
) -> Result<AppStateSnapshot, String> {
    let cwd = {
        let mut store = store.lock().map_err(|e| e.to_string())?;
        store.bind_window(window_id.as_deref());
        pipeline_cwd(&store)?
    };
    let roles_guard = roles.lock().map_err(|e| e.to_string())?;
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.bind_window(window_id.as_deref());
    store.create_pipeline_workspace(
        &roles_guard,
        cwd.trim(),
        "full",
        &FULL_PIPELINE_ROLE_IDS,
        "planner",
    )?;
    Ok(snapshot_from_store(&store))
}

/// Execute pipeline: Implementer + PR Reviewer + eagle-eye overview.
#[tauri::command]
pub fn create_execution_pipeline_tabs(
    window_id: Option<String>,
    roles: State<Mutex<RolesStore>>,
    store: State<Mutex<StateStore>>,
) -> Result<AppStateSnapshot, String> {
    let cwd = {
        let mut store = store.lock().map_err(|e| e.to_string())?;
        store.bind_window(window_id.as_deref());
        pipeline_cwd(&store)?
    };
    let roles_guard = roles.lock().map_err(|e| e.to_string())?;
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.bind_window(window_id.as_deref());
    store.create_pipeline_workspace(
        &roles_guard,
        cwd.trim(),
        "execute",
        &EXECUTION_PIPELINE_ROLE_IDS,
        "implementer",
    )?;
    Ok(snapshot_from_store(&store))
}

#[tauri::command]
pub fn sync_active_tab_form(
    app: tauri::AppHandle,
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
    crate::commands::chain_events::notify_form_sync(&app, &store, &tab_id);
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
    let window_id = store.focus_window();
    AppStateSnapshot {
        active_tab_id: store.active_for_window(window_id),
        tabs: store
            .tabs_in_window(window_id)
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
                acp_session_id: crate::store::displayed_acp_session(t),
                resume_session_id: crate::store::displayed_resume_session(t),
                model: t.model.clone(),
                worktree_branch: t.worktree.as_ref().map(|wt| {
                    crate::worktree::head_branch(std::path::Path::new(&wt.path))
                        .unwrap_or_else(|| wt.branch.clone())
                }),
                worktree_path: t.worktree.as_ref().map(|wt| wt.path.clone()),
                pipeline_run_id: t.pipeline_run_id.clone(),
                provider: crate::provider::ProviderId::resolve(t.provider),
                provider_notice: t.provider_notice.clone(),
                chain: t.chain.clone(),
                permission_note: t.permission_note.clone(),
            })
            .collect(),
        closed_tabs: store
            .data
            .closed_tabs
            .iter()
            .filter(|tab| crate::store::window_matches(&tab.window_id, window_id))
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
    window_id: Option<String>,
    store: State<Mutex<StateStore>>,
    transcripts: State<Mutex<crate::store::TranscriptStore>>,
) -> Result<TabDetail, String> {
    let transcript = {
        let mut state = store.lock().map_err(|e| e.to_string())?;
        state.bind_window(window_id.as_deref());
        let focus = state.focus_window().to_string();
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
                .iter()
                .find(|tab| crate::store::window_matches(&tab.window_id, &focus))
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
    store.bind_window(window_id.as_deref());
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
pub fn get_layout(
    window_id: Option<String>,
    store: State<Mutex<StateStore>>,
) -> Result<crate::store::LayoutState, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.bind_window(window_id.as_deref());
    Ok(store.layout().clone())
}

#[tauri::command]
pub fn set_layout(
    layout: crate::store::LayoutState,
    window_id: Option<String>,
    store: State<Mutex<StateStore>>,
) -> Result<crate::store::LayoutState, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.bind_window(window_id.as_deref());
    store.set_layout(layout)?;
    Ok(store.layout().clone())
}

#[cfg(test)]
mod pipeline_tests {
    use super::{EXECUTION_PIPELINE_ROLE_IDS, FULL_PIPELINE_ROLE_IDS};
    use crate::roles::RolesFile;
    use crate::store::{read_json, seed_output_path, AppStateFile, RolesStore, StateStore};

    fn temp_roles_store(seed: RolesFile) -> RolesStore {
        RolesStore {
            path: std::env::temp_dir().join("dct_roles_test.json"),
            data: seed,
        }
    }

    #[test]
    fn pipeline_workspace_opens_overview_tab() {
        let seed: RolesFile = read_json(&seed_output_path()).expect("roles seed");
        let roles = temp_roles_store(seed);
        let dir = std::env::temp_dir().join(format!(
            "dct_pipeline_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let mut store = StateStore {
            path,
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::MAIN_WINDOW_ID.to_string(),
        };
        let cwd = "/tmp/pipeline-project";
        let overview_id = store
            .create_pipeline_workspace(&roles, cwd, "full", &FULL_PIPELINE_ROLE_IDS, "planner")
            .unwrap();
        let active = store
            .tab_by_id(&overview_id)
            .expect("overview tab record");
        assert_eq!(active.kind, "pipeline_overview");
        assert_eq!(store.data.active_tab_id.as_deref(), Some(overview_id.as_str()));
        assert_eq!(store.data.pipeline_runs.len(), 1);
        assert_eq!(store.data.pipeline_runs[0].tab_ids.len(), 4);
        for role_id in [
            "role_planner",
            "role_plan_reviewer",
            "role_implementer",
            "role_pr_reviewer",
        ] {
            assert!(
                store.data.pipeline_runs[0].tab_ids.contains_key(role_id),
                "pipeline missing {role_id}"
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn execution_pipeline_workspace_opens_overview_tab() {
        let seed: RolesFile = read_json(&seed_output_path()).expect("roles seed");
        let roles = temp_roles_store(seed);
        let dir = std::env::temp_dir().join(format!(
            "dct_exec_pipeline_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let mut store = StateStore {
            path,
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::MAIN_WINDOW_ID.to_string(),
        };
        let cwd = "/tmp/execution-pipeline-project";
        let overview_id = store
            .create_pipeline_workspace(
                &roles,
                cwd,
                "execute",
                &EXECUTION_PIPELINE_ROLE_IDS,
                "implementer",
            )
            .unwrap();
        let active = store
            .tab_by_id(&overview_id)
            .expect("overview tab record");
        assert_eq!(active.kind, "pipeline_overview");
        assert_eq!(store.data.pipeline_runs[0].kind, "execute");
        assert_eq!(store.data.pipeline_runs[0].tab_ids.len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
