//! App settings that are not roles or tabs. The permission-capture toggle
//! lives here and defaults to off.

use crate::provider::ProviderId;
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

/// Claude's account default. Phase 5 adds the Claude model list.
pub const CLAUDE_DEFAULT_MODEL_ID: &str = "default";

impl ModelSettings {
    pub fn claude_default() -> Self {
        Self {
            default_model: CLAUDE_DEFAULT_MODEL_ID.to_string(),
            role_models: HashMap::new(),
        }
    }
}

/// Model choices per provider. A `settings.json` from before providers
/// existed has one flat `models` object; it is read as `models.cursor`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModels {
    pub cursor: ModelSettings,
    pub claude: ModelSettings,
}

impl Default for ProviderModels {
    fn default() -> Self {
        Self {
            cursor: ModelSettings::default(),
            claude: ModelSettings::claude_default(),
        }
    }
}

impl<'de> Deserialize<'de> for ProviderModels {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(deserializer)?;
        let Some(obj) = value.as_object() else {
            return Ok(Self::default());
        };
        let per_provider = obj.contains_key("cursor") || obj.contains_key("claude");
        if !per_provider {
            // Legacy flat shape: `{ defaultModel, roleModels }` → Cursor.
            let cursor: ModelSettings = serde_json::from_value(value).map_err(D::Error::custom)?;
            return Ok(Self {
                cursor,
                claude: ModelSettings::claude_default(),
            });
        }
        let cursor = match obj.get("cursor") {
            Some(v) => serde_json::from_value(v.clone()).map_err(D::Error::custom)?,
            None => ModelSettings::default(),
        };
        let claude = match obj.get("claude") {
            Some(v) => {
                let mut parsed: ModelSettings =
                    serde_json::from_value(v.clone()).map_err(D::Error::custom)?;
                if v.get("defaultModel").is_none() {
                    parsed.default_model = CLAUDE_DEFAULT_MODEL_ID.to_string();
                }
                parsed
            }
            None => ModelSettings::claude_default(),
        };
        Ok(Self { cursor, claude })
    }
}

fn default_provider() -> ProviderId {
    ProviderId::DEFAULT
}

/// Claude Code paths. `config_dir` is the Claude config folder passed to
/// every Claude process as `CLAUDE_CONFIG_DIR` (unset → `~/.claude`;
/// `DCT_CLAUDE_CONFIG_DIR` overrides it). Never created or written by
/// DCTerminal.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProviderSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorProviderSettings {}

/// `providers` in `settings.json`: default provider for new tabs (Claude for
/// new and existing profiles), the Start card's per-role provider choice, and
/// per-provider settings. No bypass toggle: every role runs with full
/// permissions (Decision 4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersSettings {
    #[serde(default = "default_provider")]
    pub default: ProviderId,
    /// Role id → `claude` | `cursor`, remembered by the Start card chip.
    #[serde(default)]
    pub role_provider: HashMap<String, String>,
    #[serde(default)]
    pub claude: ClaudeProviderSettings,
    #[serde(default)]
    pub cursor: CursorProviderSettings,
}

impl Default for ProvidersSettings {
    fn default() -> Self {
        Self {
            default: ProviderId::DEFAULT,
            role_provider: HashMap::new(),
            claude: ClaudeProviderSettings::default(),
            cursor: CursorProviderSettings::default(),
        }
    }
}

const MAX_SETTING_PATH_CHARS: usize = 1024;

/// Trimmed path, `None` when empty. Rejects newlines and NUL.
fn clean_optional_path(value: Option<String>, what: &str) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.contains(['\n', '\r', '\0']) {
        return Err(format!("{what} cannot contain a newline"));
    }
    if trimmed.chars().count() > MAX_SETTING_PATH_CHARS {
        return Err(format!("{what} is too long"));
    }
    Ok(Some(trimmed.to_string()))
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

/// U7/U8 look and feel: colour theme, the optional shortcut bar, and which
/// one-time tips were dismissed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub shortcut_bar: bool,
    #[serde(default)]
    pub tips_seen: Vec<String>,
    /// U2: scratch pad editor height in px; 0 keeps the 3-row default.
    #[serde(default)]
    pub pad_height: u32,
    /// U2: scratch pad hidden (shared by chat and terminal tabs).
    #[serde(default)]
    pub pad_hidden: bool,
}

pub const UI_THEMES: &[&str] = &["github-dark", "github-light"];
const TIPS_SEEN_LIMIT: usize = 50;
const PAD_MIN_HEIGHT: u32 = 40;
const PAD_MAX_HEIGHT: u32 = 600;

fn default_theme() -> String {
    UI_THEMES[0].to_string()
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            shortcut_bar: false,
            tips_seen: Vec::new(),
            pad_height: 0,
            pad_hidden: false,
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
    pub models: ProviderModels,
    #[serde(default)]
    pub providers: ProvidersSettings,
    #[serde(default)]
    pub notifications: NotificationSettings,
    #[serde(default)]
    pub setup: SetupSettings,
    #[serde(default)]
    pub ui: UiSettings,
}

/// F8: first-run setup was finished or skipped.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetupSettings {
    #[serde(default)]
    pub completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            diagnostics: DiagnosticsSettings::default(),
            terminal: TerminalSettings::default(),
            models: ProviderModels::default(),
            providers: ProvidersSettings::default(),
            notifications: NotificationSettings::default(),
            setup: SetupSettings::default(),
            ui: UiSettings::default(),
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
    /// Cursor model settings (the only ones used until Claude models land
    /// in Phase 5).
    pub fn models(&self) -> &ModelSettings {
        &self.data.models.cursor
    }

    pub fn models_for(&self, provider: ProviderId) -> &ModelSettings {
        match provider {
            ProviderId::Cursor => &self.data.models.cursor,
            ProviderId::Claude => &self.data.models.claude,
        }
    }

    /// Tab override, then the role default, then the global default.
    pub fn effective_model(&self, role_id: &str, tab_model: Option<&str>) -> String {
        crate::models::effective_model(&self.data.models.cursor, role_id, tab_model)
    }

    pub fn set_models(&mut self, next: ModelSettings) -> Result<(), String> {
        self.set_models_for(ProviderId::Cursor, next)
    }

    /// Save one provider's model choices. Claude ids are checked with
    /// `is_claude_model_id` so a Cursor id cannot become the Claude default.
    pub fn set_models_for(
        &mut self,
        provider: ProviderId,
        mut next: ModelSettings,
    ) -> Result<(), String> {
        let claude = provider == ProviderId::Claude;
        let valid = |id: &str| {
            if claude {
                crate::models::is_claude_model_id(id)
            } else {
                crate::models::valid_model_id(id)
            }
        };
        next.default_model = next.default_model.trim().to_string();
        if !valid(&next.default_model) {
            next.default_model = if claude {
                CLAUDE_DEFAULT_MODEL_ID.to_string()
            } else {
                default_model_id()
            };
        }
        next.role_models = next
            .role_models
            .into_iter()
            .map(|(role, model)| (role, model.trim().to_string()))
            .filter(|(role, model)| !role.trim().is_empty() && valid(model))
            .collect();
        match provider {
            ProviderId::Cursor => self.data.models.cursor = next,
            ProviderId::Claude => self.data.models.claude = next,
        }
        self.save()
    }
}

impl SettingsStore {
    pub fn providers(&self) -> &ProvidersSettings {
        &self.data.providers
    }

    pub fn default_provider(&self) -> ProviderId {
        self.data.providers.default
    }

    /// Start card choice for a role, else the default provider.
    pub fn provider_for_role(&self, role_id: &str) -> ProviderId {
        self.data
            .providers
            .role_provider
            .get(role_id)
            .and_then(|value| ProviderId::parse(value))
            .unwrap_or(self.data.providers.default)
    }

    /// Paths are trimmed; an empty path clears the setting. Unknown per-role
    /// values are dropped.
    pub fn set_providers(&mut self, mut next: ProvidersSettings) -> Result<(), String> {
        next.claude.config_dir =
            clean_optional_path(next.claude.config_dir.take(), "Claude config folder")?;
        next.claude.claude_path = clean_optional_path(next.claude.claude_path.take(), "claude path")?;
        next.claude.adapter_path =
            clean_optional_path(next.claude.adapter_path.take(), "claude-agent-acp path")?;
        next.role_provider = next
            .role_provider
            .into_iter()
            .filter_map(|(role, value)| {
                let role = role.trim().to_string();
                let id = ProviderId::parse(&value)?;
                (!role.is_empty()).then(|| (role, id.as_str().to_string()))
            })
            .collect();
        self.data.providers = next;
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

impl SettingsStore {
    pub fn setup_completed(&self) -> bool {
        self.data.setup.completed
    }

    pub fn mark_setup_complete(&mut self, now: &str) -> Result<(), String> {
        self.data.setup = SetupSettings {
            completed: true,
            completed_at: Some(now.to_string()),
        };
        self.save()
    }
}

impl SettingsStore {
    pub fn ui(&self) -> &UiSettings {
        &self.data.ui
    }

    /// Unknown themes fall back to GitHub Dark; tip ids are trimmed,
    /// de-duplicated, and capped.
    pub fn set_ui(&mut self, next: UiSettings) -> Result<(), String> {
        let theme = if UI_THEMES.contains(&next.theme.as_str()) {
            next.theme
        } else {
            default_theme()
        };
        let mut tips_seen: Vec<String> = Vec::new();
        for tip in next.tips_seen {
            let tip = tip.trim().to_string();
            if !tip.is_empty() && tip.len() <= 64 && !tips_seen.contains(&tip) {
                tips_seen.push(tip);
            }
        }
        tips_seen.truncate(TIPS_SEEN_LIMIT);
        let pad_height = match next.pad_height {
            0 => 0,
            h => h.clamp(PAD_MIN_HEIGHT, PAD_MAX_HEIGHT),
        };
        self.data.ui = UiSettings {
            theme,
            shortcut_bar: next.shortcut_bar,
            tips_seen,
            pad_height,
            pad_hidden: next.pad_hidden,
        };
        self.save()
    }
}

/// F8: show first-run setup only on a fresh profile. An existing profile
/// (a tab with a folder, a running or terminal tab, or closed tabs) counts as
/// set up even without the flag, so upgrades are not interrupted.
pub fn first_run_needed(completed: bool, state: &crate::store::AppStateFile) -> bool {
    if completed || !state.closed_tabs.is_empty() {
        return false;
    }
    !state
        .tabs
        .iter()
        .any(|tab| !tab.cwd.trim().is_empty() || tab.kind == "terminal" || tab.session.is_some())
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

/// Read the U7/U8 look-and-feel settings.
#[tauri::command]
pub fn get_ui_settings(
    settings: tauri::State<std::sync::Mutex<SettingsStore>>,
) -> Result<UiSettings, String> {
    let settings = settings.lock().map_err(|err| err.to_string())?;
    Ok(settings.ui().clone())
}

/// Save theme, shortcut bar, and dismissed tips (app data `settings.json`).
#[tauri::command]
pub fn set_ui_settings(
    ui: UiSettings,
    settings: tauri::State<std::sync::Mutex<SettingsStore>>,
) -> Result<UiSettings, String> {
    let mut settings = settings.lock().map_err(|err| err.to_string())?;
    settings.set_ui(ui)?;
    Ok(settings.ui().clone())
}

fn is_run_mode(value: &str) -> bool {
    matches!(value, "default" | "yolo" | "auto-review" | "plan" | "ask")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn ui_settings_default_to_github_dark_and_clean_input() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_ui_{nanos}"));
        let mut store = SettingsStore::open(&dir).unwrap();
        assert_eq!(store.ui().theme, "github-dark");
        assert!(!store.ui().shortcut_bar);
        assert!(store.ui().tips_seen.is_empty());
        store
            .set_ui(UiSettings {
                theme: "no-such-theme".into(),
                shortcut_bar: true,
                tips_seen: vec!["palette".into(), "palette".into(), " ".into(), "pad".into()],
                pad_height: 5000,
                pad_hidden: true,
            })
            .unwrap();
        assert_eq!(store.ui().theme, "github-dark");
        assert_eq!(store.ui().tips_seen, vec!["palette", "pad"]);
        assert_eq!(store.ui().pad_height, 600);
        assert!(store.ui().pad_hidden);
        store
            .set_ui(UiSettings {
                theme: "github-light".into(),
                ..store.ui().clone()
            })
            .unwrap();
        let again = SettingsStore::open(&dir).unwrap();
        assert_eq!(again.ui().theme, "github-light");
        assert!(again.ui().shortcut_bar);
        let old: SettingsFile =
            serde_json::from_value(serde_json::json!({ "schemaVersion": 1 })).unwrap();
        assert_eq!(old.ui, UiSettings::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn setup_flag_defaults_off_and_persists() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_setup_{nanos}"));
        let mut store = SettingsStore::open(&dir).unwrap();
        assert!(!store.setup_completed());
        store.mark_setup_complete("2026-10-06T00:00:00Z").unwrap();
        let again = SettingsStore::open(&dir).unwrap();
        assert!(again.setup_completed());
        assert_eq!(
            again.data.setup.completed_at.as_deref(),
            Some("2026-10-06T00:00:00Z")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn first_run_is_only_for_a_fresh_profile() {
        use crate::store::AppStateFile;
        let fresh = AppStateFile::default();
        assert!(first_run_needed(false, &fresh));
        assert!(!first_run_needed(true, &fresh));

        let mut seeded: AppStateFile = serde_json::from_value(serde_json::json!({
            "schemaVersion": fresh.schema_version,
            "tabs": [{
                "id": "tab_1", "label": "New · Developer", "roleId": "role_developer",
                "roleSnapshot": {"name": "Developer", "templateVersion": 1, "mode": "agent", "injection": "send_on_start"},
                "cwd": "", "answers": {}, "mergedPrompt": "", "mergedPromptHash": "",
                "phase": "draft", "order": 1, "createdAt": "2026-10-06T00:00:00Z"
            }]
        }))
        .unwrap();
        assert!(
            first_run_needed(false, &seeded),
            "the blank seed tab is still fresh"
        );
        seeded.tabs[0].cwd = "/Users/jt/Koneksi".into();
        assert!(
            !first_run_needed(false, &seeded),
            "an existing profile with a folder"
        );
        seeded.tabs[0].cwd = String::new();
        seeded.tabs[0].kind = "terminal".into();
        assert!(!first_run_needed(false, &seeded));
    }

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
        assert_eq!(parsed.models.cursor.default_model, "composer-2.5");
    }
}
