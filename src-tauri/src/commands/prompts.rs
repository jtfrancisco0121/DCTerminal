//! F6 prompt library commands. Everything lives in `prompts.json` in
//! DCTerminal's app data dir; nothing touches a repo or `~/.cursor`.

use crate::store::{PromptStore, RecentSend, SavedPrompt};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptLibrary {
    pub prompts: Vec<SavedPrompt>,
    pub recent: Vec<RecentSend>,
    /// Where the library is stored, shown in the dialog.
    pub path: String,
}

fn library(store: &PromptStore) -> PromptLibrary {
    let (prompts, recent) = store.snapshot();
    PromptLibrary {
        prompts,
        recent,
        path: store.path.display().to_string(),
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Run a change and write the file; on a failed write, keep the old data.
fn mutate<T>(
    store: &State<Mutex<PromptStore>>,
    change: impl FnOnce(&mut PromptStore) -> Result<T, String>,
) -> Result<PromptLibrary, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let before = store.data.clone();
    change(&mut store)?;
    if let Err(err) = store.save() {
        store.data = before;
        return Err(format!("Could not save the prompt library: {err}"));
    }
    Ok(library(&store))
}

#[tauri::command]
pub fn prompt_library_get(store: State<Mutex<PromptStore>>) -> Result<PromptLibrary, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(library(&store))
}

#[tauri::command]
pub fn prompt_save(
    id: Option<String>,
    name: String,
    body: String,
    store: State<Mutex<PromptStore>>,
) -> Result<PromptLibrary, String> {
    mutate(&store, |s| {
        s.save_prompt(id.as_deref(), &name, &body, &now())
    })
}

#[tauri::command]
pub fn prompt_delete(
    id: String,
    store: State<Mutex<PromptStore>>,
) -> Result<PromptLibrary, String> {
    mutate(&store, |s| s.delete_prompt(&id))
}

#[tauri::command]
pub fn prompt_mark_used(
    id: String,
    store: State<Mutex<PromptStore>>,
) -> Result<PromptLibrary, String> {
    mutate(&store, |s| s.mark_used(&id, &now()))
}

#[tauri::command]
pub fn prompt_record_send(
    text: String,
    source: String,
    store: State<Mutex<PromptStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    if store.record_send(&text, &source, &now()) {
        store.save()?;
    }
    Ok(())
}

#[tauri::command]
pub fn prompt_clear_recent(store: State<Mutex<PromptStore>>) -> Result<PromptLibrary, String> {
    mutate(&store, |s| {
        s.clear_recent();
        Ok(())
    })
}
