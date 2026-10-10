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
//! - the startup prompt as the positional argument (`deliver_prompt_limited`)
//!
//! Never passed: `--dangerously-skip-permissions`, `--allowedTools`,
//! `--disallowedTools`, `--cloud`, `--bg`, `--settings`, `--continue`.
//! The Settings run-mode override is a Cursor setting and is ignored here.
//!
//! Chat (Phase 4) spawns `claude-agent-acp` with `CLAUDE_CODE_EXECUTABLE` set
//! to the detected `claude` and the same `CLAUDE_CONFIG_DIR`. No
//! `authenticate` call: the adapter uses Claude Code's own login and
//! advertises no auth methods (captured 2026-10-09, adapter 0.88.0).

use super::claude_config::{claude_env, resolve_claude_config_dir, ConfigDirInfo};
use super::claude_detect::{
    claude_login_status, native_executable, read_claude_version, resolve_adapter, resolve_claude,
    unwrap_windows_shim,
};
use super::{
    is_extension_method, AgentRequestKind, ProgramArgs, Provider, ProviderId, ProviderStatus,
    SessionOpts, TerminalKind, TerminalLaunch,
};
use crate::acp::request_handler::is_permission_method;
use crate::cli_detect::LoginStatus;
use crate::store::settings_store::ClaudeProviderSettings;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The adapter runs `claude` through this env var instead of its bundled binary.
pub const CLAUDE_CODE_EXECUTABLE: &str = "CLAUDE_CODE_EXECUTABLE";

/// Shown when `claude-agent-acp` is not installed.
pub fn adapter_missing_message() -> String {
    format!(
        "Claude chat needs the Claude Code ACP adapter (claude-agent-acp), which was not found. \
         Install it in a terminal with `{}`. On Windows that is `claude-agent-acp.cmd` in the \
         npm global folder (`%APPDATA%\\npm`). Or set DCT_CLAUDE_ACP_PATH to it. Then Retry. \
         Claude terminal tabs work without it.",
        super::claude_detect::adapter_install_command()
    )
}

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

/// Shown when a saved Claude session belongs to a different config folder.
pub const CONFIG_CHANGED_NOTICE: &str = "Claude config folder changed; starting a new session";

/// Whether two config folders are the same place. Canonical when both exist.
pub fn same_config_dir(left: &str, right: &str) -> bool {
    let left_path = std::path::Path::new(left.trim());
    let right_path = std::path::Path::new(right.trim());
    match (left_path.canonicalize(), right_path.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => left_path == right_path,
    }
}

/// Resume id to pass to Claude, or a fresh session.
///
/// A Cursor id is never returned. Continuing `sessions.claude` after the
/// config folder changed starts fresh and explains why.
pub fn decide_claude_resume(
    requested: Option<&str>,
    sessions: &super::ProviderSessions,
    current_config: &str,
) -> (Option<String>, Option<String>) {
    let Some(id) = requested.map(str::trim).filter(|id| !id.is_empty()) else {
        return (None, None);
    };
    if sessions.cursor.as_deref() == Some(id) && sessions.claude.as_deref() != Some(id) {
        return (None, None);
    }
    if sessions.claude.as_deref() == Some(id) {
        if let Some(saved) = sessions.claude_config_dir.as_deref() {
            if !same_config_dir(saved, current_config) {
                return (None, Some(CONFIG_CHANGED_NOTICE.to_string()));
            }
        }
    }
    (Some(id.to_string()), None)
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
        Self::with_config(
            settings,
            resolve_claude_config_dir(settings.config_dir.as_deref()),
        )
    }

    /// A window account's folder, already resolved (env only for account 0).
    pub fn with_config(settings: &ClaudeProviderSettings, config: ConfigDirInfo) -> Self {
        Self {
            settings: settings.clone(),
            config,
        }
    }

    /// Env for every Claude process (`CLAUDE_CONFIG_DIR`).
    pub fn env(&self) -> Vec<(String, String)> {
        claude_env(&self.config)
    }

    /// Env for the ACP adapter: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_EXECUTABLE`,
    /// and a PATH that can find `node` (the adapter is a `#!/usr/bin/env node`
    /// script and a GUI app on macOS does not inherit the shell PATH).
    pub fn adapter_env(&self, adapter: &Path, claude: &Path) -> Vec<(String, String)> {
        let mut env = self.env();
        env.push((
            CLAUDE_CODE_EXECUTABLE.to_string(),
            claude.display().to_string(),
        ));
        let inherited = std::env::var("PATH").unwrap_or_default();
        env.push((
            "PATH".to_string(),
            adapter_path_var(adapter, claude, &inherited),
        ));
        env
    }
}

/// PATH for the adapter: the adapter's and `claude`'s folders and the usual
/// Homebrew / local bins first, then the inherited PATH. Duplicates dropped.
pub fn adapter_path_var(adapter: &Path, claude: &Path, inherited: &str) -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut parts: Vec<String> = Vec::new();
    let mut push = |dir: String| {
        if !dir.is_empty() && !parts.contains(&dir) {
            parts.push(dir);
        }
    };
    for path in [adapter, claude] {
        if let Some(dir) = path.parent() {
            push(dir.display().to_string());
        }
    }
    if !cfg!(windows) {
        push("/opt/homebrew/bin".to_string());
        push("/usr/local/bin".to_string());
    }
    for dir in inherited.split(sep) {
        push(dir.to_string());
    }
    parts.join(&sep.to_string())
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

    /// `claude-agent-acp` takes no model flag; the model is set on the
    /// session with `session/set_config_option` (category `model`).
    fn acp_command(&self, _model: Option<&str>) -> Result<ProgramArgs, String> {
        let claude = resolve_claude(self.settings.claude_path.as_deref())
            .ok_or_else(|| self.missing_message())?;
        let adapter = resolve_adapter(self.settings.adapter_path.as_deref())
            .ok_or_else(adapter_missing_message)?;
        let launch = unwrap_windows_shim(&adapter);
        let mut command =
            ProgramArgs::new(launch.program.display().to_string(), launch.prefix_args);
        command.env = self.adapter_env(&launch.program, &native_executable(&claude));
        Ok(command)
    }

    /// The adapter uses Claude Code's own login; DCTerminal never calls
    /// `authenticate` for Claude (and never `cursor_login`).
    fn auth_step(&self) -> Option<(String, Value)> {
        None
    }

    /// Keep `bypassPermissions` on offer (Decisions: roles run with full
    /// permissions). DCTerminal never passes `false` here.
    fn session_new_meta(&self, _opts: &SessionOpts) -> Option<Value> {
        Some(serde_json::json!({
            "claudeCode": { "options": { "allowDangerouslySkipPermissions": true } }
        }))
    }

    /// Mode from the role table; `default` when the session did not
    /// advertise it (e.g. bypass disabled), with every request auto-approved.
    fn mode_for_role(&self, role_id: &str, _role_mode: &str, available: &[String]) -> String {
        let wanted = claude_role_mode(role_id);
        if available.is_empty() || available.iter().any(|m| m == wanted) {
            wanted.to_string()
        } else {
            "default".to_string()
        }
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
        let launch = unwrap_windows_shim(&program);
        let mut args = launch.prefix_args;
        args.extend(claude_terminal_args(req)?);
        let mut command = ProgramArgs::new(launch.program.display().to_string(), args);
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
         https://code.claude.com/docs/en/setup. On Windows: \
         `npm install -g @anthropic-ai/claude-code` (npm puts `claude.cmd` in `%APPDATA%\\npm`) \
         or the native installer on that page. On a Mac: `brew install --cask claude-code`. \
         Or set DCT_CLAUDE_PATH to `claude.exe` or the `.cmd` shim."
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
    fn a_cursor_id_is_not_resumed_and_a_moved_config_dir_starts_fresh() {
        let mut sessions = super::super::ProviderSessions {
            cursor: Some("11111111-2222-3333-4444-555555555555".into()),
            ..Default::default()
        };
        let (id, notice) = decide_claude_resume(
            Some("11111111-2222-3333-4444-555555555555"),
            &sessions,
            "/tmp/claude",
        );
        assert!(id.is_none());
        assert!(notice.is_none());
        sessions.claude = Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into());
        sessions.claude_config_dir = Some("/tmp/account-a".into());
        let (id, notice) = decide_claude_resume(
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
            &sessions,
            "/tmp/account-b",
        );
        assert!(id.is_none());
        assert_eq!(notice.as_deref(), Some(CONFIG_CHANGED_NOTICE));
        let (id, notice) = decide_claude_resume(
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
            &sessions,
            "/tmp/account-a",
        );
        assert_eq!(id.as_deref(), Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        assert!(notice.is_none());
    }

    #[test]
    fn claude_never_authenticates_with_cursor_login() {
        assert!(ClaudeProvider::default().auth_step().is_none());
    }

    #[test]
    fn session_new_keeps_bypass_on_offer() {
        let meta = ClaudeProvider::default()
            .session_new_meta(&SessionOpts::default())
            .unwrap();
        assert_eq!(
            meta["claudeCode"]["options"]["allowDangerouslySkipPermissions"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn mode_falls_back_to_default_when_not_advertised() {
        let p = ClaudeProvider::default();
        let all: Vec<String> = [
            "default",
            "acceptEdits",
            "plan",
            "auto",
            "bypassPermissions",
        ]
        .iter()
        .map(|m| m.to_string())
        .collect();
        assert_eq!(p.mode_for_role("role_general", "agent", &all), "auto");
        assert_eq!(p.mode_for_role("role_planner", "plan", &all), "plan");
        assert_eq!(
            p.mode_for_role("role_implementer", "agent", &all),
            "bypassPermissions"
        );
        let no_bypass: Vec<String> = all
            .iter()
            .filter(|m| *m != "bypassPermissions")
            .cloned()
            .collect();
        assert_eq!(
            p.mode_for_role("role_implementer", "agent", &no_bypass),
            "default"
        );
        assert_eq!(
            p.mode_for_role("role_implementer", "agent", &[]),
            "bypassPermissions"
        );
    }

    #[test]
    fn non_claude_model_ids_never_reach_claude_model() {
        for model in ["composer-2.5", "gpt-5", "auto", "claude-4.5-sonnet"] {
            assert_eq!(
                claude_terminal_args(&role("role_general", RunMode::Default, Some(model), None))
                    .unwrap(),
                vec!["--permission-mode", "auto"],
                "{model}"
            );
        }
        assert_eq!(
            claude_terminal_args(&TerminalLaunch {
                kind: TerminalKind::Plain,
                model: Some("opus[1m]".into())
            })
            .unwrap(),
            vec!["--model", "opus[1m]"]
        );
    }

    #[test]
    fn adapter_path_finds_node_next_to_homebrew() {
        let path = adapter_path_var(
            Path::new("/opt/homebrew/bin/claude-agent-acp"),
            Path::new("/opt/homebrew/bin/claude"),
            "/usr/bin:/bin:/opt/homebrew/bin",
        );
        if !cfg!(windows) {
            assert_eq!(path, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
        }
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
                "/model",
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
        let delivery = crate::pty::launch::deliver_prompt_limited(
            &long,
            file,
            crate::pty::launch::MAX_PROMPT_ARG_BYTES,
        );
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
        let dir = crate::test_support::test_root().join(format!("dct_claude_term_{tag}_{nanos}"));
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
    fn adapter_env_has_claude_executable_and_config_dir() {
        use super::super::claude_config::{resolve_with, CLAUDE_CONFIG_DIR};
        let root = temp("adapter");
        let config = root.join("account2");
        std::fs::create_dir_all(&config).unwrap();
        let mut p = provider_with(
            &root,
            resolve_with(None, Some(&config.display().to_string()), None),
        );
        let adapter = root.join("bin").join("claude-agent-acp");
        std::fs::write(&adapter, "#!/usr/bin/env node\n").unwrap();
        p.settings.adapter_path = Some(adapter.display().to_string());
        let command = p.acp_command(Some("composer-2.5")).unwrap();
        assert_eq!(command.program, adapter.display().to_string());
        assert!(command.args.is_empty(), "no model flag for the adapter");
        let get = |key: &str| {
            command
                .env
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get(CLAUDE_CONFIG_DIR), Some(p.config.path.clone()));
        assert_eq!(
            get(CLAUDE_CODE_EXECUTABLE),
            Some(root.join("bin").join("claude").display().to_string())
        );
        assert!(get("ANTHROPIC_API_KEY").is_none());
        assert!(get("PATH")
            .unwrap()
            .starts_with(&root.join("bin").display().to_string()));
    }

    #[test]
    fn missing_claude_message_names_the_windows_npm_install() {
        let message = ClaudeProvider::default().missing_message();
        assert!(message.contains("npm install -g @anthropic-ai/claude-code"));
        assert!(message.contains("%APPDATA%\\npm"));
        assert!(message.contains("claude.cmd"));
        assert!(message.contains("brew install --cask claude-code"));
        let adapter = adapter_missing_message();
        assert!(adapter.contains("claude-agent-acp.cmd"));
        assert!(adapter.contains("%APPDATA%\\npm"));
    }

    #[test]
    fn windows_npm_shims_spawn_the_exe_and_set_claude_code_executable() {
        use super::super::claude_config::resolve_with;
        let root = temp("winspawn");
        let npm = root.join("npm");
        let exe = npm
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("bin")
            .join("claude.exe");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "").unwrap();
        let claude_cmd = npm.join("claude.cmd");
        std::fs::write(&claude_cmd, "@echo off\r\n").unwrap();
        let script = npm
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("claude-agent-acp")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "").unwrap();
        let node = npm.join("node.exe");
        std::fs::write(&node, "").unwrap();
        let adapter_cmd = npm.join("claude-agent-acp.cmd");
        std::fs::write(
            &adapter_cmd,
            "@ECHO off\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n)\r\n\"%_prog%\" \"%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js\" %*\r\n",
        )
        .unwrap();
        let config = root.join("account");
        std::fs::create_dir_all(&config).unwrap();
        let provider = ClaudeProvider {
            settings: ClaudeProviderSettings {
                claude_path: Some(claude_cmd.display().to_string()),
                adapter_path: Some(adapter_cmd.display().to_string()),
                ..Default::default()
            },
            config: resolve_with(None, Some(&config.display().to_string()), None),
        };
        let terminal = provider
            .terminal_command(&TerminalLaunch {
                kind: TerminalKind::Plain,
                model: None,
            })
            .unwrap();
        assert_eq!(terminal.program, exe.display().to_string());
        let acp = provider.acp_command(None).unwrap();
        assert_eq!(acp.program, node.display().to_string());
        assert_eq!(acp.args, vec![script.display().to_string()]);
        let configured = acp
            .env
            .iter()
            .find(|(key, _)| key == CLAUDE_CODE_EXECUTABLE)
            .map(|(_, value)| value.as_str());
        assert_eq!(configured, Some(exe.display().to_string().as_str()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_adapter_says_how_to_install_it() {
        let root = temp("noadapter");
        let mut p = provider_with(
            &root,
            super::super::claude_config::resolve_with(None, None, Some(&root)),
        );
        p.settings.adapter_path = Some(root.join("nope").display().to_string());
        if resolve_adapter(None).is_some() {
            return; // a real adapter on this machine would be found first
        }
        let err = p.acp_command(None).unwrap_err();
        assert!(
            err.contains(
                "npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.88.0"
            ),
            "{err}"
        );
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
