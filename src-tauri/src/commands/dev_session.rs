use crate::acp::connection::{stderr_text, AgentOutbox, ClientFollowups, StderrTail};
use crate::acp::{AcpClient, RequestId};
use crate::attachments::AttachmentStore;
use crate::commands::prompt_worker::{spawn_prompt_turn, TurnImages};
use crate::paths::validate_working_folder;
use crate::permissions::{cancelled_permission_result, ToolCallCache};
use crate::process_tree::{SharedProcess, STOP_GRACE};
use crate::store::StateStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

pub const DEV_TAB_ID: &str = "__dev__";

pub type SharedAcpClient = Arc<Mutex<AcpClient>>;

/// How a pending plan request should be answered.
#[derive(Clone, Debug)]
pub enum PendingPlan {
    /// Cursor `cursor/create_plan`: accepted / cancelled.
    Cursor,
    /// Claude Planner `ExitPlanMode`. Never selects a Yes / allow option.
    ClaudeExit { reject_option_id: Option<String> },
}

impl PendingPlan {
    /// The answer when the turn is cancelled or the tab stops. Claude's
    /// `ExitPlanMode` is a `session/request_permission`, so it needs the
    /// permission shape (`{outcome: {outcome: "cancelled"}}`), not Cursor's.
    pub fn cancelled_result(&self) -> Value {
        match self {
            PendingPlan::Cursor => json!({ "outcome": "cancelled" }),
            PendingPlan::ClaudeExit { .. } => cancelled_permission_result(),
        }
    }
}

/// A permission card waiting for JT: which activity row it answers and the
/// offered options (`(id, kind)`), so the decision can be logged as allow or
/// reject.
#[derive(Clone, Debug, Default)]
pub struct PendingPermission {
    pub tool_call_id: String,
    pub options: Vec<(String, String)>,
}

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
    /// Provider the session runs on (kept for restarts).
    pub provider: crate::provider::SharedProvider,
    pub process: SharedProcess,
    /// Copied from the client so the log drawer can read it mid-turn.
    pub stderr_tail: StderrTail,
    pub cancel: Arc<AtomicBool>,
    pub outbox: AgentOutbox,
    pub followups: ClientFollowups,
    pub pending_permissions: HashMap<RequestId, PendingPermission>,
    pub pending_plans: HashMap<RequestId, PendingPlan>,
    pub pending_questions: HashMap<RequestId, ()>,
    pub tool_call_cache: ToolCallCache,
    pub pending_startup_prompt: Option<String>,
    pub startup_injected: bool,
    pub prompt_in_flight: bool,
    pub exited: bool,
    /// Copied from the client so a send can check it without the client lock.
    pub supports_images: bool,
}

impl LiveSession {
    pub fn from_client(tab_id: &str, role_id: &str, client: AcpClient) -> Self {
        let process = client.process_handle();
        let stderr_tail = client.stderr_handle();
        let cancel = client.cancel_flag();
        let outbox = client.outbox();
        let followups = client.followups();
        let provider = client.provider();
        let supports_images = client.supports_images();
        Self {
            supports_images,
            provider,
            tab_id: tab_id.to_string(),
            role_id: role_id.to_string(),
            mode_id: client.mode_id().to_string(),
            cwd: client.cwd().display().to_string(),
            session_id: client.session_id().to_string(),
            client: wrap_client(client),
            process,
            stderr_tail,
            cancel,
            outbox,
            followups,
            pending_permissions: HashMap::new(),
            pending_plans: HashMap::new(),
            pending_questions: HashMap::new(),
            tool_call_cache: ToolCallCache::new(),
            pending_startup_prompt: None,
            startup_injected: false,
            prompt_in_flight: false,
            exited: false,
        }
    }

    /// The agent process is gone: flagged by a failed turn, or exited
    /// between turns without anyone noticing yet.
    pub fn is_dead(&self) -> bool {
        self.exited || matches!(self.process.try_wait(), Ok(Some(_)))
    }

    /// Stop the agent: SIGTERM now, SIGKILL after [`STOP_GRACE`] on a
    /// background thread, so Claude can finish its session log. Returns at
    /// once; callers may hold the registry lock.
    pub fn shutdown(&mut self) {
        self.release_pending();
        let _ = self.process.stop_gracefully(STOP_GRACE);
    }

    /// Stop at once (app exit, after the shared grace already ran).
    pub fn kill(&mut self) {
        self.release_pending();
        self.process.kill_tree();
    }

    fn release_pending(&mut self) {
        let pending: Vec<RequestId> = self.pending_permissions.drain().map(|(id, _)| id).collect();
        let plans: Vec<(RequestId, PendingPlan)> = self.pending_plans.drain().collect();
        let questions: Vec<RequestId> = self.pending_questions.drain().map(|(id, _)| id).collect();
        if let Ok(mut outbox) = self.outbox.lock() {
            for id in pending {
                outbox.push((id, cancelled_permission_result()));
            }
            for (id, plan) in plans {
                outbox.push((id, plan.cancelled_result()));
            }
            for id in questions {
                outbox.push((id, json!({ "outcome": "cancelled" })));
            }
        }
        self.cancel.store(true, Ordering::SeqCst);
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
            // A process that died between turns must not block a restart.
            if !existing.is_dead() {
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

    /// Add `session`. A different session it displaces is shut down, so its
    /// agent process is never left running without an owner.
    pub fn insert(&mut self, session: LiveSession) {
        let client = Arc::clone(&session.client);
        if let Some(mut old) = self.sessions.insert(session.tab_id.clone(), session) {
            if !Arc::ptr_eq(&old.client, &client) {
                old.shutdown();
            }
        }
    }

    /// Take the tab's session for a restart and mark the tab as starting,
    /// so no other start runs until `finish_start`. Refused while a start
    /// is already in progress.
    pub fn begin_restart(&mut self, tab_key: &str) -> Result<Option<LiveSession>, String> {
        if self.starting.contains(tab_key) {
            return Err(
                "Start already in progress for this tab — wait for the first click to finish"
                    .to_string(),
            );
        }
        let old = self.sessions.remove(tab_key);
        self.starting.insert(tab_key.to_string());
        Ok(old)
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

    /// App exit, step 1: SIGTERM every live agent and return their
    /// processes, so the caller can wait without holding this lock.
    pub fn terminate_all(&self) -> Vec<SharedProcess> {
        self.sessions
            .values()
            .map(|session| {
                session.process.terminate();
                session.process.clone()
            })
            .collect()
    }

    /// App exit, last step: kill whatever is left, without a grace.
    pub fn kill_all(&mut self) {
        for (_, mut session) in self.sessions.drain() {
            session.kill();
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Claude reasoning effort, and the levels the session offers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub effort_options: Vec<String>,
    /// Claude session whose agent takes pasted images.
    pub supports_images: bool,
}

/// A session still running for a tab, so a reloaded webview can reattach to it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionInfo {
    #[serde(flatten)]
    pub session: DevSessionInfo,
    pub role_id: String,
    pub prompt_in_flight: bool,
    pub exited: bool,
}

impl LiveSession {
    pub fn live_info(&self) -> LiveSessionInfo {
        // A turn holds the client lock; model and effort are skipped rather than waited for.
        let (model, effort, effort_options) = match self.client.try_lock() {
            Ok(client) => (
                client.current_model().map(String::from),
                client.current_effort().map(String::from),
                client.effort_options().to_vec(),
            ),
            Err(_) => (None, None, Vec::new()),
        };
        LiveSessionInfo {
            session: DevSessionInfo {
                session_id: self.session_id.clone(),
                mode_id: self.mode_id.clone(),
                cwd: self.cwd.clone(),
                model,
                effort,
                effort_options,
                supports_images: self.supports_images,
            },
            role_id: self.role_id.clone(),
            prompt_in_flight: self.prompt_in_flight,
            exited: self.is_dead(),
        }
    }
}

#[tauri::command]
pub fn dev_session_live(
    tab_id: String,
    state: State<Mutex<SessionRegistry>>,
) -> Result<Option<LiveSessionInfo>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    Ok(guard.get(&tab_id).map(LiveSession::live_info))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchResult {
    pub dispatched: bool,
}

fn resolve_tab_id(tab_id: Option<String>) -> String {
    tab_id.unwrap_or_else(|| DEV_TAB_ID.to_string())
}

// async: the spawn and handshake block, so keep them off the main thread.
#[tauri::command(async)]
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
        model: client.current_model().map(String::from),
        effort: client.current_effort().map(String::from),
        effort_options: client.effort_options().to_vec(),
        supports_images: client.supports_images(),
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
    attachments: Option<Vec<String>>,
    state: State<Mutex<SessionRegistry>>,
    staged: State<AttachmentStore>,
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
    let staged_ids = attachments.unwrap_or_default();
    if !staged_ids.is_empty() && !session.supports_images {
        return Err(
            "This chat's agent does not accept images — remove them and send text only."
                .to_string(),
        );
    }
    let images = TurnImages {
        images: staged.load(&tab_id, &staged_ids)?,
        staged_ids,
    };
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
        images,
        tab_id_for_injection.is_some(),
        had_attached_startup,
    );
    Ok(PromptDispatchResult { dispatched: true })
}

#[tauri::command]
pub fn dev_session_cancel(
    app: AppHandle,
    tab_id: Option<String>,
    state: State<Mutex<SessionRegistry>>,
) -> Result<(), String> {
    let tab_id = resolve_tab_id(tab_id);
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let session = guard
        .get_mut(&tab_id)
        .ok_or_else(|| "no active session".to_string())?;
    let pending: Vec<(RequestId, PendingPermission)> = session.pending_permissions.drain().collect();
    let plans: Vec<(RequestId, PendingPlan)> = session.pending_plans.drain().collect();
    let questions: Vec<RequestId> = session.pending_questions.drain().map(|(id, _)| id).collect();
    let outbox = Arc::clone(&session.outbox);
    let cancel = Arc::clone(&session.cancel);
    drop(guard);
    for (_, waiting) in &pending {
        crate::commands::activity::record_decision(
            &app,
            &tab_id,
            &waiting.tool_call_id,
            "cancelled",
        );
    }
    {
        let mut queue = outbox.lock().map_err(|e| e.to_string())?;
        for (id, _) in pending {
            queue.push((id, cancelled_permission_result()));
        }
        for (id, plan) in plans {
            queue.push((id, plan.cancelled_result()));
        }
        for id in questions {
            queue.push((id, json!({ "outcome": "cancelled" })));
        }
    }
    cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogs {
    pub stderr: String,
}

#[tauri::command]
pub fn session_agent_logs(
    tab_id: Option<String>,
    state: State<Mutex<SessionRegistry>>,
) -> Result<SessionLogs, String> {
    let tab_id = resolve_tab_id(tab_id);
    let guard = state.lock().map_err(|e| e.to_string())?;
    agent_logs(&guard, &tab_id)
}

/// The tab's agent stderr. Never takes the client lock: a turn holds it
/// until the turn ends, and the turn's callbacks wait for the registry
/// lock the caller holds here.
pub fn agent_logs(registry: &SessionRegistry, tab_id: &str) -> Result<SessionLogs, String> {
    let session = registry
        .get(tab_id)
        .ok_or_else(|| "no active session on this tab".to_string())?;
    Ok(SessionLogs {
        stderr: stderr_text(&session.stderr_tail),
    })
}

#[tauri::command]
pub fn dev_session_stop(
    app: tauri::AppHandle,
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
        crate::commands::chain_events::notify_tab(&app, &store, &tab_id);
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
