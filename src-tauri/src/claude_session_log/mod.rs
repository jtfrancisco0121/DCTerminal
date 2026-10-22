//! Read-only view of one terminal tab's Claude Code session transcript,
//! `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`.
//!
//! Shape (Claude Code 2.x, checked 2026-10): one JSON record per line. Main
//! chain records carry `isSidechain: false`; `type` is `user`, `assistant`,
//! `system` or bookkeeping (`mode`, `ai-title`, `file-history-snapshot`, …).
//! An assistant record holds one content block (`text`, `thinking`,
//! `tool_use {id,name,input}`) plus `message.stop_reason` (`tool_use`,
//! `end_turn`, `stop_sequence`, or null mid-stream). Tool results come back as
//! `user` records whose content is `tool_result {tool_use_id,is_error}`. A
//! `system` record with `subtype: turn_duration` follows a finished turn.
//! A real user prompt carries `permissionMode`. A `tool_use` is written before
//! the user answers its permission prompt, so an unanswered one in the current
//! turn is `openTool`.
//! Nothing under the config folder is created or written.
//!
//! `read_session_log` parses the file's tail in one go. The app reads through
//! `reader::SessionLogReader`, which keeps the parse and only reads the bytes
//! appended since the last read; `chat` turns the same records into ordered
//! chat entries and `watch` streams them to a view.

pub mod chat;
pub mod reader;
pub mod watch;

use crate::permissions::redact_summary;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MAX_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOOL_CALLS: usize = 500;
/// A long-lived parse drops its oldest tool calls past this many; the
/// summary only ever shows the newest `MAX_TOOL_CALLS`.
const KEEP_TOOL_CALLS: usize = 2 * MAX_TOOL_CALLS;
const TITLE_CHARS: usize = 200;
const COMMAND_CHARS: usize = 4000;
const URL_CHARS: usize = 2000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionLog {
    pub session_id: String,
    pub path: String,
    pub turn_done: bool,
    pub last_reply: String,
    pub plan: Option<String>,
    pub plan_at: Option<String>,
    pub last_prompt_at: Option<String>,
    /// The turn ended because you interrupted it (`[Request interrupted …]`),
    /// not because Claude finished. Autopilot leaves such a turn to you.
    pub interrupted: bool,
    pub tool_calls: Vec<SessionToolCall>,
    /// The current turn's unanswered tool: ExitPlanMode, then
    /// AskUserQuestion, then the newest. `None` once the turn is done.
    pub open_tool: Option<OpenTool>,
    /// The current turn's unanswered tools, oldest first. Claude Code asks
    /// about parallel calls in this order. Empty once the turn is done.
    pub pending_tools: Vec<OpenTool>,
    /// `permissionMode` of the latest real prompt.
    pub permission_mode: Option<String>,
    /// The current turn ended on a Claude rate-limit error (its text, as
    /// shown: "You've hit your limit · resets 3pm"). Autopilot stops the run
    /// with `usage_limit` on it.
    pub rate_limit: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenTool {
    pub id: String,
    pub name: String,
    pub title: String,
    /// What Claude Code's permission dialog shows for this call: the file
    /// name, the URL host, or the start of the command. Empty otherwise.
    pub hint: String,
}

/// Shown text that ties a permission dialog on screen to this call.
fn tool_hint(call: &SessionToolCall) -> String {
    if let Some(path) = call.path.as_deref() {
        return path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_string();
    }
    if let Some(url) = call.url.as_deref() {
        let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
        return rest
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default()
            .to_string();
    }
    call.command
        .as_deref()
        .map(|cmd| cmd.chars().take(40).collect())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolCallKind {
    Read,
    Edit,
    Execute,
    Fetch,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolCallStatus {
    Pending,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionToolCall {
    pub id: String,
    pub name: String,
    pub kind: ToolCallKind,
    pub title: String,
    pub path: Option<String>,
    pub command: Option<String>,
    pub url: Option<String>,
    pub status: ToolCallStatus,
    pub at: Option<String>,
}

/// A Claude session id is a UUID; anything else never becomes a file name.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

/// `<configDir>/projects/*/<id>.jsonl`, searched only under `config_dir`.
pub fn find_session_log(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let id = session_id.trim();
    if !valid_session_id(id) {
        return None;
    }
    let name = format!("{id}.jsonl");
    let projects = std::fs::read_dir(config_dir.join("projects")).ok()?;
    projects
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path().join(&name))
        .find(|path| path.is_file())
}

/// Look up and parse a session's log. `None` when it does not exist yet.
/// The app reads through `reader::SessionLogReaders`; this is the test reference.
#[cfg(test)]
pub fn load_session_log(config_dir: &Path, session_id: &str) -> Option<TerminalSessionLog> {
    let path = find_session_log(config_dir, session_id)?;
    read_session_log(&path, session_id.trim())
}

/// The last `MAX_TAIL_BYTES` of the file, starting at a whole line.
#[cfg(test)]
fn read_tail(path: &Path, max: u64) -> Option<Vec<u8>> {
    read_tail_at(path, max).map(|(_, bytes)| bytes)
}

/// `read_tail`, plus the file offset its first byte came from.
pub(crate) fn read_tail_at(path: &Path, max: u64) -> Option<(u64, Vec<u8>)> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    if start > 0 {
        let cut = bytes.iter().position(|b| *b == b'\n').map(|i| i + 1)?;
        bytes.drain(..cut);
        start += cut as u64;
    }
    Some((start, bytes))
}

/// One full parse of the file's tail. The reference the incremental reader
/// is tested against.
#[cfg(test)]
pub fn read_session_log(path: &Path, session_id: &str) -> Option<TerminalSessionLog> {
    let (_, bytes) = read_tail_at(path, MAX_TAIL_BYTES)?;
    let mut parser = Parser::default();
    for line in bytes.split(|b| *b == b'\n') {
        if let Some(value) = crate::claude_history::parse_jsonl_line(line) {
            parser.record(&value);
        }
    }
    Some(parser.summary(session_id, path))
}

/// The summary's running state. Fed one record at a time, so a reader can
/// keep it between reads.
#[derive(Default)]
pub(crate) struct Parser {
    reply: Vec<String>,
    last_prompt_at: Option<String>,
    permission_mode: Option<String>,
    last_stop: Option<String>,
    ended: bool,
    interrupted: bool,
    turn_tools: Vec<String>,
    plan: Option<String>,
    plan_at: Option<String>,
    tools: Vec<SessionToolCall>,
    by_id: HashMap<String, usize>,
    rate_limit: Option<String>,
}

impl Parser {
    pub(crate) fn record(&mut self, value: &Value) {
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let at = value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        match value.get("type").and_then(Value::as_str) {
            Some("assistant") => self.assistant(value, at),
            Some("user") => self.user(value, at),
            Some("system")
                if value.get("subtype").and_then(Value::as_str) == Some("turn_duration") =>
            {
                self.ended = true;
            }
            _ => {}
        }
    }

    fn assistant(&mut self, value: &Value, at: Option<String>) {
        let Some(message) = value.get("message") else {
            return;
        };
        self.ended = false;
        self.interrupted = false;
        self.last_stop = message
            .get("stop_reason")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(error) = rate_limit_error(value, message) {
            self.rate_limit = Some(error);
        }
        let Some(blocks) = message.get("content").and_then(Value::as_array) else {
            if let Some(text) = message.get("content").and_then(Value::as_str) {
                self.push_text(text);
            }
            return;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        self.push_text(text);
                    }
                }
                Some("tool_use") => self.tool_use(block, at.clone()),
                _ => {}
            }
        }
    }

    fn push_text(&mut self, text: &str) {
        let text = text.trim();
        if !text.is_empty() {
            self.reply.push(text.to_string());
        }
    }

    fn tool_use(&mut self, block: &Value, at: Option<String>) {
        let id = block
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        if name == "ExitPlanMode" {
            if let Some(plan) = input.get("plan").and_then(Value::as_str) {
                self.plan = Some(plan.to_string());
                self.plan_at = at.clone();
            }
        }
        let call = describe_tool(id.clone(), name, &input, at);
        if !id.is_empty() {
            if let Some(index) = self.by_id.get(&id) {
                self.tools[*index] = call;
                return;
            }
            self.by_id.insert(id.clone(), self.tools.len());
            self.turn_tools.push(id);
        }
        self.tools.push(call);
        if self.tools.len() > KEEP_TOOL_CALLS {
            self.tools.drain(..self.tools.len() - MAX_TOOL_CALLS);
            self.by_id = self
                .tools
                .iter()
                .enumerate()
                .filter(|(_, call)| !call.id.is_empty())
                .map(|(index, call)| (call.id.clone(), index))
                .collect();
        }
    }

    fn user(&mut self, value: &Value, at: Option<String>) {
        let content = value.get("message").and_then(|m| m.get("content"));
        let mut results = false;
        if let Some(blocks) = content.and_then(Value::as_array) {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                results = true;
                let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                let id = block.get("tool_use_id").and_then(Value::as_str);
                if let Some(index) = id.and_then(|id| self.by_id.get(id)) {
                    self.tools[*index].status = if failed {
                        ToolCallStatus::Failed
                    } else {
                        ToolCallStatus::Completed
                    };
                }
            }
        }
        if results {
            return;
        }
        match user_turn(value) {
            UserTurn::Interrupted => {
                self.ended = true;
                self.interrupted = true;
            }
            UserTurn::Prompt(_) => {
                self.reply.clear();
                self.turn_tools.clear();
                self.rate_limit = None;
                self.last_stop = None;
                self.ended = false;
                self.interrupted = false;
                self.last_prompt_at = at;
                if let Some(mode) = value.get("permissionMode").and_then(Value::as_str) {
                    self.permission_mode = Some(mode.to_string());
                }
            }
            UserTurn::Other => {}
        }
    }

    pub(crate) fn summary(&self, session_id: &str, path: &Path) -> TerminalSessionLog {
        let pending: Vec<&SessionToolCall> = self
            .turn_tools
            .iter()
            .filter_map(|id| self.by_id.get(id).map(|i| &self.tools[*i]))
            .filter(|call| call.status == ToolCallStatus::Pending)
            .collect();
        let stopped = matches!(
            self.last_stop.as_deref(),
            Some("end_turn" | "stop_sequence")
        );
        let turn_done = self.ended || (stopped && pending.is_empty());
        let as_open = |call: &SessionToolCall| OpenTool {
            id: call.id.clone(),
            name: call.name.clone(),
            title: call.title.clone(),
            hint: tool_hint(call),
        };
        let open_tool = (!turn_done)
            .then(|| {
                let named = |name: &str| pending.iter().find(|call| call.name == name).copied();
                named("ExitPlanMode")
                    .or_else(|| named("AskUserQuestion"))
                    .or_else(|| pending.last().copied())
            })
            .flatten()
            .map(as_open);
        let pending_tools: Vec<OpenTool> = if turn_done {
            Vec::new()
        } else {
            pending.iter().map(|call| as_open(call)).collect()
        };
        let skip = self.tools.len().saturating_sub(MAX_TOOL_CALLS);
        TerminalSessionLog {
            session_id: session_id.to_string(),
            path: path.display().to_string(),
            turn_done,
            last_reply: self.reply.join("\n\n"),
            plan: self.plan.clone(),
            plan_at: self.plan_at.clone(),
            last_prompt_at: self.last_prompt_at.clone(),
            interrupted: turn_done && self.interrupted,
            tool_calls: self.tools[skip..].to_vec(),
            open_tool,
            pending_tools,
            permission_mode: self.permission_mode.clone(),
            rate_limit: self.rate_limit.clone(),
        }
    }
}

/// Most characters of a rate-limit error kept.
const RATE_LIMIT_CHARS: usize = 300;

/// The text of a Claude rate-limit error record, if `value` is one. Claude
/// Code writes a refused request as a synthetic assistant message flagged
/// `isApiErrorMessage` (model `<synthetic>`), with `error: "rate_limit"` on
/// recent builds; older ones say so only in the text ("Claude AI usage limit
/// reached|<reset>", "API Error: 429 … rate_limit_error"). Not seen live yet
/// (V0 hit no limit), so both are matched. A model's own reply never counts.
fn rate_limit_error(value: &Value, message: &Value) -> Option<String> {
    let synthetic = is_flag(value, "isApiErrorMessage")
        || message.get("model").and_then(Value::as_str) == Some("<synthetic>");
    if !synthetic {
        return None;
    }
    let text = match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    let text = text.trim();
    let flagged = value.get("error").and_then(Value::as_str) == Some("rate_limit");
    let lower = text.to_ascii_lowercase();
    let said = [
        "usage limit",
        "limit reached",
        "hit your limit",
        "rate limit",
        "rate_limit",
        "error: 429",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    // "Context limit reached" and the like are about the conversation, not usage.
    let about_context = lower.contains("context") && !lower.contains("usage");
    if !flagged && (!said || about_context) {
        return None;
    }
    let shown = if text.is_empty() {
        "Claude reported a rate limit"
    } else {
        text
    };
    Some(shown.chars().take(RATE_LIMIT_CHARS).collect())
}

/// What a main-chain `user` record that carries no tool result is.
pub(crate) enum UserTurn {
    /// A real prompt; its text, trimmed at the start.
    Prompt(String),
    /// `[Request interrupted …]`: the turn ended.
    Interrupted,
    /// Meta reminders, compact summaries, local slash commands and their output.
    Other,
}

pub(crate) fn user_turn(value: &Value) -> UserTurn {
    if is_flag(value, "isMeta") || is_flag(value, "isCompactSummary") {
        return UserTurn::Other;
    }
    let content = value.get("message").and_then(|m| m.get("content"));
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return UserTurn::Other,
    };
    let text = text.trim_start();
    if text.starts_with("[Request interrupted") {
        return UserTurn::Interrupted;
    }
    // Local slash commands (`/model`, `/cost`, …) and their output are not turns.
    if ["<command-name>", "<command-message>", "<local-command-"]
        .iter()
        .any(|tag| text.starts_with(tag))
    {
        return UserTurn::Other;
    }
    UserTurn::Prompt(text.to_string())
}

pub(crate) fn is_flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn tool_kind(name: &str) -> ToolCallKind {
    match name {
        "Read" | "Glob" | "Grep" => ToolCallKind::Read,
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => ToolCallKind::Edit,
        "Bash" => ToolCallKind::Execute,
        "WebFetch" | "WebSearch" => ToolCallKind::Fetch,
        _ => ToolCallKind::Other,
    }
}

fn input_str<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .filter_map(|key| input.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|text| !text.is_empty())
}

pub(crate) fn describe_tool(
    id: String,
    name: String,
    input: &Value,
    at: Option<String>,
) -> SessionToolCall {
    let kind = tool_kind(&name);
    let path = input_str(input, &["file_path", "notebook_path"]).map(str::to_string);
    let command = (kind == ToolCallKind::Execute)
        .then(|| input_str(input, &["command"]))
        .flatten()
        .map(|cmd| redact_summary(cmd, COMMAND_CHARS));
    let url = input_str(input, &["url"]).map(|url| redact_summary(url, URL_CHARS));
    let detail = match kind {
        ToolCallKind::Execute => input_str(input, &["description", "command"]),
        ToolCallKind::Fetch => input_str(input, &["url", "query"]),
        _ => path
            .as_deref()
            .or_else(|| input_str(input, &["pattern", "path", "description", "query", "url"])),
    };
    let title = match detail {
        Some(detail) => redact_summary(&format!("{name}: {detail}"), TITLE_CHARS),
        None => name.clone(),
    };
    SessionToolCall {
        id,
        name,
        kind,
        title,
        path,
        command,
        url,
        status: ToolCallStatus::Pending,
        at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_history::parse_jsonl_line;
    use crate::test_support::TempDir;
    use serde_json::json;

    const SID: &str = "0b6c1d2e-aaaa-4bbb-8ccc-1234567890ab";

    fn base(kind: &str, at: &str) -> Value {
        json!({
            "parentUuid": null,
            "isSidechain": false,
            "type": kind,
            "uuid": format!("u-{at}"),
            "timestamp": at,
            "cwd": "/tmp/project",
            "sessionId": SID,
            "version": "2.1.0",
        })
    }

    fn prompt(text: &str, at: &str) -> Value {
        let mut v = base("user", at);
        v["message"] = json!({ "role": "user", "content": text });
        v
    }

    fn assistant(block: Value, stop: Option<&str>, at: &str) -> Value {
        let mut v = base("assistant", at);
        v["message"] = json!({
            "id": "msg_1", "type": "message", "role": "assistant", "model": "test",
            "content": [block], "stop_reason": stop, "stop_sequence": null,
        });
        v
    }

    fn text(t: &str, stop: Option<&str>, at: &str) -> Value {
        assistant(json!({ "type": "text", "text": t }), stop, at)
    }

    fn tool(id: &str, name: &str, input: Value, at: &str) -> Value {
        assistant(
            json!({ "type": "tool_use", "id": id, "name": name, "input": input }),
            Some("tool_use"),
            at,
        )
    }

    fn result(id: &str, is_error: bool, at: &str) -> Value {
        let mut v = base("user", at);
        v["message"] = json!({ "role": "user", "content": [
            { "tool_use_id": id, "type": "tool_result", "content": "ok", "is_error": is_error }
        ]});
        v
    }

    fn jsonl(records: &[Value]) -> String {
        records
            .iter()
            .map(|r| serde_json::to_string(r).unwrap() + "\n")
            .collect()
    }

    fn write_log(dir: &TempDir, body: &[u8]) -> PathBuf {
        let folder = dir.join("projects").join("-tmp-project");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join(format!("{SID}.jsonl"));
        std::fs::write(&path, body).unwrap();
        path
    }

    fn parse(records: &[Value]) -> TerminalSessionLog {
        let dir = TempDir::new("session_log");
        let path = write_log(&dir, jsonl(records).as_bytes());
        read_session_log(&path, SID).unwrap()
    }

    #[test]
    fn turn_done_only_after_end_turn_with_no_open_tool() {
        let mid = parse(&[
            prompt("Fix it", "t1"),
            tool("toolu_1", "Bash", json!({ "command": "ls" }), "t2"),
        ]);
        assert!(!mid.turn_done);
        assert_eq!(mid.tool_calls[0].status, ToolCallStatus::Pending);
        assert_eq!(mid.last_prompt_at.as_deref(), Some("t1"));
        let done = parse(&[
            prompt("Fix it", "t1"),
            tool("toolu_1", "Bash", json!({ "command": "ls" }), "t2"),
            result("toolu_1", false, "t3"),
            text("Done.", Some("end_turn"), "t4"),
        ]);
        assert!(done.turn_done);
        let streaming = parse(&[prompt("Fix it", "t1"), text("Working", None, "t2")]);
        assert!(!streaming.turn_done);
        let fresh_prompt = parse(&[
            prompt("one", "t1"),
            text("Done.", Some("end_turn"), "t2"),
            prompt("two", "t3"),
        ]);
        assert!(!fresh_prompt.turn_done);
        assert_eq!(fresh_prompt.last_reply, "");
        let mut duration = base("system", "t3");
        duration["subtype"] = json!("turn_duration");
        let marked = parse(&[prompt("Fix it", "t1"), text("ok", None, "t2"), duration]);
        assert!(marked.turn_done);
    }

    #[test]
    fn last_reply_joins_the_latest_turn_across_a_tool_call() {
        let log = parse(&[
            prompt("old", "t0"),
            text("Old answer", Some("end_turn"), "t0b"),
            prompt("new", "t1"),
            assistant(
                json!({ "type": "thinking", "thinking": "hmm", "signature": "x" }),
                None,
                "t2",
            ),
            text("Let me look.", Some("tool_use"), "t3"),
            tool(
                "toolu_1",
                "Read",
                json!({ "file_path": "/tmp/project/a.rs" }),
                "t4",
            ),
            result("toolu_1", false, "t5"),
            text("First part.", Some("end_turn"), "t6"),
            text("Second part.", Some("end_turn"), "t7"),
        ]);
        assert_eq!(
            log.last_reply,
            "Let me look.\n\nFirst part.\n\nSecond part."
        );
        assert_eq!(log.last_prompt_at.as_deref(), Some("t1"));
        assert!(log.turn_done);
    }

    #[test]
    fn plan_comes_from_the_newest_exit_plan_mode() {
        let log = parse(&[
            prompt("plan", "t1"),
            tool(
                "toolu_1",
                "ExitPlanMode",
                json!({ "plan": "# Plan A" }),
                "t2",
            ),
            result("toolu_1", true, "t3"),
            prompt("revise", "t4"),
            tool(
                "toolu_2",
                "ExitPlanMode",
                json!({ "plan": "# Plan B", "planFilePath": "/x.md" }),
                "t5",
            ),
        ]);
        assert_eq!(log.plan.as_deref(), Some("# Plan B"));
        assert_eq!(log.plan_at.as_deref(), Some("t5"));
        assert_eq!(log.tool_calls[0].status, ToolCallStatus::Failed);
        assert_eq!(log.tool_calls[1].status, ToolCallStatus::Pending);
        let single = parse(&[tool(
            "toolu_1",
            "ExitPlanMode",
            json!({ "plan": "# Only" }),
            "t2",
        )]);
        assert_eq!(single.plan.as_deref(), Some("# Only"));
    }

    #[test]
    fn sidechain_meta_and_local_commands_are_ignored() {
        let mut side = text("from a subagent", Some("end_turn"), "t3");
        side["isSidechain"] = json!(true);
        let mut side_tool = tool("toolu_9", "Bash", json!({ "command": "rm x" }), "t3");
        side_tool["isSidechain"] = json!(true);
        let mut meta = prompt("<system-reminder>", "t5");
        meta["isMeta"] = json!(true);
        let log = parse(&[
            prompt("go", "t1"),
            text("Main reply", Some("end_turn"), "t2"),
            side,
            side_tool,
            prompt("<command-name>/model</command-name>", "t4"),
            prompt(
                "<local-command-stdout>Set model</local-command-stdout>",
                "t4b",
            ),
            meta,
        ]);
        assert_eq!(log.last_reply, "Main reply");
        assert!(log.tool_calls.is_empty());
        assert_eq!(log.last_prompt_at.as_deref(), Some("t1"));
        assert!(log.turn_done);
    }

    #[test]
    fn interrupt_ends_the_turn() {
        let log = parse(&[
            prompt("go", "t1"),
            text("Starting", None, "t2"),
            prompt("[Request interrupted by user]", "t3"),
        ]);
        assert!(log.turn_done);
        assert!(
            log.interrupted,
            "autopilot must not read it as a finished turn"
        );
        assert_eq!(log.last_reply, "Starting");
        assert_eq!(log.last_prompt_at.as_deref(), Some("t1"));
        // The next prompt starts a new turn; finishing it is not an interrupt.
        let next = parse(&[
            prompt("go", "t1"),
            prompt("[Request interrupted by user]", "t3"),
            prompt("again", "t4"),
            text("Done", Some("end_turn"), "t5"),
        ]);
        assert!(next.turn_done && !next.interrupted);
    }

    #[test]
    fn bad_and_non_utf8_lines_are_skipped() {
        let dir = TempDir::new("session_log_bad");
        let mut body = Vec::new();
        body.extend_from_slice(jsonl(&[prompt("go", "t1")]).as_bytes());
        body.extend_from_slice(b"{not json\n");
        body.extend_from_slice(b"{\"type\":\"assistant\",\"x\":\"\xff\xfe\"}\n");
        body.extend_from_slice(jsonl(&[text("Fine", Some("end_turn"), "t2")]).as_bytes());
        body.extend_from_slice(b"{\"type\":\"user\",\"trunc");
        let path = write_log(&dir, &body);
        let log = read_session_log(&path, SID).unwrap();
        assert_eq!(log.last_reply, "Fine");
        assert!(log.turn_done);
    }

    #[test]
    fn a_large_file_is_read_from_the_tail() {
        let dir = TempDir::new("session_log_big");
        let filler = text(&"x".repeat(4096), Some("end_turn"), "t0");
        let mut body = jsonl(&[prompt("ancient", "t-old")]);
        let line = jsonl(&[filler]);
        let reps = (MAX_TAIL_BYTES as usize / line.len()) + 50;
        body.push_str(&line.repeat(reps));
        body.push_str(&jsonl(&[
            prompt("latest", "t1"),
            text("Tail reply", Some("end_turn"), "t2"),
        ]));
        let path = write_log(&dir, body.as_bytes());
        assert!(std::fs::metadata(&path).unwrap().len() > MAX_TAIL_BYTES);
        let log = read_session_log(&path, SID).unwrap();
        assert_eq!(log.last_reply, "Tail reply");
        assert_eq!(log.last_prompt_at.as_deref(), Some("t1"));
        let tail = read_tail(&path, MAX_TAIL_BYTES).unwrap();
        assert!(tail.len() as u64 <= MAX_TAIL_BYTES);
        assert!(parse_jsonl_line(tail.split(|b| *b == b'\n').next().unwrap()).is_some());
    }

    #[test]
    fn tool_kinds_status_and_redaction() {
        let log = parse(&[
            prompt("go", "t1"),
            tool("a", "Grep", json!({ "pattern": "fn main" }), "t2"),
            tool("b", "MultiEdit", json!({ "file_path": "/p/x.rs" }), "t2"),
            tool(
                "c",
                "Bash",
                json!({ "command": "curl -H 'Authorization: Bearer sk-abcdefabcdefabcdef' https://x.dev?token=s3cret" }),
                "t2",
            ),
            tool(
                "d",
                "WebFetch",
                json!({ "url": "https://example.com/a?api_key=zzz&x=1", "prompt": "p" }),
                "t2",
            ),
            tool("e", "Task", json!({ "description": "Explore code" }), "t2"),
            result("a", false, "t3"),
            result("b", true, "t3"),
            result("c", false, "t3"),
        ]);
        let kinds: Vec<_> = log.tool_calls.iter().map(|t| t.kind).collect();
        assert_eq!(
            kinds,
            vec![
                ToolCallKind::Read,
                ToolCallKind::Edit,
                ToolCallKind::Execute,
                ToolCallKind::Fetch,
                ToolCallKind::Other
            ]
        );
        let status: Vec<_> = log.tool_calls.iter().map(|t| t.status).collect();
        assert_eq!(
            status,
            vec![
                ToolCallStatus::Completed,
                ToolCallStatus::Failed,
                ToolCallStatus::Completed,
                ToolCallStatus::Pending,
                ToolCallStatus::Pending
            ]
        );
        assert_eq!(log.tool_calls[0].title, "Grep: fn main");
        assert_eq!(log.tool_calls[1].path.as_deref(), Some("/p/x.rs"));
        let bash = &log.tool_calls[2];
        let command = bash.command.as_deref().unwrap();
        assert!(
            !command.contains("sk-abcdef") && !command.contains("s3cret"),
            "{command}"
        );
        assert!(!bash.title.contains("s3cret"), "{}", bash.title);
        let fetch = &log.tool_calls[3];
        let url = fetch.url.as_deref().unwrap();
        assert!(!url.contains("zzz") && url.contains("x=1"), "{url}");
        assert!(!fetch.title.contains("zzz"));
        assert_eq!(log.tool_calls[4].title, "Task: Explore code");
        assert!(!log.turn_done);
        let json = serde_json::to_value(&log).unwrap();
        assert_eq!(json["toolCalls"][2]["kind"], json!("execute"));
        assert_eq!(json["toolCalls"][3]["status"], json!("pending"));
        assert!(json.get("lastPromptAt").is_some() && json.get("turnDone").is_some());
    }

    #[test]
    fn tool_calls_keep_the_newest_500() {
        let mut records = vec![prompt("go", "t1")];
        for i in 0..520 {
            records.push(tool(
                &format!("t{i}"),
                "Read",
                json!({ "file_path": "/a" }),
                "t2",
            ));
        }
        let log = parse(&records);
        assert_eq!(log.tool_calls.len(), MAX_TOOL_CALLS);
        assert_eq!(log.tool_calls[0].id, "t20");
        assert_eq!(log.tool_calls[499].id, "t519");
    }

    fn open_name(log: &TerminalSessionLog) -> Option<&str> {
        log.open_tool.as_ref().map(|t| t.name.as_str())
    }

    #[test]
    fn open_tool_names_the_unanswered_tool() {
        let plan = parse(&[
            prompt("plan", "t1"),
            tool("p1", "ExitPlanMode", json!({ "plan": "# P" }), "t2"),
        ]);
        assert_eq!(open_name(&plan), Some("ExitPlanMode"));
        assert_eq!(plan.open_tool.as_ref().unwrap().id, "p1");
        let ask = parse(&[
            prompt("go", "t1"),
            tool("q1", "AskUserQuestion", json!({ "questions": [] }), "t2"),
        ]);
        assert_eq!(open_name(&ask), Some("AskUserQuestion"));
        let bash = parse(&[
            prompt("go", "t1"),
            tool("b1", "Bash", json!({ "command": "rm -rf build" }), "t2"),
        ]);
        let open = bash.open_tool.as_ref().unwrap();
        assert_eq!(
            (open.name.as_str(), open.title.as_str()),
            ("Bash", "Bash: rm -rf build")
        );
        let json = serde_json::to_value(&bash).unwrap();
        assert_eq!(json["openTool"]["name"], json!("Bash"));
    }

    #[test]
    fn open_tool_clears_after_a_result_or_a_rejection() {
        let answered = parse(&[
            prompt("go", "t1"),
            tool("b1", "Bash", json!({ "command": "ls" }), "t2"),
            result("b1", false, "t3"),
        ]);
        assert_eq!(answered.open_tool, None);
        assert!(!answered.turn_done);
        let rejected = parse(&[
            prompt("go", "t1"),
            tool("b1", "Bash", json!({ "command": "ls" }), "t2"),
            result("b1", true, "t3"),
        ]);
        assert_eq!(rejected.open_tool, None);
        let previous_turn = parse(&[
            prompt("go", "t1"),
            tool("b1", "Bash", json!({ "command": "ls" }), "t2"),
            prompt("[Request interrupted by user]", "t3"),
        ]);
        assert_eq!(previous_turn.open_tool, None);
        let new_turn = parse(&[
            prompt("go", "t1"),
            tool("b1", "Bash", json!({ "command": "ls" }), "t2"),
            prompt("next", "t3"),
        ]);
        assert_eq!(new_turn.open_tool, None);
    }

    #[test]
    fn open_tool_prefers_plan_then_question_over_parallel_tools() {
        let log = parse(&[
            prompt("go", "t1"),
            tool("r1", "Read", json!({ "file_path": "/a" }), "t2"),
            tool("q1", "AskUserQuestion", json!({}), "t2"),
            tool("b1", "Bash", json!({ "command": "ls" }), "t2"),
        ]);
        assert_eq!(open_name(&log), Some("AskUserQuestion"));
        let log = parse(&[
            prompt("go", "t1"),
            tool("q1", "AskUserQuestion", json!({}), "t2"),
            tool("p1", "ExitPlanMode", json!({ "plan": "x" }), "t2"),
        ]);
        assert_eq!(open_name(&log), Some("ExitPlanMode"));
        let log = parse(&[
            prompt("go", "t1"),
            tool("r1", "Read", json!({ "file_path": "/a" }), "t2"),
            tool("b1", "Bash", json!({ "command": "ls" }), "t2"),
            result("b1", false, "t3"),
        ]);
        assert_eq!(log.open_tool.as_ref().map(|t| t.id.as_str()), Some("r1"));
    }

    #[test]
    fn pending_tools_list_the_turns_unanswered_tools_oldest_first() {
        let ids = |log: &TerminalSessionLog| {
            log.pending_tools
                .iter()
                .map(|t| t.id.clone())
                .collect::<Vec<_>>()
        };
        let parallel = parse(&[
            prompt("go", "t1"),
            tool("e1", "Edit", json!({ "file_path": "/a" }), "t2"),
            tool("e2", "Edit", json!({ "file_path": "/b" }), "t2"),
        ]);
        assert_eq!(ids(&parallel), vec!["e1", "e2"]);
        let first_answered = parse(&[
            prompt("go", "t1"),
            tool("e1", "Edit", json!({ "file_path": "/a" }), "t2"),
            tool("e2", "Edit", json!({ "file_path": "/b" }), "t2"),
            result("e1", false, "t3"),
        ]);
        assert_eq!(ids(&first_answered), vec!["e2"]);
        let earlier_turn = parse(&[
            prompt("go", "t1"),
            tool("b1", "Bash", json!({ "command": "ls" }), "t2"),
            prompt("next", "t3"),
        ]);
        assert!(earlier_turn.pending_tools.is_empty());
        let json = serde_json::to_value(&parallel).unwrap();
        assert_eq!(json["pendingTools"][1]["id"], json!("e2"));
        assert_eq!(json["pendingTools"][1]["hint"], json!("b"));
    }

    #[test]
    fn pending_tool_hints_name_what_the_dialog_shows() {
        let log = parse(&[
            prompt("go", "t1"),
            tool(
                "e1",
                "Edit",
                json!({ "file_path": "/repo/src/auth.ts" }),
                "t2",
            ),
            tool(
                "w1",
                "WebFetch",
                json!({ "url": "https://docs.example.com/a?b=1" }),
                "t2",
            ),
            tool(
                "b1",
                "Bash",
                json!({ "command": "npm test", "description": "Run tests" }),
                "t2",
            ),
            tool("g1", "Grep", json!({ "pattern": "fn main" }), "t2"),
        ]);
        let hints: Vec<&str> = log.pending_tools.iter().map(|t| t.hint.as_str()).collect();
        assert_eq!(hints, vec!["auth.ts", "docs.example.com", "npm test", ""]);
    }

    /// The record Claude Code writes when a request is refused for a limit:
    /// a synthetic assistant message flagged `isApiErrorMessage`.
    fn api_error(t: &str, error: Option<&str>, at: &str) -> Value {
        let mut v = text(t, Some("stop_sequence"), at);
        v["message"]["model"] = json!("<synthetic>");
        v["isApiErrorMessage"] = json!(true);
        if let Some(error) = error {
            v["error"] = json!(error);
        }
        v
    }

    #[test]
    fn a_rate_limit_error_ends_the_turn_and_is_named() {
        let limited = parse(&[
            prompt("Fix it", "t1"),
            api_error(
                "You've hit your limit · resets 3pm (Europe/London)",
                Some("rate_limit"),
                "t2",
            ),
        ]);
        assert!(limited.turn_done);
        assert_eq!(
            limited.rate_limit.as_deref(),
            Some("You've hit your limit · resets 3pm (Europe/London)")
        );
        // Older builds: no `error` field, the limit in the text.
        let legacy = parse(&[
            prompt("Fix it", "t1"),
            api_error("Claude AI usage limit reached|1760000000", None, "t2"),
        ]);
        assert_eq!(
            legacy.rate_limit.as_deref(),
            Some("Claude AI usage limit reached|1760000000")
        );
        let http = parse(&[
            prompt("Fix it", "t1"),
            api_error(
                "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
                None,
                "t2",
            ),
        ]);
        assert!(http.rate_limit.is_some());
    }

    #[test]
    fn other_errors_and_a_reply_about_limits_are_not_a_rate_limit() {
        let overloaded = parse(&[
            prompt("Fix it", "t1"),
            api_error("API Error: 529 Overloaded", None, "t2"),
        ]);
        assert_eq!(overloaded.rate_limit, None);
        let context = parse(&[
            prompt("Fix it", "t1"),
            api_error(
                "Context limit reached · /compact or /clear to continue",
                None,
                "t2",
            ),
        ]);
        assert_eq!(context.rate_limit, None);
        let talk = parse(&[
            prompt("What is the usage limit?", "t1"),
            text(
                "The 5-hour usage limit reached 80% earlier; rate limit details are in docs.",
                Some("end_turn"),
                "t2",
            ),
        ]);
        assert_eq!(talk.rate_limit, None);
        // A new prompt starts a new turn: the error belonged to the last one.
        let next = parse(&[
            prompt("Fix it", "t1"),
            api_error(
                "You've hit your limit · resets 3pm",
                Some("rate_limit"),
                "t2",
            ),
            prompt("try again", "t3"),
            text("Done.", Some("end_turn"), "t4"),
        ]);
        assert_eq!(next.rate_limit, None);
        assert_eq!(next.last_reply, "Done.");
    }

    #[test]
    fn permission_mode_comes_from_the_latest_prompt() {
        let mut first = prompt("one", "t1");
        first["permissionMode"] = json!("plan");
        let mut second = prompt("two", "t3");
        second["permissionMode"] = json!("auto");
        let mut meta = prompt("<system-reminder>", "t4");
        meta["isMeta"] = json!(true);
        meta["permissionMode"] = json!("default");
        let log = parse(&[
            first.clone(),
            text("ok", Some("end_turn"), "t2"),
            second,
            meta,
        ]);
        assert_eq!(log.permission_mode.as_deref(), Some("auto"));
        assert_eq!(parse(&[first]).permission_mode.as_deref(), Some("plan"));
        assert_eq!(parse(&[prompt("x", "t1")]).permission_mode, None);
    }

    #[test]
    fn lookup_stays_in_the_given_config_dir() {
        let account = TempDir::new("session_log_acct");
        let other = TempDir::new("session_log_other");
        assert!(find_session_log(account.path(), SID).is_none());
        write_log(&other, jsonl(&[prompt("hi", "t1")]).as_bytes());
        assert!(find_session_log(account.path(), SID).is_none());
        assert!(load_session_log(account.path(), SID).is_none());
        let path = write_log(&account, jsonl(&[prompt("hi", "t1")]).as_bytes());
        assert_eq!(find_session_log(account.path(), SID), Some(path.clone()));
        let log = load_session_log(account.path(), SID).unwrap();
        assert_eq!(log.session_id, SID);
        assert_eq!(log.path, path.display().to_string());
        assert!(find_session_log(account.path(), "../../etc/passwd").is_none());
    }
}
