use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const STATE_SCHEMA_VERSION: u32 = 1;
pub const MAIN_WINDOW_ID: &str = "main";

pub fn default_window_id() -> String {
    MAIN_WINDOW_ID.to_string()
}

/// A tab belongs to `window_id`. Blank ids are the original window.
pub fn window_matches(tab_window: &str, window_id: &str) -> bool {
    let tab_window = if tab_window.trim().is_empty() {
        MAIN_WINDOW_ID
    } else {
        tab_window
    };
    let window_id = if window_id.trim().is_empty() {
        MAIN_WINDOW_ID
    } else {
        window_id
    };
    tab_window == window_id
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateFile {
    pub schema_version: u32,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<TabRecord>,
    #[serde(default)]
    pub closed_tabs: Vec<ClosedTabRecord>,
    #[serde(default)]
    pub layout: LayoutState,
    #[serde(default)]
    pub pipeline_runs: Vec<PipelineRun>,
    /// One-time migrations. Missing on old files, so `claude_first` starts false.
    #[serde(default)]
    pub migrations: Migrations,
    /// Windows and the Claude account each one uses. Missing on old files.
    #[serde(default)]
    pub windows: Vec<WindowRecord>,
}

/// One top-level window bound to a Claude account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowRecord {
    pub id: String,
    /// `providers.claude.accounts[].id`.
    pub account_id: String,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub layout: LayoutState,
}

/// Eagle-Eye position on a tab or a hand-off (Phase 9).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChainRef {
    pub chain_id: String,
    /// `eagle1` or `eagle2`.
    pub kind: String,
    pub step: u32,
    pub total: u32,
}

/// Flags for one-time data migrations. `Default` is all false so an old
/// file that omits the object still migrates. A brand-new file sets
/// `claude_first` itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Migrations {
    #[serde(default)]
    pub claude_first: bool,
    /// Tabs and layout moved onto per-window records.
    #[serde(default)]
    pub windows: bool,
}

/// Linked multi-tab pipeline (eagle-eye overview + stage worker tabs).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRun {
    pub id: String,
    /// `full` (plan + review) or `execute` (approved plan only).
    pub kind: String,
    pub cwd: String,
    /// Coarse stage id, e.g. `planner`, `plan_reviewer`, `implementer`, `pr_reviewer`.
    pub stage: String,
    /// Overview tab id for this run.
    pub overview_tab_id: String,
    /// `role_id` → worker tab id.
    pub tab_ids: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_request: Option<String>,
    pub created_at: String,
}

/// Split view and file panel. Restored on relaunch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutState {
    /// `single`, `horizontal`, or `vertical`.
    #[serde(default = "default_split_mode")]
    pub split_mode: String,
    #[serde(default)]
    pub secondary_tab_id: Option<String>,
    /// Size of the main pane, in percent.
    #[serde(default = "default_split_size")]
    pub primary_size: f64,
    #[serde(default)]
    pub file_panel_open: bool,
    /// File panel width, in pixels.
    #[serde(default = "default_file_panel_width")]
    pub file_panel_width: f64,
}

fn default_split_mode() -> String {
    "single".to_string()
}

fn default_split_size() -> f64 {
    50.0
}

fn default_file_panel_width() -> f64 {
    280.0
}

impl Default for LayoutState {
    fn default() -> Self {
        Self {
            split_mode: default_split_mode(),
            secondary_tab_id: None,
            primary_size: default_split_size(),
            file_panel_open: false,
            file_panel_width: default_file_panel_width(),
        }
    }
}

impl LayoutState {
    pub fn sanitized(mut self) -> Self {
        if !matches!(
            self.split_mode.as_str(),
            "single" | "horizontal" | "vertical"
        ) {
            self.split_mode = default_split_mode();
        }
        if self.split_mode == "single" {
            self.secondary_tab_id = None;
        }
        if self.secondary_tab_id.is_none() {
            self.split_mode = default_split_mode();
        }
        if !self.primary_size.is_finite() {
            self.primary_size = default_split_size();
        }
        self.primary_size = self.primary_size.clamp(15.0, 85.0);
        if !self.file_panel_width.is_finite() {
            self.file_panel_width = default_file_panel_width();
        }
        self.file_panel_width = self.file_panel_width.clamp(160.0, 900.0);
        self
    }
}

impl Default for AppStateFile {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            active_tab_id: None,
            tabs: Vec::new(),
            closed_tabs: Vec::new(),
            layout: LayoutState::default(),
            pipeline_runs: Vec::new(),
            // Nothing to migrate in a file we are creating now.
            migrations: Migrations {
                claude_first: true,
                windows: true,
            },
            windows: vec![WindowRecord {
                id: MAIN_WINDOW_ID.to_string(),
                account_id: "default".to_string(),
                active_tab_id: None,
                layout: LayoutState::default(),
            }],
        }
    }
}

/// A closed tab can be reopened without its agent process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTabRecord {
    pub id: String,
    pub label: String,
    pub role_id: String,
    pub role_snapshot: RoleSnapshot,
    pub cwd: String,
    pub answers: HashMap<String, String>,
    #[serde(default)]
    pub color: Option<String>,
    pub merged_prompt: String,
    pub merged_prompt_hash: String,
    pub startup_prompt_sent: bool,
    pub closed_at: String,
    /// `role` for a chat tab. `terminal` for a shell, Cursor CLI, or role terminal.
    #[serde(default = "default_tab_kind")]
    pub kind: String,
    /// `shell`, `cursor-cli`, or `role`. Empty on chat tabs.
    #[serde(default)]
    pub terminal_launch: String,
    /// Kept so a reopened tab can `session/load` the same ACP thread.
    #[serde(default)]
    pub acp_session_id: Option<String>,
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub custom_label: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<crate::worktree::WorktreeRef>,
    /// Provider of this tab. `None` = saved before providers existed
    /// (resolves to Cursor until the Task 6.3 migration).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<crate::provider::ProviderId>,
    /// Session id per provider (the legacy single id lands in `cursor`).
    #[serde(default, skip_serializing_if = "crate::provider::ProviderSessions::is_empty")]
    pub sessions: crate::provider::ProviderSessions,
    /// Shown once, then cleared. Migration and config-dir mismatch use this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_notice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<ChainRef>,
    /// Set when Claude could not use the role's permission mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_note: Option<String>,
    /// Window this tab belongs to. Old files are the original window.
    #[serde(default = "default_window_id")]
    pub window_id: String,
}

/// Persisted tab snapshot (blueprint §17.2 `state.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRecord {
    pub id: String,
    pub label: String,
    pub role_id: String,
    pub role_snapshot: RoleSnapshot,
    pub cwd: String,
    pub answers: HashMap<String, String>,
    pub merged_prompt: String,
    pub merged_prompt_hash: String,
    /// `awaitingInput` | `running` (MVP; full FSM later).
    pub phase: String,
    pub order: u32,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TabSessionRef>,
    /// Read-only scrollback after Stop (MVP transcript persist).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
    /// Startup prompt was already sent for this tab (do not re-inject on Continue).
    #[serde(default)]
    pub startup_prompt_sent: bool,
    /// Optional chip color. Falls back to the role color in the UI.
    #[serde(default)]
    pub color: Option<String>,
    /// `role` for a chat tab. `terminal` for a shell, Cursor CLI, or role terminal.
    #[serde(default = "default_tab_kind")]
    pub kind: String,
    /// `shell`, `cursor-cli`, or `role`. Empty on chat tabs.
    #[serde(default)]
    pub terminal_launch: String,
    /// Per-tab model override. `None` uses the role default, then the global one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The user renamed this tab. Form edits and session starts keep the name.
    #[serde(default)]
    pub custom_label: bool,
    /// Set when the tab was opened with "New tab in worktree…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<crate::worktree::WorktreeRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline_run_id: Option<String>,
    /// Provider of this tab. `None` = saved before providers existed
    /// (resolves to Cursor until the Task 6.3 migration).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<crate::provider::ProviderId>,
    /// Session id per provider (the legacy single id lands in `cursor`).
    #[serde(default, skip_serializing_if = "crate::provider::ProviderSessions::is_empty")]
    pub sessions: crate::provider::ProviderSessions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_notice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<ChainRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_note: Option<String>,
    /// Window this tab belongs to. Old files are the original window.
    #[serde(default = "default_window_id")]
    pub window_id: String,
}

pub fn default_tab_kind() -> String {
    "role".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoleSnapshot {
    pub name: String,
    pub template_version: u32,
    pub mode: String,
    pub injection: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSessionRef {
    pub acp_session_id: String,
    pub mode_id: String,
    pub injection_pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injected_at: Option<String>,
}
