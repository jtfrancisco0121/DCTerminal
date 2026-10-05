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

    pub fn send_prompt(&mut self, text: &str) -> Result<PromptResult, String> {
        if text.trim().is_empty() {
            return Err("prompt text is empty".to_string());
        }
        let id = self.next_id;
        self.next_id += 1;
        let mut dispatch = LineDispatch::default();
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
    let mut parts = Vec::new();
    for note in &dispatch.notifications {
        if note.get("method").and_then(|m| m.as_str()) != Some("session/update") {
            continue;
        }
        let params = note.get("params").unwrap_or(note);
        append_text_from_update(params, &mut parts);
    }
    parts.join("")
}

fn append_text_from_update(params: &Value, parts: &mut Vec<String>) {
    if let Some(update) = params.get("update") {
        append_text_from_update(update, parts);
        return;
    }
    let kind = params
        .get("type")
        .or_else(|| params.get("updateType"))
        .and_then(|v| v.as_str());
    if matches!(
        kind,
        Some("agent_message_chunk") | Some("agentMessageChunk") | Some("text")
    ) || params.get("text").is_some()
    {
        if let Some(text) = params.get("text").and_then(|t| t.as_str()) {
            parts.push(text.to_string());
        } else if let Some(content) = params.get("content").and_then(|c| c.as_str()) {
            parts.push(content.to_string());
        }
    }
    if let Some(chunk) = params.get("chunk") {
        append_text_from_update(chunk, parts);
    }
}
