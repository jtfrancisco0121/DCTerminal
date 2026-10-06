//! Per-session cache of `tool_call` / `tool_call_update` notifications.
//!
//! Live Cursor ACP permission requests often omit `rawInput`. The command,
//! path, or URL usually arrived earlier (or later) on a matching
//! `toolCallId`. Fetch is special: the permission uses `web_fetch_0` and can
//! arrive before any tool_call, so title parsing remains the fallback.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct CachedToolCall {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub raw_input: Option<Value>,
    pub locations: Option<Value>,
}

#[derive(Debug, Default, Clone)]
pub struct ToolCallCache {
    entries: HashMap<String, CachedToolCall>,
}

impl ToolCallCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Observe a `session/update` notification (or its inner `update` object).
    pub fn observe_notification(&mut self, line: &Value) {
        let update = extract_update(line);
        let kind = update
            .get("sessionUpdate")
            .or_else(|| update.get("type"))
            .or_else(|| update.get("updateType"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if kind != "tool_call" && kind != "tool_call_update" {
            return;
        }
        self.observe_tool_update(update);
    }

    pub fn observe_tool_update(&mut self, update: &Value) {
        let Some(id) = tool_call_id(update) else {
            return;
        };
        let entry = self.entries.entry(id).or_default();
        if let Some(kind) = update.get("kind").and_then(|v| v.as_str()) {
            if !kind.trim().is_empty() {
                entry.kind = Some(kind.to_string());
            }
        }
        if let Some(title) = update.get("title").and_then(|v| v.as_str()) {
            if !title.trim().is_empty() {
                entry.title = Some(title.to_string());
            }
        }
        if let Some(raw) = update.get("rawInput").or_else(|| update.get("raw_input")) {
            entry.raw_input = Some(merge_objects(entry.raw_input.as_ref(), raw));
        }
        if let Some(locs) = update.get("locations") {
            entry.locations = Some(locs.clone());
        }
        if let Some(nested) = update.get("toolCall").or_else(|| update.get("tool_call")) {
            if let Some(kind) = nested.get("kind").and_then(|v| v.as_str()) {
                if !kind.trim().is_empty() {
                    entry.kind = Some(kind.to_string());
                }
            }
            if let Some(title) = nested.get("title").and_then(|v| v.as_str()) {
                if !title.trim().is_empty() {
                    entry.title = Some(title.to_string());
                }
            }
            if let Some(raw) = nested.get("rawInput").or_else(|| nested.get("raw_input")) {
                entry.raw_input = Some(merge_objects(entry.raw_input.as_ref(), raw));
            }
        }
    }

    pub fn get(&self, tool_call_id: &str) -> Option<&CachedToolCall> {
        self.entries.get(tool_call_id)
    }

    /// Return a copy of `params` with missing rawInput/kind filled from cache
    /// and, when still missing, from the title (`ls`, `Delete \`path\``, `Fetch url`).
    pub fn enrich_params(&self, params: &Value) -> Value {
        let mut enriched = params.clone();
        let tool_id = tool_object(&enriched)
            .get("toolCallId")
            .or_else(|| tool_object(&enriched).get("tool_call_id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let cached = tool_id.as_deref().and_then(|id| self.get(id));
        ensure_tool_object(&mut enriched);
        let tool_key = if enriched.get("toolCall").is_some() {
            "toolCall"
        } else if enriched.get("tool_call").is_some() {
            "tool_call"
        } else {
            "toolCall"
        };
        if let Some(tool) = enriched.get_mut(tool_key) {
            if let Some(cached) = cached {
                if tool.get("kind").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                    if let Some(kind) = &cached.kind {
                        tool.as_object_mut()
                            .unwrap()
                            .insert("kind".into(), Value::String(kind.clone()));
                    }
                }
                // Prefer cached delete kind when the request says edit but cache says delete.
                if let Some(kind) = &cached.kind {
                    if kind.eq_ignore_ascii_case("delete") {
                        tool.as_object_mut()
                            .unwrap()
                            .insert("kind".into(), Value::String("delete".into()));
                    }
                }
                let needs_raw = tool
                    .get("rawInput")
                    .or_else(|| tool.get("raw_input"))
                    .map(|raw| raw.as_object().map(|o| o.is_empty()).unwrap_or(true))
                    .unwrap_or(true);
                if needs_raw {
                    if let Some(raw) = &cached.raw_input {
                        tool.as_object_mut()
                            .unwrap()
                            .insert("rawInput".into(), raw.clone());
                    }
                } else if let Some(raw) = &cached.raw_input {
                    let merged = merge_objects(tool.get("rawInput"), raw);
                    tool.as_object_mut()
                        .unwrap()
                        .insert("rawInput".into(), merged);
                }
                if tool.get("locations").is_none() {
                    if let Some(locs) = &cached.locations {
                        tool.as_object_mut()
                            .unwrap()
                            .insert("locations".into(), locs.clone());
                    }
                }
            }
            apply_title_fallbacks(tool);
        }
        enriched
    }
}

fn extract_update(line: &Value) -> &Value {
    if line.get("method").and_then(|m| m.as_str()) == Some("session/update") {
        let params = line.get("params").unwrap_or(line);
        params.get("update").unwrap_or(params)
    } else {
        line.get("update").unwrap_or(line)
    }
}

fn tool_call_id(value: &Value) -> Option<String> {
    value
        .get("toolCallId")
        .or_else(|| value.get("tool_call_id"))
        .or_else(|| {
            value
                .get("toolCall")
                .or_else(|| value.get("tool_call"))
                .and_then(|t| t.get("toolCallId").or_else(|| t.get("tool_call_id")))
        })
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

fn tool_object(params: &Value) -> &Value {
    params
        .get("toolCall")
        .or_else(|| params.get("tool_call"))
        .unwrap_or(params)
}

fn ensure_tool_object(params: &mut Value) {
    if params.get("toolCall").is_none() && params.get("tool_call").is_none() {
        if let Some(obj) = params.as_object_mut() {
            obj.insert("toolCall".into(), json!({}));
        }
    }
}

fn merge_objects(existing: Option<&Value>, incoming: &Value) -> Value {
    match (existing.and_then(|v| v.as_object()), incoming.as_object()) {
        (Some(old), Some(new)) => {
            let mut out = Map::new();
            for (k, v) in old {
                out.insert(k.clone(), v.clone());
            }
            for (k, v) in new {
                if !v.is_null() {
                    out.insert(k.clone(), v.clone());
                }
            }
            Value::Object(out)
        }
        (_, Some(_)) => incoming.clone(),
        (Some(old), None) => Value::Object(old.clone()),
        _ => incoming.clone(),
    }
}

/// When rawInput still lacks command/path/url, parse the title.
fn apply_title_fallbacks(tool: &mut Value) {
    let title = tool
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let kind = tool
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut raw = tool
        .get("rawInput")
        .or_else(|| tool.get("raw_input"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !raw.is_object() {
        raw = json!({});
    }
    let obj = raw.as_object_mut().unwrap();

    if obj.get("command").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        if let Some(cmd) = parse_backticked_command(&title) {
            obj.insert("command".into(), Value::String(cmd));
        }
    }
    if obj.get("path").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        if let Some(path) = parse_delete_path(&title) {
            obj.insert("path".into(), Value::String(path));
        }
    }
    if obj.get("url").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        if let Some(url) = parse_fetch_url(&title) {
            obj.insert("url".into(), Value::String(url));
        }
    }

    // Display kind: Delete title or empty kind with delete path → delete.
    let looks_like_delete = title.trim().to_ascii_lowercase().starts_with("delete")
        || kind == "delete";
    if looks_like_delete {
        if let Some(map) = tool.as_object_mut() {
            map.insert("kind".into(), Value::String("delete".into()));
        }
    }

    if let Some(map) = tool.as_object_mut() {
        map.insert("rawInput".into(), raw);
    }
}

pub fn parse_backticked_command(title: &str) -> Option<String> {
    let trimmed = title.trim();
    if let Some(start) = trimmed.find('`') {
        let rest = &trimmed[start + 1..];
        if let Some(end) = rest.find('`') {
            let cmd = rest[..end].trim();
            if !cmd.is_empty() {
                return Some(cmd.to_string());
            }
        }
    }
    None
}

pub fn parse_delete_path(title: &str) -> Option<String> {
    let trimmed = title.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("delete") {
        return None;
    }
    parse_backticked_command(trimmed).or_else(|| {
        let after = trimmed[6..].trim();
        if after.is_empty() {
            None
        } else {
            Some(after.trim_matches('`').trim().to_string())
        }
    })
}

pub fn parse_fetch_url(title: &str) -> Option<String> {
    let trimmed = title.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["fetch ", "web fetch:", "web fetch ", "webfetch "] {
        if lower.starts_with(prefix) {
            let url = trimmed[prefix.len()..].trim();
            if url.starts_with("http://") || url.starts_with("https://") {
                return Some(url.to_string());
            }
        }
    }
    if let Some(idx) = lower.find("https://").or_else(|| lower.find("http://")) {
        return Some(trimmed[idx..].trim().to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enriches_shell_from_preceding_tool_call() {
        let mut cache = ToolCallCache::new();
        cache.observe_tool_update(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "`ls -la`",
            "kind": "execute",
            "rawInput": { "command": "ls -la" }
        }));
        let params = json!({
            "toolCall": {
                "toolCallId": "call-1",
                "title": "`ls -la`",
                "kind": "execute",
                "status": "pending",
                "content": [{ "type": "content", "content": { "type": "text", "text": "Shell allowlist is empty" } }]
            }
        });
        let enriched = cache.enrich_params(&params);
        assert_eq!(enriched["toolCall"]["rawInput"]["command"], "ls -la");
    }

    #[test]
    fn delete_request_kind_edit_becomes_delete_from_cache_and_title() {
        let mut cache = ToolCallCache::new();
        cache.observe_tool_update(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "del-1",
            "title": "Delete File",
            "kind": "delete",
            "rawInput": {}
        }));
        cache.observe_tool_update(&json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "del-1",
            "title": "Delete `/tmp/x/hello.txt`",
            "rawInput": { "path": "/tmp/x/hello.txt" }
        }));
        let params = json!({
            "toolCall": {
                "toolCallId": "del-1",
                "title": "Delete `/tmp/x/hello.txt`",
                "kind": "edit",
                "status": "pending"
            }
        });
        let enriched = cache.enrich_params(&params);
        assert_eq!(enriched["toolCall"]["kind"], "delete");
        assert_eq!(enriched["toolCall"]["rawInput"]["path"], "/tmp/x/hello.txt");
    }

    #[test]
    fn fetch_before_tool_call_parses_url_from_title() {
        let cache = ToolCallCache::new();
        let params = json!({
            "toolCall": {
                "toolCallId": "web_fetch_0",
                "title": "Fetch https://example.com",
                "kind": "fetch",
                "status": "pending"
            }
        });
        let enriched = cache.enrich_params(&params);
        assert_eq!(enriched["toolCall"]["rawInput"]["url"], "https://example.com");
    }

    #[test]
    fn mismatched_fetch_id_still_uses_title() {
        let mut cache = ToolCallCache::new();
        cache.observe_tool_update(&json!({
            "toolCallId": "real-call-id",
            "kind": "fetch",
            "title": "Web Fetch: https://example.com",
            "rawInput": { "url": "https://example.com" }
        }));
        let params = json!({
            "toolCall": {
                "toolCallId": "web_fetch_0",
                "title": "Fetch https://example.com",
                "kind": "fetch"
            }
        });
        let enriched = cache.enrich_params(&params);
        assert_eq!(enriched["toolCall"]["rawInput"]["url"], "https://example.com");
    }
}
