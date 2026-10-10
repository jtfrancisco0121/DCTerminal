use crate::commands::dev_session::{PendingPlan, SessionRegistry};
use crate::permissions::{
    append_permission_log, cancelled_permission_result, evaluate_permission,
    permission_log_record_with_meta, DecisionOutcome, PolicyDecision, ToolCallCache,
};
use crate::store::SettingsStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub const PERMISSION_REQUEST_EVENT: &str = "acp/permission-request";
pub const PERMISSION_AUTO_EVENT: &str = "acp/permission-auto";
pub const PLAN_REQUEST_EVENT: &str = "acp/plan-request";
pub const QUESTION_REQUEST_EVENT: &str = "acp/question-request";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEvent {
    pub tab_id: String,
    pub session_id: String,
    pub json_rpc_id: u64,
    pub title: String,
    pub message: String,
    pub tool_class: String,
    pub display_kind: String,
    pub network: bool,
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
    pub display_kind: String,
    pub network: bool,
    pub decision: String,
    pub line: String,
}

/// Claude `ExitPlanMode` ("Ready to code?"): the plan to approve.
pub fn is_exit_plan_mode(params: &Value) -> bool {
    let call = params.get("toolCall").unwrap_or(&Value::Null);
    let title = call.get("title").and_then(Value::as_str).unwrap_or("");
    call.get("kind").and_then(Value::as_str) == Some("switch_mode")
        || title.contains("Ready to code")
        || title.contains("ExitPlanMode")
        || call
            .get("rawInput")
            .and_then(|raw| raw.get("plan"))
            .is_some()
}

/// `{outcome: selected, optionId}` for the request's `allow_once` option.
/// Never `allow_always` (that writes a rule into the project's
/// `.claude/settings.local.json`), never a reject.
pub fn allow_once_result(params: &Value) -> Option<Value> {
    let option = params
        .get("options")
        .and_then(Value::as_array)?
        .iter()
        .find(|opt| opt.get("kind").and_then(Value::as_str) == Some("allow_once"))?;
    let id = option.get("optionId").and_then(Value::as_str)?;
    Some(json!({ "outcome": { "outcome": "selected", "optionId": id } }))
}

fn is_planner(role_id: &str) -> bool {
    matches!(
        role_id.trim().to_ascii_lowercase().replace('-', "_").as_str(),
        "role_planner" | "planner"
    )
}

/// Claude tabs (Decisions 4): every permission request is answered
/// `allow_once` without a card. A Planner's `ExitPlanMode` is the plan to
/// approve, so it goes to the card. A request with no `allow_once` option
/// also goes to the card rather than guessing.
pub fn stage_claude_permission_request(
    app: &AppHandle,
    tab_id: &str,
    session_id: &str,
    request: &Value,
    state: &Mutex<SessionRegistry>,
) -> Result<Option<Value>, String> {
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let role_id = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        match guard.get(tab_id) {
            Some(session) => session.role_id.clone(),
            None => return Ok(Some(cancelled_permission_result())),
        }
    };
    let exit_plan = is_exit_plan_mode(&params);
    if exit_plan && is_planner(&role_id) {
        return stage_exit_plan_request(app, tab_id, session_id, request, state);
    }
    let answer = allow_once_result(&params);
    let Some(result) = answer else {
        return stage_permission_request(app, tab_id, session_id, request, state);
    };
    capture_permission_payload(app, tab_id, &role_id, request, None);
    let json_rpc_id = request.get("id").and_then(Value::as_u64).unwrap_or(0);
    let title = params
        .get("toolCall")
        .and_then(|call| call.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Claude request")
        .to_string();
    let _ = app.emit(
        PERMISSION_AUTO_EVENT,
        PermissionAutoEvent {
            tab_id: tab_id.to_string(),
            session_id: session_id.to_string(),
            json_rpc_id,
            title: title.clone(),
            tool_class: "claude".to_string(),
            display_kind: if exit_plan { "plan" } else { "tool" }.to_string(),
            network: false,
            decision: "allow-once".to_string(),
            line: format!("Allowed once (full permissions): {title}"),
        },
    );
    if exit_plan {
        queue_role_mode(state, tab_id)?;
    }
    Ok(Some(result))
}

/// After a non-Planner ExitPlanMode, put the session back on the role mode.
fn queue_role_mode(state: &Mutex<SessionRegistry>, tab_id: &str) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let Some(session) = guard.get(tab_id) else {
        return Ok(());
    };
    let mode = crate::provider::claude::claude_role_mode(&session.role_id).to_string();
    let params = json!({
        "sessionId": session.session_id,
        "modeId": mode,
    });
    session
        .followups
        .lock()
        .map_err(|e| e.to_string())?
        .push(("session/set_mode".to_string(), params));
    Ok(())
}

fn reject_option_id(params: &Value) -> Option<String> {
    params
        .get("options")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|opt| {
            let kind = opt
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let name = opt
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let id = opt.get("optionId").and_then(Value::as_str)?;
            let id_l = id.to_ascii_lowercase();
            if kind.contains("reject")
                || id_l.contains("reject")
                || name.contains("keep")
                || name.starts_with("no")
            {
                Some(id.to_string())
            } else {
                None
            }
        })
}

/// Plan markdown from ExitPlanMode. The adapter's field is unverified on a
/// Mac; this reads `toolCall.rawInput.plan` (string or JSON), then content.
pub fn exit_plan_markdown(params: &Value) -> String {
    let call = params.get("toolCall").unwrap_or(&Value::Null);
    let raw = call.get("rawInput").unwrap_or(&Value::Null);
    if let Some(plan) = raw.get("plan").or_else(|| params.get("plan")) {
        if let Some(text) = plan.as_str() {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        } else if !plan.is_null() {
            if let Ok(text) = serde_json::to_string_pretty(plan) {
                if text != "null" {
                    return text;
                }
            }
        }
    }
    if let Some(text) = call.get("content").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return text.to_string();
        }
    }
    call.get("title")
        .and_then(Value::as_str)
        .unwrap_or("Plan")
        .to_string()
}

fn stage_exit_plan_request(
    app: &AppHandle,
    tab_id: &str,
    session_id: &str,
    request: &Value,
    state: &Mutex<SessionRegistry>,
) -> Result<Option<Value>, String> {
    let json_rpc_id = request
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "plan request missing id".to_string())?;
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let markdown = exit_plan_markdown(&params);
    let reject = reject_option_id(&params);
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let Some(session) = guard.get_mut(tab_id) else {
            return Ok(Some(cancelled_permission_result()));
        };
        session.pending_plans.insert(
            json_rpc_id,
            PendingPlan::ClaudeExit {
                reject_option_id: reject.clone(),
            },
        );
    }
    let _ = app.emit(
        PLAN_REQUEST_EVENT,
        PlanRequestEvent {
            tab_id: tab_id.to_string(),
            session_id: session_id.to_string(),
            json_rpc_id,
            title: "Ready to code?".to_string(),
            entries: vec![PlanEntryDto {
                content: markdown.clone(),
                status: "pending".to_string(),
                priority: None,
            }],
            markdown: Some(markdown),
            keep_option_id: reject,
        },
    );
    Ok(None)
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

    let cache_snapshot = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        match guard.get(tab_id) {
            Some(session) => session.tool_call_cache.clone(),
            None => ToolCallCache::new(),
        }
    };
    let enriched = cache_snapshot.enrich_params(&params);
    let outcome = evaluate_permission(&role_id, &enriched);
    capture_permission_payload(
        app,
        tab_id,
        &role_id,
        request,
        Some((
            outcome.display_kind.as_str(),
            outcome.network,
            outcome.class.as_str(),
        )),
    );
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
        display_kind: outcome.display_kind.clone(),
        network: outcome.network,
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
        display_kind: outcome.display_kind.clone(),
        network: outcome.network,
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
    /// Claude ExitPlanMode body. Empty for a Cursor plan card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    /// Reject / keep-planning option. Selecting it never approves the plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_option_id: Option<String>,
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
        session
            .pending_plans
            .insert(json_rpc_id, PendingPlan::Cursor);
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
            markdown: None,
            keep_option_id: None,
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
    let pending = session.pending_plans.remove(&json_rpc_id);
    let Some(pending) = pending else {
        return Err("no pending plan request for this id".to_string());
    };
    let result = match pending {
        PendingPlan::ClaudeExit { reject_option_id } => {
            // Hand off and Keep planning both refuse to implement in this tab.
            if let Some(id) = reject_option_id {
                json!({ "outcome": { "outcome": "selected", "optionId": id } })
            } else {
                cancelled_permission_result()
            }
        }
        PendingPlan::Cursor => {
            if outcome == "accepted" {
                json!({ "outcome": "accepted" })
            } else {
                json!({ "outcome": "cancelled" })
            }
        }
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
pub struct QuestionChoiceDto {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequestEvent {
    pub tab_id: String,
    pub session_id: String,
    pub json_rpc_id: u64,
    pub title: String,
    pub prompt: String,
    pub choices: Vec<QuestionChoiceDto>,
}

pub fn stage_question_request(
    app: &AppHandle,
    tab_id: &str,
    session_id: &str,
    request: &Value,
    state: &Mutex<SessionRegistry>,
) -> Result<Option<Value>, String> {
    let json_rpc_id = request
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "question request missing id".to_string())?;
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let Some(session) = guard.get_mut(tab_id) else {
            return Ok(Some(json!({ "outcome": "cancelled" })));
        };
        session.pending_questions.insert(json_rpc_id, ());
    }
    let title = params
        .get("title")
        .or_else(|| params.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("Question")
        .to_string();
    let prompt = params
        .get("prompt")
        .or_else(|| params.get("message"))
        .or_else(|| params.get("question"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let choices = question_choices(&params);
    let _ = app.emit(
        QUESTION_REQUEST_EVENT,
        QuestionRequestEvent {
            tab_id: tab_id.to_string(),
            session_id: session_id.to_string(),
            json_rpc_id,
            title,
            prompt,
            choices,
        },
    );
    Ok(None)
}

#[tauri::command]
pub fn respond_question_request(
    tab_id: String,
    json_rpc_id: u64,
    outcome: String,
    choice_id: Option<String>,
    state: State<Mutex<SessionRegistry>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let Some(session) = guard.get_mut(&tab_id) else {
        return Ok(());
    };
    if session.pending_questions.remove(&json_rpc_id).is_none() {
        return Err("no pending question request for this id".to_string());
    }
    let result = match outcome.as_str() {
        "answered" => {
            let id = choice_id.ok_or_else(|| "choiceId required for answered outcome".to_string())?;
            json!({
                "outcome": "answered",
                "choiceId": id
            })
        }
        "skipped" => json!({ "outcome": "skipped" }),
        _ => json!({ "outcome": "cancelled" }),
    };
    session
        .outbox
        .lock()
        .map_err(|e| e.to_string())?
        .push((json_rpc_id, result));
    Ok(())
}

fn question_choices(params: &Value) -> Vec<QuestionChoiceDto> {
    let list = params
        .get("choices")
        .or_else(|| params.get("options"))
        .and_then(|v| v.as_array());
    let Some(list) = list else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .or_else(|| item.get("optionId"))
                .or_else(|| item.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let label = item
                .get("label")
                .or_else(|| item.get("name"))
                .or_else(|| item.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if id.is_empty() && label.is_empty() {
                return None;
            }
            let resolved_id = if id.is_empty() { label.clone() } else { id };
            let resolved_label = if label.is_empty() { resolved_id.clone() } else { label };
            Some(QuestionChoiceDto {
                id: resolved_id,
                label: resolved_label,
            })
        })
        .collect()
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

fn capture_permission_payload(
    app: &AppHandle,
    tab_id: &str,
    role_id: &str,
    request: &Value,
    meta: Option<(&str, bool, &str)>,
) {
    let enabled = app
        .try_state::<Mutex<SettingsStore>>()
        .and_then(|state| state.lock().ok().map(|settings| settings.capture_enabled()))
        .unwrap_or(false);
    if !enabled {
        return;
    }
    let dir = crate::data_dir::app_data_dir(app).path;
    let path = crate::store::storage_sweep::permission_log_path(&dir);
    crate::store::storage_sweep::rotate_log_if_large(
        &path,
        crate::store::storage_sweep::PERMISSION_LOG_MAX_BYTES,
    );
    let (display_kind, network, tool_class) = meta.unwrap_or(("", false, ""));
    let record = permission_log_record_with_meta(
        tab_id,
        role_id,
        &chrono::Utc::now().to_rfc3339(),
        request,
        if display_kind.is_empty() {
            None
        } else {
            Some(display_kind)
        },
        network,
        if tool_class.is_empty() {
            None
        } else {
            Some(tool_class)
        },
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_auto_answer_picks_allow_once_never_always() {
        let params = json!({
            "toolCall": { "title": "`ls`", "kind": "execute" },
            "options": [
                { "optionId": "allow_always", "kind": "allow_always", "name": "Always allow" },
                { "optionId": "allow", "kind": "allow_once", "name": "Allow" },
                { "optionId": "reject", "kind": "reject_once", "name": "Reject" }
            ]
        });
        assert_eq!(
            allow_once_result(&params).unwrap(),
            json!({ "outcome": { "outcome": "selected", "optionId": "allow" } })
        );
        let only_always = json!({ "options": [ { "optionId": "a", "kind": "allow_always" } ] });
        assert!(allow_once_result(&only_always).is_none());
    }

    #[test]
    fn detects_exit_plan_mode() {
        assert!(is_exit_plan_mode(&json!({ "toolCall": { "title": "Ready to code?" } })));
        assert!(is_exit_plan_mode(&json!({ "toolCall": { "kind": "switch_mode" } })));
        assert!(is_exit_plan_mode(&json!({ "toolCall": { "rawInput": { "plan": "# P" } } })));
        assert!(!is_exit_plan_mode(&json!({ "toolCall": { "title": "`ls`", "kind": "execute" } })));
        assert!(is_planner("role_planner"));
        assert!(!is_planner("role_plan_reviewer"));
    }

    #[test]
    fn parses_question_choices_from_fixture_shape() {
        let params = serde_json::json!({
            "title": "Choose an approach",
            "prompt": "How should we roll out the change?",
            "choices": [
                { "id": "flag", "label": "Feature flag" },
                { "id": "direct", "label": "Direct deploy" }
            ]
        });
        let choices = question_choices(&params);
        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0].id, "flag");
        assert_eq!(choices[1].label, "Direct deploy");
    }
}
