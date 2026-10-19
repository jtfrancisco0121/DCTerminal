//! Settings > Data > Storage: app data folder size and the cleanup sweep.

use crate::store::storage_sweep::{dir_size, sweep_files};
use crate::store::{ScratchStore, StateStore};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

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
/// Shared by startup (on a background thread, after the window opens) and
/// "Clean up now". The directory walk runs without the ScratchStore lock;
/// only the prune and its save hold it. Errors are swallowed: housekeeping
/// must never stop the app from opening.
pub fn run_sweep(
    data_dir: &Path,
    scratch: &Mutex<ScratchStore>,
    known_tabs: &[String],
) -> Result<(), String> {
    sweep_files(data_dir, std::time::SystemTime::now());
    let keep: HashSet<String> = known_tabs.iter().cloned().collect();
    let mut scratch = scratch.lock().map_err(|e| e.to_string())?;
    if scratch.prune_orphans(&keep, chrono::Utc::now()) > 0 {
        let _ = scratch.save();
    }
    Ok(())
}

/// Startup's sweep, off the main thread so the window does not wait for it.
/// `known_tabs` is read before the stores are shared; pads younger than 30
/// days are never pruned, so a tab opened meanwhile keeps its pad.
pub fn spawn_startup_sweep(app: &tauri::AppHandle, data_dir: PathBuf, known_tabs: Vec<String>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("startup-sweep".into())
        .spawn(move || {
            let scratch = app.state::<Mutex<ScratchStore>>();
            if let Err(err) = run_sweep(&data_dir, &scratch, &known_tabs) {
                eprintln!("DCTerminal: startup sweep skipped: {err}");
            }
        });
    if let Err(err) = spawned {
        eprintln!("DCTerminal: startup sweep not started: {err}");
    }
}

/// Data files moved aside at startup (damaged, or written by another
/// version), one line each. Drained, so only the first window shows them.
#[tauri::command]
pub fn startup_notices() -> Vec<String> {
    crate::store::take_recovery_notes()
}

/// Walks the whole data folder, so it runs on a blocking thread.
#[tauri::command]
pub async fn storage_status(app: tauri::AppHandle) -> Result<StorageStatus, String> {
    let dir = crate::data_dir::app_data_dir(&app).path;
    tauri::async_runtime::spawn_blocking(move || status_of(&dir))
        .await
        .map_err(|err| err.to_string())
}

fn status_of(dir: &Path) -> StorageStatus {
    StorageStatus {
        app_data_dir: dir.display().to_string(),
        bytes: dir_size(dir),
    }
}

/// Walks the data folder twice and sweeps it, on a blocking thread.
#[tauri::command]
pub async fn storage_cleanup(
    app: tauri::AppHandle,
    state: State<'_, Mutex<StateStore>>,
) -> Result<StorageCleanup, String> {
    let dir = crate::data_dir::app_data_dir(&app).path;
    let known = {
        let state = state.lock().map_err(|e| e.to_string())?;
        known_tab_ids(&state)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let scratch = app.state::<Mutex<ScratchStore>>();
        cleanup(&dir, &scratch, &known)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn cleanup(
    dir: &Path,
    scratch: &Mutex<ScratchStore>,
    known: &[String],
) -> Result<StorageCleanup, String> {
    let before = dir_size(dir);
    run_sweep(dir, scratch, known)?;
    let bytes = dir_size(dir);
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
    fn status_and_the_cleanup_walk_run_while_another_thread_holds_the_scratch_store() {
        use std::sync::{mpsc, Arc};
        let tmp = crate::test_support::TempDir::new("storage_off_lock");
        let dir = tmp.path();
        let mut store = ScratchStore::open(dir).unwrap();
        store.upsert("gone_tab", "old", &[], "2020-01-01T00:00:00Z");
        store.save().unwrap();
        // A stale leftover the sweep deletes, so the test can see when it ran.
        let corrupt = dir.join("forms.json.corrupt-1");
        crate::test_support::write_aged(&corrupt, b"x", Duration::from_secs(40 * 86_400));
        let scratch = Arc::new(Mutex::new(store));

        let (locked_tx, locked_rx) = mpsc::channel();
        let holder = {
            let scratch = Arc::clone(&scratch);
            let corrupt = corrupt.clone();
            std::thread::spawn(move || {
                let _guard = scratch.lock().unwrap();
                locked_tx.send(()).unwrap();
                // Hold the lock until the walk has deleted the leftover, or
                // give up after a few seconds.
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                while corrupt.exists() && std::time::Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                !corrupt.exists()
            })
        };
        locked_rx.recv().unwrap();

        let status = status_of(dir);
        assert!(status.bytes > 0);
        let result = cleanup(dir, &scratch, &[]).unwrap();
        assert!(
            holder.join().unwrap(),
            "the walk waited for the ScratchStore lock"
        );
        assert_eq!(result.bytes, dir_size(dir));
        assert!(!scratch.lock().unwrap().data.pads.contains_key("gone_tab"));
    }

    #[test]
    fn sweep_prunes_orphan_pads_and_old_leftovers_but_keeps_known_tabs() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = crate::test_support::test_root().join(format!("dcterminal_storage_cmd_{nanos}"));
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

        run_sweep(&dir, &Mutex::new(scratch), &["open_tab".to_string()]).unwrap();

        let reloaded = ScratchStore::open(&dir).unwrap();
        assert!(reloaded.data.pads.contains_key("open_tab"));
        assert!(!reloaded.data.pads.contains_key("deleted_tab"));
        assert!(!corrupt.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
