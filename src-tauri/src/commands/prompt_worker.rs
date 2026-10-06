use crate::acp::PromptResult;
use crate::commands::acp_events::emit_session_update;
use crate::commands::agent_requests::stage_permission_request;
use crate::commands::dev_session::SessionRegistry;
use crate::store::StateStore;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const PROMPT_FINISHED_EVENT: &str = "role_session/prompt-finished";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFinishedEvent {
    pub session_id: String,
    pub tab_id: Option<String>,
    pub success: bool,
    pub result: Option<PromptResult>,
    pub error: Option<String>,
    pub agent_exited: bool,
}

/// Run `session/prompt` off the IPC thread so the UI stays responsive.
pub fn spawn_prompt_turn(
    app: AppHandle,
    tab_id: String,
    prompt_text: String,
    mark_startup_injected: bool,
    mark_tab_injection_complete: bool,
) {
    std::thread::spawn(move || {
        let finished = run_prompt_turn(
            &app,
            &tab_id,
            &prompt_text,
            mark_startup_injected,
            mark_tab_injection_complete,
        );
        let _ = app.emit(PROMPT_FINISHED_EVENT, finished);
    });
}

fn run_prompt_turn(
    app: &AppHandle,
    tab_id: &str,
    prompt_text: &str,
    mark_startup_injected: bool,
    mark_tab_injection_complete: bool,
) -> PromptFinishedEvent {
    let state = app.state::<Mutex<SessionRegistry>>();
    let outcome: Result<(PromptResult, String), String> = (|| {
        let client_arc = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            guard
                .get(tab_id)
                .ok_or_else(|| "no active agent session".to_string())?
                .client
                .clone()
        };
        let session_id = {
            let client = client_arc.lock().map_err(|e| e.to_string())?;
            client.session_id().to_string()
        };
        let session_id_for_emit = session_id.clone();
        let session_id_for_perm = session_id.clone();
        let app_emit = app.clone();
        let app_perm = app.clone();
        let tab_for_emit = tab_id.to_string();
        let tab_for_perm = tab_id.to_string();
        let on_notification = Box::new(move |value: &serde_json::Value| {
            if let Ok(mut guard) = app_emit.state::<Mutex<SessionRegistry>>().lock() {
                if let Some(session) = guard.get_mut(&tab_for_emit) {
                    session.tool_call_cache.observe_notification(value);
                }
            }
            emit_session_update(&app_emit, &tab_for_emit, &session_id_for_emit, value);
        });
        let on_agent_request = Box::new(
            move |value: &serde_json::Value| -> Result<Option<serde_json::Value>, String> {
                let method = value.get("method").and_then(|m| m.as_str()).unwrap_or("");
                if crate::acp::request_handler::is_permission_method(method) {
                    let session_mtx = app_perm.state::<Mutex<SessionRegistry>>();
                    return stage_permission_request(
                        &app_perm,
                        &tab_for_perm,
                        &session_id_for_perm,
                        value,
                        &session_mtx,
                    );
                }
                if method == "cursor/create_plan" {
                    let session_mtx = app_perm.state::<Mutex<SessionRegistry>>();
                    return crate::commands::agent_requests::stage_plan_request(
                        &app_perm,
                        &tab_for_perm,
                        &session_id_for_perm,
                        value,
                        &session_mtx,
                    );
                }
                Ok(Some(
                    crate::acp::request_handler::response_for_agent_request(value),
                ))
            },
        );
        let result = {
            let mut client = client_arc.lock().map_err(|e| e.to_string())?;
            client.send_prompt(prompt_text, Some(on_notification), Some(on_agent_request))?
        };
        {
            let mut guard = state.lock().map_err(|e| e.to_string())?;
            if let Some(session) = guard.get_mut(tab_id) {
                if mark_startup_injected {
                    session.startup_injected = true;
                }
                session.prompt_in_flight = false;
                session.pending_permissions.clear();
                session.pending_plans.clear();
            }
        }
        Ok((result, session_id))
    })();

    match outcome {
        Ok((result, session_id)) => {
            if mark_tab_injection_complete {
                if let Ok(mut store) = app.state::<Mutex<StateStore>>().lock() {
                    let _ = store.set_injection_complete(tab_id);
                }
            }
            PromptFinishedEvent {
                session_id,
                tab_id: Some(tab_id.to_string()),
                success: true,
                result: Some(result),
                error: None,
                agent_exited: false,
            }
        }
        Err(err) => {
            let agent_exited = is_agent_exit(&err);
            if let Ok(mut guard) = state.lock() {
                if let Some(session) = guard.get_mut(tab_id) {
                    session.prompt_in_flight = false;
                    session.pending_permissions.clear();
                    session.pending_plans.clear();
                    if agent_exited {
                        session.exited = true;
                        session.process.kill_tree();
                    }
                }
            }
            let session_id = state
                .lock()
                .ok()
                .and_then(|guard| guard.get(tab_id).map(|session| session.session_id.clone()))
                .unwrap_or_default();
            PromptFinishedEvent {
                session_id,
                tab_id: Some(tab_id.to_string()),
                success: false,
                result: None,
                error: Some(err),
                agent_exited,
            }
        }
    }
}

fn is_agent_exit(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("stdout closed")
        || lower.contains("agent exited")
        || lower.contains("broken pipe")
        || lower.contains("stdin write")
}
