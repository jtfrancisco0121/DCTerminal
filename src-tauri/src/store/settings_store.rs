//! App settings that are not roles or tabs. The permission-capture toggle
//! lives here and defaults to off.

use crate::store::json_io::{read_json_or_recover, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSettings {
    #[serde(default)]
    pub capture_permission_payloads: bool,
}

fn default_font_size() -> u32 {
    14
}

/// Shell program, terminal font, and per-role terminal choices.
/// `role_surface` is `chat` or `terminal`. `role_run_mode` is
/// `default`, `yolo`, `auto-review`, `plan`, or `ask`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default)]
    pub shell: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default)]
    pub role_surface: HashMap<String, String>,
    #[serde(default)]
    pub role_run_mode: HashMap<String, String>,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            shell: String::new(),
            font_size: default_font_size(),
            role_surface: HashMap::new(),
            role_run_mode: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    pub schema_version: u32,
    #[serde(default)]
    pub diagnostics: DiagnosticsSettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            diagnostics: DiagnosticsSettings::default(),
            terminal: TerminalSettings::default(),
        }
    }
}

pub struct SettingsStore {
    pub path: PathBuf,
    pub data: SettingsFile,
    pub last_capture_error: Option<String>,
}

impl SettingsStore {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("settings dir: {e}"))?;
        let path = dir.join("settings.json");
        let mut data = read_json_or_recover::<SettingsFile>(&path)?;
        if data.schema_version > SETTINGS_SCHEMA_VERSION {
            data = SettingsFile::default();
        }
        data.schema_version = SETTINGS_SCHEMA_VERSION;
        Ok(Self {
            path,
            data,
            last_capture_error: None,
        })
    }

    pub fn save(&self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    pub fn capture_enabled(&self) -> bool {
        self.data.diagnostics.capture_permission_payloads
    }

    pub fn set_capture(&mut self, enabled: bool) -> Result<(), String> {
        self.data.diagnostics.capture_permission_payloads = enabled;
        self.save()
    }

    pub fn terminal(&self) -> &TerminalSettings {
        &self.data.terminal
    }

    pub fn run_mode_for(&self, role_id: &str) -> String {
        self.data
            .terminal
            .role_run_mode
            .get(role_id)
            .cloned()
            .filter(|mode| is_run_mode(mode))
            .unwrap_or_else(|| "default".to_string())
    }

    pub fn set_terminal(&mut self, mut next: TerminalSettings) -> Result<(), String> {
        next.shell = next.shell.trim().chars().take(400).collect();
        if next.shell.contains(['\n', '\r']) {
            return Err("shell path cannot contain a newline".to_string());
        }
        next.font_size = next.font_size.clamp(8, 32);
        next.role_surface.retain(|_, value| value == "chat" || value == "terminal");
        next.role_run_mode.retain(|_, value| is_run_mode(value));
        self.data.terminal = next;
        self.save()
    }
}

fn is_run_mode(value: &str) -> bool {
    matches!(
        value,
        "default" | "yolo" | "auto-review" | "plan" | "ask"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn capture_defaults_off_and_persists() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_settings_{nanos}"));
        let mut store = SettingsStore::open(&dir).unwrap();
        assert!(!store.capture_enabled());
        store.set_capture(true).unwrap();
        let again = SettingsStore::open(&dir).unwrap();
        assert!(again.capture_enabled());
        let _ = std::fs::remove_dir_all(dir);
    }
}
