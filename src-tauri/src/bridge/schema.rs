//! The `submit_result` tool: its definition, the per-stage check of its
//! arguments, and the words around it (the role-template instructions, the
//! Stop-hook block reason, the reply on success). Plan "Result schemas",
//! `schema: 1`. A check names every problem at once, so Claude can fix them
//! all in the same turn.
//!
//! The Planner has no tool: its tasks are a fenced JSON block inside the plan
//! it hands to ExitPlanMode (D11), checked by [`planner_tasks`] with the same
//! every-problem-at-once rule. A task may name a `repo` from Settings ›
//! Repos (L1); the names come from the run folder's `repos.json`.

use super::folder::{PlannedStory, PlannedTask, ResultKind, StoryMark, SCHEMA};
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
const FINDING_FIELDS: [&str; 6] = ["severity", "summary", "pr", "file", "regression", "area"];
/// F2: what a finding is about, when it says. A plan reviewer's finding on
/// `brief`, `prd` or `architecture` (documents the Planner cannot edit in
/// plan mode) stops for you instead of going back to the Planner.
pub const FINDING_AREAS: [&str; 5] = ["plan", "code", "brief", "prd", "architecture"];

/// Pull requests an Implementer reports, and tasks a plan has (plan "Result schemas").
pub const MAX_PRS: usize = 8;
pub const MAX_TASKS: usize = 8;
const IMPLEMENTER_FIELDS: [&str; 6] = ["schema", "prs", "summary", "checks", "blocked", "story"];
const PR_FIELDS: [&str; 4] = ["url", "branch", "title", "lane"];
const CHECK_FIELDS: [&str; 2] = ["command", "passed"];
const TASKS_FIELDS: [&str; 2] = ["schema", "tasks"];
const TASK_FIELDS: [&str; 7] = ["id", "title", "dependsOn", "manual", "summary", "repo", "stories"];
/// Stories a task may list (L3), and the fields of one.
pub const MAX_STORIES: usize = 20;
const STORY_FIELDS: [&str; 6] = ["id", "title", "tickets", "doneWhen", "plannedTests", "checkpoint"];
/// Items of a story's `tickets`, `doneWhen` and `plannedTests` lists.
const MAX_STORY_ITEMS: usize = 20;
/// A story id (`s1`) is short: a reference, not a title.
const MAX_STORY_ID_CHARS: usize = 20;
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
        // F1: the shape only; the bridge checks the paths in the run folder.
        ResultKind::Artifact => super::artifact::validate(args, None),
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
    match object.get("area") {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) if FINDING_AREAS.contains(&text.trim().to_ascii_lowercase().as_str()) => {
            out.insert("area".into(), json!(text.trim().to_ascii_lowercase()));
        }
        Some(other) => problems.push(format!("`{at}.area` {other} is not one of {}", list(&FINDING_AREAS))),
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
    // L3: a story's turn may open no pull request yet; whether this story is
    // the one that must is checked against the stage's story (`check_story`).
    let story = match object.get("story") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.trim().is_empty() => None,
        Some(Value::String(text)) if text.trim().chars().count() > MAX_STORY_ID_CHARS => {
            problems.push(format!("`story` is longer than {MAX_STORY_ID_CHARS} characters: give the story's id, such as \"s1\""));
            None
        }
        Some(Value::String(text)) => Some(text.trim().to_lowercase()),
        Some(other) => {
            problems.push(format!("`story` must be the id of the story you finished, such as \"s1\", not {other}"));
            None
        }
    };
    let may_skip_prs = blocked_field || story.is_some();
    let mut prs = Vec::new();
    match object.get("prs") {
        None if may_skip_prs => {}
        None => problems.push(format!(
            "`prs` is missing: list every draft pull request you opened (1 to {MAX_PRS}), each with `url`, `branch` and `title`, or say why you are blocked in `blocked`"
        )),
        Some(Value::Array(items)) => {
            if items.is_empty() && !may_skip_prs {
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
    if let Some(story) = story {
        out["story"] = json!(story);
    }
    Ok(out)
}

/// An accepted Implementer result against the stage's story (L3, `mark`:
/// its `story.json`). While a story is current, the result must name it,
/// and the last story must list its pull request (unless blocked); a result
/// naming another story is refused with the current one named. Once every
/// story is done (a review round), `story` may be left out or name the last
/// one. With no stories, `story` must be left out. `Err` names each problem.
pub fn check_story(result: &Value, mark: Option<&StoryMark>) -> Result<(), Vec<String>> {
    let story = result.get("story").and_then(Value::as_str);
    let blocked = result.get("blocked").is_some();
    let no_prs = result.get("prs").and_then(Value::as_array).is_none_or(Vec::is_empty);
    let Some(mark) = mark.filter(|mark| !mark.ids.is_empty()) else {
        return match story {
            Some(story) => Err(vec![format!(
                "`story` {story:?}: this pull request has no stories, so leave `story` out"
            )]),
            None => Ok(()),
        };
    };
    let total = mark.ids.len();
    let Some(current) = mark.current.as_deref() else {
        let last = mark.ids.last().map(String::as_str);
        return match story {
            Some(story) if Some(story) != last => Err(vec![format!(
                "`story` {story:?}: every story of this pull request is done, so leave `story` out"
            )]),
            // A review round reports the pull request, never an empty list.
            _ if no_prs && !blocked => Err(vec![
                "`prs` is empty: every story is done, so list the draft pull request (each with `url`, `branch` and `title`)".to_string(),
            ]),
            _ => Ok(()),
        };
    };
    let number = mark.ids.iter().position(|id| id == current).map_or(0, |at| at + 1);
    let title = if mark.current_title.trim().is_empty() {
        String::new()
    } else {
        format!(" ({})", mark.current_title.trim())
    };
    let mut problems = Vec::new();
    match story {
        None if blocked => {}
        None => problems.push(format!(
            "`story` is missing: you are on story {current}{title}, {number} of {total}; set `story` to \"{current}\""
        )),
        Some(story) if story != current => problems.push(format!(
            "`story` {story:?} is not the current story: the current story is {current}{title}, {number} of {total}. Finish it and report it with `story` set to \"{current}\""
        )),
        Some(_) => {}
    }
    if number == total && no_prs && !blocked && story == Some(current) {
        problems.push(format!(
            "`prs` is empty: {current} is the last story, so list the draft pull request you opened (each with `url`, `branch` and `title`)"
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
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
/// problem, for the deny reason that sends Claude back to fix it. With no
/// repos set up, a task that names a `repo` is a problem.
pub fn planner_tasks(plan: &str) -> Result<Vec<PlannedTask>, Vec<String>> {
    planner_tasks_with(plan, &[])
}

/// [`planner_tasks`], where a task's `repo` must be one of `repos` (the
/// names in Settings › Repos, any case; kept as Settings spells it).
pub fn planner_tasks_with(plan: &str, repos: &[String]) -> Result<Vec<PlannedTask>, Vec<String>> {
    planner_tasks_checked(plan, repos, None)
}

/// [`planner_tasks_with`], where a story's `tickets` must be ids (or
/// custom ids, any case) of the run's `tickets.json` when it has one (L3).
pub fn planner_tasks_checked(plan: &str, repos: &[String], tickets: Option<&[String]>) -> Result<Vec<PlannedTask>, Vec<String>> {
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
    check_tasks(&value, repos, tickets)
}

fn check_tasks(value: &Value, repos: &[String], tickets: Option<&[String]>) -> Result<Vec<PlannedTask>, Vec<String>> {
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
            problems.push(format!("`{at}` must be an object with `id`, `title`, `dependsOn`, `manual` and `summary` (and `repo` when the plan spans repos)"));
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
        let repo = task_repo(task.get("repo"), &at, repos, &mut problems);
        let stories = task_stories(task.get("stories"), &at, manual, tickets, &mut problems);
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
                repo,
                stories,
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

/// A task's `stories` (L3): left out or `[]` for a pull request built in
/// one turn; else 1 to [`MAX_STORIES`] stories with unique ids. A manual
/// task has none, and the last story has no `checkpoint` (there is no next
/// story to wait for). Every problem is named, as for the tasks.
fn task_stories(
    value: Option<&Value>,
    at: &str,
    manual: bool,
    tickets: Option<&[String]>,
    problems: &mut Vec<String>,
) -> Vec<PlannedStory> {
    let items = match value {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(items)) if items.is_empty() => return Vec::new(),
        Some(Value::Array(items)) => items,
        Some(other) => {
            problems.push(format!("`{at}.stories` must be a list of stories, not {other}"));
            return Vec::new();
        }
    };
    if manual {
        problems.push(format!(
            "`{at}.stories`: a manual task is not built by an Implementer, so it has no stories; leave `stories` out or set `manual` to false"
        ));
        return Vec::new();
    }
    if items.len() > MAX_STORIES {
        problems.push(format!("`{at}.stories` has {} items; at most {MAX_STORIES}", items.len()));
    }
    let mut stories = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let at = format!("{at}.stories[{index}]");
        let Some(story) = item.as_object() else {
            problems.push(format!("`{at}` must be an object with `id` and `title`"));
            continue;
        };
        let before = problems.len();
        unknown_fields(story, &format!("{at}."), &STORY_FIELDS, problems);
        let id = required_text(story, &format!("{at}."), "id", MAX_STORY_ID_CHARS, problems).map(|id| id.to_lowercase());
        if let Some(id) = id.as_deref() {
            if !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
                problems.push(format!("`{at}.id` {id:?} must be letters and digits, such as \"s1\""));
            } else if ids.iter().any(|seen| seen == id) {
                problems.push(format!("story id {id:?} is used twice in {}", at.split(".stories").next().unwrap_or(&at)));
            } else {
                ids.push(id.to_string());
            }
        }
        let title = required_text(story, &format!("{at}."), "title", MAX_SUMMARY_CHARS, problems);
        let story_tickets = text_list(story.get("tickets"), &format!("{at}.tickets"), MAX_REF_CHARS, problems);
        for ticket in &story_tickets {
            if ticket.chars().any(char::is_whitespace) {
                problems.push(format!("`{at}.tickets` {ticket:?} has spaces in it: use the ticket id, such as \"86c0abc12\" or \"QA-129\""));
            } else if let Some(known) = tickets.filter(|known| !known.iter().any(|k| k.eq_ignore_ascii_case(ticket))) {
                let shown: Vec<&str> = known.iter().map(String::as_str).take(12).collect();
                problems.push(format!(
                    "`{at}.tickets` {ticket:?} is not a ticket of this run's tickets.json (it has {})",
                    if shown.is_empty() { "none".to_string() } else { list(&shown) }
                ));
            }
        }
        let done_when = text_list(story.get("doneWhen"), &format!("{at}.doneWhen"), MAX_SUMMARY_CHARS, problems);
        let planned_tests = text_list(story.get("plannedTests"), &format!("{at}.plannedTests"), MAX_SUMMARY_CHARS, problems);
        let checkpoint = match story.get("checkpoint") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) if text.trim().is_empty() => None,
            Some(Value::String(text)) if text.trim().chars().count() > MAX_LONG_TEXT_CHARS => {
                problems.push(format!("`{at}.checkpoint` is longer than {MAX_LONG_TEXT_CHARS} characters"));
                None
            }
            Some(Value::String(text)) => Some(text.trim().to_string()),
            Some(other) => {
                problems.push(format!("`{at}.checkpoint` must say what you do before the next story, not {other}"));
                None
            }
        };
        if checkpoint.is_some() && index + 1 == items.len() {
            problems.push(format!(
                "`{at}.checkpoint`: the last story has no next story to wait for; put the step in its `doneWhen` instead"
            ));
        }
        if problems.len() == before {
            stories.push(PlannedStory {
                id: id.unwrap_or_default(),
                title: title.unwrap_or_default(),
                tickets: story_tickets,
                done_when,
                planned_tests,
                checkpoint,
            });
        }
    }
    stories
}

/// An optional list of short texts (a story's tickets, done-when lines,
/// planned tests): trimmed, empty ones dropped, at most [`MAX_STORY_ITEMS`].
fn text_list(value: Option<&Value>, at: &str, max: usize, problems: &mut Vec<String>) -> Vec<String> {
    let items = match value {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(items)) => items,
        Some(other) => {
            problems.push(format!("`{at}` must be a list of strings, not {other}"));
            return Vec::new();
        }
    };
    if items.len() > MAX_STORY_ITEMS {
        problems.push(format!("`{at}` has {} items; at most {MAX_STORY_ITEMS}", items.len()));
    }
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        match item {
            Value::String(text) if text.trim().is_empty() => {}
            Value::String(text) if text.trim().chars().count() > max => {
                problems.push(format!("`{at}[{index}]` is longer than {max} characters"));
            }
            Value::String(text) => out.push(text.trim().to_string()),
            other => problems.push(format!("`{at}[{index}]` must be a string, not {other}")),
        }
    }
    out
}

/// A task's `repo` (L1): left out, `null` or `""` for the run's own folder;
/// else a name from Settings › Repos, in any case, returned as Settings
/// spells it. A name that is not there lists the ones that are, so Claude
/// fixes the plan in the same turn.
fn task_repo(value: Option<&Value>, at: &str, repos: &[String], problems: &mut Vec<String>) -> Option<String> {
    let name = match value {
        None | Some(Value::Null) => return None,
        Some(Value::String(text)) if text.trim().is_empty() => return None,
        Some(Value::String(text)) => text.trim(),
        Some(other) => {
            problems.push(format!("`{at}.repo` must be a repo name such as \"backend\", not {other}"));
            return None;
        }
    };
    if let Some(known) = repos.iter().find(|repo| repo.eq_ignore_ascii_case(name)) {
        return Some(known.clone());
    }
    problems.push(if repos.is_empty() {
        format!("`{at}.repo` {name:?} is not a repo: none are set up in DCTerminal's Settings › Repos, so leave `repo` out and the task is built in this run's folder")
    } else {
        format!(
            "`{at}.repo` {name:?} is not one of the repos in Settings › Repos ({}); leave it out for this run's own folder",
            list(&repos.iter().map(String::as_str).collect::<Vec<_>>())
        )
    });
    None
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

/// How a Planner splits a pull request into stories (L3).
const STORIES_GUIDE: &str = "A task may also list `stories`: the steps its one pull request is built in, in order, in one Implementer session \
on one branch, with the checks run after each. Use them for a pull request with several separate parts, and especially when \
the run has a tickets.json (one story per ticket or small group of tickets). Each story has `id` (`s1`, `s2`, …), `title`, and \
optionally `tickets` (ids from tickets.json), `doneWhen` and `plannedTests` (short lines), and `checkpoint`: what the user must \
do and report before the next story starts (for example a rerun on another machine). At most 20 stories; the last story has no \
`checkpoint`. Example task: {\"id\": \"pr1\", \"title\": \"Log fixes\", \"dependsOn\": [], \"manual\": false, \"summary\": \"…\", \
\"stories\": [{\"id\": \"s1\", \"title\": \"Add timing logs\", \"tickets\": [\"QA-12\"], \"checkpoint\": \"Rerun the 7,839-file case on Windows and report the log\"}, \
{\"id\": \"s2\", \"title\": \"Dedupe log lines\", \"doneWhen\": [\"Each line is written once\"], \"plannedTests\": [\"TestDedupe\"]}]}.";

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
                                "regression": { "type": "boolean" },
                                "area": { "type": "string", "enum": FINDING_AREAS, "description": "what it is about; prd or architecture for a problem in those documents" }
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
                    "story": {
                        "type": "string",
                        "maxLength": MAX_STORY_ID_CHARS,
                        "description": "only when your pull request is built in stories: the id of the story this turn finished (`prs` may be [] until the last story)"
                    },
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
        ResultKind::Artifact => super::artifact::tool_definition(),
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
             - `findings`: every finding from your review (at most {MAX_FINDINGS}), each with `severity` (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW` or `INFO`) and `summary` (one sentence, at most {MAX_SUMMARY_CHARS} characters), and optionally `pr` (`PR1`), `file` (`path:line`), `regression` (`true` when it breaks something that worked before) and `area` (`plan`, `code`, `brief`, `prd` or `architecture`: set `prd` or `architecture` when the problem is in that document, not in the plan). Use `[]` when there are none.\n\n\
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
             {STORIES_GUIDE}\n\n\
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
        ResultKind::Artifact => super::artifact::result_instructions(),
    }
}

/// [`result_instructions`] for a stage about to launch, with Settings ›
/// Repos (L1): a Planner is told which repos a plan can span, by name and
/// folder, and to set `repo` on each task when its plan spans them. With no
/// repos, or on any other stage, exactly [`result_instructions`].
pub fn stage_instructions(kind: ResultKind, repos: &[crate::store::RepoEntry]) -> String {
    stage_instructions_in(kind, repos, None)
}

/// [`stage_instructions`], where an artifact stage (F1) is also told the
/// run folder its documents go in (`run_dir`).
pub fn stage_instructions_in(kind: ResultKind, repos: &[crate::store::RepoEntry], run_dir: Option<&std::path::Path>) -> String {
    if kind == ResultKind::Artifact {
        let base = result_instructions(kind);
        return match run_dir {
            Some(dir) => format!("{base}\n\n{}", super::artifact::run_folder_section(dir)),
            None => base,
        };
    }
    let base = result_instructions(kind);
    if kind != ResultKind::Planner || repos.is_empty() {
        return base;
    }
    let lines: Vec<String> = repos.iter().map(|repo| format!("- `{}`: {}", repo.name, repo.folder)).collect();
    format!(
        "{base}\n\n\
         ### Repos\n\n\
         This run's own folder is the home repo. These repos are set up in DCTerminal (Settings › Repos):\n\n{}\n\n\
         When the plan spans repos, add `repo` to each task with the name of the repo its pull request is made in \
         (for example `\"repo\": \"{}\"`); each such task gets its own worktree in that repo. \
         Leave `repo` out for a task in this run's own folder. A task that builds on one in another repo lists it in `dependsOn` as usual, \
         so the backend's pull request is approved before its clients start.",
        lines.join("\n"),
        repos[0].name
    )
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
        ResultKind::Artifact => super::artifact::block_reason(),
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
            // L3: a story's result says which story it was.
            let story = result
                .get("story")
                .and_then(Value::as_str)
                .map(|story| format!(" for story {story}"))
                .unwrap_or_default();
            format!("DCTerminal received your result{story}: {count} pull request(s){blocked}. Finish your turn now.")
        }
        ResultKind::Planner => PLAN_RECEIVED.to_string(),
        ResultKind::Artifact => super::artifact::accepted_message(result),
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
