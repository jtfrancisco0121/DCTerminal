use crate::acp::AcpClient;
use crate::commands::prompt_worker::spawn_prompt_turn;
use crate::paths::validate_working_folder;
use crate::permissions::cancelled_permission_result;
use crate::process_tree::SharedProcess;
use crate::store::StateStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

pub const DEV_TAB_ID: &str = "__dev__";

pub type SharedAcpClient = Arc<Mutex<AcpClient>>;

pub fn wrap_client(client: AcpClient) -> SharedAcpClient {
    Arc::new(Mutex::new(client))
}

pub struct LiveSession {
    pub tab_id: String,
    pub role_id: String,
    pub mode_id: String,
    pub cwd: String,
    pub session_id: String,
    pub client: SharedAcpClient,
    pub process: SharedProcess,
    pub cancel: Arc<AtomicBool>,
    pub outbox: Arc<Mutex<Vec<(u64, Value)>>>,
    pub pending_permissions: HashMap<u64, ()>,
    pub pending_plans: HashMap<u64, ()>,
    pub pending_startup_prompt: Option<String>,
    pub startup_injected: bool,
    pub prompt_in_flight: bool,
    pub exited: bool,
}

impl LiveSession {
    pub fn from_client(tab_id: &str, role_id: &str, client: AcpClient) -> Self {
        let process = client.process_handle();
        let cancel = client.cancel_flag();
        let outbox = client.outbox();
        Self {
            tab_id: tab_id.to_string(),
            role_id: role_id.to_string(),
            mode_id: client.mode_id().to_string(),
            cwd: client.cwd().display().to_string(),
            session_id: client.session_id().to_string(),
            client: wrap_client(client),
            process,
            cancel,
            outbox,
            pending_permissions: HashMap::new(),
            pending_plans: HashMap::new(),
            pending_startup_prompt: None,
            startup_injected: false,
            prompt_in_flight: false,
            exited: false,
        }
    }

    pub fn shutdown(&mut self) {
        let pending: Vec<u64> = self.pending_permissions.drain().map(|(id, _)| id).collect();
        let plans: Vec<u64> = self.pending_plans.drain().map(|(id, _)| id).collect();
        if let Ok(mut outbox) = self.outbox.lock() {
            for id in pending {
                outbox.push((id, cancelled_permission_result()));
            }
            for id in plans {
                outbox.push((id, json!({ "outcome": "cancelled" })));
            }
        }
        self.cancel.store(true, Ordering::SeqCst);
        self.process.kill_tree();
        self.exited = true;
        self.prompt_in_flight = false;
    }
}

/// One `agent acp` process per tab. Handles are cloned so stop/cancel
/// do not need the client mutex the prompt thread holds.
pub struct SessionRegistry {
    sessions: HashMap<String, LiveSession>,
    starting: HashSet<String>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            starting: HashSet::new(),
        }
    }

    pub fn try_begin_start(&mut self, tab_key: &str) -> Result<(), String> {
        if self.starting.contains(tab_key) {
            return Err(
                "Start already in progress for this tab — wait for the first click to finish"
                    .to_string(),
            );
        }
        if let Some(existing) = self.sessions.get(tab_key) {
            if !existing.exited {
                return Err(
                    "this tab already has a live session — stop it before starting again"
                        .to_string(),
                );
            }
        }
        if let Some(mut old) = self.sessions.remove(tab_key) {
            old.shutdown();
        }
        self.starting.insert(tab_key.to_string());
        Ok(())
    }

    pub fn finish_start(&mut self, tab_key: &str) {
        self.starting.remove(tab_key);
    }

    pub fn insert(&mut self, session: LiveSession) {
        self.sessions.insert(session.tab_id.clone(), session);
    }

    pub fn get(&self, tab_id: &str) -> Option<&LiveSession> {
        self.sessions.get(tab_id)
    }

    pub fn get_mut(&mut self, tab_id: &str) -> Option<&mut LiveSession> {
        self.sessions.get_mut(tab_id)
    }

    pub fn agent_folders_except(&self, tab_id: &str) -> Vec<(String, String)> {
        self.sessions
            .values()
            .filter(|session| session.tab_id != tab_id && !session.exited)
            .map(|session| (session.cwd.clone(), session.mode_id.clone()))
            .collect()
    }

    pub fn shutdown_tab(&mut self, tab_id: &str) {
        if let Some(mut session) = self.sessions.remove(tab_id) {
            session.shutdown();
        }
    }

    pub fn shutdown_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            self.shutdown_tab(&id);
        }
    }
}

impl Drop for SessionRegistry {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSessionInfo {
    pub session_id: String,
    pub mode_id: String,
    pub cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchResult {
    pub dispatched: bool,
}

fn resolve_tab_id(tab_id: Option<String>) -> String {
    tab_id.unwrap_or_else(|| DEV_TAB_ID.to_string())
}

#[tauri::command]
pub fn dev_session_start(
    cwd: String,
    mode_id: Option<String>,
    state: State<Mutex<SessionRegistry>>,
) -> Result<DevSessionInfo, String> {
    let mode = mode_id.unwrap_or_else(|| "agent".to_string());
    let path = validate_working_folder(&cwd).map_err(|err| err.message())?;
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.try_begin_start(DEV_TAB_ID)?;
    }
    let client = match AcpClient::connect(&path, &mode) {
        Ok(client) => client,
        Err(err) => {
            if let Ok(mut guard) = state.lock() {
                guard.finish_start(DEV_TAB_ID);
            }
            return Err(err);
        }
    };
    let info = DevSessionInfo {
        session_id: client.session_id().to_string(),
        mode_id: client.mode_id().to_string(),
        cwd: client.cwd().display().to_string(),
    };
    let session = LiveSession::from_client(DEV_TAB_ID, "role_developer", client);
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.finish_start(DEV_TAB_ID);
    guard.insert(session);
    Ok(info)
}

#[tauri::command]
pub fn dev_session_send(
    app: AppHandle,
    prompt: String,
    tab_id: Option<String>,
    state: State<Mutex<SessionRegistry>>,
) -> Result<PromptDispatchResult, String> {
    let tab_id = resolve_tab_id(tab_id);
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let session = guard
        .get_mut(&tab_id)
        .ok_or_else(|| "no session for this tab — start it first".to_string())?;
    if session.exited {
        return Err(
            "the agent process exited — restart this tab before sending another prompt".to_string(),
        );
    }
    if session.prompt_in_flight {
        return Err("a prompt is already running — wait or cancel the turn".to_string());
    }
    let attached_startup = session.pending_startup_prompt.take();
    let had_attached_startup = attached_startup.is_some();
    let prompt_to_send = if let Some(startup) = attached_startup {
        format!("{startup}\n\n---\n\n{prompt}")
    } else {
        prompt
    };
    let tab_id_for_injection = if had_attached_startup {
        Some(tab_id.clone())
    } else {
        None
    };
    session.prompt_in_flight = true;
    drop(guard);
    spawn_prompt_turn(
        app,
        tab_id,
        prompt_to_send,
        tab_id_for_injection.is_some(),
        had_attached_startup,
    );
    Ok(PromptDispatchResult { dispatched: true })
}

#[tauri::command]
pub fn dev_session_cancel(
    tab_id: Option<String>,
    state: State<Mutex<SessionRegistry>>,
) -> Result<(), String> {
    let tab_id = resolve_tab_id(tab_id);
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let session = guard
        .get_mut(&tab_id)
        .ok_or_else(|| "no active session".to_string())?;
    let pending: Vec<u64> = session
        .pending_permissions
        .drain()
        .map(|(id, _)| id)
        .collect();
    let plans: Vec<u64> = session.pending_plans.drain().map(|(id, _)| id).collect();
    let outbox = Arc::clone(&session.outbox);
    let cancel = Arc::clone(&session.cancel);
    drop(guard);
    {
        let mut queue = outbox.lock().map_err(|e| e.to_string())?;
        for id in pending {
            queue.push((id, cancelled_permission_result()));
        }
        for id in plans {
            queue.push((id, json!({ "outcome": "cancelled" })));
        }
    }
    cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn dev_session_stop(
    transcript: Option<String>,
    tab_id: Option<String>,
    state: State<Mutex<SessionRegistry>>,
    state_store: State<Mutex<StateStore>>,
    transcripts: State<Mutex<crate::store::TranscriptStore>>,
) -> Result<(), String> {
    let tab_id = resolve_tab_id(tab_id);
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.shutdown_tab(&tab_id);
    }
    if tab_id != DEV_TAB_ID {
        let cwd = {
            let store = state_store.lock().map_err(|e| e.to_string())?;
            store
                .tab_by_id(&tab_id)
                .map(|tab| tab.cwd.clone())
                .unwrap_or_default()
        };
        let mut store = state_store.lock().map_err(|e| e.to_string())?;
        store.mark_tab_awaiting_input(&tab_id, transcript.clone())?;
        if let Some(text) = transcript.as_ref().filter(|text| !text.trim().is_empty()) {
            let keep = store
                .data
                .tabs
                .iter()
                .map(|tab| tab.id.clone())
                .collect::<Vec<_>>();
            let transcripts = transcripts.lock().map_err(|e| e.to_string())?;
            transcripts.save(&tab_id, text, &cwd, &chrono::Utc::now().to_rfc3339(), &keep)?;
        }
    }
    Ok(())
}
