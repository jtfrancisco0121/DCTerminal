use crate::acp::PromptResult;
use crate::commands::dev_session::{DevSessionInfo, DevSessionState};
use crate::orchestrator::{injection_strategy_from_role, InjectionStrategy};
use crate::store::{FormsStore, RolesStore, StateStore, TabSessionRef};
use chrono::Utc;
use crate::template::merge_role_prompt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};

use crate::acp::AcpClient;
use crate::commands::acp_events::emit_session_update;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSessionStartResult {
    pub errors: Vec<crate::template::FieldError>,
    pub session: Option<DevSessionInfo>,
    pub merged_chars: Option<usize>,
    pub injection_strategy: Option<String>,
    pub startup_injected: bool,
    pub injection_result: Option<PromptResult>,
    pub tab_id: Option<String>,
}

#[tauri::command]
pub fn role_session_start(
    app: AppHandle,
    role_id: String,
    values: HashMap<String, String>,
    store: State<Mutex<RolesStore>>,
    state: State<Mutex<DevSessionState>>,
    state_store: State<Mutex<StateStore>>,
    forms_store: State<Mutex<FormsStore>>,
) -> Result<RoleSessionStartResult, String> {
    let role = {
        let store = store.lock().map_err(|e| e.to_string())?;
        store
            .role_by_id(&role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {role_id}"))
    }?;

    let preview = merge_role_prompt(&role, &values);
    if !preview.errors.is_empty() {
        return Ok(RoleSessionStartResult {
            errors: preview.errors,
            session: None,
            merged_chars: None,
            injection_strategy: None,
            startup_injected: false,
            injection_result: None,
            tab_id: None,
        });
    }

    let merged = preview
        .merged
        .ok_or_else(|| "merge succeeded but produced no text".to_string())?;
    let merged_text = merged.text.clone();

    let cwd = values
        .get("cwd")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "cwd is required".to_string())?;
    let path = PathBuf::from(cwd);

    let strategy = injection_strategy_from_role(&role.injection);
    let strategy_label = match strategy {
        InjectionStrategy::SendOnStart => "send_on_start",
        InjectionStrategy::AttachToFirstMessage => "attach_to_first_message",
    };

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if !guard.phase.can_submit_startup_form() {
        return Err("a session is already running — stop it first".to_string());
    }
    if let Some(mut existing) = guard.client.take() {
        existing.shutdown();
    }
    guard.pending_startup_prompt = None;
    guard.startup_injected = false;

    let mut client = AcpClient::connect(&path, &role.default_mode)?;
    let info = DevSessionInfo {
        session_id: client.session_id().to_string(),
        mode_id: client.mode_id().to_string(),
        cwd: client.cwd().display().to_string(),
    };

    let mut injection_result = None;
    let mut startup_injected = false;

    match strategy {
        InjectionStrategy::SendOnStart => {
            let session_id = client.session_id().to_string();
            let app_handle = app.clone();
            let on_notification = Box::new(move |value: &serde_json::Value| {
                emit_session_update(&app_handle, &session_id, value);
            });
            let result = client.send_prompt(&merged_text, Some(on_notification))?;
            injection_result = Some(result);
            startup_injected = true;
            guard.startup_injected = true;
            guard.client = Some(client);
        }
        InjectionStrategy::AttachToFirstMessage => {
            guard.pending_startup_prompt = Some(merged_text.clone());
            guard.client = Some(client);
        }
    }

    guard.phase = guard
        .phase
        .after_session_started()
        .map_err(|e| e.to_string())?;

    let session_ref = TabSessionRef {
        acp_session_id: info.session_id.clone(),
        mode_id: info.mode_id.clone(),
        injection_pending: strategy == InjectionStrategy::AttachToFirstMessage,
        injected_at: if startup_injected {
            Some(Utc::now().to_rfc3339())
        } else {
            None
        },
    };

    let tab_id = {
        let mut store = state_store.lock().map_err(|e| e.to_string())?;
        store.upsert_running_tab(
            &role,
            &values,
            &info.cwd,
            &merged_text,
            session_ref,
            startup_injected,
        )?
    };
    guard.active_tab_id = Some(tab_id.clone());

    {
        let mut forms = forms_store.lock().map_err(|e| e.to_string())?;
        forms.save_after_session_start(&role, &info.cwd, &values)?;
    }

    Ok(RoleSessionStartResult {
        errors: vec![],
        session: Some(info),
        merged_chars: Some(merged.chars),
        injection_strategy: Some(strategy_label.to_string()),
        startup_injected,
        injection_result,
        tab_id: Some(tab_id),
    })
}
