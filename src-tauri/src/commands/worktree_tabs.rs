//! F3 commands. Every git write here is a direct result of a user action
//! in the UI: the "New tab in worktree…" dialog, or a confirmed removal.

use crate::commands::app_state::TabDetail;
use crate::store::{RolesStore, StateStore};
use crate::worktree::{self, RepoInfo, WorktreeRef};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|err| err.to_string())?
}

/// Read-only: branches and the destination folder for the dialog.
#[tauri::command]
pub async fn git_repo_info(path: String) -> Result<RepoInfo, String> {
    blocking(move || worktree::repo_info(&PathBuf::from(path.trim()))).await
}

/// "New tab in worktree…": `git worktree add` into
/// `<repo>-worktrees/<branch>`, then a draft tab in that folder.
#[tauri::command]
pub async fn worktree_tab_new(
    app: AppHandle,
    role_id: String,
    repo_path: String,
    branch: String,
    create_branch: bool,
    base: Option<String>,
    window_id: Option<String>,
) -> Result<TabDetail, String> {
    let role = {
        let roles = app.state::<Mutex<RolesStore>>();
        let roles = roles.lock().map_err(|e| e.to_string())?;
        roles
            .role_by_id(&role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {role_id}"))?
    };
    let created = blocking(move || {
        worktree::add_worktree(
            &PathBuf::from(repo_path.trim()),
            &branch,
            create_branch,
            base.as_deref(),
        )
    })
    .await?;
    let state = app.state::<Mutex<StateStore>>();
    let mut store = state.lock().map_err(|e| e.to_string())?;
    store.bind_window(window_id.as_deref());
    let tab_id = store.create_worktree_tab(&role, created)?;
    let tab = store
        .tab_by_id(&tab_id)
        .cloned()
        .ok_or_else(|| "worktree tab missing after create".to_string())?;
    Ok(TabDetail { tab })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCheck {
    pub worktree: WorktreeRef,
    /// Branch checked out right now (may differ from when it was created).
    pub branch: Option<String>,
    /// `git status --porcelain` lines. Removal is refused unless empty.
    pub dirty: Vec<String>,
}

/// Read-only pre-check before asking the user to confirm a removal.
#[tauri::command]
pub async fn worktree_tab_check(app: AppHandle, tab_id: String) -> Result<WorktreeCheck, String> {
    let wt = worktree_of(&app, &tab_id)?;
    blocking(move || {
        let path = PathBuf::from(&wt.path);
        if !path.is_dir() {
            return Err(format!("worktree folder is gone: {}", wt.path));
        }
        Ok(WorktreeCheck {
            branch: worktree::head_branch(&path),
            dirty: worktree::dirty_files(&path)?,
            worktree: wt,
        })
    })
    .await
}

/// Remove the worktree of a tab the user already closed, after they
/// confirmed. Never forces: a dirty tree is refused.
#[tauri::command]
pub async fn worktree_tab_remove(
    app: AppHandle,
    tab_id: String,
    confirmed: bool,
) -> Result<(), String> {
    if !confirmed {
        return Err("removing a worktree needs confirmation".to_string());
    }
    {
        let state = app.state::<Mutex<StateStore>>();
        let store = state.lock().map_err(|e| e.to_string())?;
        if store.is_tab_open(&tab_id) {
            return Err("close the tab before removing its worktree".to_string());
        }
    }
    let wt = worktree_of(&app, &tab_id)?;
    blocking(move || worktree::remove_worktree(&wt)).await
}

fn worktree_of(app: &AppHandle, tab_id: &str) -> Result<WorktreeRef, String> {
    let state = app.state::<Mutex<StateStore>>();
    let store = state.lock().map_err(|e| e.to_string())?;
    store
        .worktree_for(tab_id)
        .ok_or_else(|| "this tab was not opened in a worktree".to_string())
}
