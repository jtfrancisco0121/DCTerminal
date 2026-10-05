use crate::acp::{AcpClient, PromptResult};
use crate::commands::acp_events::emit_session_update;
use crate::orchestrator::TabPhase;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};

pub struct DevSessionState {
    pub client: Option<AcpClient>,
    /// Merged startup prompt for `attach_to_first_message` roles.
    pub pending_startup_prompt: Option<String>,
    pub startup_injected: bool,
    pub phase: TabPhase,
}

impl DevSessionState {
    pub fn new() -> Self {
        Self {
            client: None,
            pending_startup_prompt: None,
            startup_injected: false,
            phase: TabPhase::AwaitingInput,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSessionInfo {
    pub session_id: String,
    pub mode_id: String,
    pub cwd: String,
}

#[tauri::command]
pub fn dev_session_start(
    cwd: String,
    mode_id: Option<String>,
    state: State<Mutex<DevSessionState>>,
) -> Result<DevSessionInfo, String> {
    let mode = mode_id.unwrap_or_else(|| "agent".to_string());
    let path = PathBuf::from(cwd.trim());
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(mut existing) = guard.client.take() {
        existing.shutdown();
    }
    guard.pending_startup_prompt = None;
    guard.startup_injected = false;
    let client = AcpClient::connect(&path, &mode)?;
    let info = DevSessionInfo {
        session_id: client.session_id().to_string(),
        mode_id: client.mode_id().to_string(),
        cwd: client.cwd().display().to_string(),
    };
    guard.client = Some(client);
    guard.phase = TabPhase::AwaitingInput
        .after_session_started()
        .map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
pub fn dev_session_send(
    app: AppHandle,
    prompt: String,
    state: State<Mutex<DevSessionState>>,
) -> Result<PromptResult, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let prompt_to_send = if let Some(startup) = guard.pending_startup_prompt.take() {
        guard.startup_injected = true;
        format!("{startup}\n\n---\n\n{prompt}")
    } else {
        prompt
    };
    let client = guard
        .client
        .as_mut()
        .ok_or_else(|| "no dev session — call dev_session_start first".to_string())?;
    let session_id = client.session_id().to_string();
    let app = app.clone();
    let on_notification = Box::new(move |value: &serde_json::Value| {
        emit_session_update(&app, &session_id, value);
    });
    client.send_prompt(&prompt_to_send, Some(on_notification))
}

#[tauri::command]
pub fn dev_session_stop(state: State<Mutex<DevSessionState>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(mut client) = guard.client.take() {
        client.shutdown();
    }
    guard.pending_startup_prompt = None;
    guard.startup_injected = false;
    guard.phase = guard.phase.after_session_stopped();
    Ok(())
}
