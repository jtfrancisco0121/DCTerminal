use crate::commands::dev_session::SessionRegistry;
use crate::permissions::{
    append_permission_log, cancelled_permission_result, evaluate_permission, permission_log_record,
    DecisionOutcome, PolicyDecision,
};
use crate::store::SettingsStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub const PERMISSION_REQUEST_EVENT: &str = "acp/permission-request";
pub const PERMISSION_AUTO_EVENT: &str = "acp/permission-auto";
pub const PLAN_REQUEST_EVENT: &str = "acp/plan-request";

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

    capture_permission_payload(app, tab_id, &role_id, request);

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntryDto {
    pub content: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequestEvent {
    pub tab_id: String,
    pub session_id: String,
    pub json_rpc_id: u64,
    pub title: String,
    pub entries: Vec<PlanEntryDto>,
}

pub fn stage_plan_request(
    app: &AppHandle,
    tab_id: &str,
    session_id: &str,
    request: &Value,
    state: &Mutex<SessionRegistry>,
) -> Result<Option<Value>, String> {
    let json_rpc_id = request
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "plan request missing id".to_string())?;
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let Some(session) = guard.get_mut(tab_id) else {
            return Ok(Some(json!({ "outcome": "cancelled" })));
        };
        session.pending_plans.insert(json_rpc_id, ());
    }
    let entries = plan_entries(&params);
    let title = params
        .get("title")
        .or_else(|| params.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("Plan")
        .to_string();
    let _ = app.emit(
        PLAN_REQUEST_EVENT,
        PlanRequestEvent {
            tab_id: tab_id.to_string(),
            session_id: session_id.to_string(),
            json_rpc_id,
            title,
            entries,
        },
    );
    Ok(None)
}

#[tauri::command]
pub fn respond_plan_request(
    tab_id: String,
    json_rpc_id: u64,
    outcome: String,
    state: State<Mutex<SessionRegistry>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let Some(session) = guard.get_mut(&tab_id) else {
        return Ok(());
    };
    if session.pending_plans.remove(&json_rpc_id).is_none() {
        return Err("no pending plan request for this id".to_string());
    }
    let result = if outcome == "accepted" {
        json!({ "outcome": "accepted" })
    } else {
        json!({ "outcome": "cancelled" })
    };
    session
        .outbox
        .lock()
        .map_err(|e| e.to_string())?
        .push((json_rpc_id, result));
    Ok(())
}

fn plan_entries(params: &Value) -> Vec<PlanEntryDto> {
    let list = params
        .get("entries")
        .or_else(|| params.get("plan").and_then(|plan| plan.get("entries")))
        .and_then(|v| v.as_array());
    let Some(list) = list else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| {
            let content = item
                .get("content")
                .or_else(|| item.get("title"))
                .or_else(|| item.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if content.is_empty() {
                return None;
            }
            Some(PlanEntryDto {
                content,
                status: item
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("pending")
                    .to_string(),
                priority: item
                    .get("priority")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
        })
        .collect()
}

fn capture_permission_payload(app: &AppHandle, tab_id: &str, role_id: &str, request: &Value) {
    let enabled = app
        .try_state::<Mutex<SettingsStore>>()
        .and_then(|state| state.lock().ok().map(|settings| settings.capture_enabled()))
        .unwrap_or(false);
    if !enabled {
        return;
    }
    let dir = crate::data_dir::app_data_dir(app).path;
    let path = dir.join("logs").join("permission-payloads.jsonl");
    let record = permission_log_record(tab_id, role_id, &chrono::Utc::now().to_rfc3339(), request);
    if let Err(err) = append_permission_log(&path, &record) {
        note_capture_error(app, &err);
    }
}

fn note_capture_error(app: &AppHandle, err: &str) {
    if let Some(state) = app.try_state::<Mutex<SettingsStore>>() {
        if let Ok(mut settings) = state.lock() {
            settings.last_capture_error = Some(err.to_string());
        }
    }
}
