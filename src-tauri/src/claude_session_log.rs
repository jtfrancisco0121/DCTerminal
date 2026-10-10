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
//! Nothing under the config folder is created or written.

use crate::claude_history::parse_jsonl_line;
use crate::permissions::redact_summary;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MAX_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOOL_CALLS: usize = 500;
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
    pub tool_calls: Vec<SessionToolCall>,
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
pub fn load_session_log(config_dir: &Path, session_id: &str) -> Option<TerminalSessionLog> {
    let path = find_session_log(config_dir, session_id)?;
    read_session_log(&path, session_id.trim())
}

/// The last `MAX_TAIL_BYTES` of the file, starting at a whole line.
fn read_tail(path: &Path, max: u64) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    if start > 0 {
        let cut = bytes.iter().position(|b| *b == b'\n').map(|i| i + 1)?;
        bytes.drain(..cut);
    }
    Some(bytes)
}

pub fn read_session_log(path: &Path, session_id: &str) -> Option<TerminalSessionLog> {
    let bytes = read_tail(path, MAX_TAIL_BYTES)?;
    let mut parser = Parser::default();
    for line in bytes.split(|b| *b == b'\n') {
        if let Some(value) = parse_jsonl_line(line) {
            parser.record(&value);
        }
    }
    Some(parser.finish(session_id, path))
}

#[derive(Default)]
struct Parser {
    reply: Vec<String>,
    last_prompt_at: Option<String>,
    last_stop: Option<String>,
    ended: bool,
    turn_tools: Vec<String>,
    plan: Option<String>,
    plan_at: Option<String>,
    tools: Vec<SessionToolCall>,
    by_id: HashMap<String, usize>,
}

impl Parser {
    fn record(&mut self, value: &Value) {
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
        self.last_stop = message
            .get("stop_reason")
            .and_then(Value::as_str)
            .map(str::to_string);
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
        if results || is_flag(value, "isMeta") || is_flag(value, "isCompactSummary") {
            return;
        }
        let text = match content {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => return,
        };
        let text = text.trim_start();
        if text.starts_with("[Request interrupted") {
            self.ended = true;
            return;
        }
        // Local slash commands (`/model`, `/cost`, …) and their output are not turns.
        if ["<command-name>", "<command-message>", "<local-command-"]
            .iter()
            .any(|tag| text.starts_with(tag))
        {
            return;
        }
        self.reply.clear();
        self.turn_tools.clear();
        self.last_stop = None;
        self.ended = false;
        self.last_prompt_at = at;
    }

    fn finish(mut self, session_id: &str, path: &Path) -> TerminalSessionLog {
        let unanswered = self.turn_tools.iter().any(|id| {
            self.by_id
                .get(id)
                .is_some_and(|i| self.tools[*i].status == ToolCallStatus::Pending)
        });
        let stopped = matches!(
            self.last_stop.as_deref(),
            Some("end_turn" | "stop_sequence")
        );
        let turn_done = self.ended || (stopped && !unanswered);
        if self.tools.len() > MAX_TOOL_CALLS {
            let extra = self.tools.len() - MAX_TOOL_CALLS;
            self.tools.drain(..extra);
        }
        TerminalSessionLog {
            session_id: session_id.to_string(),
            path: path.display().to_string(),
            turn_done,
            last_reply: self.reply.join("\n\n"),
            plan: self.plan,
            plan_at: self.plan_at,
            last_prompt_at: self.last_prompt_at,
            tool_calls: self.tools,
        }
    }
}

fn is_flag(value: &Value, key: &str) -> bool {
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

fn describe_tool(id: String, name: String, input: &Value, at: Option<String>) -> SessionToolCall {
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
        assert_eq!(log.last_reply, "Starting");
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
