use super::connection::default_io_timeout;
use super::connection::{AcpConnection, LineDispatch, TurnControl};
use super::ndjson::session_prompt_params;
use super::session_connect::{
    handshake, handshake_load, model_requests, parse_session_models, SessionModels,
};
use crate::process_tree::SharedProcess;
use crate::provider::{CursorProvider, SharedProvider};
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
    models: SessionModels,
    provider: SharedProvider,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResult {
    pub stop_reason: Option<String>,
    pub agent_text: String,
    pub update_count: usize,
}

/// How a model choice reached the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelVia {
    /// No model was asked for, or the session already used it.
    Unchanged,
    ConfigOption,
    SetModel,
    /// `agent --model <id> acp` at spawn.
    SpawnFlag,
    /// The agent offered no way to change the model in this session.
    Unsupported,
}

impl AcpClient {
    /// Cursor session (dev tools).
    pub fn connect(cwd: &Path, mode_id: &str) -> Result<Self, String> {
        Self::connect_with_model(Arc::new(CursorProvider), cwd, mode_id, None)
            .map(|(client, _)| client)
    }

    /// New session. A model the session cannot switch to in place is applied
    /// by restarting the agent with a spawn-time model and opening a fresh session.
    pub fn connect_with_model(
        provider: SharedProvider,
        cwd: &Path,
        mode_id: &str,
        model: Option<&str>,
    ) -> Result<(Self, ModelVia), String> {
        let folder = crate::paths::validate_working_folder(&cwd.display().to_string())
            .map_err(|err| err.message())?;
        let mut client = Self::spawn_new(&provider, &folder, mode_id, None)?;
        let Some(model) = model else {
            return Ok((client, ModelVia::Unchanged));
        };
        match client.apply_model(model)? {
            ModelVia::Unsupported => {
                client.conn.kill();
                let mut flagged = Self::spawn_new(&provider, &folder, mode_id, Some(model))?;
                flagged.models.current = Some(model.to_string());
                Ok((flagged, ModelVia::SpawnFlag))
            }
            via => Ok((client, via)),
        }
    }

    fn spawn_new(
        provider: &SharedProvider,
        folder: &Path,
        mode_id: &str,
        spawn_model: Option<&str>,
    ) -> Result<Self, String> {
        let mut conn = AgentSupervisor::spawn_provider(provider, folder, spawn_model)?;
        match handshake(&mut conn, provider.as_ref(), folder, mode_id) {
            Ok((session_id, mode, models)) => {
                let mut client = Self::from_parts(
                    conn,
                    session_id,
                    mode,
                    folder.to_path_buf(),
                    provider.clone(),
                );
                client.models = models;
                Ok(client)
            }
            Err(err) => {
                conn.kill();
                Err(err)
            }
        }
    }

    /// Resume `session_id` with `session/load`. Replay notifications are returned
    /// to the caller; they are not written anywhere under `~/.cursor`.
    /// `session/load` with a model. `spawn_flag` skips the in-place attempt
    /// (the caller already knows the session cannot switch).
    pub fn load_with_model(
        provider: SharedProvider,
        cwd: &Path,
        mode_id: &str,
        session_id: &str,
        model: Option<&str>,
        spawn_flag: bool,
    ) -> Result<(Self, Vec<Value>, ModelVia), String> {
        let folder = crate::paths::validate_working_folder(&cwd.display().to_string())
            .map_err(|err| err.message())?;
        if let (Some(model), true) = (model, spawn_flag) {
            let (mut client, replay) =
                Self::spawn_load(&provider, &folder, mode_id, session_id, Some(model))?;
            client.models.current = Some(model.to_string());
            return Ok((client, replay, ModelVia::SpawnFlag));
        }
        let (mut client, replay) = Self::spawn_load(&provider, &folder, mode_id, session_id, None)?;
        let Some(model) = model else {
            return Ok((client, replay, ModelVia::Unchanged));
        };
        match client.apply_model(model)? {
            ModelVia::Unsupported => {
                client.conn.kill();
                let (mut flagged, replay) =
                    Self::spawn_load(&provider, &folder, mode_id, session_id, Some(model))?;
                flagged.models.current = Some(model.to_string());
                Ok((flagged, replay, ModelVia::SpawnFlag))
            }
            via => Ok((client, replay, via)),
        }
    }

    fn spawn_load(
        provider: &SharedProvider,
        folder: &Path,
        mode_id: &str,
        session_id: &str,
        spawn_model: Option<&str>,
    ) -> Result<(Self, Vec<Value>), String> {
        let mut conn = AgentSupervisor::spawn_provider(provider, folder, spawn_model)?;
        match handshake_load(&mut conn, provider.as_ref(), folder, mode_id, session_id) {
            Ok((loaded_id, mode, replay, models)) => {
                let mut client = Self::from_parts(
                    conn,
                    loaded_id,
                    mode,
                    folder.to_path_buf(),
                    provider.clone(),
                );
                client.models = models;
                Ok((client, replay))
            }
            Err(err) => {
                conn.kill();
                Err(err)
            }
        }
    }

    /// Switch this session's model in place: `session/set_config_option`
    /// (category `model`), then `session/set_model`. `Unsupported` means the
    /// caller has to restart the agent with `--model`.
    pub fn apply_model(&mut self, model: &str) -> Result<ModelVia, String> {
        let valid = if self.provider.id() == crate::provider::ProviderId::Claude {
            // Never send a Cursor id (or anything else) to the Claude adapter.
            crate::models::is_claude_model_id(model)
        } else {
            crate::models::valid_model_id(model)
        };
        if !valid {
            return Err(format!("not a model id: {model}"));
        }
        if self.models.current.as_deref() == Some(model) {
            return Ok(ModelVia::Unchanged);
        }
        let requests = model_requests(&self.models, &self.session_id, model);
        let mut last_error: Option<String> = None;
        for (method, params) in requests {
            let id = self.next_id;
            self.next_id += 1;
            match self.conn.call(id, &method, params, default_io_timeout()) {
                Ok(result) => {
                    if result.get("configOptions").is_some() {
                        let refreshed = parse_session_models(&result);
                        if refreshed.config_id.is_some() {
                            self.models.current = refreshed.current;
                            self.models.available = refreshed.available;
                        }
                    }
                    self.models.current = Some(model.to_string());
                    return Ok(if method == "session/set_config_option" {
                        ModelVia::ConfigOption
                    } else {
                        ModelVia::SetModel
                    });
                }
                Err(err) if err.contains("agent exited") || err.contains("stdout closed") => {
                    return Err(err);
                }
                // Method not found, or the agent rejected the value: try the
                // next request, then fall back to a restart with `--model`.
                Err(err) => last_error = Some(err),
            }
        }
        if let Some(err) = last_error {
            eprintln!("DCTerminal: in-place model switch failed, restarting with --model ({err})");
        }
        Ok(ModelVia::Unsupported)
    }

    pub fn current_model(&self) -> Option<&str> {
        self.models.current.as_deref()
    }

    fn from_parts(
        conn: AcpConnection,
        session_id: String,
        mode_id: String,
        cwd: PathBuf,
        provider: SharedProvider,
    ) -> Self {
        Self {
            provider,
            conn,
            session_id,
            mode_id,
            cwd,
            next_id: 5,
            cancel: Arc::new(AtomicBool::new(false)),
            outbox: Arc::new(Mutex::new(Vec::new())),
            models: SessionModels::default(),
        }
    }

    /// The provider this session runs on.
    pub fn provider(&self) -> SharedProvider {
        Arc::clone(&self.provider)
    }

    pub fn process_handle(&self) -> SharedProcess {
        self.conn.process_handle()
    }

    pub fn stderr_tail_text(&self) -> String {
        self.conn.stderr_tail_text()
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
