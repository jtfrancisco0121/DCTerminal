use crate::acp::PromptResult;
use crate::commands::acp_events::emit_session_update;
use crate::commands::agent_requests::stage_permission_request;
use crate::commands::dev_session::DevSessionState;
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
}

/// Run `session/prompt` off the IPC thread so the UI stays responsive.
pub fn spawn_prompt_turn(
    app: AppHandle,
    prompt_text: String,
    tab_id: Option<String>,
    mark_startup_injected: bool,
    mark_tab_injection_complete: bool,
) {
    std::thread::spawn(move || {
        let finished = run_prompt_turn(
            &app,
            &prompt_text,
            tab_id.clone(),
            mark_startup_injected,
            mark_tab_injection_complete,
        );
        let _ = app.emit(PROMPT_FINISHED_EVENT, finished);
    });
}

fn run_prompt_turn(
    app: &AppHandle,
    prompt_text: &str,
    tab_id: Option<String>,
    mark_startup_injected: bool,
    mark_tab_injection_complete: bool,
) -> PromptFinishedEvent {
    let state = app.state::<Mutex<DevSessionState>>();
    let outcome: Result<(PromptResult, String), String> = (|| {
        let client_arc = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            guard
                .client
                .clone()
                .ok_or_else(|| "no active agent session".to_string())?
        };
        let outbox = {
            let guard = state.lock().map_err(|e| e.to_string())?;
            guard.agent_response_outbox.clone()
        };
        let session_id = {
            let client = client_arc.lock().map_err(|e| e.to_string())?;
            client.session_id().to_string()
        };
        let session_id_for_emit = session_id.clone();
        let session_id_for_perm = session_id.clone();
        let app_emit = app.clone();
        let app_perm = app.clone();
        let on_notification = Box::new(move |value: &serde_json::Value| {
            emit_session_update(&app_emit, &session_id_for_emit, value);
        });
        let on_agent_request = Box::new(
            move |value: &serde_json::Value| -> Result<Option<serde_json::Value>, String> {
                let method = value
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("");
                if crate::acp::request_handler::is_permission_method(method) {
                    let session_mtx = app_perm.state::<Mutex<DevSessionState>>();
                    stage_permission_request(&app_perm, &session_id_for_perm, value, &*session_mtx)?;
                    return Ok(None);
                }
                Ok(Some(crate::acp::request_handler::response_for_agent_request(
                    value,
                )))
            },
        );
        let result = {
            let mut client = client_arc.lock().map_err(|e| e.to_string())?;
            client.send_prompt(
                prompt_text,
                Some(on_notification),
                Some(on_agent_request),
                Some(outbox),
            )?
        };
        {
            let mut guard = state.lock().map_err(|e| e.to_string())?;
            if mark_startup_injected {
                guard.startup_injected = true;
            }
            guard.prompt_in_flight = false;
            guard.pending_permission_ids.clear();
        }
        Ok((result, session_id))
    })();

    match outcome {
        Ok((result, session_id)) => {
            if mark_tab_injection_complete {
                if let Some(id) = &tab_id {
                    if let Ok(mut store) = app.state::<Mutex<StateStore>>().lock() {
                        let _ = store.set_injection_complete(id);
                    }
                }
            }
            PromptFinishedEvent {
                session_id,
                tab_id,
                success: true,
                result: Some(result),
                error: None,
            }
        }
        Err(err) => {
            if let Ok(mut guard) = state.lock() {
                guard.prompt_in_flight = false;
                guard.pending_permission_ids.clear();
            }
            let session_id = state
                .lock()
                .ok()
                .and_then(|g| {
                    g.client.as_ref().and_then(|arc| {
                        arc.lock().ok().map(|c| c.session_id().to_string())
                    })
                })
                .unwrap_or_default();
            PromptFinishedEvent {
                session_id,
                tab_id,
                success: false,
                result: None,
                error: Some(err),
            }
        }
    }
}
