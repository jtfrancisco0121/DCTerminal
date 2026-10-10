//! Cursor CLI (`agent`) behind the `Provider` trait. Delegates to the code
//! that existed before providers (`cli_detect`, `pty::launch`, `cli_launch`,
//! `pty::plans`); behavior is unchanged.

use super::{
    is_extension_method, AgentRequestKind, ProgramArgs, Provider, ProviderId, ProviderStatus,
    SessionOpts, TerminalKind, TerminalLaunch,
};
use crate::acp::request_handler::is_permission_method;
use crate::cli_detect::{
    agent_login_status, agent_missing_message, detect_agent, resolve_agent_executable, LoginStatus,
};
use crate::pty::launch::{plain_agent_args, role_terminal_flags, with_model};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, Default)]
pub struct CursorProvider;

impl CursorProvider {
    fn agent_path(&self) -> Result<String, String> {
        resolve_agent_executable()
            .map(|path| path.display().to_string())
            .ok_or_else(agent_missing_message)
    }
}

/// `agent [--model <id>] acp`. Prompt text never goes in argv.
pub fn cursor_acp_args(model: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(model) = model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    for arg in crate::acp::acp_launch_args() {
        args.push((*arg).to_string());
    }
    args
}

/// Cursor terminal argv (without the program).
pub fn cursor_terminal_args(req: &TerminalLaunch) -> Result<Vec<String>, String> {
    let model = req.model.as_deref();
    Ok(match &req.kind {
        TerminalKind::Plain => with_model(model, plain_agent_args()),
        TerminalKind::Resume { session_id } => {
            with_model(model, crate::cli_launch::resume_agent_args(session_id)?)
        }
        TerminalKind::Role {
            role_id,
            run_mode,
            prompt,
        } => {
            let mut args = with_model(model, role_terminal_flags(role_id, *run_mode));
            if let Some(text) = prompt.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                args.push(text.to_string());
            }
            args
        }
    })
}

impl Provider for CursorProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Cursor
    }

    fn detect(&self) -> ProviderStatus {
        let found = detect_agent();
        ProviderStatus {
            id: ProviderId::Cursor,
            found: found.found,
            path: found.path.clone(),
            version: found.version,
            // `agent acp` is the same executable.
            adapter_found: found.found,
            adapter_path: found.path,
            error: found.error,
        }
    }

    fn login_status(&self) -> LoginStatus {
        agent_login_status()
    }

    fn acp_command(&self, model: Option<&str>) -> Result<ProgramArgs, String> {
        Ok(ProgramArgs::new(self.agent_path()?, cursor_acp_args(model)))
    }

    fn auth_step(&self) -> Option<(String, Value)> {
        Some((
            "authenticate".to_string(),
            json!({ "methodId": "cursor_login" }),
        ))
    }

    fn session_new_meta(&self, _opts: &SessionOpts) -> Option<Value> {
        None
    }

    fn mode_for_role(&self, _role_id: &str, role_mode: &str, _available: &[String]) -> String {
        role_mode.to_string()
    }

    fn classify_request(&self, method: &str, _params: &Value) -> AgentRequestKind {
        if is_permission_method(method) {
            return AgentRequestKind::Permission;
        }
        match method {
            "cursor/create_plan" => AgentRequestKind::Plan,
            "cursor/ask_question" => AgentRequestKind::Question,
            _ if method.starts_with("cursor/") || is_extension_method(method) => {
                AgentRequestKind::UnknownExtension
            }
            _ => AgentRequestKind::Other,
        }
    }

    fn terminal_command(&self, req: &TerminalLaunch) -> Result<ProgramArgs, String> {
        let program = self.agent_path()?;
        Ok(ProgramArgs::new(program, cursor_terminal_args(req)?))
    }

    fn plans_dir(&self) -> Option<PathBuf> {
        Some(crate::pty::plans::cursor_plans_dir())
    }

    fn config_dir(&self) -> Option<super::claude_config::ConfigDirInfo> {
        None
    }

    fn missing_message(&self) -> String {
        agent_missing_message()
    }

    fn auth_error_message(&self, detail: &str) -> String {
        format!("Cursor CLI is not authenticated. Run `agent login` in a terminal, then Retry. ({detail})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::RunMode;

    #[test]
    fn acp_args_put_the_model_before_acp() {
        assert_eq!(cursor_acp_args(None), vec!["acp"]);
        assert_eq!(
            cursor_acp_args(Some("gpt-5")),
            vec!["--model", "gpt-5", "acp"]
        );
    }

    #[test]
    fn handshake_authenticates_with_cursor_login() {
        let (method, params) = CursorProvider.auth_step().unwrap();
        assert_eq!(method, "authenticate");
        assert_eq!(params["methodId"], "cursor_login");
        assert!(CursorProvider
            .session_new_meta(&SessionOpts::default())
            .is_none());
    }

    #[test]
    fn cursor_requests_are_classified_like_before() {
        let p = CursorProvider;
        let v = json!({});
        assert_eq!(
            p.classify_request("session/request_permission", &v),
            AgentRequestKind::Permission
        );
        assert_eq!(
            p.classify_request("cursor/create_plan", &v),
            AgentRequestKind::Plan
        );
        assert_eq!(
            p.classify_request("cursor/ask_question", &v),
            AgentRequestKind::Question
        );
        assert_eq!(
            p.classify_request("cursor/update_todos", &v),
            AgentRequestKind::UnknownExtension
        );
        assert_eq!(
            p.classify_request("_claude/whatever", &v),
            AgentRequestKind::UnknownExtension
        );
        assert_eq!(
            p.classify_request("fs/read_text_file", &v),
            AgentRequestKind::Other
        );
    }

    #[test]
    fn terminal_args_match_the_existing_launch_code() {
        let role = TerminalLaunch {
            kind: TerminalKind::Role {
                role_id: "role_planner".into(),
                run_mode: RunMode::Default,
                prompt: Some("Ship it".into()),
            },
            model: Some("composer-2.5".into()),
            session_id: None,
        };
        assert_eq!(
            cursor_terminal_args(&role).unwrap(),
            vec![
                "--model",
                "composer-2.5",
                "--plan",
                "--approve-mcps",
                "--trust",
                "Ship it"
            ]
        );
        let plain = TerminalLaunch {
            kind: TerminalKind::Plain,
            model: Some("gpt-5".into()),
            session_id: None,
        };
        assert_eq!(
            cursor_terminal_args(&plain).unwrap(),
            vec!["--model", "gpt-5"]
        );
        let resume = TerminalLaunch {
            kind: TerminalKind::Resume {
                session_id: "11111111-2222-3333-4444-555555555555".into(),
            },
            model: None,
            session_id: None,
        };
        assert_eq!(
            cursor_terminal_args(&resume).unwrap(),
            vec!["--resume", "11111111-2222-3333-4444-555555555555"]
        );
        let bad = TerminalLaunch {
            kind: TerminalKind::Resume {
                session_id: "x;rm".into(),
            },
            model: None,
            session_id: None,
        };
        assert!(cursor_terminal_args(&bad).is_err());
    }

    #[test]
    fn modes_are_the_role_modes() {
        assert_eq!(
            CursorProvider.mode_for_role("role_planner", "plan", &[]),
            "plan"
        );
    }
}
