//! F7 workspaces: save the open tabs as a named set and open it later.
//! Stored in `workspaces.json` in DCTerminal's app data dir only.

use crate::commands::app_state::{snapshot_from_store, AppStateSnapshot};
use crate::commands::dev_session::SessionRegistry;
use crate::store::{RoleSnapshot, RolesStore, StateStore, Workspace, WorkspaceStore, WorkspaceTab};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceList {
    pub workspaces: Vec<Workspace>,
    /// Where workspaces are stored, shown in the dialog.
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpened {
    pub state: AppStateSnapshot,
    /// New tab ids, in workspace order.
    pub tab_ids: Vec<String>,
    /// Labels of tabs left out because their role no longer exists.
    pub skipped: Vec<String>,
}

fn list(store: &WorkspaceStore) -> WorkspaceList {
    WorkspaceList {
        workspaces: store.list(),
        path: store.path.display().to_string(),
    }
}

#[tauri::command]
pub fn workspaces_list(store: State<Mutex<WorkspaceStore>>) -> Result<WorkspaceList, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(list(&store))
}

/// Save the open tabs (titles, folders, roles, kinds) under `name`.
#[tauri::command]
pub fn workspace_save(
    name: String,
    replace: bool,
    state: State<Mutex<StateStore>>,
    store: State<Mutex<WorkspaceStore>>,
) -> Result<WorkspaceList, String> {
    let (tabs, active_index, layout) = {
        let state = state.lock().map_err(|e| e.to_string())?;
        let sorted = state.sorted_tabs();
        let active = state.data.active_tab_id.as_deref();
        let active_index = sorted.iter().position(|t| Some(t.id.as_str()) == active);
        let tabs: Vec<WorkspaceTab> = sorted.into_iter().map(WorkspaceTab::from_record).collect();
        let layout = Some(state.data.layout.clone());
        (tabs, active_index, layout)
    };
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let before = store.data.clone();
    let now = chrono::Utc::now().to_rfc3339();
    store.save_workspace(&name, tabs, active_index, layout, replace, &now)?;
    if let Err(err) = store.save() {
        store.data = before;
        return Err(format!("Could not save workspaces: {err}"));
    }
    Ok(list(&store))
}

#[tauri::command]
pub fn workspace_delete(
    id: String,
    store: State<Mutex<WorkspaceStore>>,
) -> Result<WorkspaceList, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let before = store.data.clone();
    store.delete(&id)?;
    if let Err(err) = store.save() {
        store.data = before;
        return Err(format!("Could not save workspaces: {err}"));
    }
    Ok(list(&store))
}

/// Open a workspace as new tabs. Chat tabs come back as drafts (nothing is
/// started). With `replace`, the open tabs' agents and terminals are stopped
/// and the tabs are closed (they stay in the reopen list).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn workspace_open(
    id: String,
    replace: bool,
    window_id: Option<String>,
    store: State<Mutex<WorkspaceStore>>,
    roles: State<Mutex<RolesStore>>,
    state: State<Mutex<StateStore>>,
    session: State<Mutex<SessionRegistry>>,
    terminals: State<Mutex<crate::pty::PtyRegistry>>,
) -> Result<WorkspaceOpened, String> {
    let workspace = {
        let store = store.lock().map_err(|e| e.to_string())?;
        store
            .get(&id)
            .cloned()
            .ok_or_else(|| "That workspace is no longer saved.".to_string())?
    };
    let (usable, skipped) = {
        let roles = roles.lock().map_err(|e| e.to_string())?;
        workspace.with_current_roles(|role_id| {
            roles.role_by_id(role_id).map(|role| RoleSnapshot {
                name: role.name.clone(),
                template_version: role.template_version,
                mode: role.default_mode.clone(),
                injection: role.injection.clone(),
            })
        })
    };
    if usable.tabs.is_empty() {
        return Err("None of this workspace's roles exist any more.".into());
    }
    if replace {
        let open: Vec<String> = {
            let mut state = state.lock().map_err(|e| e.to_string())?;
            state.bind_window(window_id.as_deref());
            state
                .tabs_in_window(state.focus_window())
                .iter()
                .map(|tab| tab.id.clone())
                .collect()
        };
        for tab_id in &open {
            {
                let mut session = session.lock().map_err(|e| e.to_string())?;
                session.shutdown_tab(tab_id);
            }
            crate::pty::kill_tab_pty(&terminals, tab_id);
        }
    }
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.bind_window(window_id.as_deref());
    let tab_ids = state.open_workspace(&usable, replace)?;
    Ok(WorkspaceOpened {
        state: snapshot_from_store(&state),
        tab_ids,
        skipped,
    })
}
