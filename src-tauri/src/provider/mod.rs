//! Agent providers (Claude-first plan, Phase 2).
//!
//! A provider is the CLI behind a tab: Claude Code (`claude`, and
//! `claude-agent-acp` for chat) or the Cursor CLI (`agent`). This module holds
//! the provider id that tabs, workspaces, and settings store. Tabs saved before
//! providers existed have no id; they resolve to Cursor until the one-time
//! migration (plan Task 6.3) moves them to Claude.

pub mod claude;
pub mod claude_config;
pub mod claude_detect;
pub mod cursor;

use crate::cli_detect::LoginStatus;
use crate::pty::RunMode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

pub use claude::ClaudeProvider;
pub use cursor::CursorProvider;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Claude,
    Cursor,
}

impl ProviderId {
    /// Provider for a tab or workspace saved without one.
    pub const LEGACY: ProviderId = ProviderId::Cursor;
    /// Settings default for new and existing profiles (Decision 3).
    pub const DEFAULT: ProviderId = ProviderId::Claude;

    /// `None` is a legacy record: Cursor, until Task 6.3 migrates it.
    pub fn resolve(saved: Option<ProviderId>) -> ProviderId {
        saved.unwrap_or(Self::LEGACY)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Claude => "claude",
            ProviderId::Cursor => "cursor",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ProviderId::Claude => "Claude",
            ProviderId::Cursor => "Cursor",
        }
    }

    pub fn parse(value: &str) -> Option<ProviderId> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" => Some(ProviderId::Claude),
            "cursor" => Some(ProviderId::Cursor),
            _ => None,
        }
    }
}

/// Session ids per provider. A Cursor id can never resume under Claude, so a
/// tab keeps one id per provider. `claude_config_dir` is the Claude config
/// folder that was in effect when `claude` was saved (plan: Claude account /
/// config dir); a different folder later means a fresh Claude session.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_config_dir: Option<String>,
}

impl ProviderSessions {
    pub fn is_empty(&self) -> bool {
        self.cursor.is_none() && self.claude.is_none() && self.claude_config_dir.is_none()
    }

    pub fn get(&self, provider: ProviderId) -> Option<&str> {
        match provider {
            ProviderId::Cursor => self.cursor.as_deref(),
            ProviderId::Claude => self.claude.as_deref(),
        }
    }

    pub fn set(&mut self, provider: ProviderId, id: Option<String>) {
        match provider {
            ProviderId::Cursor => self.cursor = id,
            ProviderId::Claude => self.claude = id,
        }
    }
}

/// A program to run: argv plus extra environment. `env` is applied on top of
/// the inherited environment (an entry overwrites an inherited value).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramArgs {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl ProgramArgs {
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
            env: Vec::new(),
        }
    }
}

/// What the CLI and its ACP side were found to be.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: ProviderId,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Chat side found (Cursor: the same `agent`; Claude: `claude-agent-acp`).
    pub adapter_found: bool,
    pub adapter_path: Option<String>,
    pub error: Option<String>,
}

/// How an agent-to-client request is handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRequestKind {
    /// Permission request (card / auto-answer).
    Permission,
    /// A plan to approve (Cursor `cursor/create_plan`; Claude `ExitPlanMode`
    /// from Phase 4).
    Plan,
    /// A question card (Cursor `cursor/ask_question`).
    Question,
    /// A provider extension DCTerminal does not handle: answered `cancelled`
    /// so the agent never waits on it.
    UnknownExtension,
    /// Anything else (standard client methods); the caller's handler decides.
    Other,
}

/// What kind of terminal to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalKind {
    /// The CLI with no policy flags (Cursor CLI / Claude Code tile).
    Plain,
    /// A role terminal: role flags, then the startup prompt as the positional
    /// argument (already passed through `deliver_prompt`).
    Role {
        role_id: String,
        run_mode: RunMode,
        prompt: Option<String>,
    },
    /// Reopen a CLI session by id.
    Resume { session_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalLaunch {
    pub kind: TerminalKind,
    pub model: Option<String>,
}

/// Session options for `session/new`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionOpts {
    pub role_id: String,
}

/// Everything that differs between Claude Code and the Cursor CLI.
/// The ACP client, resume, plan cards, scratch pads, and hand-offs are shared.
pub trait Provider: Send + Sync {
    fn id(&self) -> ProviderId;
    /// Executable lookup and version (read-only).
    fn detect(&self) -> ProviderStatus;
    /// Signed-in state from the CLI itself (read-only CLI call).
    fn login_status(&self) -> LoginStatus;
    /// The ACP agent process for chat tabs. `model` is a spawn-time model
    /// (used when a session cannot switch in place).
    fn acp_command(&self, model: Option<&str>) -> Result<ProgramArgs, String>;
    /// `Some((method, params))` when the handshake must authenticate.
    fn auth_step(&self) -> Option<(String, Value)>;
    /// `_meta` for `session/new`, if any.
    fn session_new_meta(&self, opts: &SessionOpts) -> Option<Value>;
    /// ACP mode for a role. `role_mode` is the role's saved default mode;
    /// `available` the modes the agent advertised (may be empty).
    fn mode_for_role(&self, role_id: &str, role_mode: &str, available: &[String]) -> String;
    fn classify_request(&self, method: &str, params: &Value) -> AgentRequestKind;
    fn terminal_command(&self, req: &TerminalLaunch) -> Result<ProgramArgs, String>;
    /// Read-only folder where the CLI writes plan files.
    fn plans_dir(&self) -> Option<PathBuf>;
    /// Claude: the resolved config folder passed as `CLAUDE_CONFIG_DIR`.
    /// Cursor: none.
    fn config_dir(&self) -> Option<claude_config::ConfigDirInfo>;
    /// Text shown when the CLI is not installed.
    fn missing_message(&self) -> String;
    /// Text shown when the CLI is not signed in.
    fn auth_error_message(&self, detail: &str) -> String;
}

pub type SharedProvider = Arc<dyn Provider>;

/// Build a provider from the saved settings.
pub fn provider_for(
    id: ProviderId,
    settings: &crate::store::settings_store::ProvidersSettings,
) -> SharedProvider {
    match id {
        ProviderId::Cursor => Arc::new(CursorProvider),
        ProviderId::Claude => Arc::new(ClaudeProvider::from_settings(&settings.claude)),
    }
}

/// `true` for an ACP extension method name (`_foo/bar`) or a vendor
/// namespace DCTerminal does not implement for this provider.
pub fn is_extension_method(method: &str) -> bool {
    method.starts_with('_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_lowercase_strings() {
        assert_eq!(
            serde_json::to_value(ProviderId::Claude).unwrap(),
            serde_json::json!("claude")
        );
        let parsed: ProviderId = serde_json::from_str("\"cursor\"").unwrap();
        assert_eq!(parsed, ProviderId::Cursor);
        assert!(serde_json::from_str::<ProviderId>("\"Claude\"").is_err());
        assert_eq!(ProviderId::parse(" Claude "), Some(ProviderId::Claude));
        assert_eq!(ProviderId::parse("gpt"), None);
    }

    #[test]
    fn missing_provider_is_cursor_until_migration() {
        assert_eq!(ProviderId::resolve(None), ProviderId::Cursor);
        assert_eq!(
            ProviderId::resolve(Some(ProviderId::Claude)),
            ProviderId::Claude
        );
        assert_eq!(ProviderId::DEFAULT, ProviderId::Claude);
    }

    #[test]
    fn sessions_keep_one_id_per_provider() {
        let mut sessions = ProviderSessions::default();
        assert!(sessions.is_empty());
        sessions.set(ProviderId::Cursor, Some("c-1".into()));
        assert_eq!(sessions.get(ProviderId::Cursor), Some("c-1"));
        assert_eq!(sessions.get(ProviderId::Claude), None);
        let json = serde_json::to_value(&sessions).unwrap();
        assert_eq!(json, serde_json::json!({ "cursor": "c-1" }));
    }
}
