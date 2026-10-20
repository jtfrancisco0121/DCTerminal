//! The `submit_result` tool: its definition, the per-stage check of its
//! arguments, and the words around it (the role-template instructions, the
//! Stop-hook block reason, the reply on success). Plan "Result schemas",
//! `schema: 1`. A check names every problem at once, so Claude can fix them
//! all in the same turn.
//!
//! The Planner has no tool: its tasks are a fenced JSON block inside the plan
//! it hands to ExitPlanMode (D11), checked by [`planner_tasks`] with the same
//! every-problem-at-once rule.

use super::folder::{PlannedTask, ResultKind, SCHEMA};
use serde_json::{json, Map, Value};

/// The tool's name on the `dcterminal` server.
pub const TOOL_NAME: &str = "submit_result";
/// The MCP server's name in `--mcp-config`.
pub const SERVER_NAME: &str = "dcterminal";
/// The tool's full name in Claude Code (`--allowedTools`, hook matchers).
pub const FULL_TOOL_NAME: &str = "mcp__dcterminal__submit_result";

pub const VERDICTS: [&str; 3] = ["APPROVED", "APPROVED_WITH_CHANGES", "CHANGES_REQUIRED"];
pub const SEVERITIES: [&str; 5] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
pub const MAX_FINDINGS: usize = 100;
pub const MAX_SUMMARY_CHARS: usize = 300;
/// `pr` and `file` are short references, not prose.
const MAX_REF_CHARS: usize = 300;

const REVIEWER_FIELDS: [&str; 3] = ["schema", "verdict", "findings"];
const FINDING_FIELDS: [&str; 5] = ["severity", "summary", "pr", "file", "regression"];

/// Pull requests an Implementer reports, and tasks a plan has (plan "Result schemas").
pub const MAX_PRS: usize = 8;
pub const MAX_TASKS: usize = 8;
const IMPLEMENTER_FIELDS: [&str; 5] = ["schema", "prs", "summary", "checks", "blocked"];
const PR_FIELDS: [&str; 4] = ["url", "branch", "title", "lane"];
const CHECK_FIELDS: [&str; 2] = ["command", "passed"];
const TASKS_FIELDS: [&str; 2] = ["schema", "tasks"];
const TASK_FIELDS: [&str; 5] = ["id", "title", "dependsOn", "manual", "summary"];
/// An Implementer's summary and a task's summary may be a paragraph or two.
const MAX_LONG_TEXT_CHARS: usize = 4000;
const MAX_CHECKS: usize = 50;

/// Check `submit_result` arguments against the stage's schema. `Ok` holds
/// the arguments with only the schema's fields (and `schema: 1`); `Err`
/// names each problem.
pub fn validate(kind: ResultKind, args: &Value) -> Result<Value, Vec<String>> {
    match kind {
        ResultKind::Reviewer => validate_reviewer(args),
        ResultKind::Implementer => validate_implementer(args),
        // The Planner reports through ExitPlanMode; its stage has no tool.
        ResultKind::Planner => Err(vec![format!(
            "the Planner hands its plan over through ExitPlanMode, not {TOOL_NAME}"
        )]),
    }
}

fn list(items: &[&str]) -> String {
    items.join(", ")
}

fn unknown_fields(object: &Map<String, Value>, at: &str, allowed: &[&str], problems: &mut Vec<String>) {
    for key in object.keys().filter(|key| !allowed.contains(&key.as_str())) {
        problems.push(format!("`{at}{key}` is not a field (allowed: {})", list(allowed)));
    }
}

fn validate_reviewer(args: &Value) -> Result<Value, Vec<String>> {
    let Some(object) = args.as_object() else {
        return Err(vec!["the arguments must be a JSON object with `verdict` and `findings`".to_string()]);
    };
    let mut problems = Vec::new();
    unknown_fields(object, "", &REVIEWER_FIELDS, &mut problems);
    match object.get("schema") {
        None => {}
        Some(value) if value.as_u64() == Some(u64::from(SCHEMA)) => {}
        Some(value) => problems.push(format!("`schema` must be {SCHEMA}, not {value}")),
    }
    let verdict = match object.get("verdict") {
        None => {
            problems.push(format!("`verdict` is missing: use one of {}", list(&VERDICTS)));
            None
        }
        Some(Value::String(text)) if VERDICTS.contains(&text.as_str()) => Some(text.clone()),
        Some(Value::String(text)) => {
            problems.push(format!(
                "`verdict` {text:?} is not one of {} (REQUEST CHANGES and REQUIRES REVISION are CHANGES_REQUIRED)",
                list(&VERDICTS)
            ));
            None
        }
        Some(other) => {
            problems.push(format!("`verdict` must be a string, not {other}"));
            None
        }
    };
    let mut findings = Vec::new();
    match object.get("findings") {
        None => problems.push("`findings` is missing: give a list, `[]` when there are none".to_string()),
        Some(Value::Array(items)) => {
            if items.len() > MAX_FINDINGS {
                problems.push(format!("`findings` has {} items; at most {MAX_FINDINGS}", items.len()));
            }
            for (index, item) in items.iter().enumerate() {
                if let Some(finding) = check_finding(index, item, &mut problems) {
                    findings.push(finding);
                }
            }
        }
        Some(other) => problems.push(format!("`findings` must be a list, not {other}")),
    }
    let listed = object.get("findings").and_then(Value::as_array).map_or(0, Vec::len);
    if verdict.as_deref() == Some("CHANGES_REQUIRED") && object.get("findings").is_some_and(Value::is_array) && listed == 0 {
        problems.push("`verdict` is CHANGES_REQUIRED but `findings` is empty: list what must change".to_string());
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(json!({ "schema": SCHEMA, "verdict": verdict, "findings": findings }))
}

fn check_finding(index: usize, item: &Value, problems: &mut Vec<String>) -> Option<Value> {
    let at = format!("findings[{index}]");
    let Some(object) = item.as_object() else {
        problems.push(format!("`{at}` must be an object with `severity` and `summary`"));
        return None;
    };
    let before = problems.len();
    unknown_fields(object, &format!("{at}."), &FINDING_FIELDS, problems);
    let mut out = Map::new();
    match object.get("severity") {
        None => problems.push(format!("`{at}.severity` is missing: use one of {}", list(&SEVERITIES))),
        Some(Value::String(text)) if SEVERITIES.contains(&text.as_str()) => {
            out.insert("severity".into(), json!(text));
        }
        Some(other) => problems.push(format!(
            "`{at}.severity` {} is not one of {}",
            other,
            list(&SEVERITIES)
        )),
    }
    match object.get("summary") {
        None => problems.push(format!("`{at}.summary` is missing")),
        Some(Value::String(text)) if text.trim().is_empty() => {
            problems.push(format!("`{at}.summary` is empty"));
        }
        Some(Value::String(text)) => {
            let chars = text.chars().count();
            if chars > MAX_SUMMARY_CHARS {
                problems.push(format!(
                    "`{at}.summary` is {chars} characters; at most {MAX_SUMMARY_CHARS}"
                ));
            } else {
                out.insert("summary".into(), json!(text.trim()));
            }
        }
        Some(other) => problems.push(format!("`{at}.summary` must be a string, not {other}")),
    }
    for key in ["pr", "file"] {
        match object.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(text)) if text.chars().count() > MAX_REF_CHARS => {
                problems.push(format!("`{at}.{key}` is longer than {MAX_REF_CHARS} characters"));
            }
            Some(Value::String(text)) => {
                if !text.trim().is_empty() {
                    out.insert(key.into(), json!(text.trim()));
                }
            }
            Some(other) => problems.push(format!("`{at}.{key}` must be a string, not {other}")),
        }
    }
    match object.get("regression") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(flag)) => {
            out.insert("regression".into(), json!(flag));
        }
        Some(other) => problems.push(format!("`{at}.regression` must be true or false, not {other}")),
    }
    (problems.len() == before).then_some(Value::Object(out))
}

/// A required string field: trimmed, not empty, at most `max` characters.
fn required_text(object: &Map<String, Value>, at: &str, key: &str, max: usize, problems: &mut Vec<String>) -> Option<String> {
    match object.get(key) {
        None | Some(Value::Null) => {
            problems.push(format!("`{at}{key}` is missing"));
            None
        }
        Some(Value::String(text)) if text.trim().is_empty() => {
            problems.push(format!("`{at}{key}` is empty"));
            None
        }
        Some(Value::String(text)) => {
            let chars = text.trim().chars().count();
            if chars > max {
                problems.push(format!("`{at}{key}` is {chars} characters; at most {max}"));
                return None;
            }
            Some(text.trim().to_string())
        }
        Some(other) => {
            problems.push(format!("`{at}{key}` must be a string, not {other}"));
            None
        }
    }
}

fn no_whitespace(value: Option<String>, at: &str, problems: &mut Vec<String>) -> Option<String> {
    let text = value?;
    if text.chars().any(char::is_whitespace) {
        problems.push(format!("`{at}` {text:?} has spaces in it"));
        return None;
    }
    Some(text)
}

fn validate_implementer(args: &Value) -> Result<Value, Vec<String>> {
    let Some(object) = args.as_object() else {
        return Err(vec!["the arguments must be a JSON object with `prs` and `summary`".to_string()]);
    };
    let mut problems = Vec::new();
    unknown_fields(object, "", &IMPLEMENTER_FIELDS, &mut problems);
    match object.get("schema") {
        None => {}
        Some(value) if value.as_u64() == Some(u64::from(SCHEMA)) => {}
        Some(value) => problems.push(format!("`schema` must be {SCHEMA}, not {value}")),
    }
    // BLOCKED: `blocked` says why, and the pull requests may be none.
    let blocked = match object.get("blocked") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.trim().is_empty() => {
            problems.push("`blocked` is empty: say why you could not finish, or leave it out".to_string());
            None
        }
        Some(Value::String(text)) if text.trim().chars().count() > MAX_LONG_TEXT_CHARS => {
            problems.push(format!("`blocked` is longer than {MAX_LONG_TEXT_CHARS} characters"));
            None
        }
        Some(Value::String(text)) => Some(text.trim().to_string()),
        Some(other) => {
            problems.push(format!("`blocked` must be a string saying why you are blocked, not {other}"));
            None
        }
    };
    let blocked_field = object.get("blocked").is_some_and(|value| !value.is_null());
    let mut prs = Vec::new();
    match object.get("prs") {
        None if blocked_field => {}
        None => problems.push(format!(
            "`prs` is missing: list every draft pull request you opened (1 to {MAX_PRS}), each with `url`, `branch` and `title`, or say why you are blocked in `blocked`"
        )),
        Some(Value::Array(items)) => {
            if items.is_empty() && !blocked_field {
                problems.push(
                    "`prs` is empty: list the draft pull request you opened, or say why you are blocked in `blocked`".to_string(),
                );
            }
            if items.len() > MAX_PRS {
                problems.push(format!("`prs` has {} items; at most {MAX_PRS}", items.len()));
            }
            for (index, item) in items.iter().enumerate() {
                let at = format!("prs[{index}]");
                let Some(pr) = item.as_object() else {
                    problems.push(format!("`{at}` must be an object with `url`, `branch` and `title`"));
                    continue;
                };
                let before = problems.len();
                unknown_fields(pr, &format!("{at}."), &PR_FIELDS, &mut problems);
                let url = no_whitespace(required_text(pr, &format!("{at}."), "url", MAX_REF_CHARS, &mut problems), &format!("{at}.url"), &mut problems);
                if let Some(url) = url.as_deref() {
                    if !(url.starts_with("https://") || url.starts_with("http://")) {
                        problems.push(format!("`{at}.url` {url:?} is not a link to the pull request"));
                    }
                }
                let branch = no_whitespace(
                    required_text(pr, &format!("{at}."), "branch", MAX_REF_CHARS, &mut problems),
                    &format!("{at}.branch"),
                    &mut problems,
                );
                let title = required_text(pr, &format!("{at}."), "title", MAX_SUMMARY_CHARS, &mut problems);
                let lane = match pr.get("lane") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(text)) if text.trim().is_empty() => None,
                    Some(Value::String(text)) if text.trim().chars().count() <= 40 => Some(text.trim().to_string()),
                    Some(Value::String(_)) => {
                        problems.push(format!("`{at}.lane` is longer than 40 characters"));
                        None
                    }
                    Some(other) => {
                        problems.push(format!("`{at}.lane` must be a string such as \"pr1\", not {other}"));
                        None
                    }
                };
                if problems.len() == before {
                    let mut out = Map::new();
                    out.insert("url".into(), json!(url));
                    out.insert("branch".into(), json!(branch));
                    out.insert("title".into(), json!(title));
                    if let Some(lane) = lane {
                        out.insert("lane".into(), json!(lane));
                    }
                    prs.push(Value::Object(out));
                }
            }
        }
        Some(other) => problems.push(format!("`prs` must be a list, not {other}")),
    }
    let summary = required_text(object, "", "summary", MAX_LONG_TEXT_CHARS, &mut problems);
    let mut checks = Vec::new();
    match object.get("checks") {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => {
            if items.len() > MAX_CHECKS {
                problems.push(format!("`checks` has {} items; at most {MAX_CHECKS}", items.len()));
            }
            for (index, item) in items.iter().enumerate() {
                let at = format!("checks[{index}]");
                let Some(check) = item.as_object() else {
                    problems.push(format!("`{at}` must be an object with `command` and `passed`"));
                    continue;
                };
                let before = problems.len();
                unknown_fields(check, &format!("{at}."), &CHECK_FIELDS, &mut problems);
                let command = required_text(check, &format!("{at}."), "command", MAX_REF_CHARS, &mut problems);
                let passed = match check.get("passed") {
                    Some(Value::Bool(flag)) => Some(*flag),
                    None => {
                        problems.push(format!("`{at}.passed` is missing: true or false"));
                        None
                    }
                    Some(other) => {
                        problems.push(format!("`{at}.passed` must be true or false, not {other}"));
                        None
                    }
                };
                if problems.len() == before {
                    checks.push(json!({ "command": command, "passed": passed }));
                }
            }
        }
        Some(other) => problems.push(format!("`checks` must be a list, not {other}")),
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let mut out = json!({ "schema": SCHEMA, "prs": prs, "summary": summary });
    if object.get("checks").is_some_and(Value::is_array) {
        out["checks"] = json!(checks);
    }
    if let Some(blocked) = blocked {
        out["blocked"] = json!(blocked);
    }
    Ok(out)
}

/// The fenced code blocks of a markdown text: each block's info string
/// (`json`) and its body.
fn fenced_blocks(text: &str) -> Vec<(String, String)> {
    let mut blocks = Vec::new();
    // The open block: its fence character and length, info string and body.
    let mut open: Option<(char, usize, String, Vec<&str>)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        let fence = trimmed.chars().next().filter(|ch| *ch == '`' || *ch == '~');
        // `` ` `` and `~` are one byte each, so `run` is also a byte offset.
        let run = fence.map_or(0, |ch| trimmed.chars().take_while(|c| *c == ch).count());
        match open.take() {
            None => {
                if let Some(ch) = fence.filter(|_| run >= 3) {
                    open = Some((ch, run, trimmed[run..].trim().to_lowercase(), Vec::new()));
                }
            }
            Some((ch, len, info, mut body)) => {
                if fence == Some(ch) && run >= len && trimmed[run..].trim().is_empty() {
                    blocks.push((info, body.join("\n")));
                } else {
                    body.push(line);
                    open = Some((ch, len, info, body));
                }
            }
        }
    }
    blocks
}

/// The tasks of the plan Claude handed to ExitPlanMode: its last fenced
/// JSON block holding `tasks` (plan "Result schemas"). `Err` names each
/// problem, for the deny reason that sends Claude back to fix it.
pub fn planner_tasks(plan: &str) -> Result<Vec<PlannedTask>, Vec<String>> {
    if plan.trim().is_empty() {
        return Err(vec!["the plan is empty".to_string()]);
    }
    let mut unreadable = Vec::new();
    let mut found = None;
    for (info, body) in fenced_blocks(plan) {
        if !(info.is_empty() || info == "json" || info == "jsonc") {
            continue;
        }
        match serde_json::from_str::<Value>(&body) {
            Ok(value) if value.get("tasks").is_some() => found = Some(value),
            Ok(_) => {}
            Err(err) if info.starts_with("json") || body.contains("\"tasks\"") => {
                unreadable.push(format!("a ```json block is not valid JSON ({err})"));
            }
            Err(_) => {}
        }
    }
    let Some(value) = found else {
        let mut problems = unreadable;
        problems.push(format!(
            "the plan has no ```json block with `tasks`: add one under HANDOFF: Pull requests, with 1 to {MAX_TASKS} tasks"
        ));
        return Err(problems);
    };
    check_tasks(&value)
}

fn check_tasks(value: &Value) -> Result<Vec<PlannedTask>, Vec<String>> {
    let Some(object) = value.as_object() else {
        return Err(vec!["the tasks block must be a JSON object with `tasks`".to_string()]);
    };
    let mut problems = Vec::new();
    unknown_fields(object, "", &TASKS_FIELDS, &mut problems);
    match object.get("schema") {
        None => {}
        Some(value) if value.as_u64() == Some(u64::from(SCHEMA)) => {}
        Some(value) => problems.push(format!("`schema` must be {SCHEMA}, not {value}")),
    }
    let Some(items) = object.get("tasks").and_then(Value::as_array) else {
        problems.push(format!("`tasks` must be a list of 1 to {MAX_TASKS} tasks"));
        return Err(problems);
    };
    if items.is_empty() {
        problems.push("`tasks` is empty: a one-PR plan has one task".to_string());
    }
    if items.len() > MAX_TASKS {
        problems.push(format!("`tasks` has {} items; at most {MAX_TASKS}", items.len()));
    }
    let mut tasks = Vec::new();
    // Every task whose id reads, with its dependencies, for the checks
    // across tasks (named even when the task has other problems).
    let mut linked: Vec<(String, Vec<String>)> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let at = format!("tasks[{index}]");
        let Some(task) = item.as_object() else {
            problems.push(format!("`{at}` must be an object with `id`, `title`, `dependsOn`, `manual` and `summary`"));
            continue;
        };
        let before = problems.len();
        unknown_fields(task, &format!("{at}."), &TASK_FIELDS, &mut problems);
        let id = required_text(task, &format!("{at}."), "id", 20, &mut problems).map(|id| id.to_lowercase());
        if let Some(id) = id.as_deref() {
            if !valid_task_id(id) {
                problems.push(format!("`{at}.id` {id:?} must be pr1, pr2, … in plan order"));
            }
        }
        let title = required_text(task, &format!("{at}."), "title", MAX_SUMMARY_CHARS, &mut problems);
        let summary = required_text(task, &format!("{at}."), "summary", MAX_LONG_TEXT_CHARS, &mut problems);
        let depends_on: Vec<String> = match task.get("dependsOn") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(deps)) => deps
                .iter()
                .filter_map(|dep| match dep.as_str() {
                    Some(text) => Some(text.trim().to_lowercase()),
                    None => {
                        problems.push(format!("`{at}.dependsOn` must list task ids such as \"pr1\", not {dep}"));
                        None
                    }
                })
                .collect(),
            Some(other) => {
                problems.push(format!("`{at}.dependsOn` must be a list of task ids, not {other}"));
                Vec::new()
            }
        };
        let manual = match task.get("manual") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(other) => {
                problems.push(format!("`{at}.manual` must be true or false, not {other}"));
                false
            }
        };
        if let Some(id) = id.clone().filter(|id| valid_task_id(id)) {
            linked.push((id, depends_on.clone()));
        }
        if problems.len() == before {
            tasks.push(PlannedTask {
                id: id.unwrap_or_default(),
                title: title.unwrap_or_default(),
                depends_on,
                manual,
                summary: summary.unwrap_or_default(),
            });
        }
    }
    let ids: Vec<&str> = linked.iter().map(|(id, _)| id.as_str()).collect();
    for (index, (id, deps)) in linked.iter().enumerate() {
        if ids[..index].contains(&id.as_str()) {
            problems.push(format!("task id {id:?} is used twice"));
        }
        for dep in deps {
            if dep == id {
                problems.push(format!("{id} depends on itself"));
            } else if !ids.contains(&dep.as_str()) {
                problems.push(format!("{id} depends on {dep:?}, which is not a task"));
            }
        }
    }
    if problems.is_empty() {
        if let Some(cycle) = dependency_cycle(&tasks) {
            problems.push(format!("the dependencies go round in a circle ({})", cycle.join(" → ")));
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(tasks)
}

fn valid_task_id(id: &str) -> bool {
    id.strip_prefix("pr")
        .is_some_and(|n| !n.is_empty() && n.len() <= 2 && !n.starts_with('0') && n.chars().all(|ch| ch.is_ascii_digit()))
}

/// The first circle of dependencies, as ids (`pr1 → pr2 → pr1`), if any.
fn dependency_cycle(tasks: &[PlannedTask]) -> Option<Vec<String>> {
    fn visit<'a>(id: &'a str, tasks: &'a [PlannedTask], path: &mut Vec<&'a str>, done: &mut Vec<&'a str>) -> Option<Vec<String>> {
        if let Some(at) = path.iter().position(|seen| *seen == id) {
            let mut cycle: Vec<String> = path[at..].iter().map(|s| s.to_string()).collect();
            cycle.push(id.to_string());
            return Some(cycle);
        }
        if done.contains(&id) {
            return None;
        }
        path.push(id);
        let deps = tasks.iter().find(|t| t.id == id).map(|t| t.depends_on.as_slice()).unwrap_or_default();
        for dep in deps {
            if let Some(cycle) = visit(dep, tasks, path, done) {
                return Some(cycle);
            }
        }
        path.pop();
        done.push(id);
        None
    }
    let mut done = Vec::new();
    tasks.iter().find_map(|task| visit(&task.id, tasks, &mut Vec::new(), &mut done))
}

/// The Planner's result, as `results/<turn>.json` and the turn event carry it.
pub fn planner_result(tasks: &[PlannedTask]) -> Value {
    json!({ "schema": SCHEMA, "tasks": tasks })
}

/// The deny reason when the plan was taken: it ends the turn with no
/// approval dialog (V0 T7), and says not to start implementing.
pub const PLAN_RECEIVED: &str = "Plan received by DCTerminal. Stop here: do not start implementing and do not call ExitPlanMode again. End your turn with a short summary of the plan.";

/// The deny reason when the plan's tasks block has problems: Claude fixes
/// them and calls ExitPlanMode again in the same turn.
pub fn plan_rejected_message(problems: &[String]) -> String {
    let lines: Vec<String> = problems.iter().map(|p| format!("- {p}")).collect();
    format!(
        "DCTerminal did not take this plan. Fix each problem in the plan's ```json tasks block, then call ExitPlanMode again with the whole plan:\n{}\n{}",
        lines.join("\n"),
        TASKS_EXAMPLE
    )
}

const TASKS_EXAMPLE: &str = "Example: ```json\n{\"tasks\": [{\"id\": \"pr1\", \"title\": \"Token refresh\", \"dependsOn\": [], \"manual\": false, \"summary\": \"Refresh expired tokens in src/auth.ts.\"}]}\n```";

/// The tool as `tools/list` describes it.
pub fn tool_definition(kind: ResultKind) -> Value {
    match kind {
        ResultKind::Reviewer => json!({
            "name": TOOL_NAME,
            "title": "Submit result",
            "description": "Report this review's verdict and findings to DCTerminal. Call it once, before you finish your turn. If it returns an error, fix each problem it names and call it again.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "schema": { "type": "integer", "enum": [SCHEMA] },
                    "verdict": { "type": "string", "enum": VERDICTS },
                    "findings": {
                        "type": "array",
                        "maxItems": MAX_FINDINGS,
                        "items": {
                            "type": "object",
                            "properties": {
                                "severity": { "type": "string", "enum": SEVERITIES },
                                "summary": { "type": "string", "maxLength": MAX_SUMMARY_CHARS },
                                "pr": { "type": "string", "description": "PR1, PR2, …; omit with one pull request" },
                                "file": { "type": "string", "description": "path:line" },
                                "regression": { "type": "boolean" }
                            },
                            "required": ["severity", "summary"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["verdict", "findings"],
                "additionalProperties": false
            }
        }),
        ResultKind::Implementer => json!({
            "name": TOOL_NAME,
            "title": "Submit result",
            "description": "Report the draft pull requests you opened to DCTerminal, or why you are blocked. Call it once, before you finish your turn. If it returns an error, fix each problem it names and call it again.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "schema": { "type": "integer", "enum": [SCHEMA] },
                    "prs": {
                        "type": "array",
                        "maxItems": MAX_PRS,
                        "description": "every draft pull request you opened (at least one unless you are blocked)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "url": { "type": "string", "description": "the pull request's link" },
                                "branch": { "type": "string" },
                                "title": { "type": "string", "maxLength": MAX_SUMMARY_CHARS },
                                "lane": { "type": "string", "description": "pr1, pr2, …; only when this tab implements one pull request of several" }
                            },
                            "required": ["url", "branch", "title"],
                            "additionalProperties": false
                        }
                    },
                    "summary": { "type": "string", "maxLength": MAX_LONG_TEXT_CHARS },
                    "blocked": {
                        "type": "string",
                        "maxLength": MAX_LONG_TEXT_CHARS,
                        "description": "only when your Final Status is BLOCKED: why you could not finish"
                    },
                    "checks": {
                        "type": "array",
                        "maxItems": MAX_CHECKS,
                        "items": {
                            "type": "object",
                            "properties": {
                                "command": { "type": "string" },
                                "passed": { "type": "boolean" }
                            },
                            "required": ["command", "passed"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["summary"],
                "additionalProperties": false
            }
        }),
        // Never served: a Planner stage has no MCP server (it reports through ExitPlanMode).
        ResultKind::Planner => json!({
            "name": TOOL_NAME,
            "title": "Submit result",
            "description": "Not used by the Planner: hand your plan over with ExitPlanMode.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
    }
}

/// What `{{result_instructions}}` becomes on an engine-2 stage (D21). The
/// HANDOFF sections stay; this adds the tool call.
pub fn result_instructions(kind: ResultKind) -> String {
    match kind {
        ResultKind::Reviewer => format!(
            "## Report your result to DCTerminal\n\n\
             This stage runs in a DCTerminal pipeline. Before you finish your turn, call the `{TOOL_NAME}` tool \
             (MCP server `{SERVER_NAME}`, full name `{FULL_TOOL_NAME}`) once, with:\n\n\
             - `verdict`: `APPROVED`, `APPROVED_WITH_CHANGES` or `CHANGES_REQUIRED` (`REQUEST CHANGES` and `REQUIRES REVISION` are `CHANGES_REQUIRED`).\n\
             - `findings`: every finding from your review (at most {MAX_FINDINGS}), each with `severity` (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW` or `INFO`) and `summary` (one sentence, at most {MAX_SUMMARY_CHARS} characters), and optionally `pr` (`PR1`), `file` (`path:line`) and `regression` (`true` when it breaks something that worked before). Use `[]` when there are none.\n\n\
             Example: `{{\"verdict\": \"CHANGES_REQUIRED\", \"findings\": [{{\"severity\": \"HIGH\", \"file\": \"src/auth.ts:42\", \"summary\": \"An expired token returns 500 instead of 401.\"}}]}}`\n\n\
             If the tool answers with an error, fix each problem it names and call it again. Still end your reply with the HANDOFF sections above."
        ),
        ResultKind::Planner => format!(
            "## Hand your plan to DCTerminal\n\n\
             This stage runs in a DCTerminal pipeline. Hand your plan over by calling `ExitPlanMode` with the whole plan. \
             Under `HANDOFF: Pull requests`, add one fenced ```json block that lists the same units as tasks (1 to {MAX_TASKS}):\n\n\
             - `id`: `pr1`, `pr2`, … in the order of the list.\n\
             - `title`: the unit's short title.\n\
             - `dependsOn`: the ids it builds on (`[]` when none).\n\
             - `manual`: `true` for a step that is not a pull request (a release, a deploy, a configuration change).\n\
             - `summary`: what the unit covers, in a sentence or two.\n\n\
             A plan that ships as one pull request has one task. {TASKS_EXAMPLE}\n\n\
             DCTerminal answers ExitPlanMode with \"Plan received\": stop there and end your turn with a short summary; do not start implementing. \
             If it answers with problems instead, fix each one and call ExitPlanMode again."
        ),
        ResultKind::Implementer => format!(
            "## Report your result to DCTerminal\n\n\
             This stage runs in a DCTerminal pipeline. When your draft pull requests are open, and before you finish your turn, call the `{TOOL_NAME}` tool \
             (MCP server `{SERVER_NAME}`, full name `{FULL_TOOL_NAME}`) once, with:\n\n\
             - `prs`: every draft pull request you opened (1 to {MAX_PRS}), each with `url`, `branch` and `title`, and `lane` (`pr1`) when this tab implements one pull request of several.\n\
             - `summary`: what you built, in a few sentences.\n\
             - `checks` (optional): each check you ran, as `{{\"command\": \"npm test\", \"passed\": true}}`.\n\
             - `blocked` (only when your Final Status is `BLOCKED`): why you could not finish. `prs` may then be `[]`.\n\n\
             Example: `{{\"prs\": [{{\"url\": \"https://github.com/acme/app/pull/12\", \"branch\": \"feat/token-refresh\", \"title\": \"Refresh expired tokens\"}}], \"summary\": \"Expired tokens are refreshed once before a request fails.\", \"checks\": [{{\"command\": \"npm test\", \"passed\": true}}]}}`\n\n\
             If the tool answers with an error, fix each problem it names and call it again. Call it again after each later round too. Still end your reply with the HANDOFF sections."
        ),
    }
}

/// The Stop hook's block reason. It names the exact tool and arguments: a
/// vague reason made Claude ask the user instead (V0 T3, D10).
pub fn block_reason(kind: ResultKind) -> String {
    match kind {
        ResultKind::Reviewer => format!(
            "You have not reported your result yet. Call the `{FULL_TOOL_NAME}` tool now with your verdict and findings: \
             {{\"verdict\": \"APPROVED\" | \"APPROVED_WITH_CHANGES\" | \"CHANGES_REQUIRED\", \"findings\": [{{\"severity\": \"CRITICAL\" | \"HIGH\" | \"MEDIUM\" | \"LOW\" | \"INFO\", \"summary\": \"…\", \"file\": \"path:line\"}}]}} \
             (use [] when there are no findings). Do not ask the user; then finish your turn."
        ),
        ResultKind::Planner => "You have not handed your plan to DCTerminal yet. Call the `ExitPlanMode` tool now with your whole plan, \
             including one ```json block under HANDOFF: Pull requests with the tasks: \
             {\"tasks\": [{\"id\": \"pr1\", \"title\": \"…\", \"dependsOn\": [], \"manual\": false, \"summary\": \"…\"}]}. \
             Do not ask the user and do not start implementing; then finish your turn."
            .to_string(),
        ResultKind::Implementer => format!(
            "You have not reported your result yet. Call the `{FULL_TOOL_NAME}` tool now with the draft pull requests you opened: \
             {{\"prs\": [{{\"url\": \"https://…/pull/N\", \"branch\": \"…\", \"title\": \"…\"}}], \"summary\": \"…\", \"checks\": [{{\"command\": \"…\", \"passed\": true}}]}}. \
             If you are blocked and opened none, say why instead: {{\"prs\": [], \"summary\": \"…\", \"blocked\": \"…\"}}. \
             Do not ask the user; then finish your turn."
        ),
    }
}

/// The tool's reply when the result was accepted.
pub fn accepted_message(kind: ResultKind, result: &Value) -> String {
    match kind {
        ResultKind::Reviewer => {
            let verdict = result.get("verdict").and_then(Value::as_str).unwrap_or("?");
            let count = result.get("findings").and_then(Value::as_array).map_or(0, Vec::len);
            format!("DCTerminal received your result: {verdict} with {count} finding(s). Finish your turn now.")
        }
        ResultKind::Implementer => {
            let count = result.get("prs").and_then(Value::as_array).map_or(0, Vec::len);
            let blocked = if result.get("blocked").is_some() { ", blocked" } else { "" };
            format!("DCTerminal received your result: {count} pull request(s){blocked}. Finish your turn now.")
        }
        ResultKind::Planner => PLAN_RECEIVED.to_string(),
    }
}

/// The tool's reply when the arguments were rejected: every problem, one per line.
pub fn rejected_message(problems: &[String]) -> String {
    let lines: Vec<String> = problems.iter().map(|p| format!("- {p}")).collect();
    format!(
        "DCTerminal did not accept this result. Fix each problem and call {TOOL_NAME} again:\n{}",
        lines.join("\n")
    )
}
