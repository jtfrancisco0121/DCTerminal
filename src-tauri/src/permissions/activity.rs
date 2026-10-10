//! Turn ACP tool calls and permission requests into activity-log lines.
//!
//! Classification reuses `evaluate_permission` (the same rules the permission
//! card uses) on the cache-enriched tool object, then splits Write into
//! write / edit / delete and Read into read / fetch so the panel can answer
//! "which files were written, did anything hit the network?".

use super::policy::{evaluate_permission, ToolClass};
use super::redact::redact_summary;
use super::tool_cache::ToolCallCache;
use crate::store::ActivityPatch;
use serde_json::{json, Value};

const SUMMARY_CHARS: usize = 500;
const TITLE_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct ToolActivity {
    pub kind: &'static str,
    pub network: bool,
    pub title: String,
    pub summary: String,
}

fn raw_input(tool: &Value) -> &Value {
    tool.get("rawInput")
        .or_else(|| tool.get("raw_input"))
        .unwrap_or(&Value::Null)
}

fn raw_str<'a>(tool: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let raw = raw_input(tool);
    keys.iter()
        .find_map(|key| raw.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Claude names MCP tools `mcp__<server>__<tool>` (title or `_meta`).
fn claude_mcp_name(tool: &Value) -> bool {
    let meta_name = tool
        .pointer("/_meta/claudeCode/toolName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let title = tool.get("title").and_then(Value::as_str).unwrap_or("");
    meta_name.starts_with("mcp__") || title.trim_start().starts_with("mcp__")
}

/// Best effort: shell commands that obviously reach the network.
fn shell_hits_network(command: &str) -> bool {
    const TOOLS: &[&str] = &["curl", "wget", "ssh", "scp", "rsync", "nc", "ftp", "sftp"];
    const SUBCOMMANDS: &[(&str, &[&str])] = &[
        ("git", &["push", "pull", "fetch", "clone", "ls-remote"]),
        ("gh", &["pr", "issue", "api", "repo", "release", "run"]),
        ("npm", &["install", "i", "ci", "publish", "update"]),
        ("pnpm", &["install", "i", "add", "publish"]),
        ("yarn", &["install", "add", "publish"]),
        ("pip", &["install", "download"]),
        ("pip3", &["install", "download"]),
        ("cargo", &["install", "publish", "update", "fetch"]),
        ("brew", &["install", "upgrade", "update"]),
    ];
    command.split(['&', '|', ';', '\n']).any(|segment| {
        let words: Vec<&str> = segment
            .split_whitespace()
            .filter(|word| !word.contains('=') && *word != "sudo")
            .collect();
        let Some(first) = words.first() else {
            return false;
        };
        let program = first.rsplit('/').next().unwrap_or(first);
        if TOOLS.contains(&program) {
            return true;
        }
        SUBCOMMANDS.iter().any(|(name, subs)| {
            *name == program
                && words
                    .iter()
                    .skip(1)
                    .find(|w| !w.starts_with('-'))
                    .is_some_and(|sub| subs.contains(sub))
        })
    })
}

fn write_or_edit(tool: &Value) -> &'static str {
    let raw = raw_input(tool);
    let has = |key: &str| raw.get(key).is_some();
    if has("old_string") || has("new_string") || has("edits") || has("patch") {
        return "edit";
    }
    let title = tool
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if title.starts_with("write") || has("content") || has("contents") {
        return "write";
    }
    "edit"
}

fn first_location(tool: &Value) -> Option<&str> {
    tool.get("locations")?
        .as_array()?
        .iter()
        .find_map(|loc| loc.get("path").and_then(Value::as_str))
        .filter(|s| !s.trim().is_empty())
}

/// Classify a (cache-enriched) ACP tool object.
pub fn classify_tool(tool: &Value) -> ToolActivity {
    let outcome = evaluate_permission("", &json!({ "toolCall": tool }));
    let path = raw_str(tool, &["file_path", "path", "filePath", "notebook_path"])
        .or_else(|| first_location(tool));
    let command = raw_str(tool, &["command", "cmd"]);
    let url = raw_str(tool, &["url"]);
    let query = raw_str(tool, &["query"]);
    let kind_field = tool
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut network = outcome.network;
    let kind = if outcome.class == ToolClass::Mcp || claude_mcp_name(tool) {
        "mcp"
    } else if outcome.display_kind == "delete" {
        "delete"
    } else if network || outcome.display_kind == "fetch" {
        // ACP `fetch` also covers web search.
        network = true;
        "fetch"
    } else {
        match outcome.class {
            ToolClass::Shell => "shell",
            ToolClass::Write if kind_field == "move" => "write",
            ToolClass::Write => write_or_edit(tool),
            ToolClass::Read => "read",
            _ => "other",
        }
    };
    if kind == "shell" && command.is_some_and(shell_hits_network) {
        network = true;
    }
    let title = outcome.title.clone();
    let detail = match kind {
        "shell" => command.map(str::to_string),
        "fetch" => url
            .map(str::to_string)
            .or_else(|| query.map(|q| format!("search: {q}"))),
        "write" | "edit" | "delete" | "read" => path.map(str::to_string),
        "mcp" => tool
            .pointer("/_meta/claudeCode/toolName")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    };
    let summary = detail.unwrap_or_else(|| title.clone());
    ToolActivity {
        kind,
        network,
        title: redact_summary(&title, TITLE_CHARS),
        summary: redact_summary(&summary, SUMMARY_CHARS),
    }
}

fn update_of(line: &Value) -> &Value {
    let params = if line.get("method").and_then(Value::as_str) == Some("session/update") {
        line.get("params").unwrap_or(line)
    } else {
        line
    };
    params.get("update").unwrap_or(params)
}

fn tool_call_id(value: &Value) -> Option<String> {
    value
        .get("toolCallId")
        .or_else(|| value.get("tool_call_id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The cache's view of a tool call plus this update's `_meta`.
fn cached_tool(cache: &ToolCallCache, id: &str, update: &Value) -> Value {
    let mut tool = json!({ "toolCallId": id });
    if let Some(cached) = cache.get(id) {
        let obj = tool.as_object_mut().expect("object");
        if let Some(kind) = &cached.kind {
            obj.insert("kind".into(), json!(kind));
        }
        if let Some(title) = &cached.title {
            obj.insert("title".into(), json!(title));
        }
        if let Some(raw) = &cached.raw_input {
            obj.insert("rawInput".into(), raw.clone());
        }
        if let Some(locs) = &cached.locations {
            obj.insert("locations".into(), locs.clone());
        }
    } else {
        for key in ["kind", "title", "rawInput", "locations"] {
            if let Some(value) = update.get(key) {
                tool[key] = value.clone();
            }
        }
    }
    if let Some(meta) = update.get("_meta") {
        tool["_meta"] = meta.clone();
    }
    tool
}

/// A line for a `tool_call` / `tool_call_update` notification, after the
/// cache has observed it. Bare `in_progress` pings are skipped.
pub fn patch_for_update(
    tab_id: &str,
    line: &Value,
    cache: &ToolCallCache,
    now: &str,
) -> Option<ActivityPatch> {
    let update = update_of(line);
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("type"))
        .or_else(|| update.get("updateType"))
        .and_then(Value::as_str)?;
    if kind != "tool_call" && kind != "tool_call_update" {
        return None;
    }
    let id = tool_call_id(update)?;
    let status = update
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let terminal = matches!(status.as_deref(), Some("completed" | "failed"));
    let informative = kind == "tool_call"
        || ["title", "kind", "rawInput", "locations"]
            .iter()
            .any(|key| update.get(*key).is_some_and(|v| !v.is_null()));
    if !informative && !terminal {
        return None;
    }
    let tool = cached_tool(cache, &id, update);
    let activity = classify_tool(&tool);
    // Switch-mode / plan exits are not tool activity worth a row.
    if tool.get("kind").and_then(Value::as_str) == Some("switch_mode") {
        return None;
    }
    Some(ActivityPatch {
        id,
        tab_id: tab_id.to_string(),
        time: now.to_string(),
        kind: Some(activity.kind.to_string()),
        title: Some(activity.title),
        summary: Some(activity.summary),
        decision: None,
        network: Some(activity.network),
        status: if kind == "tool_call" {
            status.or_else(|| Some("pending".to_string()))
        } else {
            status
        },
    })
}

/// A line for a `session/request_permission` (params already enriched from
/// the cache). `decision` is `None` while the card waits for JT.
pub fn patch_for_permission(
    tab_id: &str,
    json_rpc_id: u64,
    params: &Value,
    decision: Option<&str>,
    now: &str,
) -> ActivityPatch {
    let tool = params
        .get("toolCall")
        .or_else(|| params.get("tool_call"))
        .unwrap_or(params);
    let id = tool_call_id(tool).unwrap_or_else(|| permission_fallback_id(json_rpc_id));
    let activity = classify_tool(tool);
    ActivityPatch {
        id,
        tab_id: tab_id.to_string(),
        time: now.to_string(),
        kind: Some(activity.kind.to_string()),
        title: Some(activity.title),
        summary: Some(activity.summary),
        decision: decision.map(str::to_string),
        network: Some(activity.network),
        status: None,
    }
}

pub fn permission_fallback_id(json_rpc_id: u64) -> String {
    format!("permission-{json_rpc_id}")
}

/// The tool call id a permission request is about (for a later decision).
pub fn permission_tool_call_id(params: &Value, json_rpc_id: u64) -> String {
    let tool = params
        .get("toolCall")
        .or_else(|| params.get("tool_call"))
        .unwrap_or(params);
    tool_call_id(tool).unwrap_or_else(|| permission_fallback_id(json_rpc_id))
}

/// `user_allow` for an allow option JT picked, otherwise `user_reject`.
pub fn user_decision(option_id: &str, options: &[(String, String)]) -> &'static str {
    let kind = options
        .iter()
        .find(|(id, _)| id == option_id)
        .map(|(_, kind)| kind.to_ascii_lowercase())
        .unwrap_or_default();
    let allowed = if kind.is_empty() {
        option_id.to_ascii_lowercase().contains("allow")
    } else {
        kind.starts_with("allow")
    };
    if allowed {
        "user_allow"
    } else {
        "user_reject"
    }
}

/// A decision-only line that completes an earlier row.
pub fn decision_patch(tab_id: &str, id: &str, decision: &str, now: &str) -> ActivityPatch {
    ActivityPatch {
        id: id.to_string(),
        tab_id: tab_id.to_string(),
        time: now.to_string(),
        decision: Some(decision.to_string()),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::merge_patches;
    use std::path::PathBuf;

    const NOW: &str = "2026-10-10T10:00:00Z";

    fn permission_fixture(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/acp/permissions")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// Replay a captured fixture: preceding updates, then the request.
    fn replay(name: &str, decision: &str) -> Vec<ActivityPatch> {
        let raw = permission_fixture(name);
        let mut cache = ToolCallCache::new();
        let mut lines = Vec::new();
        if let Some(items) = raw["precedingToolCallUpdates"].as_array() {
            for item in items {
                cache.observe_notification(item);
                lines.extend(patch_for_update("tab_a", item, &cache, NOW));
            }
        }
        let params = cache.enrich_params(&raw["request"]["params"]);
        let id = raw["request"]["id"].as_u64().unwrap();
        lines.push(patch_for_permission(
            "tab_a",
            id,
            &params,
            Some(decision),
            NOW,
        ));
        lines
    }

    #[test]
    fn captured_cursor_shell_merges_into_one_auto_allowed_row() {
        let lines = replay("shell-ls.json", "auto_allow");
        // tool_call, (in_progress skipped), permission.
        assert_eq!(lines.len(), 2);
        let entries = merge_patches(&lines);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "shell");
        assert_eq!(entries[0].summary, "ls -la");
        assert_eq!(entries[0].decision, "auto_allow");
        assert_eq!(entries[0].status.as_deref(), Some("pending"));
        assert!(!entries[0].network);
    }

    #[test]
    fn captured_cursor_delete_is_delete_with_path() {
        let entries = merge_patches(&replay("delete-hello.json", "user_allow"));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "delete");
        assert_eq!(
            entries[0].summary,
            "/tmp/dct-perm-capture/project/hello.txt"
        );
        assert_eq!(entries[0].decision, "user_allow");
    }

    #[test]
    fn captured_cursor_fetch_is_network() {
        let entries = merge_patches(&replay("fetch-example.json", "auto_allow"));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "fetch");
        assert_eq!(entries[0].id, "web_fetch_0");
        assert!(entries[0].network);
        assert_eq!(entries[0].summary, "https://example.com");
    }

    /// Claude bypassPermissions runs tools without a request. Shapes follow
    /// the claude-code-acp adapter (Bash/Edit/Write/WebFetch/mcp__*); no
    /// live tool_call capture exists yet (docs/claude-acp-observed.md).
    #[test]
    fn claude_tool_calls_without_permission_are_recorded_and_completed() {
        let notes = [
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "tool_call", "toolCallId": "toolu_1", "title": "Terminal",
                "kind": "execute", "status": "pending", "rawInput": {},
                "_meta": { "claudeCode": { "toolName": "Bash" } } } } }),
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "tool_call_update", "toolCallId": "toolu_1",
                "title": "`curl -s https://api.example.com -H 'Authorization: Bearer abc'`",
                "rawInput": { "command": "curl -s https://api.example.com -H 'Authorization: Bearer abc'" } } } }),
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "in_progress" } } }),
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "completed" } } }),
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "tool_call", "toolCallId": "toolu_2", "title": "Write /repo/src/new.ts",
                "kind": "edit", "status": "pending",
                "rawInput": { "file_path": "/repo/src/new.ts", "content": "export const secret = 1;" },
                "locations": [{ "path": "/repo/src/new.ts" }] } } }),
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "tool_call_update", "toolCallId": "toolu_2", "status": "failed" } } }),
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "tool_call", "toolCallId": "toolu_3", "title": "Edit `/repo/a.rs`",
                "kind": "edit", "rawInput": { "file_path": "/repo/a.rs", "old_string": "a", "new_string": "b" } } } }),
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "tool_call", "toolCallId": "toolu_4", "title": "mcp__github__create_issue",
                "kind": "other", "rawInput": { "title": "x" },
                "_meta": { "claudeCode": { "toolName": "mcp__github__create_issue" } } } } }),
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "tool_call", "toolCallId": "toolu_5", "title": "Read /repo/README.md",
                "kind": "read", "rawInput": { "file_path": "/repo/README.md" } } } }),
            json!({ "method": "session/update", "params": { "sessionId": "s", "update": {
                "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "hi" } } } }),
        ];
        let mut cache = ToolCallCache::new();
        let mut lines = Vec::new();
        for note in &notes {
            cache.observe_notification(note);
            lines.extend(patch_for_update("tab_a", note, &cache, NOW));
        }
        // in_progress and the message chunk wrote nothing.
        assert_eq!(lines.len(), 8);
        let entries = merge_patches(&lines);
        let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["shell", "write", "edit", "mcp", "read"]);
        let shell = &entries[0];
        assert_eq!(shell.status.as_deref(), Some("completed"));
        assert_eq!(shell.decision, "none");
        assert!(shell.network, "curl is network");
        assert!(shell.summary.starts_with("curl -s https://api.example.com"));
        assert!(!shell.summary.contains("abc"), "{}", shell.summary);
        let write = &entries[1];
        assert_eq!(write.summary, "/repo/src/new.ts");
        assert_eq!(write.status.as_deref(), Some("failed"));
        assert!(!lines.iter().any(|l| {
            serde_json::to_string(l)
                .unwrap()
                .contains("export const secret")
        }));
        assert_eq!(entries[2].summary, "/repo/a.rs");
        assert_eq!(entries[3].summary, "mcp__github__create_issue");
        assert_eq!(entries[4].summary, "/repo/README.md");
    }

    #[test]
    fn shell_network_heuristic() {
        assert!(shell_hits_network("cd x && git push origin main"));
        assert!(shell_hits_network("FOO=1 /usr/bin/curl https://x"));
        assert!(shell_hits_network("npm install"));
        assert!(!shell_hits_network("npm test"));
        assert!(!shell_hits_network("git status && ls"));
        assert!(!shell_hits_network("echo curl"));
    }

    #[test]
    fn user_decision_reads_the_option_kind() {
        let options = vec![
            ("allow-once".to_string(), "allow_once".to_string()),
            ("reject-once".to_string(), "reject_once".to_string()),
        ];
        assert_eq!(user_decision("allow-once", &options), "user_allow");
        assert_eq!(user_decision("reject-once", &options), "user_reject");
        assert_eq!(user_decision("allow", &[]), "user_allow");
        assert_eq!(user_decision("no", &[]), "user_reject");
        let patch = decision_patch("tab_a", "t1", "cancelled", NOW);
        assert_eq!(patch.decision.as_deref(), Some("cancelled"));
        assert!(patch.kind.is_none());
        assert_eq!(
            permission_tool_call_id(&json!({ "toolCall": {} }), 7),
            "permission-7"
        );
    }
}
