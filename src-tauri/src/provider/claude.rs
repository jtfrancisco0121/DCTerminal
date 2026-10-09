//! Claude Code behind the `Provider` trait: `claude` for terminal tabs and
//! `claude-agent-acp` (the Claude Code ACP adapter) for chat tabs.
//!
//! Every Claude process gets `CLAUDE_CONFIG_DIR=<configDir>` (Task 2.3), so a
//! GUI launch uses the same account as JT's `claude2` alias.
//!
//! Terminal flags (Phase 3, Decisions → per-role mode table):
//! - General: `--permission-mode auto`
//! - Planner: `--permission-mode plan`
//! - every other role: `--permission-mode bypassPermissions`
//! - `--model <id>` first when a model other than `default` is set
//! - the startup prompt as the positional argument (`deliver_prompt`)
//!
//! Never passed: `--dangerously-skip-permissions`, `--allowedTools`,
//! `--disallowedTools`, `--cloud`, `--bg`, `--settings`, `--continue`.
//! The Settings run-mode override is a Cursor setting and is ignored here.
//!
//! Claude chat lands in Phase 4; until then `acp_command` returns a clear
//! "not available yet" error.

use super::claude_config::{claude_env, resolve_claude_config_dir, ConfigDirInfo};
use super::claude_detect::{
    claude_login_status, read_claude_version, resolve_adapter, resolve_claude,
};
use super::{
    is_extension_method, AgentRequestKind, ProgramArgs, Provider, ProviderId, ProviderStatus,
    SessionOpts, TerminalKind, TerminalLaunch,
};
use crate::acp::request_handler::is_permission_method;
use crate::cli_detect::LoginStatus;
use crate::store::settings_store::ClaudeProviderSettings;
use serde_json::Value;
use std::path::PathBuf;

/// Shown when a Claude chat tab is started before Phase 4 lands.
pub const CLAUDE_CHAT_PENDING: &str = "Claude chat tabs are not available in this build yet. \
     Open this role as a Terminal, or switch this tab to Cursor on the Start card.";

/// The model alias that means "the account's default": no `--model` flag.
pub const CLAUDE_DEFAULT_MODEL: &str = "default";

/// Claude Code permission mode for a role (Decisions → per-role mode table).
pub fn claude_role_mode(role_id: &str) -> &'static str {
    let normalized = role_id.trim().to_ascii_lowercase().replace('-', "_");
    match normalized.as_str() {
        "role_general" | "general" => "auto",
        "role_planner" | "planner" => "plan",
        _ => "bypassPermissions",
    }
}

/// `--model <id>` for Claude, or nothing for `default` / an invalid id.
pub fn claude_model_args(model: Option<&str>) -> Vec<String> {
    match model
        .map(str::trim)
        .filter(|id| *id != CLAUDE_DEFAULT_MODEL && crate::models::is_claude_model_id(id))
    {
        Some(id) => vec!["--model".to_string(), id.to_string()],
        None => Vec::new(),
    }
}

/// A Claude session id is a UUID; anything else is refused before spawn.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

/// argv after `claude` for one terminal launch.
pub fn claude_terminal_args(req: &TerminalLaunch) -> Result<Vec<String>, String> {
    let mut args = claude_model_args(req.model.as_deref());
    match &req.kind {
        TerminalKind::Plain => {}
        TerminalKind::Resume { session_id } => {
            let id = session_id.trim();
            if !valid_session_id(id) {
                return Err(format!("not a Claude session id: {id}"));
            }
            args.push("--resume".to_string());
            args.push(id.to_string());
        }
        TerminalKind::Role {
            role_id, prompt, ..
        } => {
            args.push("--permission-mode".to_string());
            args.push(claude_role_mode(role_id).to_string());
            if let Some(text) = prompt.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                args.push(text.to_string());
            }
        }
    }
    Ok(args)
}

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
        let claude = resolve_claude(self.settings.claude_path.as_deref());
        let adapter = resolve_adapter(self.settings.adapter_path.as_deref());
        let version = claude
            .as_deref()
            .and_then(|path| read_claude_version(path, &self.config));
        ProviderStatus {
            id: ProviderId::Claude,
            found: claude.is_some(),
            path: claude.as_ref().map(|p| p.display().to_string()),
            version,
            adapter_found: adapter.is_some(),
            adapter_path: adapter.as_ref().map(|p| p.display().to_string()),
            error: claude.is_none().then(|| self.missing_message()),
        }
    }

    fn login_status(&self) -> LoginStatus {
        let claude = resolve_claude(self.settings.claude_path.as_deref());
        claude_login_status(claude.as_deref(), &self.config)
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

    fn mode_for_role(&self, role_id: &str, _role_mode: &str, _available: &[String]) -> String {
        claude_role_mode(role_id).to_string()
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

    fn terminal_command(&self, req: &TerminalLaunch) -> Result<ProgramArgs, String> {
        let program = resolve_claude(self.settings.claude_path.as_deref())
            .ok_or_else(|| self.missing_message())?;
        let mut command =
            ProgramArgs::new(program.display().to_string(), claude_terminal_args(req)?);
        command.env = self.env();
        Ok(command)
    }

    /// Claude plan mode writes plans under `<configDir>/plans` (seen on JT's
    /// Mac in `~/.claude-account2/plans`). Read-only; never created.
    fn plans_dir(&self) -> Option<PathBuf> {
        Some(self.config.path_buf().join("plans"))
    }

    fn config_dir(&self) -> Option<ConfigDirInfo> {
        Some(self.config.clone())
    }

    fn missing_message(&self) -> String {
        "Claude Code (claude) was not found. Install it from \
         https://code.claude.com/docs/en/setup (on a Mac: `brew install --cask claude-code`), \
         or set DCT_CLAUDE_PATH to the executable."
            .to_string()
    }

    fn auth_error_message(&self, detail: &str) -> String {
        let dir = &self.config.display;
        format!(
            "Claude Code is not signed in for {dir}. Open a terminal, run \
             `CLAUDE_CONFIG_DIR={dir} claude` (your `claude2`), and use `/login`. Then Retry. ({detail})"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::RunMode;
    use serde_json::json;

    #[test]
    fn claude_never_authenticates_with_cursor_login() {
        assert!(ClaudeProvider::default().auth_step().is_none());
    }

    #[test]
    fn claude_chat_says_it_is_not_available_yet() {
        let p = ClaudeProvider::default();
        assert_eq!(p.acp_command(None).unwrap_err(), CLAUDE_CHAT_PENDING);
    }

    fn role(
        role_id: &str,
        run_mode: RunMode,
        model: Option<&str>,
        prompt: Option<&str>,
    ) -> TerminalLaunch {
        TerminalLaunch {
            kind: TerminalKind::Role {
                role_id: role_id.to_string(),
                run_mode,
                prompt: prompt.map(str::to_string),
            },
            model: model.map(str::to_string),
        }
    }

    #[test]
    fn role_flags_follow_the_mode_table() {
        let cases = [
            ("role_general", "auto"),
            ("role_planner", "plan"),
            ("role_plan_reviewer", "bypassPermissions"),
            ("role_implementer", "bypassPermissions"),
            ("role_developer", "bypassPermissions"),
            ("role_pr_reviewer", "bypassPermissions"),
            ("role_codebase_audit", "bypassPermissions"),
            ("role_recommendation", "bypassPermissions"),
            ("role_custom_1234", "bypassPermissions"),
        ];
        for (role_id, mode) in cases {
            assert_eq!(
                claude_terminal_args(&role(role_id, RunMode::Default, None, None)).unwrap(),
                vec!["--permission-mode", mode],
                "{role_id}"
            );
        }
    }

    #[test]
    fn run_mode_override_is_ignored_for_claude() {
        for mode in [
            RunMode::Yolo,
            RunMode::AutoReview,
            RunMode::Plan,
            RunMode::Ask,
        ] {
            assert_eq!(
                claude_terminal_args(&role("role_pr_reviewer", mode, None, None)).unwrap(),
                vec!["--permission-mode", "bypassPermissions"]
            );
        }
    }

    #[test]
    fn model_goes_first_default_and_bad_ids_are_dropped() {
        assert_eq!(
            claude_terminal_args(&role(
                "role_planner",
                RunMode::Default,
                Some("opus"),
                Some("Plan it")
            ))
            .unwrap(),
            vec!["--model", "opus", "--permission-mode", "plan", "Plan it"]
        );
        for model in ["default", "--settings", "", "a b"] {
            assert_eq!(
                claude_terminal_args(&role("role_general", RunMode::Default, Some(model), None))
                    .unwrap(),
                vec!["--permission-mode", "auto"],
                "{model:?}"
            );
        }
    }

    #[test]
    fn never_passes_forbidden_flags() {
        let launches = [
            role("role_developer", RunMode::Yolo, Some("sonnet"), Some("go")),
            role("role_general", RunMode::Default, None, None),
            TerminalLaunch {
                kind: TerminalKind::Plain,
                model: None,
            },
        ];
        for launch in launches {
            let args = claude_terminal_args(&launch).unwrap();
            for bad in [
                "--dangerously-skip-permissions",
                "--allow-dangerously-skip-permissions",
                "--allowedTools",
                "--disallowedTools",
                "--cloud",
                "--bg",
                "--settings",
                "--continue",
            ] {
                assert!(!args.iter().any(|a| a == bad), "{bad} in {args:?}");
            }
        }
    }

    #[test]
    fn plain_tile_has_no_flags_and_resume_checks_the_id() {
        let plain = TerminalLaunch {
            kind: TerminalKind::Plain,
            model: Some("default".into()),
        };
        assert!(claude_terminal_args(&plain).unwrap().is_empty());
        let resume = |id: &str| TerminalLaunch {
            kind: TerminalKind::Resume {
                session_id: id.to_string(),
            },
            model: None,
        };
        assert_eq!(
            claude_terminal_args(&resume("0b6c1d2e-aaaa-bbbb-cccc-1234567890ab")).unwrap(),
            vec!["--resume", "0b6c1d2e-aaaa-bbbb-cccc-1234567890ab"]
        );
        assert!(claude_terminal_args(&resume("--continue")).is_err());
    }

    #[test]
    fn long_prompt_goes_through_the_prompt_file() {
        let long = "x".repeat(crate::pty::launch::MAX_PROMPT_ARG_BYTES + 1);
        let file = std::path::Path::new("/tmp/dct-prompt.md");
        let delivery = crate::pty::launch::deliver_prompt(&long, file);
        assert!(delivery.stored_body.is_some());
        let args = claude_terminal_args(&role(
            "role_developer",
            RunMode::Default,
            None,
            Some(&delivery.argument),
        ))
        .unwrap();
        assert_eq!(args.len(), 3);
        assert!(args[2].contains("/tmp/dct-prompt.md"));
        assert!(args[2].len() < 200);
    }

    fn temp(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dct_claude_term_{tag}_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn provider_with(root: &std::path::Path, config: ConfigDirInfo) -> ClaudeProvider {
        let bin = root.join("bin").join("claude");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        ClaudeProvider {
            settings: ClaudeProviderSettings {
                claude_path: Some(bin.display().to_string()),
                ..Default::default()
            },
            config,
        }
    }

    #[test]
    fn plans_dir_follows_the_config_dir() {
        let root = temp("plans");
        let missing = root.join("account2");
        let p = provider_with(
            &root,
            super::super::claude_config::resolve_with(
                None,
                Some(&missing.display().to_string()),
                None,
            ),
        );
        let plans = p.plans_dir().unwrap();
        assert_eq!(plans, missing.join("plans"));
        assert!(!plans.exists(), "plans dir must not be created");
        assert!(!missing.exists(), "config dir must not be created");
    }

    #[test]
    fn planner_handoff_reads_the_newest_plan_under_the_config_dir() {
        let root = temp("handoff");
        let config = root.join("account2");
        std::fs::create_dir_all(config.join("plans")).unwrap();
        let p = provider_with(
            &root,
            super::super::claude_config::resolve_with(
                None,
                Some(&config.display().to_string()),
                None,
            ),
        );
        let started = std::time::SystemTime::now() - std::time::Duration::from_secs(5);
        let dir = p.plans_dir().unwrap();
        assert!(crate::pty::plans::newest_plan_since(&dir, started)
            .unwrap()
            .is_none());
        std::fs::write(dir.join("delightful-plan.md"), "# Plan\n\n- step").unwrap();
        let found = crate::pty::plans::newest_plan_since(&dir, started)
            .unwrap()
            .unwrap();
        assert_eq!(found.name, "delightful-plan.md");
        assert!(found.text.contains("- step"));
    }

    #[test]
    fn terminal_env_carries_the_resolved_config_dir() {
        use super::super::claude_config::{resolve_with, ConfigDirSource, CLAUDE_CONFIG_DIR};
        let root = temp("env");
        let home = root.join("home");
        let account2 = home.join(".claude-account2");
        let from_env = home.join(".claude-env");
        std::fs::create_dir_all(&account2).unwrap();
        std::fs::create_dir_all(&from_env).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let env_value = from_env.display().to_string();
        let cases = [
            (
                resolve_with(None, Some("~/.claude-account2"), Some(&home)),
                ConfigDirSource::Setting,
            ),
            (
                resolve_with(Some(&env_value), Some("~/.claude-account2"), Some(&home)),
                ConfigDirSource::Env,
            ),
            (
                resolve_with(None, None, Some(&home)),
                ConfigDirSource::Default,
            ),
        ];
        for (config, source) in cases {
            assert_eq!(config.source, source);
            let expected = config.path.clone();
            let p = provider_with(&root, config);
            for launch in [
                TerminalLaunch {
                    kind: TerminalKind::Plain,
                    model: None,
                },
                role("role_planner", RunMode::Default, Some("opus"), Some("hi")),
            ] {
                let command = p.terminal_command(&launch).unwrap();
                assert!(command.program.ends_with("claude"));
                assert_eq!(
                    command
                        .env
                        .iter()
                        .find(|(k, _)| k == CLAUDE_CONFIG_DIR)
                        .map(|(_, v)| v.clone()),
                    Some(expected.clone()),
                    "{source:?}"
                );
            }
        }
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
