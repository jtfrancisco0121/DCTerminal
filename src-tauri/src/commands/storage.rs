//! Settings > Data > Storage: app data folder size and the cleanup sweep.

use crate::store::storage_sweep::{dir_size, sweep_files};
use crate::store::{ScratchStore, StateStore};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub app_data_dir: String,
    pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanup {
    pub bytes_freed: u64,
    pub bytes: u64,
}

/// Open and recently closed tabs: their scratch pads are never pruned.
pub fn known_tab_ids(state: &StateStore) -> Vec<String> {
    state
        .data
        .tabs
        .iter()
        .map(|tab| tab.id.clone())
        .chain(state.data.closed_tabs.iter().map(|tab| tab.id.clone()))
        .collect()
}

/// The whole sweep: orphaned scratch pads, stale leftovers, log rotation.
/// Shared by startup and "Clean up now". Errors are swallowed: housekeeping
/// must never stop the app from opening.
pub fn run_sweep(data_dir: &Path, scratch: &mut ScratchStore, known_tabs: &[String]) {
    let keep: HashSet<String> = known_tabs.iter().cloned().collect();
    if scratch.prune_orphans(&keep, chrono::Utc::now()) > 0 {
        let _ = scratch.save();
    }
    sweep_files(data_dir, std::time::SystemTime::now());
}

#[tauri::command]
pub fn storage_status(app: tauri::AppHandle) -> Result<StorageStatus, String> {
    let dir = crate::data_dir::app_data_dir(&app).path;
    let bytes = dir_size(&dir);
    Ok(StorageStatus {
        app_data_dir: dir.display().to_string(),
        bytes,
    })
}

#[tauri::command]
pub fn storage_cleanup(
    app: tauri::AppHandle,
    state: State<Mutex<StateStore>>,
    scratch: State<Mutex<ScratchStore>>,
) -> Result<StorageCleanup, String> {
    let dir = crate::data_dir::app_data_dir(&app).path;
    let known = {
        let state = state.lock().map_err(|e| e.to_string())?;
        known_tab_ids(&state)
    };
    let before = dir_size(&dir);
    {
        let mut scratch = scratch.lock().map_err(|e| e.to_string())?;
        run_sweep(&dir, &mut scratch, &known);
    }
    let bytes = dir_size(&dir);
    Ok(StorageCleanup {
        bytes_freed: before.saturating_sub(bytes),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn sweep_prunes_orphan_pads_and_old_leftovers_but_keeps_known_tabs() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_storage_cmd_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let mut scratch = ScratchStore::open(&dir).unwrap();
        scratch.upsert("open_tab", "keep", &[], "2020-01-01T00:00:00Z");
        scratch.upsert("deleted_tab", "drop", &[], "2020-01-01T00:00:00Z");
        scratch.save().unwrap();
        let corrupt = dir.join("forms.json.corrupt-1");
        std::fs::write(&corrupt, b"x").unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&corrupt).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(40 * 86_400))
            .unwrap();

        run_sweep(&dir, &mut scratch, &["open_tab".to_string()]);

        let reloaded = ScratchStore::open(&dir).unwrap();
        assert!(reloaded.data.pads.contains_key("open_tab"));
        assert!(!reloaded.data.pads.contains_key("deleted_tab"));
        assert!(!corrupt.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
