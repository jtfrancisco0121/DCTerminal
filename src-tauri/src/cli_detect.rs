use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDetectResult {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Resolve the `agent` executable (FR-001). Settings override is T1.4 / settings.json.
pub fn resolve_agent_executable() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("DCT_AGENT_PATH") {
        let path = PathBuf::from(override_path);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Some(path) = find_on_path("agent") {
        return Some(path);
    }

    known_install_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

pub fn agent_missing_message() -> String {
    "Cursor CLI (agent) was not found. Install it from https://cursor.com/docs/cli/installation, \
     add it to PATH (on Windows the shim is often %LOCALAPPDATA%\\cursor-agent\\agent.cmd), \
     or set DCT_AGENT_PATH to the executable. Then run `agent login` in a terminal."
        .to_string()
}

pub fn detect_agent() -> CliDetectResult {
    match resolve_agent_executable() {
        Some(path) => {
            let version = read_agent_version(&path);
            CliDetectResult {
                found: true,
                path: Some(path.display().to_string()),
                version,
                error: None,
            }
        }
        None => CliDetectResult {
            found: false,
            path: None,
            version: None,
            error: Some(agent_missing_message()),
        },
    }
}

#[tauri::command]
pub fn detect_cli() -> CliDetectResult {
    detect_agent()
}

fn read_agent_version(agent: &Path) -> Option<String> {
    let output = Command::new(agent).arg("--version").output();
    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if stderr.is_empty() {
                None
            } else {
                Some(stderr)
            }
        }
        Err(_) => None,
    }
}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for candidate in candidate_names(binary) {
            let full = dir.join(&candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

fn candidate_names(binary: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let mut names = Vec::new();
        if let Ok(pathext) = std::env::var("PATHEXT") {
            for ext in pathext.split(';') {
                let ext = ext.trim();
                if ext.is_empty() {
                    continue;
                }
                let ext = if ext.starts_with('.') {
                    ext.to_string()
                } else {
                    format!(".{}", ext)
                };
                names.push(format!("{}{}", binary, ext));
            }
        }
        names.push(format!("{}.exe", binary));
        names.push(format!("{}.cmd", binary));
        names.push(binary.to_string());
        names
    }
    #[cfg(not(windows))]
    {
        vec![binary.to_string()]
    }
}

pub fn known_install_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local)
                    .join("cursor-agent")
                    .join("agent.cmd"),
            );
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(PathBuf::from(home).join(".local").join("bin").join("agent"));
        }
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_windows_candidate_points_at_cursor_agent_shim() {
        #[cfg(windows)]
        {
            let candidates = known_install_candidates();
            assert!(
                candidates
                    .iter()
                    .any(|p| p.to_string_lossy().contains("cursor-agent")),
                "expected cursor-agent install candidate"
            );
        }
    }

    #[test]
    fn resolves_agent_when_on_path() {
        let result = detect_agent();
        // Developer machines with Cursor CLI should find it; CI may not.
        if result.found {
            assert!(result.path.is_some());
            assert!(result.version.is_some());
        }
    }
}
