//! Read-only view of Cursor's on-disk session folders.
//!
//! DCTerminal never creates or writes files under `~/.cursor`. Listing opens
//! `meta.json` only. `store.db` is not opened, because SQLite can create
//! `-wal` / `-shm` siblings even for a read.

use crate::paths::folder_key;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 40;
const MAX_META_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorHistoryEntry {
    pub id: String,
    /// `acp` for `acp-sessions/`, `cli` for `chats/`.
    pub source: String,
    pub cwd: String,
    pub title: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MetaFile {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

pub fn cursor_data_dir() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }?;
    Some(home.join(".cursor"))
}

/// Sessions whose `meta.json` `cwd` matches `folder`. Missing folders yield an empty list.
pub fn list_cursor_history(cursor_dir: &Path, folder: &str) -> Vec<CursorHistoryEntry> {
    let wanted = folder_key(folder);
    if wanted.is_empty() || !cursor_dir.is_dir() {
        return Vec::new();
    }
    let mut entries = Vec::new();
    collect_acp_sessions(&cursor_dir.join("acp-sessions"), &wanted, &mut entries);
    collect_cli_chats(&cursor_dir.join("chats"), &wanted, &mut entries);
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    entries.truncate(MAX_ENTRIES);
    entries
}

fn collect_acp_sessions(root: &Path, wanted: &str, out: &mut Vec<CursorHistoryEntry>) {
    let Ok(read) = fs::read_dir(root) else {
        return;
    };
    for item in read.flatten() {
        if !item.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(id) = safe_entry_name(&item.file_name()) else {
            continue;
        };
        push_meta_entry(
            &item.path().join("meta.json"),
            &id,
            "acp",
            wanted,
            out,
        );
    }
}

fn collect_cli_chats(root: &Path, wanted: &str, out: &mut Vec<CursorHistoryEntry>) {
    let Ok(projects) = fs::read_dir(root) else {
        return;
    };
    for project in projects.flatten() {
        if !project.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if safe_entry_name(&project.file_name()).is_none() {
            continue;
        }
        let Ok(chats) = fs::read_dir(project.path()) else {
            continue;
        };
        for chat in chats.flatten() {
            if !chat.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(id) = safe_entry_name(&chat.file_name()) else {
                continue;
            };
            push_meta_entry(&chat.path().join("meta.json"), &id, "cli", wanted, out);
        }
    }
}

fn push_meta_entry(
    meta_path: &Path,
    id: &str,
    source: &str,
    wanted: &str,
    out: &mut Vec<CursorHistoryEntry>,
) {
    let Some(meta) = read_meta(meta_path) else {
        return;
    };
    let Some(cwd) = meta.cwd.filter(|cwd| folder_key(cwd) == wanted) else {
        return;
    };
    let title = meta
        .title
        .filter(|s| !s.trim().is_empty())
        .or(meta.name.filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| id.to_string());
    out.push(CursorHistoryEntry {
        id: id.to_string(),
        source: source.to_string(),
        cwd,
        title,
        updated_at: mtime_rfc3339(meta_path),
    });
}

fn read_meta(path: &Path) -> Option<MetaFile> {
    let file = File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(MAX_META_BYTES as u64).read_to_end(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn safe_entry_name(name: &std::ffi::OsStr) -> Option<String> {
    let text = name.to_str()?;
    if text.is_empty()
        || text.contains('/')
        || text.contains('\\')
        || text.contains("..")
        || text.starts_with('.')
    {
        return None;
    }
    Some(text.to_string())
}

fn mtime_rfc3339(path: &Path) -> Option<String> {
    let modified = path.metadata().ok()?.modified().ok()?;
    let dt: DateTime<Utc> = modified.into();
    Some(dt.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_meta(dir: &Path, cwd: &str, title: &str) {
        fs::create_dir_all(dir).unwrap();
        let body = serde_json::json!({
            "schemaVersion": 1,
            "cwd": cwd,
            "title": title,
        });
        fs::write(dir.join("meta.json"), body.to_string()).unwrap();
    }

    #[test]
    fn lists_acp_and_cli_sessions_for_the_folder_without_touching_store_db() {
        let root = std::env::temp_dir().join(format!(
            "dcterminal_history_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        let cwd = r"C:\Work\OfflineBarangayManagementSystem";
        write_meta(
            &root.join("acp-sessions").join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
            cwd,
            "ACP chat",
        );
        write_meta(
            &root
                .join("acp-sessions")
                .join("bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"),
            r"D:\Other",
            "Elsewhere",
        );
        let cli_dir = root
            .join("chats")
            .join("abc123hash")
            .join("cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee");
        write_meta(&cli_dir, &cwd.replace('\\', "/"), "CLI chat");
        let db_path = cli_dir.join("store.db");
        fs::write(&db_path, b"not-a-real-database").unwrap();
        let before = fs::read(&db_path).unwrap();

        let listed = list_cursor_history(&root, cwd);
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|e| e.source == "acp" && e.title == "ACP chat"));
        assert!(listed.iter().any(|e| e.source == "cli" && e.title == "CLI chat"));
        assert!(!listed.iter().any(|e| e.title == "Elsewhere"));
        assert_eq!(fs::read(&db_path).unwrap(), before);
        assert!(!cli_dir.join("store.db-wal").exists());
        assert!(!cli_dir.join("store.db-shm").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_cursor_dir_is_an_empty_list() {
        let missing = std::env::temp_dir().join("dcterminal_history_missing_dir");
        let _ = fs::remove_dir_all(&missing);
        assert!(list_cursor_history(&missing, r"C:\Work").is_empty());
    }
}
