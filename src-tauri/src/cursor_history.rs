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
    /// Role that started this session in DCTerminal, when we still have the tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_name: Option<String>,
    /// Title field, or the first thing the user typed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_text: Option<String>,
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

/// Home used to find `~/.cursor`. `DCT_CURSOR_HOME` is the test override.
/// The real CLI still lives under the user profile. This crate only reads it.
pub fn cursor_home() -> Option<PathBuf> {
    resolve_cursor_home(
        std::env::var_os("DCT_CURSOR_HOME").as_deref(),
        std::env::var_os("USERPROFILE").as_deref(),
        std::env::var_os("HOME").as_deref(),
        cfg!(windows),
    )
}

pub fn cursor_data_dir() -> Option<PathBuf> {
    cursor_home().map(|home| home.join(".cursor"))
}

pub fn resolve_cursor_home(
    override_dir: Option<&std::ffi::OsStr>,
    userprofile: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
    windows: bool,
) -> Option<PathBuf> {
    if let Some(path) = nonempty_path(override_dir) {
        return Some(path);
    }
    if windows {
        nonempty_path(userprofile)
    } else {
        nonempty_path(home)
    }
}

fn nonempty_path(value: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let raw = value?;
    if raw.is_empty() {
        return None;
    }
    if let Some(text) = raw.to_str() {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        return Some(PathBuf::from(trimmed));
    }
    Some(PathBuf::from(raw))
}

/// True when `session_id` is a CLI chat for `folder` (`chats/<hash>/<id>/meta.json`).
/// ACP sessions under `acp-sessions/` are not CLI chats.
pub fn is_cli_chat(cursor_dir: &Path, folder: &str, session_id: &str) -> bool {
    let wanted = folder_key(folder);
    let id = session_id.trim();
    if wanted.is_empty()
        || id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
    {
        return false;
    }
    let Ok(projects) = fs::read_dir(cursor_dir.join("chats")) else {
        return false;
    };
    for project in projects.flatten() {
        if !project
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let Some(meta) = read_meta(&project.path().join(id).join("meta.json")) else {
            continue;
        };
        if meta
            .cwd
            .as_deref()
            .is_some_and(|cwd| folder_key(cwd) == wanted)
        {
            return true;
        }
    }
    false
}

pub fn cli_chat_required(cursor_dir: &Path, folder: &str, session_id: &str) -> Result<(), String> {
    if is_cli_chat(cursor_dir, folder, session_id) {
        return Ok(());
    }
    Err(
        "Open in Cursor CLI is only for saved chats. Resume continues a session inside DCTerminal."
            .to_string(),
    )
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
        push_meta_entry(&item.path().join("meta.json"), &id, "acp", wanted, out);
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
        role_name: None,
        user_text: None,
    });
}

#[derive(Debug, Clone)]
pub struct RoleHeading {
    pub role_name: String,
    pub heading: String,
}

/// First non-empty line of a role prompt, without a leading markdown heading mark.
pub fn first_heading(template: &str) -> String {
    template
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .trim_start_matches('#')
        .trim()
        .to_string()
}

/// Title, then the first user-written field. Task type alone is not a title.
pub fn user_text_from_answers(
    answers: &std::collections::HashMap<String, String>,
) -> Option<String> {
    for key in [
        "title",
        "request",
        "description",
        "originalTask",
        "additionalContext",
    ] {
        if let Some(text) = answers
            .get(key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            return Some(snippet(text, 80));
        }
    }
    None
}

fn snippet(text: &str, max_chars: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max_chars {
        return one_line;
    }
    let end = one_line
        .char_indices()
        .nth(max_chars.saturating_sub(1))
        .map(|(index, _)| index)
        .unwrap_or(one_line.len());
    format!("{}…", one_line[..end].trim_end())
}

fn loose(text: &str) -> String {
    text.chars()
        .flat_map(|ch| ch.to_lowercase())
        .filter(|ch| ch.is_alphanumeric() || ch.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// True when Cursor named the session from the role prompt's first line.
pub fn title_is_prompt_heading(title: &str, headings: &[RoleHeading]) -> Option<String> {
    let title = loose(title);
    if title.len() < 8 {
        return None;
    }
    headings.iter().find_map(|heading| {
        let heading_text = loose(&heading.heading);
        if heading_text.is_empty() {
            return None;
        }
        if heading_text.starts_with(&title) || title.starts_with(&heading_text) {
            Some(heading.role_name.clone())
        } else {
            None
        }
    })
}

/// Fill role and user text. A prompt heading is not the row title.
pub fn annotate_history(
    entries: &mut [CursorHistoryEntry],
    local: &std::collections::HashMap<String, (String, Option<String>)>,
    headings: &[RoleHeading],
) {
    for entry in entries {
        if let Some((role, user)) = local.get(&entry.id) {
            entry.role_name = Some(role.clone());
            entry.user_text = user.clone();
            continue;
        }
        if entry.role_name.is_none() {
            if let Some(role) = title_is_prompt_heading(&entry.title, headings) {
                entry.role_name = Some(role);
            }
        }
    }
}

fn read_meta(path: &Path) -> Option<MetaFile> {
    let file = File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(MAX_META_BYTES as u64)
        .read_to_end(&mut buf)
        .ok()?;
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

    #[test]
    fn cursor_home_prefers_the_override_over_the_user_profile() {
        let home = resolve_cursor_home(
            Some(std::ffi::OsStr::new("/tmp/e2e-home")),
            Some(std::ffi::OsStr::new("C:\\Users\\jt")),
            Some(std::ffi::OsStr::new("/home/jt")),
            true,
        );
        assert_eq!(home, Some(PathBuf::from("/tmp/e2e-home")));
        let windows = resolve_cursor_home(
            None,
            Some(std::ffi::OsStr::new("C:\\Users\\jt")),
            Some(std::ffi::OsStr::new("/home/jt")),
            true,
        );
        assert_eq!(windows, Some(PathBuf::from("C:\\Users\\jt")));
        let unix = resolve_cursor_home(
            Some(std::ffi::OsStr::new("  ")),
            Some(std::ffi::OsStr::new("C:\\Users\\jt")),
            Some(std::ffi::OsStr::new("/home/jt")),
            false,
        );
        assert_eq!(unix, Some(PathBuf::from("/home/jt")));
    }

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
            &root
                .join("acp-sessions")
                .join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
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
        assert!(listed
            .iter()
            .any(|e| e.source == "acp" && e.title == "ACP chat"));
        assert!(listed
            .iter()
            .any(|e| e.source == "cli" && e.title == "CLI chat"));
        assert!(!listed.iter().any(|e| e.title == "Elsewhere"));
        assert_eq!(fs::read(&db_path).unwrap(), before);
        assert!(!cli_dir.join("store.db-wal").exists());
        assert!(!cli_dir.join("store.db-shm").exists());
        assert!(is_cli_chat(
            &root,
            cwd,
            "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee"
        ));
        assert!(cli_chat_required(&root, cwd, "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee").is_ok());
        let acp_only = cli_chat_required(&root, cwd, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        assert!(acp_only.is_err());
        assert!(acp_only.unwrap_err().contains("saved chats"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_prompt_heading_is_not_the_history_title() {
        let headings = vec![RoleHeading {
            role_name: "Developer".into(),
            heading: "SENIOR SOFTWARE ENGINEER — CODEBASE ONBOARDING".into(),
        }];
        assert_eq!(
            title_is_prompt_heading("Senior Software Engineer", &headings).as_deref(),
            Some("Developer")
        );
        let mut entries = vec![CursorHistoryEntry {
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            source: "acp".into(),
            cwd: r"C:\Work".into(),
            title: "Senior Software Engineer".into(),
            updated_at: None,
            role_name: None,
            user_text: None,
        }];
        let mut local = std::collections::HashMap::new();
        local.insert(
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            ("Developer".into(), Some("Encrypt the login".into())),
        );
        annotate_history(&mut entries, &local, &headings);
        assert_eq!(entries[0].role_name.as_deref(), Some("Developer"));
        assert_eq!(entries[0].user_text.as_deref(), Some("Encrypt the login"));
        assert_eq!(
            user_text_from_answers(&std::collections::HashMap::from([(
                "taskType".into(),
                "Feature".into()
            )])),
            None
        );
    }

    #[test]
    fn missing_cursor_dir_is_an_empty_list() {
        let missing = std::env::temp_dir().join("dcterminal_history_missing_dir");
        let _ = fs::remove_dir_all(&missing);
        assert!(list_cursor_history(&missing, r"C:\Work").is_empty());
    }
}
