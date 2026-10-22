//! The values a stage terminal the actor opens is started with (D20): its
//! role's form, filled from the run folder and the run instead of from a
//! reply's text. The role template then merges them as for any start
//! (`template::merge_role_prompt_with`), so a role edited in Settings keeps
//! working.
//!
//! Fields are found by key, the way the frontend's hand-off mapping finds
//! them (`src/handoff/map.ts`): a plan field (`approvedPlan`, `plan`, …), a
//! request field (`originalTask`, `description`, …) and a context field
//! (`additionalContext`, …), plus `title`, `taskType` and the two behavior
//! fields when the role has them.
//!
//! - The plan is the run's approved plan when you promoted one, else the
//!   Planner's `plan.md`.
//! - The request is the step-1 form: a field named like "original task"
//!   gets every answer as one labelled block, any other request field the
//!   request itself.
//! - The context carries what the stage needs besides: a reviewer gets the
//!   pull requests, summary and checks from `prs.json` (once an Implementer
//!   reported some) and the findings its previous round sent back; a lane
//!   gets its task's line from `tasks.json`; a new terminal for a round sent
//!   back gets the findings.
//! - The context also points at the run's hand-off files (`plan.md`,
//!   `tasks.json`, `prs.json`, V4), so the stage can read them whole. Their
//!   content stays in the fields too: a role's template requires its plan
//!   field, and a stage may not be allowed to read outside its folder.

use crate::roles::Role;
use serde_json::Value;
use std::collections::HashMap;

const PLAN_KEYS: &[&str] = &[
    "approvedPlan",
    "plan",
    "implementationPlan",
    "candidatePlan",
    "proposedPlan",
    "reviewedPlan",
];
const REQUEST_KEYS: &[&str] = &[
    "description",
    "request",
    "originalTask",
    "originalRequest",
    "task",
    "requirements",
];
const CONTEXT_KEYS: &[&str] = &["additionalContext", "context", "notes"];

/// What a stage's values are built from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StageSources {
    /// The step-1 stage's form (the Planner's, or Eagle-Eye 2's Implementer's).
    pub first_answers: HashMap<String, String>,
    /// The step-1 stage's role.
    pub first_role: String,
    /// The approved plan, or the Planner's `plan.md`.
    pub plan: Option<String>,
    /// What the Implementer reported (`prs.json`'s `result`: `prs`, `summary`, `checks`).
    pub prs: Option<Value>,
    /// The finished turn's last message.
    pub reply: String,
    /// A round sent back to a new terminal: the message with the findings.
    pub findings: Option<String>,
    /// The findings this reviewer's previous round sent back, for its next review.
    pub previous_review: Option<String>,
    /// A lane's own task, from `tasks.json`.
    pub lane_note: Option<String>,
    /// The step-1 form's task type, when its own form has none.
    pub task_type: Option<String>,
    pub cwd: String,
    /// The run's hand-off files that exist, as (what, path): the plan, the
    /// tasks, the pull requests.
    pub run_files: Vec<(String, String)>,
}

/// A stage's form values, the text recorded as its hand-off on the run, and
/// a plan to add after the merged prompt (empty: the form carries it all).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StageValues {
    pub values: HashMap<String, String>,
    pub handoff_text: String,
    pub handoff_plan: String,
}

fn answer(values: &HashMap<String, String>, key: &str) -> String {
    values
        .get(key)
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

fn has(role: &Role, key: &str) -> bool {
    role.fields.iter().any(|field| field.key == key)
}

fn slot(role: &Role, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find(|key| has(role, key))
        .map(|key| key.to_string())
}

fn join(parts: &[String]) -> String {
    parts
        .iter()
        .filter(|p| !p.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The step-1 request's parts.
struct Request {
    title: String,
    task_type: String,
    request: String,
    expected: String,
    current: String,
}

impl Request {
    fn of(answers: &HashMap<String, String>, task_type: Option<&str>) -> Self {
        let request = Some(answer(answers, "request"))
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| answer(answers, "description"));
        Self {
            title: answer(answers, "title"),
            task_type: Some(answer(answers, "taskType"))
                .filter(|t| !t.is_empty())
                .or_else(|| task_type.map(str::to_string))
                .unwrap_or_default(),
            request,
            expected: answer(answers, "expectedBehavior"),
            current: answer(answers, "currentBehavior"),
        }
    }

    /// Every answer as one labelled block (`composeParts` in `map.ts`).
    fn composed(&self) -> String {
        let mut out = Vec::new();
        if !self.title.is_empty() {
            out.push(format!("Title: {}", self.title));
        }
        if !self.task_type.is_empty() {
            out.push(format!("Task type: {}", self.task_type));
        }
        if !self.request.is_empty() {
            out.push(if out.is_empty() {
                self.request.clone()
            } else {
                format!("Request:\n{}", self.request)
            });
        }
        if !self.expected.is_empty() {
            out.push(format!("Expected behavior:\n{}", self.expected));
        }
        if !self.current.is_empty() {
            out.push(format!("Current behavior:\n{}", self.current));
        }
        out.join("\n\n")
    }
}

/// A select field's option for `wanted` (the Planner's `Bug` is the
/// Implementer's `Bug Fix`), else `Other`, else the first option.
fn pick_option(options: &[String], wanted: &str) -> String {
    let wanted = match wanted.trim() {
        "Bug" => "Bug Fix",
        "Chore" => "Other",
        other => other,
    };
    let lower = wanted.to_ascii_lowercase();
    options
        .iter()
        .find(|o| o.to_ascii_lowercase() == lower)
        .or_else(|| {
            options
                .iter()
                .find(|o| !lower.is_empty() && o.to_ascii_lowercase().contains(&lower))
        })
        .or_else(|| options.iter().find(|o| o.as_str() == "Other"))
        .or_else(|| options.first())
        .cloned()
        .unwrap_or_default()
}

/// The pull requests, summary and checks an Implementer reported, for its reviewer.
fn pull_request_context(prs: &Value) -> String {
    let mut parts = Vec::new();
    let lines: Vec<String> = prs
        .get("prs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|pr| {
                    let text = |key: &str| pr.get(key).and_then(Value::as_str).unwrap_or_default();
                    let branch = Some(text("branch"))
                        .filter(|b| !b.is_empty())
                        .map(|b| format!(" (branch `{b}`)"))
                        .unwrap_or_default();
                    let title = Some(text("title"))
                        .filter(|t| !t.is_empty())
                        .map(|t| format!(": {t}"))
                        .unwrap_or_default();
                    format!("- {}{branch}{title}", text("url"))
                })
                .collect()
        })
        .unwrap_or_default();
    if lines.len() == 1 {
        parts.push(format!(
            "Pull request: {}",
            lines[0].trim_start_matches("- ")
        ));
    } else if !lines.is_empty() {
        parts.push(format!("Pull requests:\n{}", lines.join("\n")));
    }
    if let Some(summary) = prs
        .get("summary")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        parts.push(format!("Implementation summary:\n{}", summary.trim()));
    }
    let checks: Vec<String> = prs
        .get("checks")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|c| {
                    let command = c.get("command").and_then(Value::as_str).unwrap_or_default();
                    let passed = c.get("passed").and_then(Value::as_bool).unwrap_or(false);
                    format!("- {command}: {}", if passed { "passed" } else { "failed" })
                })
                .collect()
        })
        .unwrap_or_default();
    if !checks.is_empty() {
        parts.push(format!("Checks run:\n{}", checks.join("\n")));
    }
    join(&parts)
}

/// The lines that point a stage at the run's hand-off files.
fn run_files_note(files: &[(String, String)]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = files
        .iter()
        .map(|(what, path)| format!("- {what}: {path}"))
        .collect();
    format!(
        "This run's hand-off files (read them for the full detail):\n{}",
        lines.join("\n")
    )
}

/// The values `role`'s terminal starts with. `reviewer`: the stage reviews
/// the work before it (a stage with a loop-back).
pub fn stage_values(role: &Role, reviewer: bool, src: &StageSources) -> StageValues {
    let context_slot = slot(role, CONTEXT_KEYS);
    let findings = src.findings.clone().filter(|f| !f.trim().is_empty());
    // The step-1 stage again (a round sent back to a closed Planner): its
    // own form as you filled it in, with the findings added.
    if role.id == src.first_role && !src.first_answers.is_empty() {
        let mut values = src.first_answers.clone();
        values.insert("cwd".into(), src.cwd.clone());
        if let (Some(key), Some(findings)) = (context_slot.as_ref(), findings.as_ref()) {
            let before = answer(&values, key);
            values.insert(key.clone(), join(&[findings.clone(), before]));
        }
        return StageValues {
            values,
            handoff_text: findings.unwrap_or_default(),
            handoff_plan: String::new(),
        };
    }
    let parts = Request::of(&src.first_answers, src.task_type.as_deref());
    let mut values = HashMap::from([("cwd".to_string(), src.cwd.clone())]);
    if has(role, "title") && !parts.title.is_empty() {
        values.insert("title".into(), parts.title.clone());
    }
    if let Some(field) = role.fields.iter().find(|f| f.key == "taskType") {
        let options = field.options.clone().unwrap_or_default();
        let picked = if options.is_empty() {
            parts.task_type.clone()
        } else {
            pick_option(&options, &parts.task_type)
        };
        if !picked.is_empty() {
            values.insert("taskType".into(), picked);
        }
    }
    let own_expected = has(role, "expectedBehavior");
    let own_current = has(role, "currentBehavior");
    if own_expected && !parts.expected.is_empty() {
        values.insert("expectedBehavior".into(), parts.expected.clone());
    }
    if own_current && !parts.current.is_empty() {
        values.insert("currentBehavior".into(), parts.current.clone());
    }
    let plan = src
        .plan
        .clone()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| src.reply.trim().to_string());
    let plan_slot = slot(role, PLAN_KEYS);
    if let Some(key) = &plan_slot {
        if !plan.is_empty() {
            values.insert(key.clone(), plan.clone());
        }
    }
    if let Some(key) = slot(role, REQUEST_KEYS) {
        let whole = key.to_ascii_lowercase().contains("original")
            || key.to_ascii_lowercase().contains("requirement");
        let mut request = if whole {
            parts.composed()
        } else {
            let mut behaviors = Vec::new();
            if !own_expected && !parts.expected.is_empty() {
                behaviors.push(format!("Expected behavior:\n{}", parts.expected));
            }
            if !own_current && !parts.current.is_empty() {
                behaviors.push(format!("Current behavior:\n{}", parts.current));
            }
            join(&[vec![parts.request.clone()], behaviors].concat())
        };
        if request.is_empty() {
            request = if reviewer {
                "Review the work from the hand-off.".to_string()
            } else {
                "Implement the plan from the hand-off.".to_string()
            };
        }
        values.insert(key, request);
    }
    let mut context = Vec::new();
    if let Some(note) = &src.lane_note {
        context.push(note.clone());
    }
    if let Some(findings) = &findings {
        context.push(findings.clone());
    }
    if reviewer {
        if let Some(prs) = &src.prs {
            context.push(pull_request_context(prs));
        }
        if let Some(previous) = src
            .previous_review
            .as_ref()
            .filter(|p| !p.trim().is_empty())
        {
            context.push(format!(
                "The previous round was sent back with these findings. Check each one is resolved and say which in your review:\n{}",
                previous.trim()
            ));
        }
    }
    context.push(run_files_note(&src.run_files));
    context.push(answer(&src.first_answers, "additionalContext"));
    let context = join(&context);
    if let Some(key) = &context_slot {
        if !context.is_empty() {
            values.insert(key.clone(), context.clone());
        }
    }
    let handoff_text = if plan_slot.is_some() && !plan.is_empty() {
        plan
    } else {
        join(&[findings.unwrap_or_default(), context])
    };
    StageValues {
        values,
        handoff_text,
        handoff_plan: String::new(),
    }
}

/// The text a hand-off you filled in carries on the run: its plan field,
/// else its request field.
pub fn carried_text(role: &Role, values: &HashMap<String, String>) -> String {
    PLAN_KEYS
        .iter()
        .chain(REQUEST_KEYS)
        .filter(|key| has(role, key))
        .map(|key| answer(values, key))
        .find(|text| !text.is_empty())
        .unwrap_or_default()
}
