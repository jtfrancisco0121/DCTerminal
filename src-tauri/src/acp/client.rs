use super::connection::{AcpConnection, LineDispatch};
use super::session_connect::handshake;
use crate::supervisor::AgentSupervisor;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

const PROMPT_TIMEOUT: Duration = Duration::from_secs(600);

pub struct AcpClient {
    conn: AcpConnection,
    session_id: String,
    mode_id: String,
    cwd: PathBuf,
    next_id: u64,
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
        if !cwd.is_dir() {
            return Err(format!("working folder does not exist: {}", cwd.display()));
        }
        let mut conn = AgentSupervisor::spawn_default(cwd)?;
        let (session_id, mode) = handshake(&mut conn, cwd, mode_id)?;
        Ok(Self {
            conn,
            session_id,
            mode_id: mode,
            cwd: cwd.to_path_buf(),
            next_id: 5,
        })
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
        on_notification: Option<Box<dyn FnMut(&Value)>>,
        on_agent_request: Option<Box<dyn FnMut(&Value) -> Result<Value, String>>>,
    ) -> Result<PromptResult, String> {
        if text.trim().is_empty() {
            return Err("prompt text is empty".to_string());
        }
        let id = self.next_id;
        self.next_id += 1;
        let mut dispatch = LineDispatch::default();
        if let Some(handler) = on_notification {
            dispatch.set_on_notification(handler);
        }
        if let Some(handler) = on_agent_request {
            dispatch.set_on_agent_request(handler);
        }
        let result = self.conn.call_with_dispatch(
            id,
            "session/prompt",
            json!({
                "sessionId": self.session_id,
                "prompt": [{ "type": "text", "text": text }]
            }),
            PROMPT_TIMEOUT,
            &mut dispatch,
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

    pub fn cancel_turn(&mut self) -> Result<(), String> {
        let id = self.next_id;
        self.next_id += 1;
        self.conn.call(
            id,
            "session/cancel",
            json!({ "sessionId": self.session_id }),
            Duration::from_secs(10),
        )?;
        Ok(())
    }

    pub fn shutdown(&mut self) {
        self.conn.kill();
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
