use serde_json::{json, Value};

pub fn is_permission_method(method: &str) -> bool {
    let m = method.to_lowercase();
    m == "session/request_permission" || m.contains("request_permission")
}

/// FR-007 / FR-011: never leave agent requests unanswered; deny by default in dev.
pub fn response_for_agent_request(request: &Value) -> Value {
    let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");

    match method {
        "session/request_permission" => json!({
            "outcome": { "outcome": "cancelled" }
        }),
        "cursor/ask_question" => json!({
            "outcome": "cancelled"
        }),
        "cursor/create_plan" => json!({
            "outcome": "cancelled"
        }),
        "fs/read_text_file" | "fs/write_text_file" | "terminal/create" | "terminal/output" => {
            json!({})
        }
        _ if method.starts_with("cursor/") || method.starts_with('_') => {
            json!({ "outcome": "cancelled" })
        }
        _ => json!({}),
    }
}
