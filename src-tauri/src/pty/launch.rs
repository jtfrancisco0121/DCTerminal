//! How a terminal-mode role becomes an `agent` command line.
//!
//! Flags come from JT's Windows `agent --help` (CLI 2026.10.01). This module
//! does not read or write `~/.cursor`, and it does not change `approvalMode`.
//!
//! Confirmed flags we use:
//! - `--yolo` — alias of `-f` / `--force`, labeled "Run Everything"
//! - `--plan` — start in plan mode
//! - `--mode ask` — start in ask mode
//! - `--auto-review` — only when a role's Settings override selects it
//! - `--approve-mcps` — MCP is allowed for every role
//! - `--trust` — included on every role terminal launch
//! - `--model <id>` — the tab's model (tab override, role default, or the
//!   global default `composer-2.5`). Ids are checked by `valid_model_id`
//!   so one can never be read as a flag.
//!
//! Not used, on purpose:
//! - `--sandbox` — no role policy maps to enabled or disabled
//! - `--continue` — the interactive CLI owns it. `--resume` is used only for
//!   a Cursor CLI chat picked from history.
//! - `--force` — same switch as `--yolo`; the confirmed set uses `--yolo`
//! - There is no flag that denies file writes while still allowing shell.
//!   PR Reviewer's default therefore omits `--yolo` and `--mode`, so the CLI
//!   keeps its allowlist prompts. Shell still runs; writes are not free.

use std::path::Path;

/// Bytes, not characters. Windows `CreateProcess` rejects command lines past
/// 32,767 bytes. 24,000 leaves room for the executable path and the flags.
pub const MAX_PROMPT_ARG_BYTES: usize = 24_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    Default,
    /// Settings label: Run Everything. Passes `--yolo`.
    Yolo,
    /// Settings label: Auto-review. Passes `--auto-review`.
    AutoReview,
    Plan,
    Ask,
}

impl RunMode {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "yolo" | "run-everything" | "runeverything" => Self::Yolo,
            "auto-review" | "autoreview" => Self::AutoReview,
            "plan" => Self::Plan,
            "ask" => Self::Ask,
            _ => Self::Default,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramArgs {
    pub program: String,
    pub args: Vec<String>,
}

/// Mode flags for one role, then `--approve-mcps --trust`.
/// An override replaces only the mode portion.
pub fn role_terminal_flags(role_id: &str, mode: RunMode) -> Vec<String> {
    let mut args = Vec::new();
    match effective_mode(role_id, mode) {
        Effective::Yolo => args.push("--yolo".to_string()),
        Effective::AutoReview => args.push("--auto-review".to_string()),
        Effective::Plan => args.push("--plan".to_string()),
        Effective::Ask => {
            args.push("--mode".to_string());
            args.push("ask".to_string());
        }
        Effective::Prompts => {}
    }
    args.push("--approve-mcps".to_string());
    args.push("--trust".to_string());
    args
}

/// Put `--model <id>` first. An invalid id is dropped, so the CLI's own
/// default applies instead of a bad argument.
pub fn with_model(model: Option<&str>, args: Vec<String>) -> Vec<String> {
    match model
        .map(str::trim)
        .filter(|id| crate::models::valid_model_id(id))
    {
        Some(id) => {
            let mut out = vec!["--model".to_string(), id.to_string()];
            out.extend(args);
            out
        }
        None => args,
    }
}

/// Interactive `agent` with no policy flags. Used by the plain Cursor CLI tab.
pub fn plain_agent_args() -> Vec<String> {
    Vec::new()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptDelivery {
    /// Positional argument passed to `agent`.
    pub argument: String,
    /// When set, write this body to the prompt file before spawn.
    pub stored_body: Option<String>,
}

/// Inline the prompt when it fits. Otherwise the argument tells `agent` to
/// read the file, and `stored_body` is what the caller writes there.
pub fn deliver_prompt(prompt: &str, file_path: &Path) -> PromptDelivery {
    if prompt.len() <= MAX_PROMPT_ARG_BYTES {
        return PromptDelivery {
            argument: prompt.to_string(),
            stored_body: None,
        };
    }
    let path = file_path.display();
    PromptDelivery {
        argument: format!(
            "Read and follow the instructions in {path} exactly. That file is your startup prompt."
        ),
        stored_body: Some(prompt.to_string()),
    }
}

/// Startup text for a hand-off opened as a terminal.
/// The merged role prompt is kept when it already contains the plan.
/// Developer (no plan field) gets the plan appended.
pub fn handoff_terminal_prompt(merged: &str, plan: &str) -> String {
    let merged = merged.trim();
    let plan = plan.trim();
    if plan.is_empty() {
        return merged.to_string();
    }
    if merged.is_empty() || merged.contains(plan) {
        return if merged.is_empty() {
            plan.to_string()
        } else {
            merged.to_string()
        };
    }
    format!("{merged}\n\nApproved plan from the Planner hand-off:\n\n{plan}")
}

pub fn role_agent_command(
    program: &str,
    role_id: &str,
    mode: RunMode,
    model: Option<&str>,
    prompt: Option<&str>,
) -> ProgramArgs {
    let mut args = with_model(model, role_terminal_flags(role_id, mode));
    if let Some(prompt) = prompt.map(str::trim).filter(|text| !text.is_empty()) {
        args.push(prompt.to_string());
    }
    ProgramArgs {
        program: program.to_string(),
        args,
    }
}

#[derive(Clone, Copy)]
enum Effective {
    Yolo,
    AutoReview,
    Plan,
    Ask,
    Prompts,
}

fn effective_mode(role_id: &str, mode: RunMode) -> Effective {
    match mode {
        RunMode::Yolo => Effective::Yolo,
        RunMode::AutoReview => Effective::AutoReview,
        RunMode::Plan => Effective::Plan,
        RunMode::Ask => Effective::Ask,
        RunMode::Default => match role_family(role_id) {
            Family::FullAccess => Effective::Yolo,
            Family::Planner => Effective::Plan,
            Family::General => Effective::Ask,
            Family::Reviewer | Family::Other => Effective::Prompts,
        },
    }
}

enum Family {
    FullAccess,
    Planner,
    General,
    Reviewer,
    Other,
}

fn role_family(role_id: &str) -> Family {
    let normalized = role_id.trim().to_ascii_lowercase().replace('-', "_");
    match normalized.as_str() {
        "role_implementer" | "implementer" | "role_developer" | "developer" => Family::FullAccess,
        "role_planner" | "planner" => Family::Planner,
        "role_general" | "general" => Family::General,
        "role_pr_reviewer" | "role_reviewer" | "pr_reviewer" | "reviewer" => Family::Reviewer,
        _ => Family::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn implementer_and_developer_run_everything() {
        let expected = vec!["--yolo", "--approve-mcps", "--trust"];
        assert_eq!(
            role_terminal_flags("role_implementer", RunMode::Default),
            expected
        );
        assert_eq!(
            role_terminal_flags("role_developer", RunMode::Default),
            expected
        );
    }

    #[test]
    fn planner_uses_plan_and_general_uses_ask() {
        assert_eq!(
            role_terminal_flags("role_planner", RunMode::Default),
            vec!["--plan", "--approve-mcps", "--trust"]
        );
        assert_eq!(
            role_terminal_flags("role_general", RunMode::Default),
            vec!["--mode", "ask", "--approve-mcps", "--trust"]
        );
    }

    #[test]
    fn reviewer_keeps_approval_prompts() {
        let flags = role_terminal_flags("role_pr_reviewer", RunMode::Default);
        assert_eq!(flags, vec!["--approve-mcps", "--trust"]);
        assert!(!flags.iter().any(|flag| flag == "--yolo"
            || flag == "--force"
            || flag == "--mode"
            || flag == "--plan"));
    }

    #[test]
    fn settings_override_replaces_only_the_mode_flag() {
        assert_eq!(
            role_terminal_flags("role_implementer", RunMode::Plan),
            vec!["--plan", "--approve-mcps", "--trust"]
        );
        assert_eq!(
            role_terminal_flags("role_pr_reviewer", RunMode::AutoReview),
            vec!["--auto-review", "--approve-mcps", "--trust"]
        );
        assert_eq!(
            role_terminal_flags("role_planner", RunMode::Yolo),
            vec!["--yolo", "--approve-mcps", "--trust"]
        );
        assert_eq!(RunMode::parse("auto-review"), RunMode::AutoReview);
        assert_eq!(RunMode::parse("nope"), RunMode::Default);
    }

    #[test]
    fn model_goes_first_and_bad_ids_are_dropped() {
        let args = with_model(
            Some("composer-2.5"),
            role_terminal_flags("role_planner", RunMode::Default),
        );
        assert_eq!(&args[..3], &["--model", "composer-2.5", "--plan"]);
        assert_eq!(with_model(Some("--yolo"), vec!["x".to_string()]), vec!["x"]);
        assert_eq!(with_model(None, Vec::new()), Vec::<String>::new());
    }

    #[test]
    fn plain_cursor_cli_tab_has_no_flags() {
        assert!(plain_agent_args().is_empty());
    }

    #[test]
    fn short_prompt_is_the_positional_argument() {
        let command = role_agent_command(
            "agent",
            "role_planner",
            RunMode::Default,
            None,
            Some("Ship it"),
        );
        assert_eq!(command.program, "agent");
        assert_eq!(command.args.last().map(String::as_str), Some("Ship it"));
        assert_eq!(command.args[0], "--plan");
    }

    #[test]
    fn long_prompt_is_stored_and_the_argument_points_at_the_file() {
        let prompt = "x".repeat(MAX_PROMPT_ARG_BYTES + 8);
        let path = PathBuf::from("/tmp/dcterminal/prompt.txt");
        let delivery = deliver_prompt(&prompt, &path);
        let stored = delivery.stored_body.expect("overflow body");
        assert_eq!(stored, prompt);
        assert!(delivery.argument.contains("/tmp/dcterminal/prompt.txt"));
        assert!(!delivery.argument.contains(&prompt));
        assert!(delivery.argument.len() < MAX_PROMPT_ARG_BYTES);
    }

    #[test]
    fn handoff_prompt_keeps_a_merged_template_that_already_contains_the_plan() {
        let plan = "Replace the token check.";
        let merged = format!("You are the implementer.\n\n{plan}");
        assert_eq!(handoff_terminal_prompt(&merged, plan), merged);
    }

    #[test]
    fn handoff_prompt_appends_the_plan_when_the_template_has_no_plan_field() {
        let plan = "Add a regression test for login.";
        let merged = "You are the developer. Wait for instructions.";
        let prompt = handoff_terminal_prompt(merged, plan);
        assert!(prompt.starts_with(merged));
        assert!(prompt.contains(plan));
        assert!(prompt.contains("Approved plan from the Planner hand-off"));
    }
}
