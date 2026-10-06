use serde_json::Value;

/// Pull displayable text from an ACP `session/update` payload (params or inner `update`).
pub fn text_from_session_params(params: &Value) -> Option<String> {
    if let Some(update) = params.get("update") {
        return text_from_update_value(update);
    }
    text_from_update_value(params)
}

pub fn text_from_update_value(update: &Value) -> Option<String> {
    let kind = update_kind(update);
    let normalized = kind.replace('_', "").to_lowercase();

    if normalized.contains("toolcall") {
        return Some(format_tool_update(update));
    }

    extract_text_from_value(update).filter(|s| !s.is_empty())
}

fn update_kind(update: &Value) -> String {
    update
        .get("type")
        .or_else(|| update.get("updateType"))
        .or_else(|| update.get("sessionUpdate"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn format_tool_update(update: &Value) -> String {
    let name = update
        .get("toolName")
        .or_else(|| update.get("name"))
        .or_else(|| update.get("title"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            update
                .get("toolCall")
                .and_then(|t| t.get("name"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("tool");
    let status = update
        .get("status")
        .or_else(|| update.get("toolCall").and_then(|t| t.get("status")))
        .and_then(|v| v.as_str());
    match status {
        Some(s) => format!("{} ({})", name, s),
        None => name.to_string(),
    }
}

pub fn extract_text_from_value(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    if let Some(n) = value.as_number() {
        return Some(n.to_string());
    }
    if let Some(b) = value.as_bool() {
        return Some(b.to_string());
    }
    if let Some(arr) = value.as_array() {
        let joined: String = arr.iter().filter_map(extract_text_from_value).collect();
        return if joined.is_empty() {
            None
        } else {
            Some(joined)
        };
    }
    if let Some(obj) = value.as_object() {
        for key in [
            "text",
            "delta",
            "content",
            "message",
            "chunk",
            "value",
            "data",
        ] {
            if let Some(v) = obj.get(key) {
                if let Some(s) = extract_text_from_value(v) {
                    if !s.is_empty() {
                        return Some(s);
                    }
                }
            }
        }
        if let Some(parts) = obj.get("parts") {
            if let Some(s) = extract_text_from_value(parts) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::extract_text_from_value;
    use serde_json::json;

    #[test]
    fn nested_text_block() {
        let v = json!({ "type": "text", "text": "Hello" });
        assert_eq!(extract_text_from_value(&v).as_deref(), Some("Hello"));
    }

    #[test]
    fn content_parts_array() {
        let v = json!({
            "content": [{ "text": "A" }, { "text": "B" }]
        });
        assert_eq!(extract_text_from_value(&v).as_deref(), Some("AB"));
    }
}
