//! Per-role answers for ACP `session/request_permission`.
//!
//! Live Cursor CLI payloads (2026.10.01) often omit `rawInput` on the permission
//! request itself. Enrich from the per-session tool-call cache first, then parse
//! the title. Classification follows ACP `toolCall.kind` (delete → Write, fetch →
//! Read). MCP payloads are still unverified; `mcp_signal` remains best-effort.
//! Ambiguous requests are not auto-allowed except for Implementer and Developer.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolClass {
    Write,
    Shell,
    Mcp,
    Read,
    Other,
    Unknown,
}

impl ToolClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolClass::Write => "write",
            ToolClass::Shell => "shell",
            ToolClass::Mcp => "mcp",
            ToolClass::Read => "read",
            ToolClass::Other => "other",
            ToolClass::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyDecision {
    /// Auto-answer `allow-once`. Never `allow-always` (that can persist globally).
    AllowOnce,
    /// Auto-answer `reject-once` (or cancel if the agent offered no reject option).
    Reject,
    /// Show the permission card. Dismissing cancels; nothing is auto-allowed.
    Ask,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionChoice {
    pub id: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct DecisionOutcome {
    pub class: ToolClass,
    pub decision: PolicyDecision,
    pub title: String,
    pub message: String,
    /// UI / log label (`delete`, `execute`, `fetch`, …). May differ from class.
    pub display_kind: String,
    /// True when this is a network fetch (permission log labels it).
    pub network: bool,
    pub options: Vec<PermissionChoice>,
    /// JSON-RPC result body when the decision is automatic.
    pub auto_result: Option<Value>,
    pub transcript_line: Option<String>,
}

pub fn evaluate_permission(role_id: &str, params: &Value) -> DecisionOutcome {
    let class = classify_permission_params(params);
    let decision = decide_for_role(role_id, class);
    let title = permission_title(params);
    let message = permission_message(params);
    let display_kind = display_kind_label(params, class);
    let network = is_network_fetch(params, class);
    let options = permission_options(params);
    let transcript_line = match decision {
        PolicyDecision::Ask => None,
        other => Some(auto_decision_line(other, class, &title, network)),
    };
    let auto_result = match decision {
        PolicyDecision::AllowOnce => Some(selected_result(&choice_id(&options, true))),
        PolicyDecision::Reject => Some(reject_result(&options)),
        PolicyDecision::Ask => None,
    };
    DecisionOutcome {
        class,
        decision,
        title,
        message,
        display_kind,
        network,
        options,
        auto_result,
        transcript_line,
    }
}

pub fn decide_for_role(role_id: &str, class: ToolClass) -> PolicyDecision {
    match canonical_role(role_id) {
        RoleKind::FullAccess => PolicyDecision::AllowOnce,
        RoleKind::Reviewer => match class {
            ToolClass::Write => PolicyDecision::Reject,
            ToolClass::Shell | ToolClass::Mcp | ToolClass::Read | ToolClass::Other => {
                PolicyDecision::AllowOnce
            }
            ToolClass::Unknown => PolicyDecision::Ask,
        },
        RoleKind::ReadOnlyMode => match class {
            ToolClass::Write | ToolClass::Shell => PolicyDecision::Reject,
            ToolClass::Mcp | ToolClass::Read | ToolClass::Other => PolicyDecision::AllowOnce,
            ToolClass::Unknown => PolicyDecision::Ask,
        },
        RoleKind::Unknown => PolicyDecision::Ask,
    }
}

pub fn classify_permission_params(params: &Value) -> ToolClass {
    let tool = tool_object(params);
    if mcp_signal(params) || mcp_signal(tool) {
        return ToolClass::Mcp;
    }
    if let Some(kind) = kind_string(tool).or_else(|| kind_string(params)) {
        if let Some(class) = class_from_kind(&kind) {
            return class;
        }
    }
    if let Some(class) = class_from_names(tool).or_else(|| class_from_names(params)) {
        return class;
    }
    if let Some(class) = class_from_raw_input(tool).or_else(|| class_from_raw_input(params)) {
        return class;
    }
    ToolClass::Unknown
}

pub fn auto_decision_line(
    decision: PolicyDecision,
    class: ToolClass,
    title: &str,
    network: bool,
) -> String {
    let title = if title.trim().is_empty() {
        "permission request"
    } else {
        title.trim()
    };
    let label = if network {
        format!("{}, network", class.as_str())
    } else {
        class.as_str().to_string()
    };
    match decision {
        PolicyDecision::AllowOnce => {
            format!("Permission auto-allowed ({label}): {title}")
        }
        PolicyDecision::Reject => {
            format!("Permission denied by role policy ({label}): {title}")
        }
        PolicyDecision::Ask => format!("Permission needs a decision ({label}): {title}"),
    }
}

pub fn cancelled_permission_result() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

fn selected_result(option_id: &str) -> Value {
    json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option_id
        }
    })
}

fn reject_result(options: &[PermissionChoice]) -> Value {
    if let Some(id) = options.iter().find_map(|opt| {
        let kind = opt.kind.to_ascii_lowercase();
        let id = opt.id.to_ascii_lowercase();
        if kind == "reject_once" || id == "reject-once" || id.contains("reject") {
            Some(opt.id.clone())
        } else {
            None
        }
    }) {
        selected_result(&id)
    } else {
        cancelled_permission_result()
    }
}

fn choice_id(options: &[PermissionChoice], allow: bool) -> String {
    if allow {
        if let Some(opt) = options.iter().find(|opt| {
            let kind = opt.kind.to_ascii_lowercase();
            let id = opt.id.to_ascii_lowercase();
            kind == "allow_once" || id == "allow-once"
        }) {
            return opt.id.clone();
        }
        if let Some(opt) = options.iter().find(|opt| {
            let kind = opt.kind.to_ascii_lowercase();
            let id = opt.id.to_ascii_lowercase();
            kind != "allow_always"
                && id != "allow-always"
                && !id.contains("reject")
                && kind != "reject_once"
        }) {
            return opt.id.clone();
        }
        return "allow-once".to_string();
    }
    "reject-once".to_string()
}

#[derive(Clone, Copy)]
enum RoleKind {
    FullAccess,
    Reviewer,
    ReadOnlyMode,
    Unknown,
}

fn canonical_role(role_id: &str) -> RoleKind {
    let normalized = role_id.trim().to_ascii_lowercase().replace('-', "_");
    match normalized.as_str() {
        "role_implementer" | "implementer" | "role_developer" | "developer"
        | "role_plan_reviewer" | "plan_reviewer" => RoleKind::FullAccess,
        "role_pr_reviewer" | "role_reviewer" | "pr_reviewer" | "reviewer" => RoleKind::Reviewer,
        "role_planner" | "planner" | "role_general" | "general" | "role_recommendation"
        | "recommendation" => RoleKind::ReadOnlyMode,
        "role_codebase_audit" | "codebase_audit" => RoleKind::Reviewer,
        _ => RoleKind::Unknown,
    }
}

fn tool_object(params: &Value) -> &Value {
    params
        .get("toolCall")
        .or_else(|| params.get("tool_call"))
        .unwrap_or(params)
}

fn mcp_signal(value: &Value) -> bool {
    if value.get("mcpServer").is_some() || value.get("mcp_server").is_some() {
        return true;
    }
    if let Some(raw) = value.get("rawInput").or_else(|| value.get("raw_input")) {
        if raw.get("mcpServer").is_some()
            || raw.get("mcp_server").is_some()
            || (raw.get("serverName").is_some() && raw.get("toolName").is_some())
        {
            return true;
        }
    }
    if let Some(kind) = kind_string(value) {
        if kind.eq_ignore_ascii_case("mcp") || kind.to_ascii_lowercase().starts_with("mcp_") {
            return true;
        }
    }
    for key in ["title", "toolName", "name", "tool"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            let lower = text.to_ascii_lowercase();
            if lower.starts_with("mcp:")
                || lower.starts_with("mcp ")
                || lower.starts_with("mcp/")
                || lower.contains(" mcp:")
            {
                return true;
            }
        }
    }
    false
}

fn kind_string(value: &Value) -> Option<String> {
    value
        .get("kind")
        .or_else(|| value.get("toolKind"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn class_from_kind(kind: &str) -> Option<ToolClass> {
    let k = kind.trim().to_ascii_lowercase().replace('-', "_");
    match k.as_str() {
        "edit" | "delete" | "move" | "write" | "apply_patch" | "strreplace" => {
            Some(ToolClass::Write)
        }
        "execute" | "shell" | "terminal" | "bash" => Some(ToolClass::Shell),
        "read" | "search" | "fetch" | "think" => Some(ToolClass::Read),
        "other" => Some(ToolClass::Other),
        "mcp" => Some(ToolClass::Mcp),
        _ => None,
    }
}

fn class_from_names(value: &Value) -> Option<ToolClass> {
    for key in ["toolName", "name", "title", "tool", "permission"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            if let Some(class) = class_from_label(text) {
                return Some(class);
            }
        }
    }
    None
}

fn class_from_label(text: &str) -> Option<ToolClass> {
    let lower = text.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    if lower.starts_with("mcp:") || lower.starts_with("mcp ") {
        return Some(ToolClass::Mcp);
    }
    const WRITE: &[&str] = &[
        "edit",
        "write",
        "delete",
        "strreplace",
        "str_replace",
        "apply_patch",
        "applypatch",
        "notebookedit",
    ];
    const SHELL: &[&str] = &["shell", "bash", "terminal", "execute", "command"];
    const READ: &[&str] = &[
        "read",
        "grep",
        "glob",
        "search",
        "webfetch",
        "websearch",
        "fetch",
    ];
    if WRITE.iter().any(|w| label_has_word(&lower, w)) {
        return Some(ToolClass::Write);
    }
    if SHELL.iter().any(|w| label_has_word(&lower, w)) {
        return Some(ToolClass::Shell);
    }
    if READ.iter().any(|w| label_has_word(&lower, w)) {
        return Some(ToolClass::Read);
    }
    None
}

fn label_has_word(label: &str, word: &str) -> bool {
    label
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| part == word)
}

fn class_from_raw_input(value: &Value) -> Option<ToolClass> {
    let raw = value.get("rawInput").or_else(|| value.get("raw_input"))?;
    if raw.get("command").and_then(|v| v.as_str()).is_some()
        || raw.get("cmd").and_then(|v| v.as_str()).is_some()
    {
        return Some(ToolClass::Shell);
    }
    let has_path = raw.get("path").is_some()
        || raw.get("file_path").is_some()
        || raw.get("filePath").is_some();
    let has_write_body = raw.get("contents").is_some()
        || raw.get("content").is_some()
        || raw.get("old_string").is_some()
        || raw.get("new_string").is_some()
        || raw.get("patch").is_some();
    if has_path && has_write_body {
        return Some(ToolClass::Write);
    }
    None
}

fn permission_title(params: &Value) -> String {
    let tool = tool_object(params);
    for source in [tool, params] {
        for key in ["title", "toolName", "name", "permission"] {
            if let Some(text) = source.get(key).and_then(|v| v.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    "Permission required".to_string()
}

fn permission_message(params: &Value) -> String {
    let tool = tool_object(params);
    let mut parts: Vec<String> = Vec::new();

    for source in [params, tool] {
        for key in ["message", "description"] {
            if let Some(text) = source.get(key).and_then(|v| v.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    push_unique(&mut parts, trimmed);
                }
            }
        }
    }

    if let Some(reason) = content_text_reason(tool).or_else(|| content_text_reason(params)) {
        push_unique(&mut parts, &reason);
    }

    if let Some(detail) = raw_input_detail(tool).or_else(|| raw_input_detail(params)) {
        push_unique(&mut parts, &detail);
    } else if let Some(from_title) = detail_from_title(permission_title(params).as_str()) {
        push_unique(&mut parts, &from_title);
    }

    if parts.is_empty() {
        let title = permission_title(params);
        if title != "Permission required" {
            return title;
        }
        return "Permission required".to_string();
    }
    parts.join(" — ")
}

fn push_unique(parts: &mut Vec<String>, text: &str) {
    if parts.iter().any(|p| p == text) {
        return;
    }
    parts.push(text.to_string());
}

fn content_text_reason(value: &Value) -> Option<String> {
    let content = value.get("content")?;
    let arr = content.as_array()?;
    for item in arr {
        if item.get("type").and_then(|v| v.as_str()) != Some("content") {
            // Also accept a bare text content block.
        }
        let text = item
            .pointer("/content/text")
            .or_else(|| item.get("text"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(text) = text {
            return Some(text.to_string());
        }
    }
    None
}

fn raw_input_detail(value: &Value) -> Option<String> {
    let raw = value.get("rawInput").or_else(|| value.get("raw_input"))?;
    if let Some(cmd) = raw
        .get("command")
        .or_else(|| raw.get("cmd"))
        .and_then(|v| v.as_str())
    {
        let trimmed = cmd.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(path) = raw
        .get("path")
        .or_else(|| raw.get("filePath"))
        .or_else(|| raw.get("file_path"))
        .and_then(|v| v.as_str())
    {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(url) = raw.get("url").and_then(|v| v.as_str()) {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn detail_from_title(title: &str) -> Option<String> {
    use super::tool_cache::{parse_backticked_command, parse_delete_path, parse_fetch_url};
    parse_backticked_command(title)
        .or_else(|| parse_delete_path(title))
        .or_else(|| parse_fetch_url(title))
}

pub fn display_kind_label(params: &Value, class: ToolClass) -> String {
    let tool = tool_object(params);
    let kind = kind_string(tool)
        .or_else(|| kind_string(params))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let title = permission_title(params);
    if kind == "delete" || title.trim().to_ascii_lowercase().starts_with("delete") {
        return "delete".to_string();
    }
    if kind == "fetch" || is_network_fetch(params, class) {
        return "fetch".to_string();
    }
    if !kind.is_empty() {
        return kind;
    }
    class.as_str().to_string()
}

pub fn is_network_fetch(params: &Value, class: ToolClass) -> bool {
    let tool = tool_object(params);
    if let Some(kind) = kind_string(tool).or_else(|| kind_string(params)) {
        if kind.eq_ignore_ascii_case("fetch") {
            return true;
        }
    }
    let title = permission_title(params).to_ascii_lowercase();
    if title.starts_with("fetch ") || title.starts_with("web fetch") {
        return true;
    }
    if let Some(raw) = tool.get("rawInput").or_else(|| tool.get("raw_input")) {
        if raw.get("url").and_then(|v| v.as_str()).is_some() && class == ToolClass::Read {
            return true;
        }
    }
    false
}

fn permission_options(params: &Value) -> Vec<PermissionChoice> {
    let mut options = Vec::new();
    if let Some(arr) = params.get("options").and_then(|v| v.as_array()) {
        for opt in arr {
            let id = opt
                .get("optionId")
                .or_else(|| opt.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if id.is_empty() {
                continue;
            }
            let label = opt
                .get("name")
                .or_else(|| opt.get("label"))
                .or_else(|| opt.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            let kind = opt
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            options.push(PermissionChoice { id, label, kind });
        }
    }
    if options.is_empty() {
        options = vec![
            PermissionChoice {
                id: "allow-once".to_string(),
                label: "Allow once".to_string(),
                kind: "allow_once".to_string(),
            },
            PermissionChoice {
                id: "allow-always".to_string(),
                label: "Allow always".to_string(),
                kind: "allow_always".to_string(),
            },
            PermissionChoice {
                id: "reject-once".to_string(),
                label: "Reject".to_string(),
                kind: "reject_once".to_string(),
            },
        ];
    }
    options
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn params_kind(kind: &str) -> Value {
        json!({
            "sessionId": "s1",
            "toolCall": {
                "toolCallId": "t1",
                "title": format!("tool {kind}"),
                "kind": kind,
                "rawInput": {}
            },
            "options": [
                { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "allow-always", "name": "Always", "kind": "allow_always" },
                { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
            ]
        })
    }

    #[test]
    fn classifies_acp_tool_kinds() {
        assert_eq!(
            classify_permission_params(&params_kind("edit")),
            ToolClass::Write
        );
        assert_eq!(
            classify_permission_params(&params_kind("delete")),
            ToolClass::Write
        );
        assert_eq!(
            classify_permission_params(&params_kind("execute")),
            ToolClass::Shell
        );
        assert_eq!(
            classify_permission_params(&params_kind("read")),
            ToolClass::Read
        );
        assert_eq!(
            classify_permission_params(&params_kind("other")),
            ToolClass::Other
        );
    }

    #[test]
    fn classifies_shell_from_raw_command_when_kind_missing() {
        let params = json!({
            "toolCall": {
                "title": "Run tests",
                "rawInput": { "command": "npm test" }
            }
        });
        assert_eq!(classify_permission_params(&params), ToolClass::Shell);
    }

    #[test]
    fn classifies_write_from_path_and_contents() {
        let params = json!({
            "toolName": "custom",
            "rawInput": { "path": "src/main.rs", "contents": "fn main() {}" }
        });
        assert_eq!(classify_permission_params(&params), ToolClass::Write);
    }

    #[test]
    fn classifies_mcp_from_server_fields_before_write_looking_title() {
        let params = json!({
            "toolCall": {
                "title": "Write issue",
                "kind": "other",
                "rawInput": { "serverName": "github", "toolName": "create_issue" }
            }
        });
        assert_eq!(classify_permission_params(&params), ToolClass::Mcp);
    }

    #[test]
    fn shell_command_mentioning_mcp_is_still_shell() {
        let params = json!({
            "toolCall": {
                "kind": "execute",
                "title": "Shell",
                "rawInput": { "command": "npm install @modelcontextprotocol/sdk" }
            }
        });
        assert_eq!(classify_permission_params(&params), ToolClass::Shell);
    }

    #[test]
    fn unknown_payload_stays_unknown() {
        let params = json!({ "toolCall": { "title": "Do the thing" } });
        assert_eq!(classify_permission_params(&params), ToolClass::Unknown);
    }

    #[test]
    fn implementer_and_developer_auto_allow_everything() {
        for role in ["role_implementer", "role_developer", "Implementer"] {
            for class in [
                ToolClass::Write,
                ToolClass::Shell,
                ToolClass::Mcp,
                ToolClass::Unknown,
            ] {
                assert_eq!(
                    decide_for_role(role, class),
                    PolicyDecision::AllowOnce,
                    "{role} {class:?}"
                );
            }
        }
    }

    #[test]
    fn reviewer_allows_shell_and_mcp_and_rejects_writes() {
        for role in ["role_pr_reviewer", "role_codebase_audit"] {
            assert_eq!(
                decide_for_role(role, ToolClass::Shell),
                PolicyDecision::AllowOnce,
                "{role}"
            );
            assert_eq!(
                decide_for_role(role, ToolClass::Mcp),
                PolicyDecision::AllowOnce,
                "{role}"
            );
            assert_eq!(
                decide_for_role(role, ToolClass::Read),
                PolicyDecision::AllowOnce,
                "{role}"
            );
            assert_eq!(
                decide_for_role(role, ToolClass::Write),
                PolicyDecision::Reject,
                "{role}"
            );
            assert_eq!(
                decide_for_role(role, ToolClass::Unknown),
                PolicyDecision::Ask,
                "{role}"
            );
        }
    }

    #[test]
    fn planner_and_general_block_write_and_shell_but_allow_mcp() {
        for role in ["role_planner", "role_general", "role_recommendation"] {
            assert_eq!(
                decide_for_role(role, ToolClass::Write),
                PolicyDecision::Reject
            );
            assert_eq!(
                decide_for_role(role, ToolClass::Shell),
                PolicyDecision::Reject
            );
            assert_eq!(
                decide_for_role(role, ToolClass::Mcp),
                PolicyDecision::AllowOnce
            );
            assert_eq!(
                decide_for_role(role, ToolClass::Unknown),
                PolicyDecision::Ask
            );
        }
    }

    #[test]
    fn unknown_role_asks_instead_of_auto_allowing() {
        assert_eq!(
            decide_for_role("role_custom", ToolClass::Read),
            PolicyDecision::Ask
        );
    }

    #[test]
    fn plan_reviewer_has_full_access() {
        let outcome = evaluate_permission("role_plan_reviewer", &params_kind("edit"));
        assert_eq!(outcome.decision, PolicyDecision::AllowOnce);
        let result = outcome.auto_result.expect("auto");
        assert_eq!(result["outcome"]["optionId"], "allow-once");
        for class in [ToolClass::Write, ToolClass::Shell, ToolClass::Mcp, ToolClass::Unknown] {
            assert_eq!(
                decide_for_role("role_plan_reviewer", class),
                PolicyDecision::AllowOnce,
                "{class:?}"
            );
        }
    }

    #[test]
    fn auto_allow_uses_allow_once_not_allow_always() {
        let outcome = evaluate_permission("role_developer", &params_kind("edit"));
        let result = outcome.auto_result.expect("auto");
        assert_eq!(result["outcome"]["optionId"], "allow-once");
        assert!(outcome
            .transcript_line
            .unwrap()
            .contains("auto-allowed (write)"));
    }

    #[test]
    fn reviewer_write_selects_reject_once() {
        let outcome = evaluate_permission("role_pr_reviewer", &params_kind("edit"));
        let result = outcome.auto_result.expect("auto");
        assert_eq!(result["outcome"]["optionId"], "reject-once");
        assert_eq!(outcome.decision, PolicyDecision::Reject);
    }

    #[test]
    fn ambiguous_reviewer_request_has_no_auto_result() {
        let params = json!({ "toolCall": { "title": "Do the thing" } });
        let outcome = evaluate_permission("role_pr_reviewer", &params);
        assert_eq!(outcome.decision, PolicyDecision::Ask);
        assert!(outcome.auto_result.is_none());
        assert!(outcome.transcript_line.is_none());
    }

    #[test]
    fn reject_without_reject_option_cancels() {
        let params = json!({
            "toolCall": { "kind": "edit", "title": "Edit file" },
            "options": [
                { "optionId": "allow-once", "name": "Allow", "kind": "allow_once" }
            ]
        });
        let outcome = evaluate_permission("role_planner", &params);
        assert_eq!(
            outcome.auto_result.unwrap()["outcome"]["outcome"],
            "cancelled"
        );
    }

    fn fixture_params(name: &str) -> (Value, Option<Value>) {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/acp/permissions")
            .join(name);
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let params = raw["request"]["params"].clone();
        let preceding = raw.get("precedingToolCallUpdates").cloned();
        (params, preceding)
    }

    fn enrich_from_fixture(name: &str) -> Value {
        use crate::permissions::ToolCallCache;
        let (params, preceding) = fixture_params(name);
        let mut cache = ToolCallCache::new();
        if let Some(Value::Array(items)) = preceding {
            for item in items {
                if let Some(update) = item.get("update") {
                    cache.observe_tool_update(update);
                }
            }
        }
        cache.enrich_params(&params)
    }

    #[test]
    fn captured_shell_message_includes_allowlist_reason_and_command() {
        let enriched = enrich_from_fixture("shell-ls.json");
        let outcome = evaluate_permission("role_developer", &enriched);
        assert_eq!(outcome.class, ToolClass::Shell);
        assert_eq!(outcome.display_kind, "execute");
        assert!(outcome.message.contains("Shell allowlist is empty"));
        assert!(outcome.message.contains("ls -la"));
        assert!(!outcome.message.is_empty());
    }

    #[test]
    fn captured_delete_displays_as_delete_and_classifies_write() {
        let enriched = enrich_from_fixture("delete-hello.json");
        let outcome = evaluate_permission("role_pr_reviewer", &enriched);
        assert_eq!(outcome.class, ToolClass::Write);
        assert_eq!(outcome.display_kind, "delete");
        assert_eq!(outcome.decision, PolicyDecision::Reject);
        assert!(outcome.message.contains("hello.txt"));
    }

    #[test]
    fn captured_fetch_is_read_network_and_allowed_for_planner() {
        let enriched = enrich_from_fixture("fetch-example.json");
        assert_eq!(classify_permission_params(&enriched), ToolClass::Read);
        for role in ["role_planner", "role_general", "role_pr_reviewer"] {
            let outcome = evaluate_permission(role, &enriched);
            assert_eq!(outcome.decision, PolicyDecision::AllowOnce, "{role}");
            assert!(outcome.network, "{role}");
            assert_eq!(outcome.display_kind, "fetch");
            assert!(
                outcome
                    .transcript_line
                    .as_deref()
                    .unwrap()
                    .contains("network"),
                "{role}"
            );
            assert!(outcome.message.contains("https://example.com"));
        }
        let implementer = evaluate_permission("role_implementer", &enriched);
        assert_eq!(implementer.decision, PolicyDecision::AllowOnce);
        let unknown = evaluate_permission("role_custom", &enriched);
        assert_eq!(unknown.decision, PolicyDecision::Ask);
    }

    #[test]
    fn captured_shell_role_matrix() {
        let enriched = enrich_from_fixture("shell-echo.json");
        assert_eq!(
            evaluate_permission("role_implementer", &enriched).decision,
            PolicyDecision::AllowOnce
        );
        assert_eq!(
            evaluate_permission("role_developer", &enriched).decision,
            PolicyDecision::AllowOnce
        );
        assert_eq!(
            evaluate_permission("role_pr_reviewer", &enriched).decision,
            PolicyDecision::AllowOnce
        );
        for role in ["role_planner", "role_general", "role_recommendation"] {
            assert_eq!(
                evaluate_permission(role, &enriched).decision,
                PolicyDecision::Reject,
                "{role}"
            );
        }
        assert_eq!(
            evaluate_permission("role_codebase_audit", &enriched).decision,
            PolicyDecision::AllowOnce
        );
        assert_eq!(
            evaluate_permission("role_custom", &enriched).decision,
            PolicyDecision::Ask
        );
    }

    #[test]
    fn fetch_without_cache_parses_title() {
        let (params, _) = fixture_params("fetch-example.json");
        let outcome = evaluate_permission("role_planner", &params);
        assert!(outcome.message.contains("https://example.com"));
        assert!(outcome.network);
    }

    #[test]
    fn planner_allows_fetch_read_class() {
        assert_eq!(
            decide_for_role("role_planner", ToolClass::Read),
            PolicyDecision::AllowOnce
        );
        assert_eq!(
            decide_for_role("role_general", ToolClass::Read),
            PolicyDecision::AllowOnce
        );
    }
}
