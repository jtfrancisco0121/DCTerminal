//! Per-tab scratch pads (`scratch.json`). Drafts are also mirrored in the
//! WebView so a crash between disk flushes loses at most the debounce window.

use crate::store::json_io::{read_json_or_recover, write_json_atomic};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const SCRATCH_SCHEMA_VERSION: u32 = 1;
pub const MAX_PAD_CHARS: usize = 1_000_000;
pub const HISTORY_LIMIT: usize = 50;
const ORPHAN_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScratchPad {
    pub content: String,
    pub updated_at: String,
    #[serde(default)]
    pub history: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScratchFile {
    pub schema_version: u32,
    #[serde(default)]
    pub pads: HashMap<String, ScratchPad>,
}

impl Default for ScratchFile {
    fn default() -> Self {
        Self {
            schema_version: SCRATCH_SCHEMA_VERSION,
            pads: HashMap::new(),
        }
    }
}

pub struct ScratchStore {
    pub path: PathBuf,
    pub data: ScratchFile,
}

impl ScratchStore {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("scratch dir: {e}"))?;
        let path = dir.join("scratch.json");
        let mut data = read_json_or_recover::<ScratchFile>(&path)?;
        if data.schema_version > SCRATCH_SCHEMA_VERSION {
            let _ = std::fs::rename(
                &path,
                path.with_extension(format!("json.corrupt-schema-{}", data.schema_version)),
            );
            data = ScratchFile::default();
        }
        data.schema_version = SCRATCH_SCHEMA_VERSION;
        Ok(Self { path, data })
    }

    pub fn save(&self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    pub fn upsert(&mut self, tab_id: &str, content: &str, history: &[String], now: &str) {
        let mut kept = Vec::new();
        for item in history {
            let trimmed = item.trim();
            if trimmed.is_empty() || kept.iter().any(|e: &String| e == trimmed) {
                continue;
            }
            kept.push(trimmed.to_string());
            if kept.len() == HISTORY_LIMIT {
                break;
            }
        }
        self.data.pads.insert(
            tab_id.to_string(),
            ScratchPad {
                content: content.chars().take(MAX_PAD_CHARS).collect(),
                updated_at: now.to_string(),
                history: kept,
            },
        );
    }

    /// Drop pads for tabs that are gone and have not been edited in 30 days.
    /// Returns how many pads were dropped.
    pub fn prune_orphans(&mut self, keep: &HashSet<String>, now: DateTime<Utc>) -> usize {
        let before = self.data.pads.len();
        self.data.pads.retain(|id, pad| {
            if keep.contains(id) {
                return true;
            }
            let Ok(updated) = DateTime::parse_from_rfc3339(&pad.updated_at) else {
                return true;
            };
            now.signed_duration_since(updated).num_days() < ORPHAN_DAYS
        });
        before - self.data.pads.len()
    }
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
        let path = crate::test_support::test_root().join(format!("dcterminal_scratch_{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn round_trips_a_pad_and_truncates_huge_text() {
        let dir = dir();
        let mut store = ScratchStore::open(&dir).unwrap();
        let huge = "é".repeat(MAX_PAD_CHARS + 10);
        store.upsert(
            "tab_1",
            &huge,
            &["  hello  ".into(), "hello".into()],
            "2026-10-06T00:00:00Z",
        );
        store.save().unwrap();
        let loaded = ScratchStore::open(&dir).unwrap();
        let pad = loaded.data.pads.get("tab_1").unwrap();
        assert_eq!(pad.content.chars().count(), MAX_PAD_CHARS);
        assert_eq!(pad.history, vec!["hello".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_scratch_file_falls_back_instead_of_failing_open() {
        let dir = dir();
        let path = dir.join("scratch.json");
        std::fs::write(&path, b"{not-json").unwrap();
        let store = ScratchStore::open(&dir).unwrap();
        assert!(store.data.pads.is_empty());
        assert!(!path.exists());
        let leftover = std::fs::read_dir(&dir).unwrap().count();
        assert!(leftover >= 1, "corrupt file should be kept aside");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_reports_when_the_parent_is_not_a_directory() {
        let dir = dir();
        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        let store = ScratchStore {
            path: blocker.join("scratch.json"),
            data: ScratchFile::default(),
        };
        let err = store.save().unwrap_err();
        assert!(!err.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prunes_month_old_orphans_and_keeps_open_tabs() {
        let dir = dir();
        let mut store = ScratchStore::open(&dir).unwrap();
        store.upsert("live", "keep", &[], "2020-01-01T00:00:00Z");
        store.upsert("old", "drop", &[], "2020-01-01T00:00:00Z");
        let now = DateTime::parse_from_rfc3339("2026-10-06T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut keep = HashSet::new();
        keep.insert("live".to_string());
        assert_eq!(store.prune_orphans(&keep, now), 1);
        assert!(store.data.pads.contains_key("live"));
        assert!(!store.data.pads.contains_key("old"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
