//! F4 commands: the diff panel's list, per-file diff, and confirmed revert.
//! Snapshots live in `<app data>/changes/<tab id>`; see `turn_changes`.

use crate::commands::dev_session::SessionRegistry;
use crate::store::StateStore;
use crate::turn_changes::{self, ChangeSet, FileDiff, RevertOutcome, RevertRequest};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// `<app data>/changes`.
pub struct ChangesRoot(pub PathBuf);

impl ChangesRoot {
    pub fn open(data_dir: &std::path::Path, keep: &[String]) -> Self {
        let root = data_dir.join("changes");
        turn_changes::prune(&root, keep);
        Self(root)
    }
}

fn locate(app: &AppHandle, tab_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let cwd = {
        let state = app.state::<Mutex<StateStore>>();
        let store = state.lock().map_err(|e| e.to_string())?;
        store
            .tab_by_id(tab_id)
            .map(|tab| tab.cwd.clone())
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?
    };
    if cwd.trim().is_empty() {
        return Err("This tab has no working folder yet.".to_string());
    }
    let cwd = crate::files::canonical_root(&cwd)?;
    let root = app.state::<ChangesRoot>();
    let snap = turn_changes::snapshot_dir(&root.0, tab_id)?;
    Ok((cwd, snap))
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|err| err.to_string())?
}

/// Called by the prompt worker right before `session/prompt`. Never fails
/// the turn: a folder outside git simply has no diff.
pub fn snapshot_turn(app: &AppHandle, tab_id: &str) {
    let result =
        locate(app, tab_id).and_then(|(cwd, snap)| turn_changes::take_snapshot(&cwd, &snap));
    if let Err(err) = result {
        eprintln!("DCTerminal: change snapshot for {tab_id} failed: {err}");
    }
}

fn scope_of(scope: &str) -> &'static str {
    if scope == "tab" {
        "tab"
    } else {
        "turn"
    }
}

#[tauri::command]
pub async fn changes_list(
    app: AppHandle,
    tab_id: String,
    scope: String,
) -> Result<ChangeSet, String> {
    let (cwd, snap) = locate(&app, &tab_id)?;
    blocking(move || turn_changes::list_changes(&cwd, &snap, scope_of(&scope))).await
}

/// "Snapshot now": start counting changes from this moment (any tab kind).
#[tauri::command]
pub async fn changes_snapshot(app: AppHandle, tab_id: String) -> Result<ChangeSet, String> {
    let (cwd, snap) = locate(&app, &tab_id)?;
    blocking(move || {
        turn_changes::take_snapshot(&cwd, &snap)?;
        turn_changes::list_changes(&cwd, &snap, "turn")
    })
    .await
}

#[tauri::command]
pub async fn changes_file_diff(
    app: AppHandle,
    tab_id: String,
    base: String,
    now: String,
    path: String,
) -> Result<FileDiff, String> {
    let (cwd, snap) = locate(&app, &tab_id)?;
    blocking(move || turn_changes::file_diff(&cwd, &snap, &base, &now, &path)).await
}

/// Revert files to the snapshot. The UI asks first; this refuses without
/// `confirmed` and while the tab's agent is still working.
#[tauri::command]
pub async fn changes_revert(
    app: AppHandle,
    tab_id: String,
    base: String,
    files: Vec<RevertRequest>,
    confirmed: bool,
) -> Result<RevertOutcome, String> {
    if !confirmed {
        return Err("reverting needs confirmation".to_string());
    }
    if files.is_empty() {
        return Ok(RevertOutcome::default());
    }
    {
        let registry = app.state::<Mutex<SessionRegistry>>();
        let registry = registry.lock().map_err(|e| e.to_string())?;
        if registry
            .get(&tab_id)
            .map(|session| session.prompt_in_flight)
            .unwrap_or(false)
        {
            return Err("The agent is still working in this tab. Stop it or wait for the turn to end, then revert.".to_string());
        }
    }
    let (cwd, snap) = locate(&app, &tab_id)?;
    blocking(move || turn_changes::revert_files(&cwd, &snap, &base, &files)).await
}
