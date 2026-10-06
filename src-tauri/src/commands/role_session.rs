use crate::acp::AcpClient;
use crate::commands::dev_session::{DevSessionInfo, LiveSession, SessionRegistry};
use crate::commands::prompt_worker::spawn_prompt_turn;
use crate::orchestrator::{injection_strategy_from_role, InjectionStrategy};
use crate::paths::{same_folder_warning, validate_working_folder};
use crate::store::{FormsStore, RolesStore, StateStore, TabSessionRef};
use crate::template::{merge_role_prompt, FieldError};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSessionStartResult {
    pub errors: Vec<FieldError>,
    pub session: Option<DevSessionInfo>,
    pub merged_chars: Option<usize>,
    pub injection_strategy: Option<String>,
    pub startup_injected: bool,
    pub injection_in_flight: bool,
    pub tab_id: Option<String>,
    pub resumed_session: bool,
    pub skipped_startup_injection: bool,
    pub folder_warning: Option<String>,
}

fn empty_start(errors: Vec<FieldError>) -> RoleSessionStartResult {
    RoleSessionStartResult {
        errors,
        session: None,
        merged_chars: None,
        injection_strategy: None,
        startup_injected: false,
        injection_in_flight: false,
        tab_id: None,
        resumed_session: false,
        skipped_startup_injection: false,
        folder_warning: None,
    }
}

fn finish_starting(state: &Mutex<SessionRegistry>, key: &str) {
    if let Ok(mut guard) = state.lock() {
        guard.finish_start(key);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects each managed state as its own argument.
pub fn role_session_start(
    app: AppHandle,
    role_id: String,
    values: HashMap<String, String>,
    tab_id: Option<String>,
    resend_startup: Option<bool>,
    store: State<Mutex<RolesStore>>,
    state: State<Mutex<SessionRegistry>>,
    state_store: State<Mutex<StateStore>>,
    forms_store: State<Mutex<FormsStore>>,
    projects: State<Mutex<crate::store::ProjectsStore>>,
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
        return Ok(empty_start(preview.errors));
    }

    let merged = preview
        .merged
        .ok_or_else(|| "merge succeeded but produced no text".to_string())?;
    let merged_text = merged.text.clone();

    let cwd_raw = values
        .get("cwd")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "cwd is required".to_string())?;
    let path = match validate_working_folder(cwd_raw) {
        Ok(path) => path,
        Err(err) => {
            return Ok(empty_start(vec![FieldError {
                key: "cwd".to_string(),
                message: err.message(),
            }]));
        }
    };

    let strategy = injection_strategy_from_role(&role.injection);
    let strategy_label = match strategy {
        InjectionStrategy::SendOnStart => "send_on_start",
        InjectionStrategy::AttachToFirstMessage => "attach_to_first_message",
    };

    let start_key = tab_id
        .clone()
        .unwrap_or_else(|| "__role_start__".to_string());
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        if let Err(err) = guard.try_begin_start(&start_key) {
            return Ok(empty_start(vec![FieldError {
                key: "_session".to_string(),
                message: err,
            }]));
        }
    }

    let client = match AcpClient::connect(&path, &role.default_mode) {
        Err(e) if e.starts_with("AUTH_ERROR:") || e.contains("AUTH_ERROR:") => {
            finish_starting(&state, &start_key);
            let msg = e
                .split("AUTH_ERROR:")
                .nth(1)
                .unwrap_or(e.as_str())
                .trim()
                .to_string();
            return Ok(empty_start(vec![FieldError {
                key: "_auth".to_string(),
                message: format!(
                    "Cursor CLI is not authenticated. Run `agent login` in a terminal, then Retry. ({msg})"
                ),
            }]));
        }
        Err(e) if is_cli_missing(&e) => {
            finish_starting(&state, &start_key);
            return Ok(empty_start(vec![FieldError {
                key: "_cli".to_string(),
                message: e,
            }]));
        }
        Err(e) => {
            finish_starting(&state, &start_key);
            return Err(e);
        }
        Ok(client) => client,
    };

    let info = DevSessionInfo {
        session_id: client.session_id().to_string(),
        mode_id: client.mode_id().to_string(),
        cwd: client.cwd().display().to_string(),
    };
    let mut folder_warning = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let others = guard.agent_folders_except(&start_key);
        let refs: Vec<(&str, &str)> = others
            .iter()
            .map(|(cwd, mode)| (cwd.as_str(), mode.as_str()))
            .collect();
        same_folder_warning(&info.cwd, &info.mode_id, &refs)
    };

    let session_ref = TabSessionRef {
        acp_session_id: info.session_id.clone(),
        mode_id: info.mode_id.clone(),
        injection_pending: strategy == InjectionStrategy::AttachToFirstMessage,
        injected_at: None,
    };

    let resend = resend_startup.unwrap_or(false);
    let skip_startup = {
        let store = state_store.lock().map_err(|e| e.to_string())?;
        store.should_skip_startup_injection(tab_id.as_deref(), resend)
    };

    let persisted_tab_id = {
        let mut store = state_store.lock().map_err(|e| e.to_string())?;
        match store.promote_tab_to_running(
            tab_id.as_deref(),
            &role,
            &values,
            &info.cwd,
            &merged_text,
            session_ref,
        ) {
            Ok(id) => id,
            Err(err) => {
                finish_starting(&state, &start_key);
                // Drop the process we just spawned.
                let mut live = LiveSession::from_client(&start_key, &role.id, client);
                live.shutdown();
                return Err(err);
            }
        }
    };

    let mut live = LiveSession::from_client(&persisted_tab_id, &role.id, client);
    let mut injection_in_flight = false;
    if skip_startup {
        live.startup_injected = true;
    } else if strategy == InjectionStrategy::AttachToFirstMessage {
        live.pending_startup_prompt = Some(merged_text.clone());
    } else {
        live.prompt_in_flight = true;
        injection_in_flight = true;
    }

    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.finish_start(&start_key);
        if persisted_tab_id != start_key {
            guard.finish_start(&persisted_tab_id);
        }
        guard.insert(live);
    }

    {
        let mut forms = forms_store.lock().map_err(|e| e.to_string())?;
        forms.save_after_session_start(&role, &info.cwd, &values)?;
    }

    if let Ok(mut projects) = projects.lock() {
        projects.remember(&info.cwd, &chrono::Utc::now().to_rfc3339());
        if let Err(err) = projects.save() {
            let note = format!("Could not save this folder to recent projects ({err}).");
            folder_warning = Some(match folder_warning {
                Some(existing) => format!("{existing} {note}"),
                None => note,
            });
        }
    }

    if injection_in_flight {
        spawn_prompt_turn(
            app,
            persisted_tab_id.clone(),
            merged_text,
            true,
            true,
        );
    }

    Ok(RoleSessionStartResult {
        errors: vec![],
        session: Some(info),
        merged_chars: Some(merged.chars),
        injection_strategy: Some(strategy_label.to_string()),
        startup_injected: skip_startup,
        injection_in_flight,
        tab_id: Some(persisted_tab_id),
        resumed_session: skip_startup,
        skipped_startup_injection: skip_startup,
        folder_warning,
    })
}

fn is_cli_missing(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("was not found")
        || lower.contains("not found")
        || lower.contains("dct_agent_path")
}
