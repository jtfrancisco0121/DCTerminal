use super::connection::{AcpConnection, LineDispatch, TurnControl};
use super::ndjson::session_prompt_params;
use super::session_connect::handshake;
use crate::process_tree::SharedProcess;
use crate::supervisor::AgentSupervisor;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const PROMPT_TIMEOUT: Duration = Duration::from_secs(600);

pub struct AcpClient {
    conn: AcpConnection,
    session_id: String,
    mode_id: String,
    cwd: PathBuf,
    next_id: u64,
    cancel: Arc<AtomicBool>,
    outbox: Arc<Mutex<Vec<(u64, Value)>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResult {
    pub stop_reason: Option<String>,
    pub agent_text: String,
    pub update_count: usize,
}

impl AcpClient {
    pub fn connect(cwd: &Path, mode_id: &str) -> Result<Self, String> {
        let folder = crate::paths::validate_working_folder(&cwd.display().to_string())
            .map_err(|err| err.message())?;
        let mut conn = AgentSupervisor::spawn_default(&folder)?;
        let (session_id, mode) = handshake(&mut conn, &folder, mode_id)?;
        Ok(Self {
            conn,
            session_id,
            mode_id: mode,
            cwd: folder,
            next_id: 5,
            cancel: Arc::new(AtomicBool::new(false)),
            outbox: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub fn process_handle(&self) -> SharedProcess {
        self.conn.process_handle()
    }

    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    pub fn outbox(&self) -> Arc<Mutex<Vec<(u64, Value)>>> {
        Arc::clone(&self.outbox)
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn mode_id(&self) -> &str {
        &self.mode_id
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub fn send_prompt(
        &mut self,
        text: &str,
        on_notification: Option<super::connection::NotificationHandler>,
        on_agent_request: Option<super::connection::AgentRequestHandler>,
    ) -> Result<PromptResult, String> {
        if text.trim().is_empty() {
            return Err("prompt text is empty".to_string());
        }
        // A cancel that arrived before this turn is stale.
        self.cancel.store(false, Ordering::SeqCst);
        let id = self.next_id;
        self.next_id += 1;
        let mut dispatch = LineDispatch::default();
        if let Some(handler) = on_notification {
            dispatch.set_on_notification(handler);
        }
        if let Some(handler) = on_agent_request {
            dispatch.set_on_agent_request(handler);
        }
        let outbox = Arc::clone(&self.outbox);
        let session_for_prompt = self.session_id.clone();
        let mut turn = TurnControl {
            cancel: self.cancel.as_ref(),
            session_id: &session_for_prompt,
            next_id: &mut self.next_id,
            outbox: Some(outbox),
        };
        let result = self.conn.call_with_dispatch(
            id,
            "session/prompt",
            session_prompt_params(&session_for_prompt, text),
            PROMPT_TIMEOUT,
            &mut dispatch,
            Some(&mut turn),
        )?;
        let stop_reason = result
            .get("stopReason")
            .and_then(|v| v.as_str())
            .map(String::from);
        let agent_text = extract_agent_text(&dispatch);
        Ok(PromptResult {
            stop_reason,
            agent_text,
            update_count: dispatch.notifications.len(),
        })
    }

}

fn extract_agent_text(dispatch: &LineDispatch) -> String {
    use super::text_extract::text_from_session_params;
    let mut parts = Vec::new();
    for note in &dispatch.notifications {
        if note.get("method").and_then(|m| m.as_str()) != Some("session/update") {
            continue;
        }
        let params = note.get("params").unwrap_or(note);
        let kind = params
            .get("update")
            .and_then(|u| u.get("type"))
            .or_else(|| params.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let normalized = kind.replace('_', "").to_lowercase();
        if normalized.contains("thought") || normalized.contains("toolcall") {
            continue;
        }
        if let Some(text) = text_from_session_params(params) {
            parts.push(text);
        }
    }
    parts.join("")
}
