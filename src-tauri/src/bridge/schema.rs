//! The `submit_result` tool: its definition, the per-stage check of its
//! arguments, and the words around it (the role-template instructions, the
//! Stop-hook block reason, the reply on success). Plan "Result schemas",
//! `schema: 1`. A check names every problem at once, so Claude can fix them
//! all in the same turn.

use super::folder::{ResultKind, SCHEMA};
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

/// Check `submit_result` arguments against the stage's schema. `Ok` holds
/// the arguments with only the schema's fields (and `schema: 1`); `Err`
/// names each problem.
pub fn validate(kind: ResultKind, args: &Value) -> Result<Value, Vec<String>> {
    match kind {
        ResultKind::Reviewer => validate_reviewer(args),
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
