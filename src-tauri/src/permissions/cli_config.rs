//! Read-only inspection of Cursor CLI `cli-config.json` approvalMode.
//!
//! DCTerminal never writes this file and never overrides the user's global
//! setting. Honor `CURSOR_CONFIG_DIR` when set (the directory that contains
//! `cli-config.json`). Otherwise read `~/.cursor/cli-config.json`.

use crate::cursor_history::cursor_home;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalModeKind {
    Unrestricted,
    Allowlist,
    Other,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalModeStatus {
    pub kind: ApprovalModeKind,
    /// Raw `approvalMode` string when present.
    pub approval_mode: Option<String>,
    pub config_path: Option<String>,
    /// True when role permission rules cannot fire because the CLI never
    /// sends `session/request_permission`.
    pub role_rules_off: bool,
    /// Human-readable note for Settings (allowlist gap, unknown, etc.).
    pub note: Option<String>,
}

/// Resolve the path we would read. Never creates directories or files.
pub fn cli_config_path() -> Option<PathBuf> {
    resolve_cli_config_path(
        std::env::var_os("CURSOR_CONFIG_DIR").as_deref(),
        cursor_home().as_deref(),
    )
}

pub fn resolve_cli_config_path(
    cursor_config_dir: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(dir) = cursor_config_dir {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("cli-config.json"));
        }
    }
    home.map(|h| h.join(".cursor").join("cli-config.json"))
}

/// Read the file if present. Missing or unparseable → Unknown (no scary warning).
pub fn read_approval_mode() -> ApprovalModeStatus {
    let Some(path) = cli_config_path() else {
        eprintln!("DCTerminal: Cursor cli-config path unknown (no home / CURSOR_CONFIG_DIR)");
        return ApprovalModeStatus {
            kind: ApprovalModeKind::Unknown,
            approval_mode: None,
            config_path: None,
            role_rules_off: false,
            note: Some("Cursor CLI approval mode could not be determined.".to_string()),
        };
    };
    read_approval_mode_at(&path)
}

pub fn read_approval_mode_at(path: &Path) -> ApprovalModeStatus {
    let display = path.display().to_string();
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => status_from_value(&value, Some(display)),
            Err(err) => {
                eprintln!("DCTerminal: could not parse {display}: {err}");
                ApprovalModeStatus {
                    kind: ApprovalModeKind::Unknown,
                    approval_mode: None,
                    config_path: Some(display),
                    role_rules_off: false,
                    note: Some("Cursor CLI approval mode could not be parsed.".to_string()),
                }
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => ApprovalModeStatus {
            kind: ApprovalModeKind::Unknown,
            approval_mode: None,
            config_path: Some(display),
            role_rules_off: false,
            note: None,
        },
        Err(err) => {
            eprintln!("DCTerminal: could not read {display}: {err}");
            ApprovalModeStatus {
                kind: ApprovalModeKind::Unknown,
                approval_mode: None,
                config_path: Some(display),
                role_rules_off: false,
                note: Some("Cursor CLI approval mode could not be read.".to_string()),
            }
        }
    }
}

pub fn status_from_value(value: &Value, config_path: Option<String>) -> ApprovalModeStatus {
    let raw = extract_approval_mode(value);
    let kind = classify_approval_mode(raw.as_deref());
    // Role rules are retired. approvalMode is still read so Settings can
    // show it; it no longer turns a warning on.
    let role_rules_off = false;
    let note = match kind {
        ApprovalModeKind::Unrestricted => Some(
            "Cursor CLI approvalMode is unrestricted. DCTerminal still answers allow-once and does not write project settings."
                .to_string(),
        ),
        ApprovalModeKind::Allowlist => Some(
            "Cursor CLI approvalMode is allowlist. DCTerminal still answers any permission request it receives with allow-once."
                .to_string(),
        ),
        ApprovalModeKind::Other => Some(format!(
            "Cursor CLI approvalMode is `{}`. DCTerminal still answers any permission requests it receives.",
            raw.as_deref().unwrap_or("?")
        )),
        ApprovalModeKind::Unknown => None,
    };
    ApprovalModeStatus {
        kind,
        approval_mode: raw,
        config_path,
        role_rules_off,
        note,
    }
}

fn extract_approval_mode(value: &Value) -> Option<String> {
    value
        .get("approvalMode")
        .or_else(|| value.get("approval_mode"))
        .or_else(|| {
            value
                .get("permissions")
                .and_then(|p| p.get("approvalMode").or_else(|| p.get("approval_mode")))
        })
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn classify_approval_mode(raw: Option<&str>) -> ApprovalModeKind {
    let Some(raw) = raw else {
        return ApprovalModeKind::Unknown;
    };
    let normalized = raw.trim().to_ascii_lowercase().replace([' ', '_'], "-");
    match normalized.as_str() {
        "unrestricted" | "yolo" | "run-everything" | "runeverything" | "force" => {
            ApprovalModeKind::Unrestricted
        }
        "allowlist" | "allow-list" | "allow" => ApprovalModeKind::Allowlist,
        _ => ApprovalModeKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn classifies_unrestricted_aliases() {
        for raw in ["unrestricted", "yolo", "Run Everything", "run_everything"] {
            assert_eq!(
                classify_approval_mode(Some(raw)),
                ApprovalModeKind::Unrestricted,
                "{raw}"
            );
        }
        assert_eq!(
            classify_approval_mode(Some("allowlist")),
            ApprovalModeKind::Allowlist
        );
        assert_eq!(classify_approval_mode(None), ApprovalModeKind::Unknown);
    }

    #[test]
    fn parses_fixture_configs() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/acp/permissions");
        let unrestricted = status_from_value(
            &serde_json::from_str(
                &std::fs::read_to_string(dir.join("cli-config-unrestricted.json")).unwrap(),
            )
            .unwrap(),
            Some("fixture".into()),
        );
        assert_eq!(unrestricted.kind, ApprovalModeKind::Unrestricted);
        assert!(!unrestricted.role_rules_off);
        assert!(unrestricted
            .note
            .as_deref()
            .unwrap()
            .contains("allow-once"));

        let allowlist = status_from_value(
            &serde_json::from_str(
                &std::fs::read_to_string(dir.join("cli-config-allowlist.json")).unwrap(),
            )
            .unwrap(),
            Some("fixture".into()),
        );
        assert_eq!(allowlist.kind, ApprovalModeKind::Allowlist);
        assert!(!allowlist.role_rules_off);
        assert!(allowlist
            .note
            .as_deref()
            .unwrap()
            .contains("allow-once"));
    }

    #[test]
    fn missing_file_is_unknown_without_scary_note() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dct_missing_cli_config_{nanos}.json"));
        let status = read_approval_mode_at(&path);
        assert_eq!(status.kind, ApprovalModeKind::Unknown);
        assert!(!status.role_rules_off);
        assert!(status.note.is_none());
    }

    #[test]
    fn honors_cursor_config_dir_over_home() {
        let path = resolve_cli_config_path(
            Some(std::ffi::OsStr::new("/tmp/dct-cfg")),
            Some(Path::new("/home/someone")),
        );
        assert_eq!(path.unwrap(), PathBuf::from("/tmp/dct-cfg/cli-config.json"));
    }

    #[test]
    fn nested_permissions_approval_mode() {
        let status = status_from_value(
            &json!({ "permissions": { "approvalMode": "allowlist" } }),
            None,
        );
        assert_eq!(status.kind, ApprovalModeKind::Allowlist);
    }
}
