//! Where DCTerminal stores its own files.
//!
//! `DCT_DATA_DIR` is the explicit override used by end-to-end tests. On Windows
//! Tauri's known-folder lookup ignores `APPDATA` and can fail with
//! `unknown path` when `USERPROFILE` is not a real profile. That failure must
//! not abort startup: the setup hook panics if it returns an error.

use std::ffi::OsStr;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataDirOrigin {
    Override,
    KnownFolder,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDataDir {
    pub path: PathBuf,
    pub origin: DataDirOrigin,
    /// Set when the operating system could not name the profile folder.
    pub warning: Option<String>,
}

pub fn app_data_dir(app: &AppHandle) -> ResolvedDataDir {
    let known = app.path().app_data_dir().map_err(|err| err.to_string());
    resolve_data_dir(
        std::env::var_os("DCT_DATA_DIR").as_deref(),
        known,
        std::env::temp_dir().join("dcterminal"),
    )
}

pub fn resolve_data_dir(
    override_dir: Option<&OsStr>,
    known_folder: Result<PathBuf, String>,
    fallback: PathBuf,
) -> ResolvedDataDir {
    if let Some(path) = override_path(override_dir) {
        return ResolvedDataDir {
            path,
            origin: DataDirOrigin::Override,
            warning: None,
        };
    }
    match known_folder {
        Ok(path) => ResolvedDataDir {
            path,
            origin: DataDirOrigin::KnownFolder,
            warning: None,
        },
        Err(err) => {
            let warning = format!(
                "known folder lookup failed ({err}); using {}",
                fallback.display()
            );
            ResolvedDataDir {
                path: fallback,
                origin: DataDirOrigin::Fallback,
                warning: Some(warning),
            }
        }
    }
}

fn override_path(value: Option<&OsStr>) -> Option<PathBuf> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_data_dir_wins_over_the_known_folder() {
        let resolved = resolve_data_dir(
            Some(OsStr::new("/tmp/dcterminal-e2e")),
            Ok(PathBuf::from("/real/profile")),
            PathBuf::from("/fallback"),
        );
        assert_eq!(resolved.origin, DataDirOrigin::Override);
        assert_eq!(resolved.path, PathBuf::from("/tmp/dcterminal-e2e"));
        assert!(resolved.warning.is_none());
    }

    #[test]
    fn an_unknown_path_falls_back_instead_of_failing_startup() {
        let resolved = resolve_data_dir(
            None,
            Err("unknown path".to_string()),
            PathBuf::from("/fallback"),
        );
        assert_eq!(resolved.origin, DataDirOrigin::Fallback);
        assert_eq!(resolved.path, PathBuf::from("/fallback"));
        let warning = resolved.warning.expect("fallback explains itself");
        assert!(warning.contains("unknown path"));
    }

    #[test]
    fn a_blank_override_does_not_hide_the_known_folder() {
        let resolved = resolve_data_dir(
            Some(OsStr::new("   ")),
            Ok(PathBuf::from("/real/profile")),
            PathBuf::from("/fallback"),
        );
        assert_eq!(resolved.origin, DataDirOrigin::KnownFolder);
        assert_eq!(resolved.path, PathBuf::from("/real/profile"));
    }
}
