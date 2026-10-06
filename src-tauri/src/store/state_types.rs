use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateFile {
    pub schema_version: u32,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<TabRecord>,
    #[serde(default)]
    pub closed_tabs: Vec<ClosedTabRecord>,
}

impl Default for AppStateFile {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            active_tab_id: None,
            tabs: Vec::new(),
            closed_tabs: Vec::new(),
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
