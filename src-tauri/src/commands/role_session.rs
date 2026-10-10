use crate::acp::{map_session_update, AcpClient, ModelVia, SessionUpdateEvent};
use crate::commands::dev_session::{DevSessionInfo, LiveSession, SessionRegistry};
use crate::commands::prompt_worker::spawn_prompt_turn;
use crate::orchestrator::{injection_strategy_from_role, InjectionStrategy};
use crate::paths::{same_folder_warning, validate_working_folder};
use crate::provider::{provider_for_account, ProviderId, SharedProvider};
use crate::session_id::{session_start_bind, SessionStartBind};
use crate::store::{FormsStore, RolesStore, StateStore, TabSessionRef};
use crate::template::{merge_role_prompt, FieldError};
use serde::Serialize;
use serde_json::Value;
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
    pub loaded_via_session_load: bool,
    pub replay_message_count: usize,
    pub replay_truncated: bool,
    pub replay: Vec<SessionUpdateEvent>,
    /// How the model reached the agent: `unchanged`, `configOption`,
    /// `setModel`, `spawnFlag`, or `unsupported`.
    pub model_via: Option<ModelVia>,
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
        loaded_via_session_load: false,
        replay_message_count: 0,
        replay_truncated: false,
        replay: Vec::new(),
        model_via: None,
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
    resume_session_id: Option<String>,
    window_id: Option<String>,
    store: State<Mutex<RolesStore>>,
    state: State<Mutex<SessionRegistry>>,
    state_store: State<Mutex<StateStore>>,
    forms_store: State<Mutex<FormsStore>>,
    projects: State<Mutex<crate::store::ProjectsStore>>,
    settings: State<Mutex<crate::store::SettingsStore>>,
) -> Result<RoleSessionStartResult, String> {
    let role = {
        let store = store.lock().map_err(|e| e.to_string())?;
        store
            .role_by_id(&role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {role_id}"))
    }?;

    let mut bind = match session_start_bind(resume_session_id.as_deref()) {
        Ok(bind) => bind,
        Err(err) => {
            return Ok(empty_start(vec![FieldError {
                key: "_session".to_string(),
                message: err,
            }]));
        }
    };
    let provider = {
        let mut store = state_store.lock().map_err(|e| e.to_string())?;
        store.bind_window(window_id.as_deref());
        let settings = settings.lock().map_err(|e| e.to_string())?;
        let id = store.provider_for_start(tab_id.as_deref());
        let account = store.account_for_tab(tab_id.as_deref());
        provider_for_account(id, settings.providers(), Some(&account))
    };
    let mut start_notice: Option<String> = None;
    if provider.id() == ProviderId::Claude {
        if let SessionStartBind::LoadExisting { session_id } = &bind {
            let (sessions, current) = {
                let store = state_store.lock().map_err(|e| e.to_string())?;
                let sessions = tab_id
                    .as_deref()
                    .and_then(|id| store.tab_by_id(id))
                    .map(|tab| tab.sessions.clone())
                    .unwrap_or_default();
                let current = provider
                    .config_dir()
                    .map(|info| info.path)
                    .unwrap_or_default();
                (sessions, current)
            };
            let (resume, notice) = crate::provider::claude::decide_claude_resume(
                Some(session_id),
                &sessions,
                &current,
            );
            start_notice = notice;
            if resume.is_none() {
                bind = SessionStartBind::CreateNew;
            }
        }
    }
    let loading = matches!(bind, SessionStartBind::LoadExisting { .. });

    let preview = merge_role_prompt(&role, &values);
    // Resuming an existing ACP thread does not send the role template, so
    // missing startup fields must not block session/load.
    if !loading && !preview.errors.is_empty() {
        return Ok(empty_start(preview.errors));
    }

    let merged_chars = preview.merged.as_ref().map(|merged| merged.chars);
    let merged_text = preview.merged.map(|merged| merged.text).unwrap_or_default();

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

    if provider.id() == ProviderId::Claude {
        // Missing `claude` or adapter: say which and how to install it
        // before the tab is touched.
        if let Err(message) = provider.acp_command(None) {
            return Ok(empty_start(vec![FieldError {
                key: "_cli".to_string(),
                message,
            }]));
        }
    }

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

    // Claude: the per-role mode table (Decisions), never the Cursor mode.
    let mode_id = if provider.id() == ProviderId::Claude {
        provider.mode_for_role(&role.id, &role.default_mode, &[])
    } else {
        load_mode_id(&state_store, tab_id.as_deref(), &bind, &role.default_mode)?
    };
    let model = crate::models::model_for_tab_provider(
        &state_store,
        &settings,
        tab_id.as_deref(),
        &role.id,
        provider.id(),
    )?;
    let (client, replay_notes, model_via) = match connect_client(
        provider.clone(),
        &path,
        &mode_id,
        &bind,
        &model,
    ) {
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
                message: provider.auth_error_message(&msg),
            }]));
        }
        Err(e) if is_cli_missing(&e) || e == provider.missing_message() => {
            finish_starting(&state, &start_key);
            return Ok(empty_start(vec![FieldError {
                key: "_cli".to_string(),
                message: e,
            }]));
        }
        Err(e) if loading => {
            finish_starting(&state, &start_key);
            return Ok(empty_start(vec![FieldError {
                key: "_session".to_string(),
                message: friendly_load_error(&e),
            }]));
        }
        Err(e) => {
            finish_starting(&state, &start_key);
            return Err(e);
        }
        Ok((mut client, notes, via)) => {
            // Cache the adapter's model list (Phase 5). App data only.
            if provider.id() == ProviderId::Claude && !client.model_entries().is_empty() {
                let dir = crate::data_dir::app_data_dir(&app).path;
                let _ = crate::models::remember_claude_models(&dir, client.model_entries());
            }
            // The role's reasoning effort (Settings > Models). A level the
            // session does not offer is skipped; the session keeps its own.
            if provider.id() == ProviderId::Claude {
                let wanted = settings.lock().ok().and_then(|s| {
                    s.models_for(ProviderId::Claude)
                        .role_effort
                        .get(&role.id)
                        .cloned()
                });
                if let Some(effort) = wanted {
                    if let Err(err) = client.apply_effort(&effort) {
                        eprintln!("DCTerminal: effort {effort} not applied ({err})");
                    }
                }
            }
            (client, notes, via)
        }
    };

    let info = DevSessionInfo {
        session_id: client.session_id().to_string(),
        mode_id: client.mode_id().to_string(),
        cwd: client.cwd().display().to_string(),
        model: client
            .current_model()
            .map(String::from)
            .or(Some(model.clone())),
        effort: client.current_effort().map(String::from),
        effort_options: client.effort_options().to_vec(),
        supports_images: client.supports_images(),
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
        injection_pending: !loading && strategy == InjectionStrategy::AttachToFirstMessage,
        injected_at: None,
    };

    let resend = resend_startup.unwrap_or(false);
    let skip_startup = loading || {
        let store = state_store.lock().map_err(|e| e.to_string())?;
        store.should_skip_startup_injection(tab_id.as_deref(), resend)
    };

    let persisted_tab_id = {
        let mut store = state_store.lock().map_err(|e| e.to_string())?;
        store.bind_window(window_id.as_deref());
        match store.promote_tab_to_running(
            tab_id.as_deref(),
            &role,
            &values,
            &info.cwd,
            &merged_text,
            session_ref,
            provider.id(),
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
    if let Ok(store) = state_store.lock() {
        crate::commands::chain_events::notify_tab(&app, &store, &persisted_tab_id);
    }

    if provider.id() == ProviderId::Claude {
        let mut store = state_store.lock().map_err(|e| e.to_string())?;
        if let Some(dir) = provider.config_dir() {
            store.remember_claude_config(&persisted_tab_id, &dir.path)?;
        }
        let wanted = crate::provider::claude::claude_role_mode(&role.id);
        let note = (info.mode_id != wanted).then(|| {
            format!("the adapter did not offer {wanted} (using {})", info.mode_id)
        });
        store.set_permission_note(&persisted_tab_id, note)?;
        if start_notice.is_some() {
            store.set_provider_notice(&persisted_tab_id, start_notice.clone())?;
        }
    }

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
            Default::default(),
            true,
            true,
        );
    }

    let replay = replay_events(&persisted_tab_id, &info.session_id, &replay_notes);
    let replay_message_count = replay_message_count(&replay_notes);
    let replay_truncated = replay_is_truncated(&replay_notes);

    Ok(RoleSessionStartResult {
        errors: vec![],
        session: Some(info),
        merged_chars,
        injection_strategy: Some(strategy_label.to_string()),
        startup_injected: skip_startup,
        injection_in_flight,
        tab_id: Some(persisted_tab_id),
        resumed_session: skip_startup,
        skipped_startup_injection: skip_startup,
        folder_warning: match (folder_warning, start_notice.clone()) {
            (Some(existing), Some(notice)) => Some(format!("{notice} {existing}")),
            (None, Some(notice)) => Some(notice),
            (existing, None) => existing,
        },
        loaded_via_session_load: loading,
        replay_message_count,
        replay_truncated,
        replay,
        model_via: Some(model_via),
    })
}

fn friendly_load_error(err: &str) -> String {
    if err.contains("LOAD_UNSUPPORTED") {
        return "This Cursor CLI cannot continue a saved session. Start a new session instead."
            .to_string();
    }
    let detail: String = err.chars().take(500).collect();
    format!("Could not continue this session. {detail}")
}

fn load_mode_id(
    state_store: &Mutex<StateStore>,
    tab_id: Option<&str>,
    bind: &SessionStartBind,
    role_mode: &str,
) -> Result<String, String> {
    let SessionStartBind::LoadExisting { session_id } = bind else {
        return Ok(role_mode.to_string());
    };
    let store = state_store.lock().map_err(|e| e.to_string())?;
    let stored = tab_id
        .and_then(|id| store.tab_by_id(id))
        .and_then(|tab| tab.session.as_ref())
        .filter(|session| session.acp_session_id == *session_id)
        .map(|session| session.mode_id.clone());
    Ok(stored.unwrap_or_else(|| role_mode.to_string()))
}

fn connect_client(
    provider: SharedProvider,
    path: &std::path::Path,
    mode_id: &str,
    bind: &SessionStartBind,
    model: &str,
) -> Result<(AcpClient, Vec<Value>, ModelVia), String> {
    match bind {
        SessionStartBind::CreateNew => {
            AcpClient::connect_with_model(provider, path, mode_id, Some(model))
                .map(|(client, via)| (client, Vec::new(), via))
        }
        SessionStartBind::LoadExisting { session_id } => {
            AcpClient::load_with_model(provider, path, mode_id, session_id, Some(model), false)
        }
    }
}

fn replay_is_truncated(notes: &[Value]) -> bool {
    let mut stored = 0usize;
    let mut bytes = 0usize;
    for note in notes {
        let Some(event) = map_session_update("", "", note) else {
            continue;
        };
        bytes += event.raw_json.len();
        stored += 1;
        if stored > 2000 || bytes > 500_000 {
            return true;
        }
    }
    false
}

fn replay_events(tab_id: &str, session_id: &str, notes: &[Value]) -> Vec<SessionUpdateEvent> {
    let mut replay = Vec::new();
    let mut bytes = 0usize;
    for note in notes {
        let Some(event) = map_session_update(tab_id, session_id, note) else {
            continue;
        };
        bytes += event.raw_json.len();
        if replay.len() >= 2000 || bytes > 500_000 {
            break;
        }
        replay.push(event);
    }
    replay
}

fn replay_message_count(notes: &[Value]) -> usize {
    notes
        .iter()
        .filter(|note| {
            map_session_update("", "", note).is_some_and(|event| is_message_kind(&event.kind))
        })
        .count()
}

fn is_message_kind(kind: &str) -> bool {
    let normalized = kind.replace('_', "").to_lowercase();
    normalized.contains("usermessage") || normalized.contains("agentmessage")
}

/// Only the missing `agent` binary. A resume error such as "session not found"
/// must stay a continue failure, not a missing-CLI failure.
fn is_cli_missing(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("cursor cli (agent) was not found") || lower.contains("dct_agent_path")
}

#[cfg(test)]
mod tests {
    use super::{friendly_load_error, is_cli_missing};

    #[test]
    fn a_missing_session_is_not_a_missing_cli() {
        let err = r#"{"message":"session not found"}"#;
        assert!(!is_cli_missing(err));
        let text = friendly_load_error(err);
        assert!(text.contains("Could not continue this session"));
        assert!(!text.contains("session/load"));
    }

    #[test]
    fn a_missing_agent_binary_is_a_missing_cli() {
        assert!(is_cli_missing(
            "Cursor CLI (agent) was not found. Set DCT_AGENT_PATH."
        ));
    }

    #[test]
    fn an_unsupported_continue_says_to_start_a_new_session() {
        let text = friendly_load_error("LOAD_UNSUPPORTED: loadSession is false");
        assert!(text.contains("Start a new session"));
        assert!(!text.contains("ACP"));
    }
}
