//! Working-folder checks. Paths are passed to `current_dir` and ACP `cwd`
//! as `PathBuf` values — never interpolated into a shell string.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderError {
    Empty,
    Missing { path: String },
    NotDirectory { path: String },
    Unreadable { path: String },
}

impl FolderError {
    pub fn message(&self) -> String {
        match self {
            FolderError::Empty => "Working folder is required".to_string(),
            FolderError::Missing { path } => {
                format!("Working folder was not found (it may have been moved or deleted): {path}")
            }
            FolderError::NotDirectory { path } => {
                format!("Working folder must be a directory, not a file: {path}")
            }
            FolderError::Unreadable { path } => {
                format!("Working folder is not readable: {path}")
            }
        }
    }

    pub fn status_code(&self) -> &'static str {
        match self {
            FolderError::Empty => "empty",
            FolderError::Missing { .. } => "missing",
            FolderError::NotDirectory { .. } => "not-a-directory",
            FolderError::Unreadable { .. } => "unreadable",
        }
    }
}

pub fn validate_working_folder(raw: &str) -> Result<PathBuf, FolderError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(FolderError::Empty);
    }
    if trimmed.contains('\0') {
        return Err(FolderError::Missing {
            path: trimmed.to_string(),
        });
    }
    let path = PathBuf::from(trimmed);
    inspect_folder(&path)
}

pub fn folder_status_code(raw: &str) -> String {
    match validate_working_folder(raw) {
        Ok(_) => "ok".to_string(),
        Err(err) => err.status_code().to_string(),
    }
}

fn inspect_folder(path: &Path) -> Result<PathBuf, FolderError> {
    let display = path.display().to_string();
    match path.metadata() {
        Ok(meta) if meta.is_dir() => match std::fs::read_dir(path) {
            Ok(_) => Ok(path.to_path_buf()),
            Err(err) if err.kind() == ErrorKind::PermissionDenied => {
                Err(FolderError::Unreadable { path: display })
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
                Err(FolderError::Missing { path: display })
            }
            Err(_) => Err(FolderError::Unreadable { path: display }),
        },
        Ok(_) => Err(FolderError::NotDirectory { path: display }),
        Err(err) if err.kind() == ErrorKind::PermissionDenied => {
            Err(FolderError::Unreadable { path: display })
        }
        Err(_) => Err(FolderError::Missing { path: display }),
    }
}

/// Compare folders even when one side uses `\` and the other `/`.
/// Drive-letter and UNC paths are case-insensitive (Windows semantics),
/// which also lets Linux unit tests cover the Windows path strings.
pub fn folder_key(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    let unified = trimmed.replace('\\', "/");
    if is_windows_style_path(&unified) {
        unified.to_lowercase()
    } else {
        unified
    }
}

fn is_windows_style_path(unified: &str) -> bool {
    unified.starts_with("//") || (unified.len() >= 2 && unified.as_bytes().get(1) == Some(&b':'))
}

pub fn same_folder_warning(
    new_cwd: &str,
    new_mode: &str,
    others: &[(&str, &str)],
) -> Option<String> {
    if new_mode != "agent" {
        return None;
    }
    let key = folder_key(new_cwd);
    let conflict = others
        .iter()
        .any(|(cwd, mode)| *mode == "agent" && folder_key(cwd) == key);
    if !conflict {
        return None;
    }
    Some(format!(
        "Another agent-mode tab is already using this folder ({new_cwd}). \
         Both sessions can run; two agents writing the same repo may conflict."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dcterminal_paths_{nanos}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn rejects_blank_missing_and_file() {
        assert!(matches!(
            validate_working_folder("   "),
            Err(FolderError::Empty)
        ));
        let missing = scratch_dir().join("does-not-exist");
        assert!(matches!(
            validate_working_folder(&missing.display().to_string()),
            Err(FolderError::Missing { .. })
        ));
        let dir = scratch_dir();
        let file = dir.join("not-a-dir.txt");
        fs::write(&file, b"x").unwrap();
        let err = validate_working_folder(&file.display().to_string()).unwrap_err();
        assert!(matches!(err, FolderError::NotDirectory { .. }), "{err:?}");
        assert!(validate_working_folder(&dir.display().to_string()).is_ok());
        let _ = fs::remove_dir_all(dir);
        assert_eq!(folder_status_code(""), "empty");
        assert_eq!(folder_status_code("   "), "empty");
        assert_eq!(
            folder_status_code(&missing.display().to_string()),
            "missing"
        );
    }

    #[test]
    fn folder_keys_match_windows_spaces_unicode_and_unc() {
        assert_eq!(
            folder_key(r"C:\Users\José\My Projects\repo"),
            folder_key("c:/users/josé/my projects/repo")
        );
        assert_eq!(
            folder_key(r"\\Server\Share\Proj\"),
            folder_key("//server/share/proj")
        );
        assert_ne!(folder_key(r"C:\Work\one"), folder_key(r"C:\Work\two"));
    }

    #[test]
    fn same_folder_warns_only_for_two_agent_modes() {
        let cwd = r"C:\Repos\Demo App";
        let others = [(r"c:/repos/demo app", "agent")];
        assert!(same_folder_warning(cwd, "agent", &others).is_some());
        assert!(same_folder_warning(cwd, "plan", &others).is_none());
        let readonly = [(cwd, "ask")];
        assert!(same_folder_warning(cwd, "agent", &readonly).is_none());
        assert!(same_folder_warning(cwd, "agent", &[]).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_directory_is_rejected_when_not_root() {
        use std::os::unix::fs::PermissionsExt;
        if is_root() {
            return;
        }
        let dir = scratch_dir();
        let perms = fs::Permissions::from_mode(0o000);
        fs::set_permissions(&dir, perms).unwrap();
        let err = validate_working_folder(&dir.display().to_string());
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o755));
        let _ = fs::remove_dir_all(&dir);
        assert!(
            matches!(err, Err(FolderError::Unreadable { .. })),
            "{err:?}"
        );
    }

    #[cfg(unix)]
    fn is_root() -> bool {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|text| {
                text.lines()
                    .find(|line| line.starts_with("Uid:"))
                    .map(|line| line.split_whitespace().nth(1) == Some("0"))
            })
            .unwrap_or(false)
    }
}
