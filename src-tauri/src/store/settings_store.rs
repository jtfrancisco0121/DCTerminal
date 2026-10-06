//! App settings that are not roles or tabs. The permission-capture toggle
//! lives here and defaults to off.

use crate::store::json_io::{read_json_or_recover, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSettings {
    #[serde(default)]
    pub capture_permission_payloads: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    pub schema_version: u32,
    #[serde(default)]
    pub diagnostics: DiagnosticsSettings,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            diagnostics: DiagnosticsSettings::default(),
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
