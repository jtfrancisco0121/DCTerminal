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

#[tauri::command]
pub fn scratch_save(
    tab_id: String,
    content: String,
    history: Vec<String>,
    store: State<Mutex<ScratchStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    store.upsert(&tab_id, &content, &history, &now);
    store.save()
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

/// Same rules as session start: the path must exist, be a directory, and be readable.
#[tauri::command]
pub fn check_working_folder(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    validate_working_folder(trimmed).map_err(|err| err.message())?;
    Ok(trimmed.to_string())
}

#[tauri::command]
pub fn transcript_save(
    tab_id: String,
    text: String,
    cwd: String,
    transcripts: State<Mutex<TranscriptStore>>,
    state: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let keep = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state
            .data
            .tabs
            .iter()
            .map(|t| t.id.clone())
            .collect::<Vec<_>>()
    };
    let transcripts = transcripts.lock().map_err(|e| e.to_string())?;
    transcripts.save(
        &tab_id,
        &text,
        &cwd,
        &chrono::Utc::now().to_rfc3339(),
        &keep,
    )
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
        last_error: settings.last_capture_error.clone(),
    })
}

fn diagnostic_paths(app: &tauri::AppHandle) -> (String, String, String) {
    let dir = crate::data_dir::app_data_dir(app).path;
    (
        dir.display().to_string(),
        dir.join("transcripts").display().to_string(),
        dir.join("logs")
            .join("permission-payloads.jsonl")
            .display()
            .to_string(),
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

        let real = std::env::temp_dir();
        let ok = check_working_folder(format!("  {}  ", real.display())).unwrap();
        assert_eq!(ok, real.display().to_string().trim());
    }
}

#[tauri::command]
pub fn cursor_approval_mode() -> ApprovalModeStatus {
    read_approval_mode()
}
