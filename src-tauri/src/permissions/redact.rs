//! Redact file bodies and secrets from `session/request_permission` payloads
//! before they are written to the local diagnostic log.

use serde_json::{json, Value};

const REDACTED: &str = "[redacted]";
const MAX_STRING: usize = 500;

const SENSITIVE_KEYS: &[&str] = &[
    "content",
    "contents",
    "filecontent",
    "file_content",
    "text",
    "diff",
    "old_string",
    "oldstring",
    "new_string",
    "newstring",
    "body",
    "secret",
    "token",
    "password",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "access_token",
    "refresh_token",
    "private_key",
];

pub fn redact_permission_payload(value: &Value) -> Value {
    redact_value(value, None)
}

fn redact_value(value: &Value, key: Option<&str>) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), redact_value(v, Some(k)));
            }
            Value::Object(out)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| redact_value(item, key)).collect())
        }
        Value::String(text) => Value::String(redact_string(key, text)),
        other => other.clone(),
    }
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace('-', "_");
    SENSITIVE_KEYS
        .iter()
        .any(|name| normalized == *name || normalized.ends_with(&format!("_{name}")))
}

fn redact_string(key: Option<&str>, text: &str) -> String {
    if key.is_some_and(sensitive_key) {
        return REDACTED.to_string();
    }
    if looks_like_secret(text) {
        return REDACTED.to_string();
    }
    if text.chars().count() > MAX_STRING && !key.is_some_and(keep_long) {
        let head: String = text.chars().take(120).collect();
        return format!("{head}…[truncated]");
    }
    text.to_string()
}

fn keep_long(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key == "command" || key == "title" || key == "path" || key == "cwd"
}

fn looks_like_secret(text: &str) -> bool {
    let trimmed = text.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("sk-")
        || lower.starts_with("sk_live")
        || lower.starts_with("ghp_")
        || lower.starts_with("github_pat_")
        || lower.starts_with("xoxb-")
        || lower.starts_with("bearer ")
        || lower.starts_with("akia")
        || trimmed.contains("BEGIN PRIVATE KEY")
        || trimmed.contains("BEGIN OPENSSH PRIVATE KEY")
}

pub fn append_permission_log(path: &std::path::Path, line: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("permission log dir: {e}"))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("permission log: {e}"))?;
    use std::io::Write;
    let payload = serde_json::to_string(line).map_err(|e| e.to_string())?;
    writeln!(file, "{payload}").map_err(|e| format!("permission log write: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("permission log sync: {e}"))?;
    Ok(())
}

pub fn permission_log_record(
    tab_id: &str,
    role_id: &str,
    captured_at: &str,
    request: &Value,
) -> Value {
    json!({
        "capturedAt": captured_at,
        "tabId": tab_id,
        "roleId": role_id,
        "method": request.get("method").and_then(|m| m.as_str()).unwrap_or("session/request_permission"),
        "payload": redact_permission_payload(request),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn redacts_file_contents_and_secrets_but_keeps_the_command() {
        let value = json!({
            "method": "session/request_permission",
            "params": {
                "toolCall": {
                    "kind": "edit",
                    "title": "Edit auth.ts",
                    "content": "const token = 'super-secret-file-body';",
                    "rawInput": {
                        "path": "src/auth.ts",
                        "command": "npm test",
                        "apiKey": "sk-live-abc123",
                        "diff": "--- a/auth.ts\n+++ b/auth.ts"
                    }
                }
            }
        });
        let out = redact_permission_payload(&value);
        let tool = &out["params"]["toolCall"];
        assert_eq!(tool["content"], REDACTED);
        assert_eq!(tool["title"], "Edit auth.ts");
        assert_eq!(tool["rawInput"]["path"], "src/auth.ts");
        assert_eq!(tool["rawInput"]["command"], "npm test");
        assert_eq!(tool["rawInput"]["apiKey"], REDACTED);
        assert_eq!(tool["rawInput"]["diff"], REDACTED);
        assert_eq!(tool["kind"], "edit");
    }

    #[test]
    fn redacts_inline_tokens_and_truncates_unknown_blobs() {
        let value = json!({ "note": "Bearer abc.def.ghi", "blob": "x".repeat(800) });
        let out = redact_permission_payload(&value);
        assert_eq!(out["note"], REDACTED);
        assert!(out["blob"].as_str().unwrap().contains("[truncated]"));
    }

    #[test]
    fn append_reports_a_write_failure() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_permlog_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        let err = append_permission_log(&blocker.join("log.jsonl"), &json!({"a": 1})).unwrap_err();
        assert!(err.contains("permission log"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
