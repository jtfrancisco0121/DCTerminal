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
        || normalized
            .split('_')
            .any(|part| matches!(part, "secret" | "password" | "passwd" | "token"))
}

/// `scheme://user:pass@host/…` with the credential part masked.
fn mask_url_userinfo(word: &str) -> Option<String> {
    let (scheme, rest) = word.split_once("://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let (userinfo, host) = authority.rsplit_once('@')?;
    let user = match userinfo.split_once(':') {
        Some((user, _)) => format!("{user}:{REDACTED}"),
        None => REDACTED.to_string(),
    };
    Some(format!("{scheme}://{user}@{host}{tail}"))
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
    key == "command" || key == "title" || key == "path" || key == "cwd" || key == "url"
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

/// One line for the activity log: a command, path, or URL with inline
/// secrets masked (`Bearer x`, `sk-…`, `TOKEN=x`, `--password x`) and capped
/// at `max_chars`. Whitespace runs collapse so multi-line scripts fit a row.
pub fn redact_summary(text: &str, max_chars: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut mask_next = false;
    for word in text.split_whitespace() {
        let bare = word.trim_matches(|c| c == '"' || c == '\'');
        let lower = bare.to_ascii_lowercase();
        // `Authorization: Bearer x` masks only the credential.
        if lower == "bearer" || lower == "basic" || lower.ends_with("authorization:") {
            out.push(word.to_string());
            mask_next = true;
            continue;
        }
        if mask_next {
            out.push(REDACTED.to_string());
            mask_next = false;
            continue;
        }
        if let Some(flag) = lower.strip_prefix("--") {
            if sensitive_key(flag) && !flag.contains('=') {
                out.push(word.to_string());
                mask_next = true;
                continue;
            }
        }
        if let Some(masked) = mask_url_userinfo(bare) {
            out.push(masked);
            continue;
        }
        if let Some((base, query)) = bare.split_once("://").and_then(|_| bare.split_once('?')) {
            let pairs: Vec<String> = query
                .split('&')
                .map(|pair| match pair.split_once('=') {
                    Some((key, _)) if sensitive_key(key) || key.eq_ignore_ascii_case("key") => {
                        format!("{key}={REDACTED}")
                    }
                    _ => pair.to_string(),
                })
                .collect();
            out.push(format!("{base}?{}", pairs.join("&")));
            continue;
        }
        if let Some((key, _)) = bare.split_once('=') {
            let key = key.trim_start_matches('-');
            if !key.is_empty() && sensitive_key(key) {
                out.push(format!("{key}={REDACTED}"));
                continue;
            }
        }
        if looks_like_secret(bare) {
            out.push(REDACTED.to_string());
            continue;
        }
        out.push(word.to_string());
    }
    let joined = out.join(" ");
    if joined.chars().count() > max_chars {
        let head: String = joined.chars().take(max_chars.saturating_sub(1)).collect();
        format!("{head}…")
    } else {
        joined
    }
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

pub fn permission_log_record_with_meta(
    tab_id: &str,
    role_id: &str,
    captured_at: &str,
    request: &Value,
    display_kind: Option<&str>,
    network: bool,
    tool_class: Option<&str>,
) -> Value {
    let mut record = json!({
        "capturedAt": captured_at,
        "tabId": tab_id,
        "roleId": role_id,
        "method": request.get("method").and_then(|m| m.as_str()).unwrap_or("session/request_permission"),
        "payload": redact_permission_payload(request),
    });
    if let Some(kind) = display_kind {
        record
            .as_object_mut()
            .unwrap()
            .insert("displayKind".into(), json!(kind));
    }
    if network {
        record
            .as_object_mut()
            .unwrap()
            .insert("network".into(), json!(true));
    }
    if let Some(class) = tool_class {
        record
            .as_object_mut()
            .unwrap()
            .insert("toolClass".into(), json!(class));
    }
    record
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
    fn summary_masks_inline_secrets_and_caps_length() {
        let cmd = "curl -H 'Authorization: Bearer abc.def' https://api.example.com --token xyz";
        let out = redact_summary(cmd, 500);
        assert!(!out.contains("abc.def"), "{out}");
        assert!(!out.contains("xyz"), "{out}");
        assert!(out.contains("https://api.example.com"));
        let env = redact_summary("GITHUB_TOKEN=ghp_123 API_KEY=k1 npm   publish", 500);
        assert_eq!(env, "GITHUB_TOKEN=[redacted] API_KEY=[redacted] npm publish");
        assert_eq!(redact_summary("echo sk-live-123", 500), "echo [redacted]");
        assert_eq!(
            redact_summary("https://x.dev/a?q=1&access_token=abc", 500),
            "https://x.dev/a?q=1&access_token=[redacted]"
        );
        assert_eq!(redact_summary("ls -la\n  src", 500), "ls -la src");
        let long = redact_summary(&"a ".repeat(400), 500);
        assert_eq!(long.chars().count(), 500);
        assert!(long.ends_with('…'));
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
