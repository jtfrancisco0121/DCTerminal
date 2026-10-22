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

/// `identifier` in `tauri.conf.json`; Tauri names the app data folder after it.
const IDENTIFIER: &str = "com.jtfrancisco.dcterminal";

/// The data dir before Tauri exists (no AppHandle yet), by the same rule as
/// [`app_data_dir`]: `DCT_DATA_DIR`, else the platform data folder joined
/// with the identifier. `None` when the platform folder cannot be named
/// (Tauri would then use its temp fallback) and on Windows, where nothing
/// needs it yet.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn data_dir_before_tauri() -> Option<PathBuf> {
    let known = platform_data_dir(
        std::env::var_os("HOME").as_deref(),
        std::env::var_os("XDG_DATA_HOME").as_deref(),
    )
    .map(|dir| dir.join(IDENTIFIER))
    .ok_or_else(|| "no home folder".to_string());
    let resolved = resolve_data_dir(
        std::env::var_os("DCT_DATA_DIR").as_deref(),
        known,
        std::env::temp_dir().join("dcterminal"),
    );
    (resolved.origin != DataDirOrigin::Fallback).then_some(resolved.path)
}

/// The folder Tauri's `app_data_dir` starts from (the `dirs` crate's
/// `data_dir`): `~/Library/Application Support` on macOS, `$XDG_DATA_HOME`
/// (when absolute) or `~/.local/share` on other Unix systems.
#[cfg_attr(not(unix), allow(dead_code))]
fn platform_data_dir(home: Option<&OsStr>, xdg_data_home: Option<&OsStr>) -> Option<PathBuf> {
    let home = home.filter(|home| !home.is_empty()).map(PathBuf::from);
    if cfg!(windows) {
        return None;
    }
    if cfg!(target_os = "macos") {
        return home.map(|home| home.join("Library").join("Application Support"));
    }
    xdg_data_home
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| home.map(|home| home.join(".local").join("share")))
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
    fn the_identifier_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
    }

    #[cfg(unix)]
    #[test]
    fn the_platform_data_folder_matches_tauris() {
        let dir = platform_data_dir(Some(OsStr::new("/home/me")), None).unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(dir, PathBuf::from("/home/me/Library/Application Support"));
        } else {
            assert_eq!(dir, PathBuf::from("/home/me/.local/share"));
            let xdg = platform_data_dir(Some(OsStr::new("/home/me")), Some(OsStr::new("/xdg")));
            assert_eq!(xdg.unwrap(), PathBuf::from("/xdg"));
            let relative = platform_data_dir(Some(OsStr::new("/home/me")), Some(OsStr::new("rel")));
            assert_eq!(relative.unwrap(), PathBuf::from("/home/me/.local/share"));
        }
        assert_eq!(platform_data_dir(None, None), None);
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
