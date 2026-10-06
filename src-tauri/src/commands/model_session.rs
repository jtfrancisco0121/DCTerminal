//! Change the model of a running chat tab.
//!
//! In place first (`session/set_config_option`, then `session/set_model`).
//! When the agent offers neither, the tab's `agent acp` is restarted with
//! `--model <id>` and the same session is reopened with `session/load`.

use crate::acp::{AcpClient, ModelVia};
use crate::commands::dev_session::{LiveSession, SessionRegistry};
use crate::store::{SettingsStore, StateStore};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModelResult {
    /// The model the tab now uses (override, role default, or global default).
    pub model: String,
    /// `None` when the tab has no live session; the model applies at the next start.
    pub via: Option<ModelVia>,
    /// The agent process was restarted with `--model` and `session/load`.
    pub restarted: bool,
}

struct LiveSnapshot {
    client: crate::commands::dev_session::SharedAcpClient,
    role_id: String,
    mode_id: String,
    cwd: PathBuf,
    session_id: String,
}

fn live_snapshot(
    registry: &Mutex<SessionRegistry>,
    tab_id: &str,
) -> Result<Option<LiveSnapshot>, String> {
    let guard = registry.lock().map_err(|e| e.to_string())?;
    let Some(session) = guard.get(tab_id) else {
        return Ok(None);
    };
    if session.exited {
        return Ok(None);
    }
    if session.prompt_in_flight {
        return Err("Wait for the current turn to finish, then change the model.".to_string());
    }
    Ok(Some(LiveSnapshot {
        client: session.client.clone(),
        role_id: session.role_id.clone(),
        mode_id: session.mode_id.clone(),
        cwd: PathBuf::from(&session.cwd),
        session_id: session.session_id.clone(),
    }))
}

#[tauri::command]
pub fn acp_set_model(
    tab_id: String,
    model: Option<String>,
    registry: State<Mutex<SessionRegistry>>,
    store: State<Mutex<StateStore>>,
    settings: State<Mutex<SettingsStore>>,
) -> Result<SetModelResult, String> {
    let model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    if let Some(id) = &model {
        if !crate::models::valid_model_id(id) {
            return Err(format!("not a model id: {id}"));
        }
    }
    let snapshot = live_snapshot(&registry, &tab_id)?;
    {
        let mut store = store.lock().map_err(|e| e.to_string())?;
        store.set_tab_model(&tab_id, model.clone())?;
    }
    let role_id = snapshot
        .as_ref()
        .map(|s| s.role_id.clone())
        .unwrap_or_default();
    let effective = crate::models::model_for_tab(&store, &settings, Some(&tab_id), &role_id)?;
    let Some(live) = snapshot else {
        return Ok(SetModelResult {
            model: effective,
            via: None,
            restarted: false,
        });
    };
    let via = {
        let mut client = live
            .client
            .try_lock()
            .map_err(|_| "The agent is busy. Try again when the turn finishes.".to_string())?;
        client.apply_model(&effective)?
    };
    if via != ModelVia::Unsupported {
        return Ok(SetModelResult {
            model: effective,
            via: Some(via),
            restarted: false,
        });
    }
    // Stop the old process before the new one opens the same session.
    let (startup_injected, pending_startup) = {
        let mut guard = registry.lock().map_err(|e| e.to_string())?;
        let mut old = guard.take(&tab_id);
        let flags = old
            .as_ref()
            .map(|s| (s.startup_injected, s.pending_startup_prompt.clone()))
            .unwrap_or((true, None));
        if let Some(session) = old.as_mut() {
            session.shutdown();
        }
        flags
    };
    let (client, _replay, via) = AcpClient::load_with_model(
        &live.cwd,
        &live.mode_id,
        &live.session_id,
        Some(&effective),
        true,
    )
    .map_err(|err| {
        format!(
            "The agent stopped while switching models. Continue the session to reopen it. ({err})"
        )
    })?;
    let mut session = LiveSession::from_client(&tab_id, &live.role_id, client);
    session.startup_injected = startup_injected;
    session.pending_startup_prompt = pending_startup;
    {
        let mut guard = registry.lock().map_err(|e| e.to_string())?;
        guard.insert(session);
    }
    Ok(SetModelResult {
        model: effective,
        via: Some(via),
        restarted: true,
    })
}
