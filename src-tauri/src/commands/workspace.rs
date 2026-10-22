//! Scratch pads, recent projects, transcripts, tab chrome, and diagnostics.

use crate::paths::validate_working_folder;
use crate::permissions::{read_approval_mode, ApprovalModeStatus};
use crate::store::{ProjectsStore, ScratchStore, SettingsStore, StateStore, TranscriptStore};
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchSnapshot {
    pub pads: Vec<ScratchPadEntry>,
    /// Open and closed tabs in every window. The WebView drops mirrored
    /// pads for any other tab so a deleted tab's draft is not resurrected.
    pub known_tab_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchPadEntry {
    pub tab_id: String,
    pub content: String,
    pub updated_at: String,
    pub history: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedProjectDto {
    pub path: String,
    pub available: bool,
    pub favorite: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLists {
    pub favorites: Vec<ListedProjectDto>,
    pub recent: Vec<ListedProjectDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLoad {
    pub text: String,
    pub cwd: String,
    pub read_only: bool,
    pub recovered_from_corrupt: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsStatus {
    pub capture_permission_payloads: bool,
    pub app_data_dir: String,
    pub transcripts_dir: String,
    pub log_path: String,
    /// `logs/crash.log`: panics, with a backtrace.
    pub crash_log_path: String,
    pub last_error: Option<String>,
}

#[tauri::command]
pub fn scratch_load(
    store: State<Mutex<ScratchStore>>,
    state: State<Mutex<StateStore>>,
) -> Result<ScratchSnapshot, String> {
    let known_tab_ids = {
        let state = state.lock().map_err(|e| e.to_string())?;
        super::storage::known_tab_ids(&state)
    };
    let store = store.lock().map_err(|e| e.to_string())?;
    let mut pads: Vec<ScratchPadEntry> = store
        .data
        .pads
        .iter()
        .map(|(tab_id, pad)| ScratchPadEntry {
            tab_id: tab_id.clone(),
            content: pad.content.clone(),
            updated_at: pad.updated_at.clone(),
            history: pad.history.clone(),
        })
        .collect();
    pads.sort_by(|a, b| a.tab_id.cmp(&b.tab_id));
    Ok(ScratchSnapshot {
        pads,
        known_tab_ids,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchSaveOutcome {
    /// False when the stored pad is newer (another window edited it); the
    /// caller should adopt `pad` instead of its own copy.
    pub applied: bool,
    /// The pad as stored after this call.
    pub pad: ScratchPadEntry,
}

/// `updated_at` is when the caller's copy was edited (RFC3339). `None`
/// means now, for callers that write a fresh pad.
#[tauri::command]
pub fn scratch_save(
    tab_id: String,
    content: String,
    history: Vec<String>,
    updated_at: Option<String>,
    store: State<Mutex<ScratchStore>>,
) -> Result<ScratchSaveOutcome, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let updated_at = updated_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let applied = store.upsert_if_newer(&tab_id, &content, &history, &updated_at);
    if applied {
        store.save()?;
    }
    let pad = &store.data.pads[&tab_id];
    Ok(ScratchSaveOutcome {
        applied,
        pad: ScratchPadEntry {
            tab_id,
            content: pad.content.clone(),
            updated_at: pad.updated_at.clone(),
            history: pad.history.clone(),
        },
    })
}

#[tauri::command]
pub fn projects_list(store: State<Mutex<ProjectsStore>>) -> Result<ProjectLists, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let (favorites, recent) = store.list();
    Ok(ProjectLists {
        favorites: favorites.into_iter().map(listed_dto).collect(),
        recent: recent.into_iter().map(listed_dto).collect(),
    })
}

#[tauri::command]
pub fn projects_remember(path: String, store: State<Mutex<ProjectsStore>>) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.remember(&path, &chrono::Utc::now().to_rfc3339());
    store.save()
}

#[tauri::command]
pub fn projects_toggle_favorite(
    path: String,
    store: State<Mutex<ProjectsStore>>,
) -> Result<bool, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let starred = store.toggle_favorite(&path, &chrono::Utc::now().to_rfc3339());
    store.save()?;
    Ok(starred)
}

#[tauri::command]
pub fn projects_remove(
    path: String,
    favorite: bool,
    store: State<Mutex<ProjectsStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.remove(&path, favorite);
    store.save()
}

/// Same rules as session start: the path must exist, be a directory, and be
/// readable. It need not be a git repo: a workspace folder of repos (W1)
/// and a plain folder both pass.
#[tauri::command]
pub fn check_working_folder(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    validate_working_folder(trimmed).map_err(|err| err.message())?;
    Ok(trimmed.to_string())
}

#[tauri::command]
pub async fn transcript_save(
    app: tauri::AppHandle,
    tab_id: String,
    text: String,
    cwd: String,
) -> Result<(), String> {
    save_tab_transcript_blocking(app, tab_id, text, cwd).await
}

/// `save_tab_transcript` on a blocking thread, stamped now: the write and
/// the rotation scan never run on the main thread.
pub(crate) async fn save_tab_transcript_blocking(
    app: tauri::AppHandle,
    tab_id: String,
    text: String,
    cwd: String,
) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<StateStore>>();
        let transcripts = app.state::<Mutex<TranscriptStore>>();
        save_tab_transcript(
            &state,
            &transcripts,
            &tab_id,
            &text,
            &cwd,
            &chrono::Utc::now().to_rfc3339(),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Saves one tab's transcript. Rotation never drops the file of an open or
/// closed tab, so a tab reopened from the closed list gets its chat back.
/// The state lock is released before the transcript lock is taken, and the
/// transcript lock covers only the file write: the rotation scan runs after
/// it is dropped. Callers must not hold either lock. A tab that saves in
/// either gap is not in `keep`, so rotation also spares any file modified
/// since this save began. Blocking: call it off the main thread.
pub(crate) fn save_tab_transcript(
    state: &Mutex<StateStore>,
    transcripts: &Mutex<TranscriptStore>,
    tab_id: &str,
    text: &str,
    cwd: &str,
    now: &str,
) -> Result<(), String> {
    let cutoff = std::time::SystemTime::now();
    let mut keep = {
        let state = state.lock().map_err(|e| e.to_string())?;
        crate::commands::storage::known_tab_ids(&state)
    };
    keep.push(tab_id.to_string());
    let dir = {
        let transcripts = transcripts.lock().map_err(|e| e.to_string())?;
        transcripts.write(tab_id, text, cwd, now)?;
        transcripts.dir.clone()
    };
    crate::store::rotate_transcripts(&dir, &keep, Some(cutoff))
}

/// F5: search saved chat text across open tabs, closed tabs, and older
/// transcripts. Read-only.
#[tauri::command]
pub async fn history_search(
    app: tauri::AppHandle,
    query: String,
) -> Result<Vec<crate::history_search::HistoryHit>, String> {
    use tauri::Manager;
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let files = {
        let transcripts = app.state::<Mutex<TranscriptStore>>();
        let transcripts = transcripts.lock().map_err(|e| e.to_string())?;
        transcripts.list_all()
    };
    let sources = {
        let state = app.state::<Mutex<StateStore>>();
        let state = state.lock().map_err(|e| e.to_string())?;
        crate::history_search::collect_sources(&state, files)
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::history_search::search_sources(&sources, &query)
    })
    .await
    .map_err(|err| err.to_string())
}

const MAX_EXPORT_CHARS: usize = 8_000_000;

#[tauri::command]
pub fn export_text_file(path: String, text: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("No file path.".into());
    }
    if text.len() > MAX_EXPORT_CHARS {
        return Err(format!(
            "Export is {} characters. The limit is {}.",
            text.len(),
            MAX_EXPORT_CHARS
        ));
    }
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Choose a full path for the export.".into());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn transcript_load(
    tab_id: String,
    transcripts: State<Mutex<TranscriptStore>>,
) -> Result<TranscriptLoad, String> {
    let transcripts = transcripts.lock().map_err(|e| e.to_string())?;
    match transcripts.load(&tab_id)? {
        Some(loaded) => Ok(TranscriptLoad {
            text: loaded.text,
            cwd: loaded.cwd,
            read_only: loaded.read_only,
            recovered_from_corrupt: loaded.recovered_from_corrupt,
        }),
        None => Ok(TranscriptLoad {
            text: String::new(),
            cwd: String::new(),
            read_only: true,
            recovered_from_corrupt: false,
        }),
    }
}

#[tauri::command]
pub fn diagnostics_status(
    app: tauri::AppHandle,
    settings: State<Mutex<SettingsStore>>,
) -> Result<DiagnosticsStatus, String> {
    let settings = settings.lock().map_err(|e| e.to_string())?;
    let paths = diagnostic_paths(&app);
    Ok(DiagnosticsStatus {
        capture_permission_payloads: settings.capture_enabled(),
        app_data_dir: paths.0,
        transcripts_dir: paths.1,
        log_path: paths.2,
        crash_log_path: paths.3,
        last_error: settings.last_capture_error.clone(),
    })
}

#[tauri::command]
pub fn diagnostics_set_capture(
    app: tauri::AppHandle,
    enabled: bool,
    settings: State<Mutex<SettingsStore>>,
) -> Result<DiagnosticsStatus, String> {
    let mut settings = settings.lock().map_err(|e| e.to_string())?;
    settings.set_capture(enabled)?;
    let paths = diagnostic_paths(&app);
    Ok(DiagnosticsStatus {
        capture_permission_payloads: settings.capture_enabled(),
        app_data_dir: paths.0,
        transcripts_dir: paths.1,
        log_path: paths.2,
        crash_log_path: paths.3,
        last_error: settings.last_capture_error.clone(),
    })
}

fn diagnostic_paths(app: &tauri::AppHandle) -> (String, String, String, String) {
    let dir = crate::data_dir::app_data_dir(app).path;
    (
        dir.display().to_string(),
        dir.join("transcripts").display().to_string(),
        dir.join("logs")
            .join("permission-payloads.jsonl")
            .display()
            .to_string(),
        crate::crash_log::crash_log_path(&dir).display().to_string(),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsLogTail {
    pub text: String,
    pub path: String,
}

/// Tail of the redacted permission-payload log (when capture is on).
#[tauri::command]
pub fn diagnostics_read_log(
    app: tauri::AppHandle,
    max_bytes: Option<u64>,
) -> Result<DiagnosticsLogTail, String> {
    let paths = diagnostic_paths(&app);
    let path = PathBuf::from(&paths.2);
    let cap = max_bytes.unwrap_or(64 * 1024).min(512 * 1024);
    let text = tail_file(&path, cap)?;
    Ok(DiagnosticsLogTail {
        text,
        path: paths.2,
    })
}

fn tail_file(path: &PathBuf, max_bytes: u64) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn listed_dto(item: crate::store::ListedProject) -> ListedProjectDto {
    ListedProjectDto {
        path: item.path,
        available: item.available,
        favorite: item.favorite,
    }
}

#[cfg(test)]
mod tests {
    use super::check_working_folder;

    #[test]
    fn pasted_path_uses_the_same_folder_rules() {
        let err = check_working_folder("   ".into()).unwrap_err();
        assert!(err.contains("required"));

        let missing = check_working_folder(r"C:\no\such\dcterminal-folder".into()).unwrap_err();
        assert!(missing.contains("not found"));

        let real = crate::test_support::test_root();
        let ok = check_working_folder(format!("  {}  ", real.display())).unwrap();
        assert_eq!(ok, real.display().to_string().trim());
    }

    /// W1: a folder of repos that is not a repo itself is a working folder,
    /// and so is a plain folder with no repos, as before.
    #[test]
    fn a_workspace_folder_and_a_plain_folder_are_both_accepted() {
        let dir = crate::test_support::TempDir::new("w1_check_folder");
        let repo = dir.join("koneksi-engine");
        std::fs::create_dir_all(&repo).unwrap();
        let out = std::process::Command::new("git").arg("-C").arg(&repo).args(["init", "-q"]).output().unwrap();
        assert!(out.status.success());
        assert!(crate::workspace_repos::workspace_repos(dir.path(), &[]).workspace);
        assert_eq!(check_working_folder(dir.path().display().to_string()).unwrap(), dir.path().display().to_string());
        let plain = crate::test_support::TempDir::new("w1_check_plain");
        assert!(!crate::workspace_repos::workspace_repos(plain.path(), &[]).workspace);
        assert!(check_working_folder(plain.path().display().to_string()).is_ok());
    }
}

#[tauri::command]
pub fn cursor_approval_mode() -> ApprovalModeStatus {
    read_approval_mode()
}
