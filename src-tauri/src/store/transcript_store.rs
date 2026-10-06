//! Per-tab transcripts in the app data dir. One bad file cannot take the
//! others down, and the directory is capped so a long-running app does not
//! fill the disk.

use crate::store::json_io::{read_json, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const TRANSCRIPT_SCHEMA_VERSION: u32 = 1;
pub const MAX_TRANSCRIPT_CHARS: usize = 500_000;
pub const MAX_TRANSCRIPT_FILES: usize = 30;

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
        let path = self.path_for(tab_id);
        write_json_atomic(&path, &file)?;
        self.rotate(keep_ids)?;
        Ok(())
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

    fn path_for(&self, tab_id: &str) -> PathBuf {
        self.dir.join(format!("{tab_id}.json"))
    }

    fn rotate(&self, keep_ids: &[String]) -> Result<(), String> {
        let mut files = Vec::new();
        for entry in std::fs::read_dir(&self.dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name.contains(".corrupt") || name.ends_with(".bak") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            files.push((modified, entry.path(), name));
        }
        if files.len() <= MAX_TRANSCRIPT_FILES {
            return Ok(());
        }
        files.sort_by_key(|(modified, _, _)| *modified);
        let overflow = files.len() - MAX_TRANSCRIPT_FILES;
        let mut removed = 0;
        for (_, path, name) in files {
            if removed >= overflow {
                break;
            }
            let id = name.trim_end_matches(".json");
            if keep_ids.iter().any(|keep| keep == id) {
                continue;
            }
            let _ = std::fs::remove_file(path);
            removed += 1;
        }
        Ok(())
    }
}

fn safe_tab_id(tab_id: &str) -> bool {
    !tab_id.is_empty()
        && tab_id.len() < 80
        && tab_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn truncate_transcript(text: &str) -> String {
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dcterminal_transcripts_{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        path
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
        store
            .save("tab_big", &huge, "C:\\w", "t", &[])
            .unwrap();
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
