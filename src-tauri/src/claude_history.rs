//! Read-only index of Claude Code sessions under `<configDir>/projects`.
//!
//! DCTerminal never creates, locks, or writes that folder. Each session is a
//! jsonl file. The folder name encodes the cwd, but encoding of `.`, spaces
//! and `_` is unverified, so a file is kept only when a record's `cwd` matches
//! the folder (canonicalized when the path exists).

use crate::paths::folder_key;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 40;
/// Stop reading a transcript once the title and the first user line are known,
/// and never read more than this from the start of one file.
const MAX_READ_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHistoryEntry {
    pub id: String,
    /// Always `claude`, so the history list can share the Cursor row shape.
    pub source: String,
    pub cwd: String,
    pub title: String,
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// How the session was started (`cli`, the adapter, …). Values are unverified.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entrypoint: Option<String>,
}

/// Sessions in `config_dir/projects` whose records name `folder`.
/// A missing projects dir yields an empty list. Nothing is created.
pub fn list_claude_history(config_dir: &Path, folder: &str) -> Vec<ClaudeHistoryEntry> {
    let wanted = folder_key(folder);
    if wanted.is_empty() {
        return Vec::new();
    }
    let projects = projects_dir(config_dir);
    if !projects.is_dir() {
        return Vec::new();
    }
    let Ok(projects_read) = std::fs::read_dir(&projects) else {
        return Vec::new();
    };
    let dirs = projects_read
        .flatten()
        .filter(|project| {
            project
                .file_type()
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
        })
        .map(|project| project.path());
    sessions_in(dirs, &wanted)
}

/// The quick first pass: only the project folders Claude Code names after
/// `folder` (as given, and canonicalized), so the other projects are not
/// read. The full [`list_claude_history`] can find more (a session filed
/// under another name); every entry here is also in its result.
pub fn list_claude_history_own_folder(config_dir: &Path, folder: &str) -> Vec<ClaudeHistoryEntry> {
    let wanted = folder_key(folder);
    if wanted.is_empty() {
        return Vec::new();
    }
    let projects = projects_dir(config_dir);
    let mut names = vec![claude_project_folder_name(&wanted)];
    if let Some(canon) = canonicalize_existing(&wanted) {
        let name = claude_project_folder_name(&canon);
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let dirs = names
        .into_iter()
        .map(|name| projects.join(name))
        .filter(|dir| dir.is_dir());
    sessions_in(dirs, &wanted)
}

/// The project folder name Claude Code uses for `cwd`: every character other
/// than an ASCII letter or digit becomes `-` (one per UTF-16 unit, as in its
/// JavaScript). Very long paths are shortened by Claude Code with a hash;
/// those are left to the full scan.
pub fn claude_project_folder_name(cwd: &str) -> String {
    let mut name = String::new();
    for c in folder_key(cwd).chars() {
        if c.is_ascii_alphanumeric() {
            name.push(c);
        } else {
            name.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    name
}

/// The newest [`MAX_ENTRIES`] matching sessions in `dirs` (not recursive).
fn sessions_in(dirs: impl Iterator<Item = PathBuf>, wanted: &str) -> Vec<ClaudeHistoryEntry> {
    let mut entries = Vec::new();
    for dir in dirs {
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(entry) = read_session(&path, wanted) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    entries.truncate(MAX_ENTRIES);
    entries
}

struct Scan {
    session_id: Option<String>,
    cwd: Option<String>,
    custom_title: Option<String>,
    ai_title: Option<String>,
    user_text: Option<String>,
    git_branch: Option<String>,
    entrypoint: Option<String>,
    sidechain: bool,
    saw_user: bool,
}

fn read_session(path: &Path, wanted: &str) -> Option<ClaudeHistoryEntry> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file.take(MAX_READ_BYTES));
    let mut scan = Scan {
        session_id: None,
        cwd: None,
        custom_title: None,
        ai_title: None,
        user_text: None,
        git_branch: None,
        entrypoint: None,
        sidechain: false,
        saw_user: false,
    };
    // Bytes, not read_line: one bad UTF-8 line (or the read cap splitting a
    // character) must skip that line, not drop the whole session.
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).ok()?;
        if read == 0 {
            break;
        }
        let Some(value) = parse_jsonl_line(&line) else {
            continue;
        };
        observe(&mut scan, &value);
        if scan.sidechain {
            return None;
        }
        // customTitle wins, so keep reading title records after the first
        // user line. Stop once a later non-title record starts.
        let kind = value.get("type").and_then(Value::as_str);
        let title_record = matches!(kind, Some("custom-title" | "ai-title" | "summary"));
        if scan.custom_title.is_some() {
            break;
        }
        if scan.saw_user && !title_record && kind != Some("user") {
            break;
        }
    }
    let cwd = scan.cwd.as_deref()?;
    if !cwd_matches(cwd, wanted) {
        return None;
    }
    let id = scan
        .session_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("session")
                .to_string()
        });
    let title = scan
        .custom_title
        .or(scan.ai_title)
        .or(scan.user_text)
        .unwrap_or_else(|| "Claude session".to_string());
    let updated_at = meta.modified().ok().map(|time| {
        let datetime: DateTime<Utc> = time.into();
        datetime.to_rfc3339()
    });
    Some(ClaudeHistoryEntry {
        id,
        source: "claude".to_string(),
        cwd: cwd.to_string(),
        title: trim_title(&title),
        updated_at,
        git_branch: scan.git_branch,
        entrypoint: scan.entrypoint,
    })
}

/// One transcript record from raw bytes. Bad JSON or bad UTF-8 yields `None`,
/// so callers skip that line and keep the rest of the session.
pub(crate) fn parse_jsonl_line(line: &[u8]) -> Option<Value> {
    serde_json::from_slice::<Value>(line.trim_ascii()).ok()
}

fn observe(scan: &mut Scan, value: &Value) {
    if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        scan.sidechain = true;
        return;
    }
    if scan.session_id.is_none() {
        scan.session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    if scan.cwd.is_none() {
        scan.cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
    }
    if scan.git_branch.is_none() {
        scan.git_branch = value
            .get("gitBranch")
            .and_then(Value::as_str)
            .filter(|branch| !branch.is_empty())
            .map(str::to_string);
    }
    if scan.entrypoint.is_none() {
        scan.entrypoint = value
            .get("entrypoint")
            .and_then(Value::as_str)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string);
    }
    match value.get("type").and_then(Value::as_str) {
        Some("custom-title") => {
            if scan.custom_title.is_none() {
                scan.custom_title = text_field(value, "customTitle");
            }
        }
        Some("ai-title") => {
            if scan.ai_title.is_none() {
                scan.ai_title = text_field(value, "aiTitle");
            }
        }
        Some("user") => {
            scan.saw_user = true;
            if scan.user_text.is_none() {
                scan.user_text = user_text(value);
            }
        }
        _ => {}
    }
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn user_text(value: &Value) -> Option<String> {
    let message = value.get("message").unwrap_or(value);
    let content = message.get("content").or_else(|| value.get("content"))?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn trim_title(title: &str) -> String {
    let one = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = one.chars();
    let clipped: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

/// True when `record_cwd` is the folder the user asked for.
/// Canonicalize when both paths exist; otherwise compare the folder key.
fn cwd_matches(record_cwd: &str, wanted_key: &str) -> bool {
    let record_key = folder_key(record_cwd);
    if record_key == wanted_key {
        return true;
    }
    let Some(record_canon) = canonicalize_existing(record_cwd) else {
        return false;
    };
    let Some(wanted_canon) = canonicalize_existing_key(wanted_key) else {
        return false;
    };
    folder_key(&record_canon) == folder_key(&wanted_canon)
}

fn canonicalize_existing(path: &str) -> Option<String> {
    let canon = std::fs::canonicalize(path).ok()?;
    Some(canon.display().to_string())
}

fn canonicalize_existing_key(key: &str) -> Option<String> {
    // folder_key lowercases on Windows and strips a trailing slash. Try the
    // key as a path; tests pass a real temp path through folder_key.
    canonicalize_existing(key)
}

/// The projects directory that would be scanned. Exposed so a test can prove
/// a non-default config dir is used and `~/.claude/projects` is not.
pub fn projects_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("projects")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_session(dir: &Path, name: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn indexes_matching_cwd_and_skips_sidechains_and_other_folders() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = crate::test_support::test_root().join(format!("dct_claude_hist_{nanos}"));
        let folder = root.join("app");
        std::fs::create_dir_all(&folder).unwrap();
        let folder_text = folder.display().to_string();
        let projects = root.join("config-a").join("projects").join("-tmp-app");
        write_session(
            &projects,
            "11111111-1111-1111-1111-111111111111.jsonl",
            &format!(
                "{}\n{}\n{}\n",
                serde_json::json!({
                    "type": "user",
                    "sessionId": "11111111-1111-1111-1111-111111111111",
                    "cwd": folder_text,
                    "gitBranch": "feat/x",
                    "entrypoint": "sdk-cli",
                    "message": { "content": "Add the picker" }
                }),
                serde_json::json!({ "type": "ai-title", "aiTitle": "Model picker", "cwd": folder_text }),
                serde_json::json!({ "type": "custom-title", "customTitle": "Claude models", "cwd": folder_text }),
            ),
        );
        write_session(
            &projects,
            "side.jsonl",
            &serde_json::json!({
                "type": "user",
                "isSidechain": true,
                "cwd": folder_text,
                "message": { "content": "hidden" }
            })
            .to_string(),
        );
        let other = root.join("config-a").join("projects").join("-other");
        write_session(
            &other,
            "other.jsonl",
            &serde_json::json!({
                "type": "user",
                "cwd": "/somewhere/else",
                "message": { "content": "nope" }
            })
            .to_string(),
        );
        // A decoy default config dir that must not be read.
        let decoy = root.join(".claude").join("projects").join("-tmp-app");
        write_session(
            &decoy,
            "decoy.jsonl",
            &serde_json::json!({
                "type": "user",
                "cwd": folder_text,
                "customTitle": "wrong account",
                "message": { "content": "from the default folder" }
            })
            .to_string(),
        );

        let entries = list_claude_history(&root.join("config-a"), &folder_text);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(entries[0].title, "Claude models");
        assert_eq!(entries[0].git_branch.as_deref(), Some("feat/x"));
        assert_eq!(entries[0].entrypoint.as_deref(), Some("sdk-cli"));
        assert_eq!(entries[0].source, "claude");
        assert!(list_claude_history(&root.join("config-a"), &folder_text)
            .iter()
            .all(|entry| entry.title != "from the default folder"));
        let decoy_entries = list_claude_history(&root.join(".claude"), &folder_text);
        assert_eq!(decoy_entries.len(), 1);
        assert_eq!(decoy_entries[0].title, "from the default folder");
        let before = std::fs::metadata(&projects).unwrap().modified().unwrap();
        let _ = list_claude_history(&root.join("config-a"), &folder_text);
        let after = std::fs::metadata(&projects).unwrap().modified().unwrap();
        assert_eq!(before, after);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn project_folder_names_follow_claude_codes_encoding() {
        assert_eq!(
            claude_project_folder_name("/Users/me/my.app_x"),
            "-Users-me-my-app-x"
        );
        assert_eq!(
            claude_project_folder_name("/Users/me/My App/"),
            "-Users-me-My-App"
        );
    }

    #[test]
    fn the_folders_own_sessions_come_back_without_reading_the_other_projects() {
        let root = crate::test_support::TempDir::new("claude_hist_own");
        let folder = root.join("app");
        std::fs::create_dir_all(&folder).unwrap();
        let folder_text = folder.display().to_string();
        let config = root.join("cfg");
        let projects = projects_dir(&config);
        let session = |id: &str, title: &str| {
            serde_json::json!({
                "type": "user",
                "sessionId": id,
                "cwd": folder_text,
                "message": { "content": title }
            })
            .to_string()
        };
        let own = projects.join(claude_project_folder_name(&folder_text));
        write_session(&own, "own-1.jsonl", &session("own-1", "first own"));
        write_session(&own, "own-2.jsonl", &session("own-2", "second own"));
        // Many other projects. One holds a session for the same folder under a
        // name that is not the folder's own (a renamed or aliased project):
        // only the full scan may find it, so seeing it here would mean the
        // other folders were read.
        for index in 0..50 {
            let other = projects.join(format!("-other-project-{index}"));
            write_session(
                &other,
                "x.jsonl",
                &serde_json::json!({
                    "type": "user",
                    "cwd": format!("/other/{index}"),
                    "message": { "content": "elsewhere" }
                })
                .to_string(),
            );
        }
        write_session(
            &projects.join("-renamed-project"),
            "stray.jsonl",
            &session("stray", "found only by the full scan"),
        );

        let quick = list_claude_history_own_folder(&config, &folder_text);
        let mut quick_ids: Vec<_> = quick.iter().map(|entry| entry.id.as_str()).collect();
        quick_ids.sort();
        assert_eq!(quick_ids, ["own-1", "own-2"]);

        let full = list_claude_history(&config, &folder_text);
        let mut full_ids: Vec<_> = full.iter().map(|entry| entry.id.as_str()).collect();
        full_ids.sort();
        assert_eq!(full_ids, ["own-1", "own-2", "stray"]);
        for entry in &quick {
            assert!(full.contains(entry), "{entry:?}");
        }
    }

    #[test]
    fn title_falls_back_to_the_first_user_line() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = crate::test_support::test_root().join(format!("dct_claude_hist_title_{nanos}"));
        let folder = root.join("app");
        std::fs::create_dir_all(&folder).unwrap();
        let folder_text = folder.display().to_string();
        write_session(
            &root.join("cfg").join("projects").join("p"),
            "abc.jsonl",
            &serde_json::json!({
                "type": "user",
                "cwd": folder_text,
                "message": { "content": [{ "type": "text", "text": "hello there" }] }
            })
            .to_string(),
        );
        let entries = list_claude_history(&root.join("cfg"), &folder_text);
        assert_eq!(entries[0].title, "hello there");
        assert_eq!(entries[0].id, "abc");
        let _ = std::fs::remove_dir_all(root);
    }
}
