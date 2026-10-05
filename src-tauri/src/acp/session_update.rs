use serde::Serialize;
use serde_json::Value;

pub const SESSION_UPDATE_EVENT: &str = "acp/session-update";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateEvent {
    pub session_id: String,
    pub kind: String,
    pub text_delta: Option<String>,
    pub raw_json: String,
}

pub fn map_session_update(session_id: &str, line: &Value) -> Option<SessionUpdateEvent> {
    let method = line.get("method").and_then(|m| m.as_str());
    let params = if method == Some("session/update") {
        line.get("params").cloned().unwrap_or_else(|| line.clone())
    } else if method.is_some() {
        return None;
    } else {
        line.clone()
    };

    let (kind, text_delta) = classify_update(&params);
    Some(SessionUpdateEvent {
        session_id: session_id.to_string(),
        kind,
        text_delta,
        raw_json: params.to_string(),
    })
}

fn classify_update(params: &Value) -> (String, Option<String>) {
    let update = params.get("update").unwrap_or(params);
    let kind = update
        .get("type")
        .or_else(|| update.get("updateType"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let normalized = kind.replace('_', "").to_lowercase();
    let text_delta = if normalized.contains("agentmessage")
        || normalized == "text"
        || kind == "agent_message_chunk"
    {
        extract_text_delta(update)
    } else {
        None
    };

    (kind, text_delta)
}

fn extract_text_delta(value: &Value) -> Option<String> {
    if let Some(text) = value.get("text").and_then(|t| t.as_str()) {
        return Some(text.to_string());
    }
    if let Some(content) = value.get("content").and_then(|c| c.as_str()) {
        return Some(content.to_string());
    }
    if let Some(chunk) = value.get("chunk") {
        return extract_text_delta(chunk);
    }
    if let Some(delta) = value.get("delta").and_then(|d| d.as_str()) {
        return Some(delta.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::map_session_update;
    use serde_json::json;

    #[test]
    fn maps_agent_message_chunk() {
        let line = json!({
            "method": "session/update",
            "params": {
                "type": "agent_message_chunk",
                "text": "Hello"
            }
        });
        let evt = map_session_update("sess_1", &line).expect("event");
        assert_eq!(evt.session_id, "sess_1");
        assert_eq!(evt.text_delta.as_deref(), Some("Hello"));
    }
}
