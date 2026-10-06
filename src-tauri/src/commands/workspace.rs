//! Scratch pads, recent projects, transcripts, tab chrome, and diagnostics.

use crate::paths::validate_working_folder;
use crate::store::{
    ProjectsStore, ScratchStore, SettingsStore, StateStore, TranscriptStore,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchSnapshot {
    pub pads: Vec<ScratchPadEntry>,
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
pub fn scratch_load(store: State<Mutex<ScratchStore>>) -> Result<ScratchSnapshot, String> {
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
    Ok(ScratchSnapshot { pads })
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
    match app.path().app_data_dir() {
        Ok(dir) => (
            dir.display().to_string(),
            dir.join("transcripts").display().to_string(),
            dir.join("logs")
                .join("permission-payloads.jsonl")
                .display()
                .to_string(),
        ),
        Err(_) => (
            String::new(),
            "transcripts".to_string(),
            "logs/permission-payloads.jsonl".to_string(),
        ),
    }
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
