use crate::acp::{AcpClient, PromptResult};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub struct DevSessionState {
    pub client: Option<AcpClient>,
}

impl DevSessionState {
    pub fn new() -> Self {
        Self { client: None }
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
    let client = AcpClient::connect(&path, &mode)?;
    let info = DevSessionInfo {
        session_id: client.session_id().to_string(),
        mode_id: client.mode_id().to_string(),
        cwd: client.cwd().display().to_string(),
    };
    guard.client = Some(client);
    Ok(info)
}

#[tauri::command]
pub fn dev_session_send(
    prompt: String,
    state: State<Mutex<DevSessionState>>,
) -> Result<PromptResult, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let client = guard
        .client
        .as_mut()
        .ok_or_else(|| "no dev session — call dev_session_start first".to_string())?;
    client.send_prompt(&prompt)
}

#[tauri::command]
pub fn dev_session_stop(state: State<Mutex<DevSessionState>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(mut client) = guard.client.take() {
        client.shutdown();
    }
    Ok(())
}
