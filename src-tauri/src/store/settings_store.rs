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

/// Model choices. `default_model` applies to every tab unless the tab's role
/// has an entry in `role_models`, or the tab has its own override.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    #[serde(default = "default_model_id")]
    pub default_model: String,
    #[serde(default)]
    pub role_models: HashMap<String, String>,
}

fn default_model_id() -> String {
    crate::models::DEFAULT_MODEL_ID.to_string()
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            default_model: default_model_id(),
            role_models: HashMap::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

/// F1 agent notifications. Everything defaults on; a settings file from
/// before this section existed loads with the defaults.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    /// Master switch.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// OS notification while the window is not focused.
    #[serde(default = "default_true")]
    pub system: bool,
    /// In-app toast for background tabs while the window is focused.
    #[serde(default = "default_true")]
    pub toast_when_focused: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            system: true,
            toast_when_focused: true,
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
    #[serde(default)]
    pub models: ModelSettings,
    #[serde(default)]
    pub notifications: NotificationSettings,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            diagnostics: DiagnosticsSettings::default(),
            terminal: TerminalSettings::default(),
            models: ModelSettings::default(),
            notifications: NotificationSettings::default(),
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
        next.role_surface
            .retain(|_, value| value == "chat" || value == "terminal");
        next.role_run_mode.retain(|_, value| is_run_mode(value));
        self.data.terminal = next;
        self.save()
    }
}

impl SettingsStore {
    pub fn models(&self) -> &ModelSettings {
        &self.data.models
    }

    /// Tab override, then the role default, then the global default.
    pub fn effective_model(&self, role_id: &str, tab_model: Option<&str>) -> String {
        crate::models::effective_model(&self.data.models, role_id, tab_model)
    }

    pub fn set_models(&mut self, mut next: ModelSettings) -> Result<(), String> {
        next.default_model = next.default_model.trim().to_string();
        if !crate::models::valid_model_id(&next.default_model) {
            next.default_model = default_model_id();
        }
        next.role_models = next
            .role_models
            .into_iter()
            .map(|(role, model)| (role, model.trim().to_string()))
            .filter(|(role, model)| !role.trim().is_empty() && crate::models::valid_model_id(model))
            .collect();
        self.data.models = next;
        self.save()
    }
}

impl SettingsStore {
    pub fn notifications(&self) -> &NotificationSettings {
        &self.data.notifications
    }

    pub fn set_notifications(&mut self, next: NotificationSettings) -> Result<(), String> {
        self.data.notifications = next;
        self.save()
    }
}

/// Read the F1 notification toggles.
#[tauri::command]
pub fn get_notification_settings(
    settings: tauri::State<std::sync::Mutex<SettingsStore>>,
) -> Result<NotificationSettings, String> {
    let settings = settings.lock().map_err(|err| err.to_string())?;
    Ok(settings.notifications().clone())
}

/// Save the F1 notification toggles (app data `settings.json`).
#[tauri::command]
pub fn set_notification_settings(
    notifications: NotificationSettings,
    settings: tauri::State<std::sync::Mutex<SettingsStore>>,
) -> Result<NotificationSettings, String> {
    let mut settings = settings.lock().map_err(|err| err.to_string())?;
    settings.set_notifications(notifications)?;
    Ok(settings.notifications().clone())
}

fn is_run_mode(value: &str) -> bool {
    matches!(value, "default" | "yolo" | "auto-review" | "plan" | "ask")
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

    #[test]
    fn model_defaults_to_composer_and_drops_bad_ids() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_models_{nanos}"));
        let mut store = SettingsStore::open(&dir).unwrap();
        assert_eq!(store.models().default_model, "composer-2.5");
        assert_eq!(store.effective_model("role_planner", None), "composer-2.5");
        store
            .set_models(ModelSettings {
                default_model: "--yolo".to_string(),
                role_models: HashMap::from([
                    ("role_planner".to_string(), "gpt-5".to_string()),
                    ("role_general".to_string(), "bad id".to_string()),
                ]),
            })
            .unwrap();
        let again = SettingsStore::open(&dir).unwrap();
        assert_eq!(again.models().default_model, "composer-2.5");
        assert_eq!(again.effective_model("role_planner", None), "gpt-5");
        assert_eq!(again.effective_model("role_general", None), "composer-2.5");
        assert_eq!(
            again.effective_model("role_planner", Some("sonnet-4.5")),
            "sonnet-4.5"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn notifications_default_on_and_persist() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_notify_{nanos}"));
        let mut store = SettingsStore::open(&dir).unwrap();
        assert_eq!(store.notifications(), &NotificationSettings::default());
        assert!(store.notifications().enabled);
        store
            .set_notifications(NotificationSettings {
                enabled: false,
                system: true,
                toast_when_focused: false,
            })
            .unwrap();
        let again = SettingsStore::open(&dir).unwrap();
        assert!(!again.notifications().enabled);
        assert!(again.notifications().system);
        assert!(!again.notifications().toast_when_focused);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_without_notifications_section_default_on() {
        let raw = r#"{"schemaVersion":1,"notifications":{"system":false}}"#;
        let parsed: SettingsFile = serde_json::from_str(raw).unwrap();
        assert!(parsed.notifications.enabled);
        assert!(!parsed.notifications.system);
        assert!(parsed.notifications.toast_when_focused);
        let bare: SettingsFile = serde_json::from_str(r#"{"schemaVersion":1}"#).unwrap();
        assert_eq!(bare.notifications, NotificationSettings::default());
        let json = serde_json::to_value(&bare.notifications).unwrap();
        assert_eq!(json["toastWhenFocused"], serde_json::json!(true));
    }

    #[test]
    fn settings_without_models_section_still_load() {
        let raw = r#"{"schemaVersion":1,"terminal":{"shell":"","fontSize":14}}"#;
        let parsed: SettingsFile = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.models.default_model, "composer-2.5");
    }
}
