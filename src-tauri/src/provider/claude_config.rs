//! Which Claude account DCTerminal uses: the Claude config folder.
//!
//! JT runs Claude as `claude2` (`CLAUDE_CONFIG_DIR=$HOME/.claude-account2
//! claude`). A GUI app does not see shell aliases, so every Claude process
//! DCTerminal starts gets `CLAUDE_CONFIG_DIR=<resolved folder>` from
//! [`claude_env`]. Precedence: `DCT_CLAUDE_CONFIG_DIR` → settings
//! `providers.claude.configDir` → `~/.claude`. An inherited
//! `CLAUDE_CONFIG_DIR` in DCTerminal's own environment is ignored and
//! overwritten.
//!
//! The folder is read-only for DCTerminal: it is never created, and nothing
//! is written into it.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Env override for the Claude config folder (wins over the setting).
pub const CONFIG_DIR_ENV: &str = "DCT_CLAUDE_CONFIG_DIR";
/// The variable Claude Code itself reads.
pub const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigDirSource {
    /// `DCT_CLAUDE_CONFIG_DIR`.
    Env,
    /// Settings `providers.claude.configDir`.
    Setting,
    /// `~/.claude`.
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDirInfo {
    /// Absolute path (canonical when the folder exists).
    pub path: String,
    /// Short form for the status bar, with the home folder as `~`.
    pub display: String,
    pub source: ConfigDirSource,
    pub exists: bool,
}

impl ConfigDirInfo {
    pub fn path_buf(&self) -> PathBuf {
        PathBuf::from(&self.path)
    }

    /// `<configDir>/projects`, where Claude Code keeps session transcripts.
    pub fn projects_dir(&self) -> PathBuf {
        self.path_buf().join("projects")
    }

    /// "Claude config folder not found: <path>" when missing.
    pub fn missing_message(&self) -> Option<String> {
        (!self.exists).then(|| format!("Claude config folder not found: {}", self.path))
    }
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// `~` / `~/x` / `~\x` → home-relative. A relative path is taken relative
/// to the home folder (a GUI app's working directory means nothing).
pub fn expand_home(raw: &str, home: Option<&Path>) -> PathBuf {
    let raw = raw.trim();
    let rest = if raw == "~" {
        Some("")
    } else {
        raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\"))
    };
    match (rest, home) {
        (Some(rest), Some(home)) => {
            if rest.is_empty() {
                home.to_path_buf()
            } else {
                home.join(rest)
            }
        }
        (Some(_), None) => PathBuf::from(raw),
        (None, _) => {
            let path = PathBuf::from(raw);
            match home {
                Some(home) if path.is_relative() => home.join(path),
                _ => path,
            }
        }
    }
}

/// Home folder as `~` for display.
pub fn tilde_display(path: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home {
        if let Ok(rest) = path.strip_prefix(home) {
            if rest.as_os_str().is_empty() {
                return "~".to_string();
            }
            return format!("~/{}", rest.display()).replace('\\', "/");
        }
        // Canonical paths may differ from `$HOME` by a symlink (macOS /var).
        if let Ok(canonical_home) = std::fs::canonicalize(home) {
            if canonical_home != home {
                return tilde_display(path, Some(&canonical_home));
            }
        }
    }
    path.display().to_string()
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// Pure resolver (inputs passed in) so tests do not touch the process env.
pub fn resolve_with(
    env_override: Option<&str>,
    setting: Option<&str>,
    home: Option<&Path>,
) -> ConfigDirInfo {
    let (raw, source) = if let Some(value) = nonempty(env_override) {
        (value.to_string(), ConfigDirSource::Env)
    } else if let Some(value) = nonempty(setting) {
        (value.to_string(), ConfigDirSource::Setting)
    } else {
        ("~/.claude".to_string(), ConfigDirSource::Default)
    };
    let expanded = expand_home(&raw, home);
    // `is_dir` and `canonicalize` only read; the folder is never created.
    let exists = expanded.is_dir();
    let path = if exists {
        std::fs::canonicalize(&expanded).unwrap_or(expanded)
    } else {
        expanded
    };
    ConfigDirInfo {
        display: tilde_display(&path, home),
        path: path.display().to_string(),
        source,
        exists,
    }
}

/// Resolve the Claude config folder from `DCT_CLAUDE_CONFIG_DIR`, then the
/// setting, then `~/.claude`.
pub fn resolve_claude_config_dir(setting: Option<&str>) -> ConfigDirInfo {
    let env_override = std::env::var(CONFIG_DIR_ENV).ok();
    resolve_with(env_override.as_deref(), setting, home_dir().as_deref())
}

/// The environment every Claude process gets: `CLAUDE_CONFIG_DIR=<path>`.
/// Applied on top of the inherited env, so an inherited value is replaced.
pub fn claude_env(info: &ConfigDirInfo) -> Vec<(String, String)> {
    vec![(CLAUDE_CONFIG_DIR.to_string(), info.path.clone())]
}

/// Apply [`claude_env`] to a `Command`.
pub fn apply_claude_env(command: &mut std::process::Command, info: &ConfigDirInfo) {
    for (key, value) in claude_env(info) {
        command.env(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_home(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dct_claude_home_{tag}_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn env_wins_over_setting_which_wins_over_default() {
        let home = temp_home("prec");
        std::fs::create_dir_all(home.join(".claude-account2")).unwrap();
        std::fs::create_dir_all(home.join(".claude-env")).unwrap();
        let info = resolve_with(
            Some("~/.claude-env"),
            Some("~/.claude-account2"),
            Some(&home),
        );
        assert_eq!(info.source, ConfigDirSource::Env);
        assert_eq!(info.path, home.join(".claude-env").display().to_string());
        let info = resolve_with(None, Some("~/.claude-account2"), Some(&home));
        assert_eq!(info.source, ConfigDirSource::Setting);
        assert_eq!(
            info.path,
            home.join(".claude-account2").display().to_string()
        );
        assert_eq!(info.display, "~/.claude-account2");
        assert!(info.exists);
        let info = resolve_with(Some("  "), Some(""), Some(&home));
        assert_eq!(info.source, ConfigDirSource::Default);
        assert_eq!(info.path, home.join(".claude").display().to_string());
        assert_eq!(info.display, "~/.claude");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn tilde_and_relative_paths_expand_under_home() {
        let home = PathBuf::from("/Users/jt");
        assert_eq!(
            expand_home("~/.claude-account2", Some(&home)),
            PathBuf::from("/Users/jt/.claude-account2")
        );
        assert_eq!(expand_home("~", Some(&home)), home);
        assert_eq!(
            expand_home(".claude-x", Some(&home)),
            PathBuf::from("/Users/jt/.claude-x")
        );
        assert_eq!(
            expand_home("/opt/claude", Some(&home)),
            PathBuf::from("/opt/claude")
        );
    }

    #[test]
    fn tilde_expands_on_mac_and_windows_homes() {
        let mac = PathBuf::from("/Users/jt");
        assert_eq!(
            expand_home("~/.claude-account2", Some(&mac)),
            mac.join(".claude-account2")
        );
        assert_eq!(expand_home("~/.claude", Some(&mac)), mac.join(".claude"));
        let windows = PathBuf::from(r"C:\Users\jt");
        assert_eq!(
            expand_home("~/.claude-account2", Some(&windows)),
            windows.join(".claude-account2")
        );
        assert_eq!(
            expand_home(r"~\.claude", Some(&windows)),
            windows.join(".claude")
        );
        assert_eq!(expand_home("~", Some(&windows)), windows);
    }

    #[test]
    fn a_missing_folder_is_reported_and_not_created() {
        let home = temp_home("missing");
        let info = resolve_with(None, Some("~/.claude-nope"), Some(&home));
        assert!(!info.exists);
        assert!(!home.join(".claude-nope").exists(), "never created");
        assert_eq!(
            info.missing_message().unwrap(),
            format!(
                "Claude config folder not found: {}",
                home.join(".claude-nope").display()
            )
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn old_settings_without_the_key_resolve_to_dot_claude() {
        let parsed: crate::store::settings_store::SettingsFile =
            serde_json::from_str(r#"{"schemaVersion":1}"#).unwrap();
        let info = resolve_with(
            None,
            parsed.providers.claude.config_dir.as_deref(),
            Some(Path::new("/Users/jt")),
        );
        assert_eq!(info.source, ConfigDirSource::Default);
        assert_eq!(info.path, "/Users/jt/.claude");
    }

    #[test]
    fn claude_env_overrides_an_inherited_claude_config_dir() {
        let info = resolve_with(None, Some("/x/account2"), None);
        assert_eq!(
            claude_env(&info),
            vec![(CLAUDE_CONFIG_DIR.to_string(), "/x/account2".to_string())]
        );
        #[cfg(unix)]
        {
            let mut command = std::process::Command::new("sh");
            command
                .arg("-c")
                .arg("printf %s \"$CLAUDE_CONFIG_DIR\"")
                .env(CLAUDE_CONFIG_DIR, "/inherited/.claude");
            apply_claude_env(&mut command, &info);
            let out = command.output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), "/x/account2");
        }
    }
}
