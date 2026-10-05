use serde_json::{json, Value};

/// FR-007 / FR-011: never leave agent requests unanswered; deny by default in dev.
pub fn response_for_agent_request(request: &Value) -> Value {
    let method = request
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("");

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
        _ if method.starts_with("cursor/") => json!({ "outcome": "cancelled" }),
        _ => json!({}),
    }
}
