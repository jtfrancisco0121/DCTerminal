use super::text_extract::text_from_session_params;
use serde::Serialize;
use serde_json::Value;

pub const SESSION_UPDATE_EVENT: &str = "acp/session-update";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateEvent {
    pub tab_id: String,
    pub session_id: String,
    pub kind: String,
    pub text_delta: Option<String>,
    pub raw_json: String,
    /// A `tool_call` / `tool_call_update` that writes a plan file
    /// (`<configDir>/plans/*.md`): its path, so the UI can find the plan
    /// when `ExitPlanMode` carries none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_path: Option<String>,
}

pub fn map_session_update(
    tab_id: &str,
    session_id: &str,
    line: &Value,
) -> Option<SessionUpdateEvent> {
    let method = line.get("method").and_then(|m| m.as_str());
    if let Some(method) = method {
        if method == "cursor/update_todos" || method == "cursor/task" {
            let params = line.get("params").cloned().unwrap_or_else(|| line.clone());
            return Some(SessionUpdateEvent {
                tab_id: tab_id.to_string(),
                session_id: session_id.to_string(),
                kind: method.to_string(),
                text_delta: None,
                raw_json: params.to_string(),
                plan_path: None,
            });
        }
    }
    let params = if method == Some("session/update") {
        line.get("params").cloned().unwrap_or_else(|| line.clone())
    } else if method.is_some() {
        return None;
    } else {
        line.clone()
    };

    let update = params.get("update").unwrap_or(&params);
    let kind = update
        .get("type")
        .or_else(|| update.get("updateType"))
        .or_else(|| update.get("sessionUpdate"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let text_delta = text_from_session_params(&params);
    let plan_path = if kind == "tool_call" || kind == "tool_call_update" {
        crate::permissions::plan_file_in_update(update)
    } else {
        None
    };

    Some(SessionUpdateEvent {
        tab_id: tab_id.to_string(),
        session_id: session_id.to_string(),
        kind,
        text_delta,
        raw_json: params.to_string(),
        plan_path,
    })
}

#[cfg(test)]
mod tests {
    use super::map_session_update;
    use serde_json::json;

    #[test]
    fn maps_chunk_with_text_object() {
        let line = json!({
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "type": "agent_message_chunk",
                    "text": { "type": "text", "text": "Hi" }
                }
            }
        });
        let evt = map_session_update("tab_1", "sess_1", &line).expect("event");
        assert_eq!(evt.text_delta.as_deref(), Some("Hi"));
    }

    #[test]
    fn maps_agent_message_chunk() {
        let line = json!({
            "method": "session/update",
            "params": {
                "update": {
                    "type": "agent_message_chunk",
                    "text": "Hello"
                }
            }
        });
        let evt = map_session_update("tab_1", "sess_1", &line).expect("event");
        assert_eq!(evt.session_id, "sess_1");
        assert_eq!(evt.text_delta.as_deref(), Some("Hello"));
    }

    #[test]
    fn maps_tool_call_update() {
        let line = json!({
            "method": "session/update",
            "params": {
                "update": {
                    "type": "tool_call_update",
                    "toolName": "read_file",
                    "status": "completed"
                }
            }
        });
        let evt = map_session_update("tab_1", "sess_1", &line).expect("event");
        assert_eq!(evt.kind, "tool_call_update");
        assert_eq!(evt.text_delta.as_deref(), Some("read_file (completed)"));
    }

    #[test]
    fn a_tool_call_that_writes_a_plan_file_carries_its_path() {
        let write = json!({
            "method": "session/update",
            "params": { "update": {
                "sessionUpdate": "tool_call", "toolCallId": "w", "kind": "edit",
                "rawInput": { "file_path": "/Users/me/.claude-account2/plans/fix.md" }
            } }
        });
        let evt = map_session_update("tab_1", "sess_1", &write).expect("event");
        assert_eq!(evt.plan_path.as_deref(), Some("/Users/me/.claude-account2/plans/fix.md"));
        assert!(serde_json::to_string(&evt).unwrap().contains("\"planPath\""));
        let chunk = json!({ "method": "session/update", "params": { "update": {
            "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "/x/plans/a.md" } } } });
        let evt = map_session_update("tab_1", "sess_1", &chunk).expect("event");
        assert_eq!(evt.plan_path, None);
        assert!(!serde_json::to_string(&evt).unwrap().contains("planPath"));
    }

    #[test]
    fn maps_tool_call_update_with_nested_title() {
        let line = json!({
            "method": "session/update",
            "params": {
                "update": {
                    "type": "tool_call_update",
                    "toolCallId": "tc_1",
                    "status": "in_progress",
                    "toolCall": {
                        "toolCallId": "tc_1",
                        "title": "Read app/main.py",
                        "status": "in_progress"
                    }
                }
            }
        });
        let evt = map_session_update("tab_1", "sess_1", &line).expect("event");
        assert_eq!(
            evt.text_delta.as_deref(),
            Some("Read app/main.py (in_progress)")
        );
    }

    #[test]
    fn forwards_todo_and_task_notifications() {
        let todos = json!({
            "method": "cursor/update_todos",
            "params": { "todos": [{ "id": "1", "content": "Write tests", "status": "pending" }] }
        });
        let evt = map_session_update("tab_1", "sess_1", &todos).expect("todos");
        assert_eq!(evt.kind, "cursor/update_todos");
        assert!(evt.raw_json.contains("Write tests"));

        let task = json!({
            "method": "cursor/task",
            "params": { "agentId": "a1", "description": "Explore", "status": "running" }
        });
        let evt = map_session_update("tab_1", "sess_1", &task).expect("task");
        assert_eq!(evt.kind, "cursor/task");
    }
}
