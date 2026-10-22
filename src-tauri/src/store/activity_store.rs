//! Per-tab agent activity log: `<app data>/activity/<tab id>.jsonl`.
//!
//! Every role runs with full permissions, so this is how JT answers "which
//! commands ran, which files were written, did anything hit the network?"
//! after a long turn. Lines are append-only partial records keyed by the
//! ACP `toolCallId`; the reader merges them, so a later `tool_call_update`
//! (status, richer input) or a permission decision completes the earlier
//! row instead of adding a new one. Each tab file rotates at
//! `max_file_bytes` into `<tab id>.jsonl.1` (one previous file kept), and at
//! most `max_tabs` tab logs are kept, oldest first out.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Current file size that triggers rotation. With one rotated file a tab
/// keeps at most ~2 MB.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TABS: usize = 100;

/// One appended line. Only the fields known at that moment are set.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPatch {
    /// ACP `toolCallId` (or a synthetic id when the agent sent none).
    pub id: String,
    pub tab_id: String,
    /// RFC 3339.
    pub time: String,
    /// shell | write | edit | delete | fetch | mcp | read | other
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Redacted command / path / URL, capped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// auto_allow | user_allow | user_reject | cancelled
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<bool>,
    /// ACP tool status: pending | in_progress | completed | failed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// A merged row for the Activity panel.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub tab_id: String,
    /// First time the tool call was seen.
    pub time: String,
    pub updated_at: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    /// `none` when the agent never asked (bypassPermissions runs most tools
    /// without a request).
    pub decision: String,
    pub network: bool,
    pub status: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ActivityStore {
    root: PathBuf,
    max_file_bytes: u64,
    max_tabs: usize,
}

impl ActivityStore {
    /// `<data dir>/activity`, dropping logs of tabs that no longer exist
    /// (open or closed), like the changes snapshots.
    pub fn open(data_dir: &Path, keep: &[String]) -> Self {
        let store = Self::with_limits(data_dir.join("activity"), MAX_FILE_BYTES, MAX_TABS);
        store.prune(keep);
        store
    }

    pub fn with_limits(root: PathBuf, max_file_bytes: u64, max_tabs: usize) -> Self {
        Self {
            root,
            max_file_bytes: max_file_bytes.max(1),
            max_tabs: max_tabs.max(1),
        }
    }

    fn current_path(&self, tab_id: &str) -> Result<PathBuf, String> {
        if tab_id.is_empty()
            || !tab_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!("bad tab id: {tab_id}"));
        }
        Ok(self.root.join(format!("{tab_id}.jsonl")))
    }

    fn rotated_path(current: &Path) -> PathBuf {
        let mut name = current.as_os_str().to_owned();
        name.push(".1");
        PathBuf::from(name)
    }

    pub fn append(&self, patch: &ActivityPatch) -> Result<(), String> {
        let path = self.current_path(&patch.tab_id)?;
        std::fs::create_dir_all(&self.root).map_err(|e| format!("activity dir: {e}"))?;
        let existed = match std::fs::metadata(&path) {
            Ok(meta) => {
                if meta.len() >= self.max_file_bytes {
                    self.rotate(&path)?;
                }
                true
            }
            Err(_) => false,
        };
        let line = serde_json::to_string(patch).map_err(|e| e.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("activity log: {e}"))?;
        writeln!(file, "{line}").map_err(|e| format!("activity write: {e}"))?;
        if !existed {
            self.enforce_tab_cap(&patch.tab_id);
        }
        Ok(())
    }

    /// Start a new current file. The rotated file becomes one merged line
    /// per row (old rotated rows + current rows), newest kept within
    /// `max_file_bytes`. A long turn's many `tool_call_update` lines thus
    /// collapse into their rows instead of pushing the turn's opening lines
    /// out: a row is only lost once a whole file's worth of newer *rows*
    /// exists, never because its own updates were chatty.
    fn rotate(&self, current: &Path) -> Result<(), String> {
        let rotated = Self::rotated_path(current);
        let mut patches = Vec::new();
        for file in [&rotated, &current.to_path_buf()] {
            if let Ok(text) = std::fs::read_to_string(file) {
                patches.extend(
                    text.lines()
                        .filter(|line| !line.trim().is_empty())
                        .filter_map(|line| serde_json::from_str::<ActivityPatch>(line).ok()),
                );
            }
        }
        let entries = merge_patches(&patches);
        let mut lines: Vec<String> = Vec::new();
        let mut bytes = 0u64;
        for entry in entries.iter().rev() {
            let mut entry_lines = vec![serde_json::to_string(&entry_patch(entry, false))
                .map_err(|e| e.to_string())?];
            if entry.updated_at != entry.time {
                entry_lines.push(
                    serde_json::to_string(&entry_patch(entry, true)).map_err(|e| e.to_string())?,
                );
            }
            let size: u64 = entry_lines.iter().map(|line| line.len() as u64 + 1).sum();
            if bytes + size > self.max_file_bytes && !lines.is_empty() {
                break;
            }
            bytes += size;
            // Built newest first; reversed below.
            lines.extend(entry_lines.into_iter().rev());
        }
        lines.reverse();
        let mut body = lines.join("\n");
        if !body.is_empty() {
            body.push('\n');
        }
        let tmp = {
            let mut name = rotated.as_os_str().to_owned();
            name.push(".tmp");
            PathBuf::from(name)
        };
        std::fs::write(&tmp, body).map_err(|e| format!("activity rotate: {e}"))?;
        std::fs::rename(&tmp, &rotated).map_err(|e| format!("activity rotate: {e}"))?;
        std::fs::remove_file(current).map_err(|e| format!("activity rotate: {e}"))?;
        Ok(())
    }

    /// Merged entries, oldest first. `limit` keeps the newest `limit`.
    pub fn list(&self, tab_id: &str, limit: Option<usize>) -> Result<Vec<ActivityEntry>, String> {
        let path = self.current_path(tab_id)?;
        let mut patches = Vec::new();
        for file in [Self::rotated_path(&path), path] {
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            // A torn last line (crash mid-write) is skipped, not fatal.
            patches.extend(
                text.lines()
                    .filter(|line| !line.trim().is_empty())
                    .filter_map(|line| serde_json::from_str::<ActivityPatch>(line).ok()),
            );
        }
        let mut entries = merge_patches(&patches);
        if let Some(limit) = limit {
            if entries.len() > limit {
                entries.drain(..entries.len() - limit);
            }
        }
        Ok(entries)
    }

    pub fn clear(&self, tab_id: &str) -> Result<(), String> {
        let path = self.current_path(tab_id)?;
        for file in [Self::rotated_path(&path), path] {
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(format!("activity clear: {err}")),
            }
        }
        Ok(())
    }

    /// Delete logs for tabs not in `keep`.
    pub fn prune(&self, keep: &[String]) {
        for (tab_id, _) in self.tab_logs() {
            if !keep.contains(&tab_id) {
                let _ = self.clear(&tab_id);
            }
        }
    }

    /// `(tab id, modified)` for every tab that has a current log.
    fn tab_logs(&self) -> Vec<(String, std::time::SystemTime)> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                let tab_id = name.strip_suffix(".jsonl")?.to_string();
                let modified = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                Some((tab_id, modified))
            })
            .collect()
    }

    /// Only checked when a tab's log is created, so appends stay cheap.
    fn enforce_tab_cap(&self, current_tab: &str) {
        let mut logs = self.tab_logs();
        if logs.len() <= self.max_tabs {
            return;
        }
        logs.sort_by_key(|(_, modified)| *modified);
        let mut excess = logs.len() - self.max_tabs;
        for (tab_id, _) in logs {
            if excess == 0 {
                break;
            }
            if tab_id == current_tab {
                continue;
            }
            if self.clear(&tab_id).is_ok() {
                excess -= 1;
            }
        }
    }
}

/// A merged row as one line again (`touch_only`: just its last-update time).
fn entry_patch(entry: &ActivityEntry, touch_only: bool) -> ActivityPatch {
    if touch_only {
        return ActivityPatch {
            id: entry.id.clone(),
            tab_id: entry.tab_id.clone(),
            time: entry.updated_at.clone(),
            ..Default::default()
        };
    }
    ActivityPatch {
        id: entry.id.clone(),
        tab_id: entry.tab_id.clone(),
        time: entry.time.clone(),
        kind: Some(entry.kind.clone()),
        title: Some(entry.title.clone()).filter(|t| !t.is_empty()),
        summary: Some(entry.summary.clone()).filter(|s| !s.is_empty()),
        decision: Some(entry.decision.clone()).filter(|d| d != "none"),
        network: entry.network.then_some(true),
        status: entry.status.clone(),
    }
}

fn is_terminal_status(status: &str) -> bool {
    matches!(status, "completed" | "failed")
}

/// Fold partial lines into one row per id, in first-seen order. Rows whose
/// opening line was rotated away (no title or summary left) are dropped.
pub fn merge_patches(patches: &[ActivityPatch]) -> Vec<ActivityEntry> {
    let mut order: Vec<ActivityEntry> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for patch in patches {
        if patch.id.is_empty() {
            continue;
        }
        let at = *index.entry(patch.id.clone()).or_insert_with(|| {
            order.push(ActivityEntry {
                id: patch.id.clone(),
                tab_id: patch.tab_id.clone(),
                time: patch.time.clone(),
                updated_at: patch.time.clone(),
                kind: "other".to_string(),
                title: String::new(),
                summary: String::new(),
                decision: "none".to_string(),
                network: false,
                status: None,
            });
            order.len() - 1
        });
        let entry = &mut order[at];
        entry.updated_at = patch.time.clone();
        if let Some(kind) = patch.kind.as_deref().filter(|k| !k.is_empty()) {
            // A bare "other" never hides a kind learned earlier.
            if kind != "other" || entry.kind == "other" {
                entry.kind = kind.to_string();
            }
        }
        if let Some(title) = patch.title.as_deref().filter(|t| !t.trim().is_empty()) {
            entry.title = title.to_string();
        }
        if let Some(summary) = patch.summary.as_deref().filter(|s| !s.trim().is_empty()) {
            entry.summary = summary.to_string();
        }
        if let Some(decision) = patch.decision.as_deref().filter(|d| !d.is_empty()) {
            entry.decision = decision.to_string();
        }
        if patch.network == Some(true) {
            entry.network = true;
        }
        if let Some(status) = patch.status.as_deref().filter(|s| !s.is_empty()) {
            let done = entry.status.as_deref().is_some_and(is_terminal_status);
            if !done || is_terminal_status(status) {
                entry.status = Some(status.to_string());
            }
        }
    }
    order.retain(|entry| !entry.title.is_empty() || !entry.summary.is_empty());
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        crate::test_support::test_root().join(format!("dct_activity_{tag}_{nanos}"))
    }

    fn patch(id: &str, time: &str) -> ActivityPatch {
        ActivityPatch {
            id: id.to_string(),
            tab_id: "tab_a".to_string(),
            time: time.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn merges_updates_by_tool_call_id() {
        let root = temp_root("merge");
        let store = ActivityStore::with_limits(root.clone(), 1 << 20, 10);
        store
            .append(&ActivityPatch {
                kind: Some("shell".into()),
                title: Some("Terminal".into()),
                status: Some("pending".into()),
                ..patch("t1", "2026-10-10T10:00:00Z")
            })
            .unwrap();
        store
            .append(&ActivityPatch {
                kind: Some("read".into()),
                summary: Some("src/main.rs".into()),
                ..patch("t2", "2026-10-10T10:00:01Z")
            })
            .unwrap();
        store
            .append(&ActivityPatch {
                summary: Some("npm test".into()),
                decision: Some("auto_allow".into()),
                ..patch("t1", "2026-10-10T10:00:02Z")
            })
            .unwrap();
        store
            .append(&ActivityPatch {
                kind: Some("other".into()),
                status: Some("completed".into()),
                ..patch("t1", "2026-10-10T10:00:03Z")
            })
            .unwrap();
        // A late in_progress never undoes completed.
        store
            .append(&ActivityPatch {
                status: Some("in_progress".into()),
                ..patch("t1", "2026-10-10T10:00:04Z")
            })
            .unwrap();
        let entries = store.list("tab_a", None).unwrap();
        assert_eq!(entries.len(), 2);
        let first = &entries[0];
        assert_eq!(first.id, "t1");
        assert_eq!(first.kind, "shell");
        assert_eq!(first.summary, "npm test");
        assert_eq!(first.decision, "auto_allow");
        assert_eq!(first.status.as_deref(), Some("completed"));
        assert_eq!(first.time, "2026-10-10T10:00:00Z");
        assert_eq!(first.updated_at, "2026-10-10T10:00:04Z");
        assert_eq!(entries[1].decision, "none");
        let newest = store.list("tab_a", Some(1)).unwrap();
        assert_eq!(newest.len(), 1);
        assert_eq!(newest[0].id, "t2");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn skips_torn_lines_and_rejects_bad_tab_ids() {
        let root = temp_root("torn");
        let store = ActivityStore::with_limits(root.clone(), 1 << 20, 10);
        store
            .append(&ActivityPatch {
                summary: Some("ls".into()),
                ..patch("t1", "2026-10-10T10:00:00Z")
            })
            .unwrap();
        let path = root.join("tab_a.jsonl");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        write!(file, "{{\"id\":\"t2\",\"tab").unwrap();
        assert_eq!(store.list("tab_a", None).unwrap().len(), 1);
        assert!(store.list("../etc", None).is_err());
        let mut bad = patch("x", "t");
        bad.tab_id = "a/b".into();
        assert!(store.append(&bad).is_err());
        assert!(store.list("missing", None).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rotates_and_keeps_the_newest_lines() {
        let root = temp_root("rotate");
        let store = ActivityStore::with_limits(root.clone(), 400, 10);
        for n in 0..40 {
            store
                .append(&ActivityPatch {
                    kind: Some("shell".into()),
                    summary: Some(format!("echo {n}")),
                    ..patch(&format!("t{n}"), "2026-10-10T10:00:00Z")
                })
                .unwrap();
        }
        let current = std::fs::metadata(root.join("tab_a.jsonl")).unwrap().len();
        let rotated = std::fs::metadata(root.join("tab_a.jsonl.1")).unwrap().len();
        assert!(current <= 400 + 200, "{current}");
        assert!(rotated <= 400 + 200, "{rotated}");
        let entries = store.list("tab_a", None).unwrap();
        assert!(entries.len() < 40);
        assert_eq!(entries.last().unwrap().summary, "echo 39");
        // Oldest went first.
        assert!(entries.iter().all(|e| e.summary != "echo 0"));
        // An update whose opening line rotated away is dropped, not shown blank.
        store
            .append(&ActivityPatch {
                status: Some("completed".into()),
                ..patch("t0", "2026-10-10T10:00:09Z")
            })
            .unwrap();
        assert!(store
            .list("tab_a", None)
            .unwrap()
            .iter()
            .all(|e| e.id != "t0"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_chatty_long_turn_does_not_rotate_away_its_own_early_rows() {
        // One long pipeline turn: a build starts, then hundreds of updates
        // on a test run stream in. The build's row (opened once, early) must
        // survive several rotations, with its status and decision.
        let root = temp_root("chatty");
        let store = ActivityStore::with_limits(root.clone(), 2_000, 10);
        store
            .append(&ActivityPatch {
                kind: Some("shell".into()),
                title: Some("Terminal".into()),
                summary: Some("cargo build".into()),
                status: Some("in_progress".into()),
                decision: Some("auto_allow".into()),
                ..patch("t_build", "2026-10-10T10:00:00Z")
            })
            .unwrap();
        for n in 0..300 {
            store
                .append(&ActivityPatch {
                    kind: Some("shell".into()),
                    title: Some("Terminal".into()),
                    summary: Some(format!("cargo test -- part {}", n % 3)),
                    status: Some("in_progress".into()),
                    ..patch(&format!("t_test{}", n % 3), "2026-10-10T10:00:01Z")
                })
                .unwrap();
        }
        store
            .append(&ActivityPatch {
                status: Some("completed".into()),
                ..patch("t_build", "2026-10-10T10:05:00Z")
            })
            .unwrap();
        assert!(root.join("tab_a.jsonl.1").exists(), "it did rotate");
        let entries = store.list("tab_a", None).unwrap();
        let build = entries
            .iter()
            .find(|e| e.id == "t_build")
            .expect("the turn's first row is still there");
        assert_eq!(build.summary, "cargo build");
        assert_eq!(build.decision, "auto_allow");
        assert_eq!(build.status.as_deref(), Some("completed"));
        assert_eq!(build.time, "2026-10-10T10:00:00Z");
        assert_eq!(build.updated_at, "2026-10-10T10:05:00Z");
        assert_eq!(entries.len(), 4);
        // Both files stay near the limit.
        for name in ["tab_a.jsonl", "tab_a.jsonl.1"] {
            let len = std::fs::metadata(root.join(name)).map(|m| m.len()).unwrap_or(0);
            assert!(len <= 2_000 + 400, "{name}: {len}");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn caps_tab_logs_oldest_first_and_prunes_gone_tabs() {
        let root = temp_root("cap");
        let store = ActivityStore::with_limits(root.clone(), 1 << 20, 2);
        for (n, tab) in ["tab_1", "tab_2", "tab_3"].iter().enumerate() {
            let mut p = patch(&format!("t{n}"), "2026-10-10T10:00:00Z");
            p.tab_id = tab.to_string();
            p.summary = Some("ls".into());
            store.append(&p).unwrap();
            // Distinct modification times on coarse file systems.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!root.join("tab_1.jsonl").exists());
        assert!(root.join("tab_2.jsonl").exists());
        assert!(root.join("tab_3.jsonl").exists());
        store.prune(&["tab_3".to_string()]);
        assert!(!root.join("tab_2.jsonl").exists());
        assert!(root.join("tab_3.jsonl").exists());
        store.clear("tab_3").unwrap();
        assert!(!root.join("tab_3.jsonl").exists());
        store.clear("tab_3").unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}
