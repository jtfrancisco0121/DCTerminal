//! Read-only tree and preview of a tab's working folder, plus a guarded save.
//!
//! Every path is relative to the tab's `cwd`, which is looked up from
//! `state.json` (the webview never names the root). A path is rejected when it
//! is absolute, has a `..` part, goes through `.git`, `node_modules` or
//! `target`, or resolves (after symlinks) outside the root. A save only
//! replaces a file that already exists, and it refuses when the file changed
//! on disk since it was read, unless the caller forces it.

use crate::store::StateStore;
use base64::Engine;
use serde::Serialize;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::State;

pub const MAX_ENTRIES: usize = 1000;
pub const MAX_TEXT_BYTES: u64 = 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
pub const HIDDEN_NAMES: [&str; 3] = [".git", "node_modules", "target"];
pub const CONFLICT_PREFIX: &str = "CONFLICT:";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// Relative to the root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub root: String,
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub abs_path: String,
    pub size: u64,
    pub mtime_ms: u64,
    /// `text`, `image`, `binary`, or `tooLarge`.
    pub kind: String,
    pub text: Option<String>,
    pub data_base64: Option<String>,
    pub mime: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime_ms: u64,
    pub size: u64,
}

/// Show a path without Windows' `\\?\` verbatim prefix.
pub fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").map(String::from).unwrap_or(text)
}

pub fn canonical_root(cwd: &str) -> Result<PathBuf, String> {
    let folder = crate::paths::validate_working_folder(cwd).map_err(|err| err.message())?;
    folder
        .canonicalize()
        .map_err(|err| format!("could not open the working folder: {err}"))
}

/// Split a relative path into plain parts, or say why it is refused.
pub fn relative_parts(rel: &str) -> Result<Vec<String>, String> {
    let normalized = rel.replace('\\', "/");
    let trimmed = normalized.trim();
    if trimmed.starts_with('/') || Path::new(trimmed).is_absolute() || trimmed.contains(':') {
        return Err("the path must be inside the tab's folder".to_string());
    }
    let mut parts = Vec::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy().to_string();
                if HIDDEN_NAMES.contains(&part.as_str()) {
                    return Err(format!("{part} is not shown in the file panel"));
                }
                parts.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => return Err("`..` is not allowed".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("the path must be inside the tab's folder".to_string())
            }
        }
    }
    Ok(parts)
}

/// Resolve `rel` under the canonical `root`. Symlinks are followed and the
/// result must still be inside the root.
pub fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts = relative_parts(rel)?;
    let mut joined = root.to_path_buf();
    for part in &parts {
        joined.push(part);
    }
    let resolved = joined
        .canonicalize()
        .map_err(|err| format!("{rel}: {err}"))?;
    if !resolved.starts_with(root) {
        return Err("that path leads outside the tab's folder".to_string());
    }
    Ok(resolved)
}

fn rel_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|rel| {
            rel.components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One directory level. `.gitignore` (and parent ignore files) apply;
/// `.git`, `node_modules`, `target` and links that leave the root are hidden.
pub fn list_dir(root: &Path, rel: &str) -> Result<DirListing, String> {
    let dir = resolve_inside(root, rel)?;
    if !dir.is_dir() {
        return Err(format!("{rel} is not a folder"));
    }
    let walker = ignore::WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .parents(true)
        .require_git(false)
        .follow_links(false)
        .build();
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in walker {
        let Ok(item) = item else { continue };
        if item.depth() == 0 {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();
        if HIDDEN_NAMES.contains(&name.as_str()) {
            continue;
        }
        let path = item.path().to_path_buf();
        let is_link = item.path_is_symlink();
        let target = if is_link {
            match path.canonicalize() {
                Ok(real) if real.starts_with(root) => real,
                _ => continue,
            }
        } else {
            path.clone()
        };
        let Ok(meta) = std::fs::metadata(&target) else {
            continue;
        };
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let rel_path = if rel_parts_empty(rel) {
            name.clone()
        } else {
            format!("{}/{}", rel_string(root, &dir), name)
        };
        entries.push(FileEntry {
            name,
            path: rel_path,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(DirListing {
        root: display_path(root),
        path: rel_string(root, &dir),
        entries,
        truncated,
    })
}

fn rel_parts_empty(rel: &str) -> bool {
    relative_parts(rel).map(|p| p.is_empty()).unwrap_or(true)
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

pub fn read_file(root: &Path, rel: &str) -> Result<FileContent, String> {
    let path = resolve_inside(root, rel)?;
    let meta = std::fs::metadata(&path).map_err(|err| err.to_string())?;
    if !meta.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    let size = meta.len();
    let mut content = FileContent {
        path: rel_string(root, &path),
        abs_path: display_path(&path),
        size,
        mtime_ms: mtime_ms(&meta),
        kind: "tooLarge".to_string(),
        text: None,
        data_base64: None,
        mime: None,
    };
    if let Some(mime) = image_mime(&path) {
        if size > MAX_IMAGE_BYTES {
            return Ok(content);
        }
        let bytes = std::fs::read(&path).map_err(|err| err.to_string())?;
        content.kind = "image".to_string();
        content.mime = Some(mime.to_string());
        content.data_base64 = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
        return Ok(content);
    }
    if size > MAX_TEXT_BYTES {
        return Ok(content);
    }
    let mut bytes = Vec::with_capacity(size as usize);
    std::fs::File::open(&path)
        .and_then(|mut file| file.by_ref().take(MAX_TEXT_BYTES).read_to_end(&mut bytes))
        .map_err(|err| err.to_string())?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        content.kind = "binary".to_string();
        return Ok(content);
    }
    match String::from_utf8(bytes) {
        Ok(text) => {
            content.kind = "text".to_string();
            content.text = Some(text);
        }
        Err(_) => content.kind = "binary".to_string(),
    }
    Ok(content)
}

/// Replace an existing text file. `expected_mtime_ms` is the mtime from the
/// read; a different mtime on disk returns a `CONFLICT:` error unless `force`.
pub fn write_file(
    root: &Path,
    rel: &str,
    text: &str,
    expected_mtime_ms: Option<u64>,
    force: bool,
) -> Result<WriteResult, String> {
    if text.len() as u64 > MAX_TEXT_BYTES {
        return Err("the file is too large to save from the panel".to_string());
    }
    let path = resolve_inside(root, rel)?;
    let meta = std::fs::metadata(&path).map_err(|err| err.to_string())?;
    if !meta.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    if meta.permissions().readonly() {
        return Err(format!("{rel} is read-only"));
    }
    let on_disk = mtime_ms(&meta);
    if !force {
        if let Some(expected) = expected_mtime_ms {
            if expected != on_disk {
                return Err(format!(
                    "{CONFLICT_PREFIX} {rel} changed on disk after it was opened"
                ));
            }
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| "the file has no folder".to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let temp = parent.join(format!(
        ".{name}.dcterminal-{}.tmp",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    std::fs::write(&temp, text.as_bytes()).map_err(|err| format!("save failed: {err}"))?;
    let _ = std::fs::set_permissions(&temp, meta.permissions());
    if let Err(err) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("save failed: {err}"));
    }
    let after = std::fs::metadata(&path).map_err(|err| err.to_string())?;
    Ok(WriteResult {
        mtime_ms: mtime_ms(&after),
        size: after.len(),
    })
}

fn tab_root(store: &Mutex<StateStore>, tab_id: &str) -> Result<PathBuf, String> {
    let cwd = {
        let store = store.lock().map_err(|err| err.to_string())?;
        store
            .tab_by_id(tab_id)
            .map(|tab| tab.cwd.clone())
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?
    };
    if cwd.trim().is_empty() {
        return Err("This tab has no working folder yet.".to_string());
    }
    canonical_root(&cwd)
}

#[tauri::command]
pub fn files_list(
    tab_id: String,
    path: Option<String>,
    store: State<Mutex<StateStore>>,
) -> Result<DirListing, String> {
    let root = tab_root(&store, &tab_id)?;
    list_dir(&root, path.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn files_read(
    tab_id: String,
    path: String,
    store: State<Mutex<StateStore>>,
) -> Result<FileContent, String> {
    let root = tab_root(&store, &tab_id)?;
    read_file(&root, &path)
}

#[tauri::command]
pub fn files_write(
    tab_id: String,
    path: String,
    text: String,
    expected_mtime_ms: Option<u64>,
    force: Option<bool>,
    store: State<Mutex<StateStore>>,
) -> Result<WriteResult, String> {
    let root = tab_root(&store, &tab_id)?;
    write_file(
        &root,
        &path,
        &text,
        expected_mtime_ms,
        force.unwrap_or(false),
    )
}

/// Reveal in Finder (Explorer on Windows, the file manager on Linux).
#[tauri::command]
pub fn files_reveal(
    tab_id: String,
    path: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let root = tab_root(&store, &tab_id)?;
    let target = resolve_inside(&root, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let nanos = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("dcterminal_files_{label}_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn parent_absolute_and_hidden_parts_are_refused() {
        assert!(relative_parts("../etc/passwd").is_err());
        assert!(relative_parts("src/../../x").is_err());
        assert!(relative_parts("/etc/passwd").is_err());
        assert!(relative_parts(r"C:\Windows").is_err());
        assert!(relative_parts(r"..\x").is_err());
        assert!(relative_parts(".git/config").is_err());
        assert!(relative_parts("a/node_modules/b").is_err());
        assert_eq!(
            relative_parts("./src/main.rs").unwrap(),
            vec!["src", "main.rs"]
        );
        assert!(relative_parts("").unwrap().is_empty());
    }

    #[test]
    fn listing_respects_gitignore_and_hides_build_folders() {
        let root = temp_root("list");
        std::fs::write(root.join(".gitignore"), "secret.txt\nbuild/\n").unwrap();
        std::fs::write(root.join("secret.txt"), "x").unwrap();
        std::fs::write(root.join("README.md"), "# hi").unwrap();
        for dir in ["src", "build", ".git", "node_modules", "target"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::write(root.join("src").join("lib.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("src").join("secret.txt"), "x").unwrap();
        let top = list_dir(&root, "").unwrap();
        let names: Vec<&str> = top.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", ".gitignore", "README.md"]);
        assert!(top.entries[0].is_dir);
        let nested = list_dir(&root, "src").unwrap();
        let nested_names: Vec<&str> = nested.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(nested_names, vec!["src/lib.rs"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn listing_caps_entries() {
        let root = temp_root("cap");
        for n in 0..(MAX_ENTRIES + 5) {
            std::fs::write(root.join(format!("f{n}.txt")), "").unwrap();
        }
        let listing = list_dir(&root, "").unwrap();
        assert_eq!(listing.entries.len(), MAX_ENTRIES);
        assert!(listing.truncated);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_that_escape_the_root_are_hidden_and_refused() {
        let root = temp_root("link");
        let outside = temp_root("outside");
        std::fs::write(outside.join("passwd"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.join("passwd"), root.join("escape")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape_dir")).unwrap();
        std::fs::write(root.join("inside.txt"), "ok").unwrap();
        std::os::unix::fs::symlink(root.join("inside.txt"), root.join("alias")).unwrap();
        let names: Vec<String> = list_dir(&root, "")
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert!(names.contains(&"alias".to_string()));
        assert!(!names.contains(&"escape".to_string()));
        assert!(!names.contains(&"escape_dir".to_string()));
        assert!(read_file(&root, "escape").is_err());
        assert!(read_file(&root, "escape_dir/passwd").is_err());
        assert!(write_file(&root, "escape", "x", None, true).is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("passwd")).unwrap(),
            "secret"
        );
        assert_eq!(
            read_file(&root, "alias").unwrap().text.as_deref(),
            Some("ok")
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn reads_text_images_binary_and_large_files() {
        let root = temp_root("read");
        std::fs::write(root.join("a.rs"), "fn x() {}").unwrap();
        std::fs::write(root.join("p.png"), [0x89, b'P', b'N', b'G']).unwrap();
        std::fs::write(root.join("b.bin"), [0u8, 1, 2]).unwrap();
        std::fs::write(
            root.join("big.txt"),
            vec![b'a'; MAX_TEXT_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(read_file(&root, "a.rs").unwrap().kind, "text");
        let image = read_file(&root, "p.png").unwrap();
        assert_eq!(image.kind, "image");
        assert_eq!(image.mime.as_deref(), Some("image/png"));
        assert_eq!(read_file(&root, "b.bin").unwrap().kind, "binary");
        let big = read_file(&root, "big.txt").unwrap();
        assert_eq!(big.kind, "tooLarge");
        assert!(big.text.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn save_checks_mtime_and_only_replaces_existing_files() {
        let root = temp_root("write");
        std::fs::write(root.join("a.txt"), "one").unwrap();
        let read = read_file(&root, "a.txt").unwrap();
        let saved = write_file(&root, "a.txt", "two", Some(read.mtime_ms), false).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "two");
        let stale = write_file(&root, "a.txt", "three", Some(saved.mtime_ms + 1), false);
        assert!(stale.unwrap_err().starts_with(CONFLICT_PREFIX));
        write_file(&root, "a.txt", "three", Some(0), true).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "three"
        );
        assert!(write_file(&root, "new.txt", "x", None, false).is_err());
        assert!(!root.join("new.txt").exists());
        assert!(write_file(&root, "../a.txt", "x", None, true).is_err());
        let leftovers = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn verbatim_prefix_is_hidden() {
        assert_eq!(display_path(Path::new(r"\\?\C:\Work")), r"C:\Work");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\srv\share")),
            r"\\srv\share"
        );
        assert_eq!(display_path(Path::new("/tmp/x")), "/tmp/x");
    }
}
