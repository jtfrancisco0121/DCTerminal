//! F1: the `artifact` result (`schema: 1`). An artifact stage (the Analyst,
//! PM and Architect roles) writes documents into the run folder and reports
//! them through `submit_result`:
//!
//! - `status`: `complete`, `partial` (decisions are missing: `openQuestions`
//!   lists them) or `blocked` (`reason` says why).
//! - `artifacts[]`: the documents, as paths relative to the run folder. Each
//!   must be a file that exists inside the run folder (a link out of it is
//!   refused), at most [`MAX_ARTIFACTS`], and none of the files the app or
//!   the bridge keep there (`tasks.json`, `stages/`, …).
//! - `openQuestions[]`: required, and not empty, when `partial`.
//! - `reason`: required when `blocked`.
//! - `summary`: what the documents say, in a few sentences.
//!
//! Like every check here, it names each problem at once so Claude fixes them
//! all in the same turn.

use super::folder::SCHEMA;
use super::schema::{FULL_TOOL_NAME, SERVER_NAME, TOOL_NAME};
use serde_json::{json, Map, Value};
use std::path::{Component, Path};

/// Documents one result may list.
pub const MAX_ARTIFACTS: usize = 20;
/// Open questions one result may list.
pub const MAX_QUESTIONS: usize = 20;
/// One open question is a sentence or two.
pub const MAX_QUESTION_CHARS: usize = 1_000;
const MAX_PATH_CHARS: usize = 300;
const MAX_TEXT_CHARS: usize = 4_000;
pub const STATUSES: [&str; 3] = ["complete", "partial", "blocked"];
const FIELDS: [&str; 6] = ["schema", "status", "artifacts", "openQuestions", "reason", "summary"];
/// Top-level files and folders of the run folder that belong to the app or
/// the bridge: never a stage's document.
const RESERVED: [&str; 11] = [
    "run.json",
    "repos.json",
    "tickets.json",
    "writeback.json",
    "plan.md",
    "tasks.json",
    "artifacts.json",
    "bridge.log",
    "stages",
    "inbox",
    "prs.json",
];

fn unknown_fields(object: &Map<String, Value>, problems: &mut Vec<String>) {
    for key in object.keys().filter(|key| !FIELDS.contains(&key.as_str())) {
        problems.push(format!("`{key}` is not a field (allowed: {})", FIELDS.join(", ")));
    }
}

fn text(object: &Map<String, Value>, key: &str, required: bool, problems: &mut Vec<String>) -> Option<String> {
    match object.get(key) {
        None | Some(Value::Null) => {
            if required {
                problems.push(format!("`{key}` is missing"));
            }
            None
        }
        Some(Value::String(text)) if text.trim().is_empty() => {
            if required {
                problems.push(format!("`{key}` is empty"));
            }
            None
        }
        Some(Value::String(text)) if text.trim().chars().count() > MAX_TEXT_CHARS => {
            problems.push(format!("`{key}` is longer than {MAX_TEXT_CHARS} characters"));
            None
        }
        Some(Value::String(text)) => Some(text.trim().to_string()),
        Some(other) => {
            problems.push(format!("`{key}` must be a string, not {other}"));
            None
        }
    }
}

/// A document path as written, made plain (`./docs/brief.md` → `docs/brief.md`).
/// `Err` says why it is not a path inside the run folder at all.
fn plain_path(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("is empty".into());
    }
    if raw.chars().count() > MAX_PATH_CHARS {
        return Err(format!("is longer than {MAX_PATH_CHARS} characters"));
    }
    let unix = raw.replace('\\', "/");
    let looks_absolute = unix.starts_with('/') || unix.chars().nth(1) == Some(':') || Path::new(raw).is_absolute();
    if looks_absolute {
        return Err("is not relative to the run folder: give the path inside it, such as \"brief.md\"".into());
    }
    let mut parts = Vec::new();
    for part in Path::new(&unix).components() {
        match part {
            Component::Normal(name) => parts.push(name.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return Err("climbs out of the run folder (`..`): write the document inside it".into()),
        }
    }
    if parts.is_empty() {
        return Err("names no file".into());
    }
    let first = parts[0].as_str();
    let reserved = RESERVED.contains(&first)
        || first.starts_with('.')
        || (parts.len() == 1 && ((first.starts_with("prs-") || first.starts_with("findings-")) && first.ends_with(".json")));
    if reserved {
        return Err("is one of the files DCTerminal keeps in the run folder: write your document under its own name, such as \"brief.md\"".into());
    }
    Ok(parts.join("/"))
}

/// `path` (plain, relative) is a file inside `run_dir`, links resolved.
fn inside(run_dir: &Path, path: &str) -> Result<(), String> {
    let full = run_dir.join(path);
    let meta = std::fs::metadata(&full).map_err(|_| format!("does not exist in the run folder ({})", full.display()))?;
    if !meta.is_file() {
        return Err("is not a file".into());
    }
    let root = std::fs::canonicalize(run_dir).map_err(|err| format!("could not be checked ({err})"))?;
    let real = std::fs::canonicalize(&full).map_err(|err| format!("could not be checked ({err})"))?;
    if !real.starts_with(&root) {
        return Err("leads out of the run folder (a link): write the document itself there".into());
    }
    Ok(())
}

/// Check an artifact stage's `submit_result` arguments. With `run_dir`, each
/// document must also be a file inside that folder; without, only the shape
/// is checked. `Ok` holds the arguments with only the schema's fields.
pub fn validate(args: &Value, run_dir: Option<&Path>) -> Result<Value, Vec<String>> {
    let Some(object) = args.as_object() else {
        return Err(vec!["the arguments must be a JSON object with `status`, `artifacts` and `summary`".to_string()]);
    };
    let mut problems = Vec::new();
    unknown_fields(object, &mut problems);
    match object.get("schema") {
        None => {}
        Some(value) if value.as_u64() == Some(u64::from(SCHEMA)) => {}
        Some(value) => problems.push(format!("`schema` must be {SCHEMA}, not {value}")),
    }
    let status = match object.get("status") {
        None | Some(Value::Null) => {
            problems.push(format!("`status` is missing: use one of {}", STATUSES.join(", ")));
            None
        }
        Some(Value::String(text)) if STATUSES.contains(&text.trim()) => Some(text.trim().to_string()),
        Some(other) => {
            problems.push(format!("`status` {other} is not one of {}", STATUSES.join(", ")));
            None
        }
    };
    let mut artifacts: Vec<String> = Vec::new();
    match object.get("artifacts") {
        None | Some(Value::Null) => problems.push(
            "`artifacts` is missing: list the documents you wrote, as paths inside the run folder (`[]` when you wrote none)".to_string(),
        ),
        Some(Value::Array(items)) => {
            if items.len() > MAX_ARTIFACTS {
                problems.push(format!("`artifacts` has {} items; at most {MAX_ARTIFACTS}", items.len()));
            }
            for (index, item) in items.iter().enumerate() {
                let at = format!("artifacts[{index}]");
                let Some(raw) = item.as_str() else {
                    problems.push(format!("`{at}` must be a path such as \"brief.md\", not {item}"));
                    continue;
                };
                let checked = plain_path(raw).and_then(|path| match run_dir {
                    Some(dir) => inside(dir, &path).map(|()| path),
                    None => Ok(path),
                });
                match checked {
                    Err(why) => problems.push(format!("`{at}` {raw:?} {why}")),
                    Ok(path) if artifacts.contains(&path) => problems.push(format!("`{at}` {raw:?} is listed twice")),
                    Ok(path) => artifacts.push(path),
                }
            }
        }
        Some(other) => problems.push(format!("`artifacts` must be a list of paths, not {other}")),
    }
    let mut questions: Vec<String> = Vec::new();
    match object.get("openQuestions") {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => {
            if items.len() > MAX_QUESTIONS {
                problems.push(format!("`openQuestions` has {} items; at most {MAX_QUESTIONS}", items.len()));
            }
            for (index, item) in items.iter().enumerate() {
                match item {
                    Value::String(text) if text.trim().is_empty() => {}
                    Value::String(text) if text.trim().chars().count() > MAX_QUESTION_CHARS => {
                        problems.push(format!("`openQuestions[{index}]` is longer than {MAX_QUESTION_CHARS} characters"));
                    }
                    Value::String(text) => questions.push(text.trim().to_string()),
                    other => problems.push(format!("`openQuestions[{index}]` must be a string, not {other}")),
                }
            }
        }
        Some(other) => problems.push(format!("`openQuestions` must be a list of questions, not {other}")),
    }
    let reason = text(object, "reason", status.as_deref() == Some("blocked"), &mut problems);
    let summary = text(object, "summary", true, &mut problems);
    match status.as_deref() {
        Some("complete") => {
            if artifacts.is_empty() && object.get("artifacts").is_some_and(Value::is_array) {
                problems.push("`status` is complete but `artifacts` is empty: list the documents you wrote".to_string());
            }
            if !questions.is_empty() {
                problems.push("`status` is complete but `openQuestions` lists questions: use `partial` to ask them".to_string());
            }
        }
        Some("partial") if questions.is_empty() => {
            problems.push("`status` is partial, so list in `openQuestions` the decisions you need from the user".to_string());
        }
        _ => {}
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let mut out = json!({ "schema": SCHEMA, "status": status, "artifacts": artifacts, "openQuestions": questions, "summary": summary });
    if let Some(reason) = reason {
        out["reason"] = json!(reason);
    }
    Ok(out)
}

/// The tool as `tools/list` describes it to an artifact stage.
pub fn tool_definition() -> Value {
    json!({
        "name": TOOL_NAME,
        "title": "Submit result",
        "description": "Report the documents you wrote into the run folder to DCTerminal, with open questions when decisions are missing. Call it once, before you finish your turn. If it returns an error, fix each problem it names and call it again.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "schema": { "type": "integer", "enum": [SCHEMA] },
                "status": { "type": "string", "enum": STATUSES },
                "artifacts": {
                    "type": "array",
                    "maxItems": MAX_ARTIFACTS,
                    "items": { "type": "string", "description": "a path relative to the run folder, such as brief.md" }
                },
                "openQuestions": {
                    "type": "array",
                    "maxItems": MAX_QUESTIONS,
                    "description": "the decisions you need from the user (required when status is partial)",
                    "items": { "type": "string", "maxLength": MAX_QUESTION_CHARS }
                },
                "reason": { "type": "string", "maxLength": MAX_TEXT_CHARS, "description": "only when status is blocked: why" },
                "summary": { "type": "string", "maxLength": MAX_TEXT_CHARS }
            },
            "required": ["status", "artifacts", "summary"],
            "additionalProperties": false
        }
    })
}

/// What `{{result_instructions}}` becomes on an artifact stage (D21).
pub fn result_instructions() -> String {
    format!(
        "## Report your result to DCTerminal\n\n\
         This stage runs in a DCTerminal pipeline. Write your document into this run's folder (its path is below), \
         then, before you finish your turn, call the `{TOOL_NAME}` tool (MCP server `{SERVER_NAME}`, full name `{FULL_TOOL_NAME}`) once, with:\n\n\
         - `status`: `complete` when the document is done; `partial` when decisions are missing that only the user can make; \
         `blocked` when you cannot write it at all.\n\
         - `artifacts`: the documents you wrote, as paths relative to the run folder (`[\"brief.md\"]`), at most {MAX_ARTIFACTS}. Each must exist.\n\
         - `openQuestions` (required with `partial`): each decision you need, one short question each.\n\
         - `reason` (required with `blocked`): why you cannot go on.\n\
         - `summary`: what the document says, in a few sentences.\n\n\
         Example: `{{\"status\": \"partial\", \"artifacts\": [\"brief.md\"], \"openQuestions\": [\"Is offline use in scope?\"], \"summary\": \"The brief covers the sync problem; scope waits on one decision.\"}}`\n\n\
         With `partial` or `blocked` the run waits for the user, whose answers come back to you in this session: update the document then and report again. \
         If the tool answers with an error, fix each problem it names and call it again."
    )
}

/// The run folder section added to an artifact stage's instructions at launch.
pub fn run_folder_section(run_dir: &Path) -> String {
    format!(
        "### This run's folder\n\n\
         Write your documents in `{}` (for example `{}`), and list them in `artifacts` relative to that folder. \
         Documents the stages before you wrote are there too.",
        run_dir.display(),
        run_dir.join("brief.md").display()
    )
}

/// The Stop hook's block reason on an artifact stage.
pub fn block_reason() -> String {
    format!(
        "You have not reported your result yet. Call the `{FULL_TOOL_NAME}` tool now with the documents you wrote into the run folder: \
         {{\"status\": \"complete\" | \"partial\" | \"blocked\", \"artifacts\": [\"brief.md\"], \"openQuestions\": [\"…\"], \"summary\": \"…\"}} \
         (`openQuestions` with partial, `reason` with blocked). Do not ask the user; then finish your turn."
    )
}

/// The tool's reply when the result was accepted.
pub fn accepted_message(result: &Value) -> String {
    let status = result.get("status").and_then(Value::as_str).unwrap_or("?");
    let count = result.get("artifacts").and_then(Value::as_array).map_or(0, Vec::len);
    let waits = if status == "complete" { "" } else { " The run waits for the user's answer." };
    format!("DCTerminal received your result: {status} with {count} document(s).{waits} Finish your turn now.")
}

#[cfg(test)]
#[path = "artifact_tests.rs"]
mod tests;
