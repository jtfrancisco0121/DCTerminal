use crate::commands::dev_session::DevSessionState;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub const PERMISSION_REQUEST_EVENT: &str = "acp/permission-request";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEvent {
    pub session_id: String,
    pub json_rpc_id: u64,
    pub title: String,
    pub message: String,
    pub options: Vec<PermissionOption>,
    pub raw_params: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
}

/// Queue a permission prompt for the UI and defer the JSON-RPC reply (read loop keeps running).
pub fn stage_permission_request(
    app: &AppHandle,
    session_id: &str,
    request: &Value,
    state: &Mutex<DevSessionState>,
) -> Result<(), String> {
    let json_rpc_id = request
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "permission request missing id".to_string())?;
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let parsed = parse_permission_params(&params);

    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.pending_permission_ids.push_back(json_rpc_id);
    }

    let payload = PermissionRequestEvent {
        session_id: session_id.to_string(),
        json_rpc_id,
        title: parsed.title,
        message: parsed.message,
        options: parsed.options,
        raw_params: params.to_string(),
    };
    let _ = app.emit(PERMISSION_REQUEST_EVENT, payload);
    Ok(())
}

struct ParsedPermission {
    title: String,
    message: String,
    options: Vec<PermissionOption>,
}

fn parse_permission_params(params: &Value) -> ParsedPermission {
    let title = params
        .get("title")
        .or_else(|| params.get("permission"))
        .or_else(|| params.get("toolName"))
        .and_then(|v| v.as_str())
        .unwrap_or("Permission required")
        .to_string();
    let message = params
        .get("message")
        .or_else(|| params.get("description"))
        .or_else(|| params.get("command"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut options = Vec::new();
    if let Some(arr) = params.get("options").and_then(|v| v.as_array()) {
        for opt in arr {
            let id = opt
                .get("id")
                .or_else(|| opt.get("optionId"))
                .and_then(|v| v.as_str())
                .unwrap_or("allow-once")
                .to_string();
            let label = opt
                .get("label")
                .or_else(|| opt.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            options.push(PermissionOption { id, label });
        }
    }
    if options.is_empty() {
        options = vec![
            PermissionOption {
                id: "allow-once".to_string(),
                label: "Allow once".to_string(),
            },
            PermissionOption {
                id: "allow-always".to_string(),
                label: "Allow always".to_string(),
            },
            PermissionOption {
                id: "reject-once".to_string(),
                label: "Reject".to_string(),
            },
        ];
    }

    ParsedPermission {
        title,
        message,
        options,
    }
}

#[tauri::command]
pub fn respond_permission_request(
    outcome: String,
    option_id: Option<String>,
    state: State<Mutex<DevSessionState>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let rpc_id = guard
        .pending_permission_ids
        .pop_front()
        .ok_or_else(|| "no pending permission request".to_string())?;

    let result = if outcome == "selected" {
        let id = option_id.ok_or_else(|| "optionId required for selected outcome".to_string())?;
        json!({
            "outcome": {
                "outcome": "selected",
                "optionId": id
            }
        })
    } else {
        json!({
            "outcome": {
                "outcome": "cancelled"
            }
        })
    };

    guard
        .agent_response_outbox
        .lock()
        .map_err(|e| e.to_string())?
        .push((rpc_id, result));
    Ok(())
}
