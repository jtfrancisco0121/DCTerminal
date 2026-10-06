use crate::acp::AcpClient;
use crate::commands::prompt_worker::spawn_prompt_turn;
use crate::orchestrator::TabPhase;
use crate::store::StateStore;
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

pub type SharedAcpClient = Arc<Mutex<AcpClient>>;

pub fn wrap_client(client: AcpClient) -> SharedAcpClient {
    Arc::new(Mutex::new(client))
}

pub struct DevSessionState {
    pub client: Option<SharedAcpClient>,
    /// Merged startup prompt for `attach_to_first_message` roles.
    pub pending_startup_prompt: Option<String>,
    pub startup_injected: bool,
    pub phase: TabPhase,
    pub active_tab_id: Option<String>,
    pub prompt_in_flight: bool,
    /// JSON-RPC ids waiting for a permission result from the UI.
    pub pending_permission_ids: VecDeque<u64>,
    /// Results to write to the agent while `session/prompt` is in flight.
    pub agent_response_outbox: Arc<Mutex<Vec<(u64, Value)>>>,
}

impl DevSessionState {
    pub fn new() -> Self {
        Self {
            client: None,
            pending_startup_prompt: None,
            startup_injected: false,
            phase: TabPhase::AwaitingInput,
            active_tab_id: None,
            prompt_in_flight: false,
            pending_permission_ids: VecDeque::new(),
            agent_response_outbox: Arc::new(Mutex::new(Vec::new())),
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

fn shutdown_shared(client: &SharedAcpClient) {
    if let Ok(mut c) = client.lock() {
        c.shutdown();
    }
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
    if let Some(existing) = guard.client.take() {
        shutdown_shared(&existing);
    }
    guard.pending_startup_prompt = None;
    guard.startup_injected = false;
    let client = AcpClient::connect(&path, &mode)?;
    let info = DevSessionInfo {
        session_id: client.session_id().to_string(),
        mode_id: client.mode_id().to_string(),
        cwd: client.cwd().display().to_string(),
    };
    guard.client = Some(wrap_client(client));
    guard.phase = TabPhase::AwaitingInput
        .after_session_started()
        .map_err(|e| e.to_string())?;
    Ok(info)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchResult {
    pub dispatched: bool,
}

#[tauri::command]
pub fn dev_session_send(
    app: AppHandle,
    prompt: String,
    state: State<Mutex<DevSessionState>>,
) -> Result<PromptDispatchResult, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if guard.prompt_in_flight {
        return Err("a prompt is already running — wait or stop the session".to_string());
    }
    if guard.client.is_none() {
        return Err("no dev session — call dev_session_start first".to_string());
    }
    let attached_startup = guard.pending_startup_prompt.take();
    let had_attached_startup = attached_startup.is_some();
    let prompt_to_send = if let Some(startup) = attached_startup {
        format!("{startup}\n\n---\n\n{prompt}")
    } else {
        prompt
    };
    let tab_id_for_injection = if had_attached_startup {
        guard.active_tab_id.clone()
    } else {
        None
    };
    guard.prompt_in_flight = true;
    spawn_prompt_turn(
        app,
        prompt_to_send,
        tab_id_for_injection,
        had_attached_startup,
        had_attached_startup,
    );
    Ok(PromptDispatchResult { dispatched: true })
}

#[tauri::command]
pub fn dev_session_cancel(state: State<Mutex<DevSessionState>>) -> Result<(), String> {
    let client_arc = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        guard.client.clone().ok_or_else(|| "no active session".to_string())?
    };
    {
        let mut client = client_arc.lock().map_err(|e| e.to_string())?;
        client.cancel_turn()?;
    }
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.prompt_in_flight = false;
    guard.pending_permission_ids.clear();
    Ok(())
}

#[tauri::command]
pub fn dev_session_stop(
    transcript: Option<String>,
    state: State<Mutex<DevSessionState>>,
    state_store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let tab_id = guard.active_tab_id.clone();
    if let Some(client_arc) = guard.client.take() {
        shutdown_shared(&client_arc);
    }
    guard.pending_startup_prompt = None;
    guard.startup_injected = false;
    guard.phase = guard.phase.after_session_stopped();
    guard.active_tab_id = None;
    guard.prompt_in_flight = false;
    guard.pending_permission_ids.clear();
    if let Some(id) = tab_id {
        let mut store = state_store.lock().map_err(|e| e.to_string())?;
        store.mark_tab_awaiting_input(&id, transcript)?;
    }
    Ok(())
}
