//! Claude Code behind the `Provider` trait: `claude` for terminal tabs and
//! `claude-agent-acp` (the Claude Code ACP adapter) for chat tabs.
//!
//! Phase 2 covers detection, login status, and the config folder. Claude
//! terminal tabs land in Phase 3 and Claude chat in Phase 4; until then the
//! launch methods return a clear "not available yet" error.

use super::{
    is_extension_method, AgentRequestKind, ProgramArgs, Provider, ProviderId, ProviderStatus,
    SessionOpts, TerminalLaunch,
};
use crate::acp::request_handler::is_permission_method;
use crate::cli_detect::LoginStatus;
use super::claude_config::{claude_env, resolve_claude_config_dir, ConfigDirInfo};
use crate::store::settings_store::ClaudeProviderSettings;
use serde_json::Value;
use std::path::PathBuf;

/// Shown when a Claude tab is started before its phase lands.
pub const CLAUDE_CHAT_PENDING: &str = "Claude chat tabs are not available in this build yet. \
     Switch this tab to Cursor on the Start card for now.";
pub const CLAUDE_TERMINAL_PENDING: &str =
    "Claude terminal tabs are not available in this build yet. \
     Switch this tab to Cursor on the Start card for now.";

#[derive(Debug, Clone)]
pub struct ClaudeProvider {
    pub settings: ClaudeProviderSettings,
    /// Resolved when the provider is built (env override → setting → `~/.claude`).
    pub config: ConfigDirInfo,
}

impl Default for ClaudeProvider {
    fn default() -> Self {
        Self::from_settings(&ClaudeProviderSettings::default())
    }
}

impl ClaudeProvider {
    pub fn from_settings(settings: &ClaudeProviderSettings) -> Self {
        Self {
            settings: settings.clone(),
            config: resolve_claude_config_dir(settings.config_dir.as_deref()),
        }
    }

    /// Env for every Claude process (`CLAUDE_CONFIG_DIR`).
    pub fn env(&self) -> Vec<(String, String)> {
        claude_env(&self.config)
    }
}

impl Provider for ClaudeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Claude
    }

    fn detect(&self) -> ProviderStatus {
        ProviderStatus {
            id: ProviderId::Claude,
            found: false,
            path: None,
            version: None,
            adapter_found: false,
            adapter_path: None,
            error: Some(self.missing_message()),
        }
    }

    fn login_status(&self) -> LoginStatus {
        LoginStatus {
            state: "unknown".into(),
            account: None,
            detail: None,
            api_key_env: false,
        }
    }

    fn acp_command(&self, _model: Option<&str>) -> Result<ProgramArgs, String> {
        Err(CLAUDE_CHAT_PENDING.to_string())
    }

    /// The adapter uses Claude Code's own login; DCTerminal never calls
    /// `authenticate` for Claude (and never `cursor_login`).
    fn auth_step(&self) -> Option<(String, Value)> {
        None
    }

    fn session_new_meta(&self, _opts: &SessionOpts) -> Option<Value> {
        None
    }

    fn mode_for_role(&self, _role_id: &str, _role_mode: &str, _available: &[String]) -> String {
        "default".to_string()
    }

    fn classify_request(&self, method: &str, _params: &Value) -> AgentRequestKind {
        if is_permission_method(method) {
            return AgentRequestKind::Permission;
        }
        if method.starts_with("cursor/") || is_extension_method(method) {
            return AgentRequestKind::UnknownExtension;
        }
        AgentRequestKind::Other
    }

    fn terminal_command(&self, _req: &TerminalLaunch) -> Result<ProgramArgs, String> {
        Err(CLAUDE_TERMINAL_PENDING.to_string())
    }

    fn plans_dir(&self) -> Option<PathBuf> {
        None
    }

    fn config_dir(&self) -> Option<ConfigDirInfo> {
        Some(self.config.clone())
    }

    fn missing_message(&self) -> String {
        "Claude Code (claude) was not found. Install it from https://code.claude.com/docs, \
         or set DCT_CLAUDE_PATH to the executable."
            .to_string()
    }

    fn auth_error_message(&self, detail: &str) -> String {
        format!("Claude Code is not signed in. ({detail})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_never_authenticates_with_cursor_login() {
        assert!(ClaudeProvider::default().auth_step().is_none());
    }

    #[test]
    fn claude_launches_say_they_are_not_available_yet() {
        let p = ClaudeProvider::default();
        assert_eq!(p.acp_command(None).unwrap_err(), CLAUDE_CHAT_PENDING);
        let launch = TerminalLaunch {
            kind: super::super::TerminalKind::Plain,
            model: None,
        };
        assert_eq!(
            p.terminal_command(&launch).unwrap_err(),
            CLAUDE_TERMINAL_PENDING
        );
    }

    #[test]
    fn claude_extensions_are_cancelled_and_permissions_kept() {
        let p = ClaudeProvider::default();
        assert_eq!(
            p.classify_request("session/request_permission", &json!({})),
            AgentRequestKind::Permission
        );
        assert_eq!(
            p.classify_request("_auth/status_update", &json!({})),
            AgentRequestKind::UnknownExtension
        );
        assert_eq!(
            p.classify_request("cursor/create_plan", &json!({})),
            AgentRequestKind::UnknownExtension
        );
    }
}
