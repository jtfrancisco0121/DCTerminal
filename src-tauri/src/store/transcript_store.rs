//! Per-tab transcripts in the app data dir. One bad file cannot take the
//! others down, and the directory is capped so a long-running app does not
//! fill the disk.

use crate::store::json_io::{read_json, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub const TRANSCRIPT_SCHEMA_VERSION: u32 = 1;
pub const MAX_TRANSCRIPT_CHARS: usize = 500_000;
pub const MAX_TRANSCRIPT_FILES: usize = 30;

#[cfg(test)]
thread_local! {
    /// Runs once per rotation scan, after the folder is listed, on the
    /// thread doing the rotation. Lets a test look at the locks mid-scan.
    pub(crate) static ROTATION_HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        std::cell::RefCell::new(None);
}

/// Folders with a rotation running. Rotation runs without the store lock,
/// so two saves could otherwise trim the same folder at once and, picking
/// from different keep lists, remove more than the overflow. Keyed by
/// folder so unrelated stores (and parallel tests) never skip each other.
static ROTATING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// One rotation per folder at a time. `try_acquire` never waits: a save
/// that finds a rotation running skips its own, and the next save trims
/// whatever is left over. Released on drop, so every return path frees it.
pub struct RotationGuard {
    dir: PathBuf,
}

impl RotationGuard {
    pub fn try_acquire(dir: &Path) -> Option<Self> {
        let mut rotating = ROTATING.lock().unwrap_or_else(|p| p.into_inner());
        if rotating.iter().any(|busy| busy == dir) {
            return None;
        }
        rotating.push(dir.to_path_buf());
        Some(Self {
            dir: dir.to_path_buf(),
        })
    }
}

impl Drop for RotationGuard {
    fn drop(&mut self) {
        let mut rotating = ROTATING.lock().unwrap_or_else(|p| p.into_inner());
        rotating.retain(|busy| busy != &self.dir);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptFile {
    pub schema_version: u32,
    pub tab_id: String,
    pub text: String,
    pub cwd: String,
    pub updated_at: String,
    /// Restored history is never treated as a live session.
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedTranscript {
    pub text: String,
    pub cwd: String,
    pub read_only: bool,
    pub recovered_from_corrupt: bool,
}

#[derive(Debug)]
pub struct TranscriptStore {
    pub dir: PathBuf,
}

impl TranscriptStore {
    pub fn open(app_dir: &Path) -> Result<Self, String> {
        let dir = app_dir.join("transcripts");
        std::fs::create_dir_all(&dir).map_err(|e| format!("transcript dir: {e}"))?;
        Ok(Self { dir })
    }

    pub fn save(
        &self,
        tab_id: &str,
        text: &str,
        cwd: &str,
        now: &str,
        keep_ids: &[String],
    ) -> Result<(), String> {
        self.write(tab_id, text, cwd, now)?;
        rotate_transcripts(&self.dir, keep_ids, None)
    }

    /// Writes one tab's transcript, with no rotation. Callers that hold the
    /// store lock write with this, drop the guard, then rotate with
    /// `rotate_transcripts`.
    pub fn write(&self, tab_id: &str, text: &str, cwd: &str, now: &str) -> Result<(), String> {
        if !safe_tab_id(tab_id) {
            return Err(format!("refusing transcript name: {tab_id}"));
        }
        let body = truncate_transcript(text);
        let file = TranscriptFile {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            tab_id: tab_id.to_string(),
            text: body,
            cwd: cwd.to_string(),
            updated_at: now.to_string(),
            read_only: true,
        };
        write_json_atomic(&self.path_for(tab_id), &file)
    }

    pub fn load(&self, tab_id: &str) -> Result<Option<LoadedTranscript>, String> {
        if !safe_tab_id(tab_id) {
            return Ok(None);
        }
        let path = self.path_for(tab_id);
        if !path.exists() {
            return Ok(None);
        }
        match read_json::<TranscriptFile>(&path) {
            Ok(file) => Ok(Some(LoadedTranscript {
                text: file.text,
                cwd: file.cwd,
                read_only: true,
                recovered_from_corrupt: false,
            })),
            Err(_) => {
                let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3f");
                let corrupt = path.with_extension(format!("json.corrupt-{stamp}"));
                let _ = std::fs::rename(&path, corrupt);
                Ok(Some(LoadedTranscript {
                    text: String::new(),
                    cwd: String::new(),
                    read_only: true,
                    recovered_from_corrupt: true,
                }))
            }
        }
    }

    /// Every readable transcript, newest first. Read-only: unreadable files
    /// are skipped, not moved aside (that is `load`'s job).
    pub fn list_all(&self) -> Vec<TranscriptFile> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut files: Vec<TranscriptFile> = entries
            .flatten()
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                name.ends_with(".json") && !name.contains(".corrupt")
            })
            .filter_map(|entry| read_json::<TranscriptFile>(&entry.path()).ok())
            .filter(|file| safe_tab_id(&file.tab_id))
            .collect();
        files.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        files
    }

    fn path_for(&self, tab_id: &str) -> PathBuf {
        self.dir.join(format!("{tab_id}.json"))
    }
}

/// Caps the folder at `MAX_TRANSCRIPT_FILES`, oldest first. Never removes
/// a file named in `keep_ids`, or one modified at or after `cutoff`: a tab
/// that saved after the caller read `keep_ids` is newer than that list and
/// must not be rotated away by it. A directory walk, so it takes only the
/// folder path and runs without the store lock. Skips when another
/// rotation of the same folder is running (`RotationGuard`).
pub fn rotate_transcripts(
    dir: &Path,
    keep_ids: &[String],
    cutoff: Option<SystemTime>,
) -> Result<(), String> {
    // Another save is trimming this folder: skip, the next save trims the rest.
    let Some(_rotating) = RotationGuard::try_acquire(dir) else {
        return Ok(());
    };
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name.contains(".corrupt") || name.ends_with(".bak") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        files.push((modified, entry.path(), name));
    }
    #[cfg(test)]
    ROTATION_HOOK.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook();
        }
    });
    if files.len() <= MAX_TRANSCRIPT_FILES {
        return Ok(());
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    let overflow = files.len() - MAX_TRANSCRIPT_FILES;
    let mut removed = 0;
    for (modified, path, name) in files {
        if removed >= overflow {
            break;
        }
        let id = name.trim_end_matches(".json");
        if keep_ids.iter().any(|keep| keep == id) {
            continue;
        }
        if cutoff.is_some_and(|cutoff| modified >= cutoff) {
            continue;
        }
        let _ = std::fs::remove_file(path);
        removed += 1;
    }
    Ok(())
}

fn safe_tab_id(tab_id: &str) -> bool {
    !tab_id.is_empty()
        && tab_id.len() < 80
        && tab_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Keeps the newest `MAX_TRANSCRIPT_CHARS` characters, marked as cut.
pub fn truncate_transcript(text: &str) -> String {
    let count = text.chars().count();
    if count <= MAX_TRANSCRIPT_CHARS {
        return text.to_string();
    }
    let skip = count - MAX_TRANSCRIPT_CHARS;
    let tail: String = text.chars().skip(skip).collect();
    format!("[earlier transcript truncated]\n{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        // Unique per call: two tests in the same microsecond must not share it.
        crate::test_support::temp_path("dcterminal_transcripts")
    }

    #[test]
    fn saves_and_reloads_a_read_only_transcript_for_a_missing_folder() {
        let dir = dir();
        let store = TranscriptStore::open(&dir).unwrap();
        store
            .save(
                "tab_1",
                "hello from the agent",
                r"C:\gone\repo",
                "2026-10-06T00:00:00Z",
                &["tab_1".into()],
            )
            .unwrap();
        let loaded = store.load("tab_1").unwrap().unwrap();
        assert!(loaded.read_only);
        assert!(loaded.text.contains("hello from the agent"));
        assert_eq!(loaded.cwd, r"C:\gone\repo");
        assert!(!loaded.recovered_from_corrupt);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn truncates_oversized_transcripts() {
        let dir = dir();
        let store = TranscriptStore::open(&dir).unwrap();
        let huge = "x".repeat(MAX_TRANSCRIPT_CHARS + 50);
        store.save("tab_big", &huge, "C:\\w", "t", &[]).unwrap();
        let loaded = store.load("tab_big").unwrap().unwrap();
        assert!(loaded.text.starts_with("[earlier transcript truncated]"));
        assert!(loaded.text.chars().count() < MAX_TRANSCRIPT_CHARS + 80);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_transcript_is_moved_aside_and_reported() {
        let dir = dir();
        let store = TranscriptStore::open(&dir).unwrap();
        let path = store.dir.join("tab_bad.json");
        std::fs::write(&path, b"{broken").unwrap();
        let loaded = store.load("tab_bad").unwrap().unwrap();
        assert!(loaded.recovered_from_corrupt);
        assert!(loaded.text.is_empty());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn list_all_reads_every_transcript_and_leaves_bad_files_alone() {
        let dir = dir();
        let store = TranscriptStore::open(&dir).unwrap();
        store
            .save("tab_a", "alpha", "/w", "2026-01-01", &[])
            .unwrap();
        store
            .save("tab_b", "beta", "/w", "2026-02-01", &[])
            .unwrap();
        let bad = store.dir.join("tab_bad.json");
        std::fs::write(&bad, b"{broken").unwrap();
        let all = store.list_all();
        let ids: Vec<&str> = all.iter().map(|f| f.tab_id.as_str()).collect();
        assert_eq!(ids, vec!["tab_b", "tab_a"]);
        assert!(bad.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rotates_old_files_but_keeps_open_tabs() {
        let dir = dir();
        let store = TranscriptStore::open(&dir).unwrap();
        for i in 0..(MAX_TRANSCRIPT_FILES + 5) {
            store
                .save(&format!("tab_{i}"), "t", "C:\\w", "now", &["tab_0".into()])
                .unwrap();
            // Distinct mtimes so the oldest file is the one we expect to drop.
            let path = store.path_for(&format!("tab_{i}"));
            filetime_touch(&path, i as u64);
        }
        store
            .save("tab_new", "n", "C:\\w", "now", &["tab_0".into()])
            .unwrap();
        let names = std::fs::read_dir(&store.dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".json") && !n.contains("bak") && !n.contains("corrupt"))
            .count();
        assert!(names <= MAX_TRANSCRIPT_FILES + 1);
        assert!(store.load("tab_0").unwrap().is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rotation_keeps_every_id_in_keep_even_past_the_cap() {
        let dir = dir();
        let store = TranscriptStore::open(&dir).unwrap();
        let ids: Vec<String> = (0..(MAX_TRANSCRIPT_FILES + 5))
            .map(|i| format!("tab_{i}"))
            .collect();
        for (i, id) in ids.iter().enumerate() {
            store.save(id, "t", "C:\\w", "now", &ids).unwrap();
            filetime_touch(&store.path_for(id), i as u64);
        }
        store.save("tab_new", "n", "C:\\w", "now", &ids).unwrap();
        for id in &ids {
            assert!(store.load(id).unwrap().is_some(), "{id} was rotated away");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    fn filetime_touch(path: &Path, seconds: u64) {
        let time = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(seconds + 10);
        let _ = file_set_mtime(path, time);
    }

    fn file_set_mtime(path: &Path, time: std::time::SystemTime) -> std::io::Result<()> {
        let file = std::fs::OpenOptions::new().write(true).open(path)?;
        file.set_modified(time)
    }

    #[test]
    fn save_fails_when_the_transcript_path_cannot_be_created() {
        let dir = dir();
        let blocker = dir.join("transcripts");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let err = TranscriptStore::open(&dir).unwrap_err();
        assert!(err.contains("transcript") || !err.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
