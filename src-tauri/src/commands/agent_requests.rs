use crate::commands::dev_session::SessionRegistry;
use crate::permissions::{
    cancelled_permission_result, evaluate_permission, DecisionOutcome, PolicyDecision,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub const PERMISSION_REQUEST_EVENT: &str = "acp/permission-request";
pub const PERMISSION_AUTO_EVENT: &str = "acp/permission-auto";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEvent {
    pub tab_id: String,
    pub session_id: String,
    pub json_rpc_id: u64,
    pub title: String,
    pub message: String,
    pub tool_class: String,
    pub options: Vec<PermissionOption>,
    pub raw_params: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionAutoEvent {
    pub tab_id: String,
    pub session_id: String,
    pub json_rpc_id: u64,
    pub title: String,
    pub tool_class: String,
    pub decision: String,
    pub line: String,
}

/// Apply the role policy. `Ok(Some(result))` is an immediate JSON-RPC reply.
/// `Ok(None)` means the UI must answer; the id is queued on the tab.
pub fn stage_permission_request(
    app: &AppHandle,
    tab_id: &str,
    session_id: &str,
    request: &Value,
    state: &Mutex<SessionRegistry>,
) -> Result<Option<Value>, String> {
    let json_rpc_id = request
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "permission request missing id".to_string())?;
    let params = request.get("params").cloned().unwrap_or(Value::Null);

    let role_id = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        match guard.get(tab_id) {
            Some(session) => session.role_id.clone(),
            None => return Ok(Some(cancelled_permission_result())),
        }
    };

    let outcome = evaluate_permission(&role_id, &params);
    if outcome.decision != PolicyDecision::Ask {
        if let Some(line) = outcome.transcript_line.clone() {
            let _ = app.emit(
                PERMISSION_AUTO_EVENT,
                auto_event(tab_id, session_id, json_rpc_id, &outcome, &line),
            );
        }
        return Ok(outcome.auto_result);
    }

    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let Some(session) = guard.get_mut(tab_id) else {
            return Ok(Some(cancelled_permission_result()));
        };
        session.pending_permissions.insert(json_rpc_id, ());
    }

    let raw = params.to_string();
    let raw_params = if raw.len() > 8_000 {
        format!("{}…", &raw[..8_000])
    } else {
        raw
    };
    let payload = PermissionRequestEvent {
        tab_id: tab_id.to_string(),
        session_id: session_id.to_string(),
        json_rpc_id,
        title: outcome.title,
        message: outcome.message,
        tool_class: outcome.class.as_str().to_string(),
        options: outcome
            .options
            .into_iter()
            .map(|opt| PermissionOption {
                id: opt.id,
                label: opt.label,
            })
            .collect(),
        raw_params,
    };
    let _ = app.emit(PERMISSION_REQUEST_EVENT, payload);
    Ok(None)
}

fn auto_event(
    tab_id: &str,
    session_id: &str,
    json_rpc_id: u64,
    outcome: &DecisionOutcome,
    line: &str,
) -> PermissionAutoEvent {
    let decision = match outcome.decision {
        PolicyDecision::AllowOnce => "allow-once",
        PolicyDecision::Reject => "reject",
        PolicyDecision::Ask => "ask",
    };
    PermissionAutoEvent {
        tab_id: tab_id.to_string(),
        session_id: session_id.to_string(),
        json_rpc_id,
        title: outcome.title.clone(),
        tool_class: outcome.class.as_str().to_string(),
        decision: decision.to_string(),
        line: line.to_string(),
    }
}

#[tauri::command]
pub fn respond_permission_request(
    tab_id: String,
    json_rpc_id: u64,
    outcome: String,
    option_id: Option<String>,
    state: State<Mutex<SessionRegistry>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let Some(session) = guard.get_mut(&tab_id) else {
        return Ok(());
    };
    if session.pending_permissions.remove(&json_rpc_id).is_none() {
        return Err("no pending permission request for this id".to_string());
    }
    let result = if outcome == "selected" {
        let id = option_id.ok_or_else(|| "optionId required for selected outcome".to_string())?;
        json!({
            "outcome": {
                "outcome": "selected",
                "optionId": id
            }
        })
    } else {
        cancelled_permission_result()
    };
    session
        .outbox
        .lock()
        .map_err(|e| e.to_string())?
        .push((json_rpc_id, result));
    Ok(())
}
