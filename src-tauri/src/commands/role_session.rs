use crate::acp::{map_session_update, AcpClient, ModelVia, SessionUpdateEvent};
use crate::commands::dev_session::{DevSessionInfo, LiveSession, SessionRegistry, StartingTab};
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
use std::sync::{Mutex, MutexGuard};
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

// async: the spawn and handshake block (up to the 30 s IO timeout), so they
// run off the main thread and the window keeps drawing.
#[tauri::command(async)]
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
    // Ended on every return; the success path ends it with the insert.
    let starting = match StartingTab::begin(&state, &start_key) {
        Ok(starting) => starting,
        Err(err) => {
            return Ok(empty_start(vec![FieldError {
                key: "_session".to_string(),
                message: err,
            }]));
        }
    };

    // Claude: the per-role mode table (Decisions), never the Cursor mode.
    let mode_id = if provider.id() == ProviderId::Claude {
        claude_start_mode(provider.as_ref(), &state_store, tab_id.as_deref(), &role)?
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
            return Ok(empty_start(vec![FieldError {
                key: "_cli".to_string(),
                message: e,
            }]));
        }
        Err(e) if loading => {
            return Ok(empty_start(vec![FieldError {
                key: "_session".to_string(),
                message: friendly_load_error(&e),
            }]));
        }
        Err(e) => return Err(e),
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

    // From here to the registry insert every early return drops the agent
    // through this guard, which stops it (nothing else owns it yet).
    let client = StartedAgent::new(&start_key, &role.id, client);
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

    let promoted = {
        let mut store = state_store.lock().map_err(|e| e.to_string())?;
        store.bind_window(window_id.as_deref());
        store.promote_tab_to_running(
            tab_id.as_deref(),
            &role,
            &values,
            &info.cwd,
            &merged_text,
            session_ref,
            provider.id(),
        )
    };
    let persisted_tab_id = promoted?;
    if let Ok(store) = state_store.lock() {
        crate::commands::chain_events::notify_tab(&app, &store, &persisted_tab_id);
    }

    if provider.id() == ProviderId::Claude {
        record_claude_start(
            &state_store,
            &provider,
            &persisted_tab_id,
            &role.id,
            &info.mode_id,
            start_notice.as_deref(),
        )?;
    }

    // The registry lock is taken while the agent is still guarded: a poisoned
    // registry stops the agent instead of dropping a live session that has no Drop.
    // From the handover to `insert` below there are only field assignments and one
    // `clone()`, no fallible call. A panic there would still leak the agent
    // (`LiveSession` has no Drop); that gap is accepted.
    let (mut guard, mut live) = client.into_live_locked(&state, &persisted_tab_id)?;
    let mut injection_in_flight = false;
    if skip_startup {
        live.startup_injected = true;
    } else if strategy == InjectionStrategy::AttachToFirstMessage {
        live.pending_startup_prompt = Some(merged_text.clone());
    } else {
        live.prompt_in_flight = true;
        injection_in_flight = true;
    }

    starting.finish(&mut guard);
    if persisted_tab_id != start_key {
        guard.finish_start(&persisted_tab_id);
    }
    guard.insert(live);
    drop(guard);

    {
        let mut forms = forms_store.lock().map_err(|e| e.to_string())?;
        forms.save_after_session_start(&role.id, &info.cwd)?;
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

/// A connected agent that is not yet in the registry. Dropping it stops the
/// agent: `ProcessTree` has no `Drop` and neither Stop nor quit can reach a
/// session the registry does not hold, so a failed start would orphan it.
struct StartedAgent {
    key: String,
    role_id: String,
    client: Option<AcpClient>,
}

impl StartedAgent {
    fn new(key: &str, role_id: &str, client: AcpClient) -> Self {
        Self {
            key: key.to_string(),
            role_id: role_id.to_string(),
            client: Some(client),
        }
    }

    /// Hand the agent to the registry's session type; it is no longer stopped on drop.
    fn into_live(mut self, tab_id: &str) -> LiveSession {
        let client = self.client.take().expect("agent already handed over");
        LiveSession::from_client(tab_id, &self.role_id, client)
    }

    /// Lock the registry, then hand the agent over. The lock comes first so a
    /// poisoned registry returns an error while this guard still owns (and so
    /// stops) the agent; once handed over there is no early return before the insert.
    fn into_live_locked<'a>(
        self,
        state: &'a Mutex<SessionRegistry>,
        tab_id: &str,
    ) -> Result<(MutexGuard<'a, SessionRegistry>, LiveSession), String> {
        let guard = state.lock().map_err(|e| e.to_string())?;
        Ok((guard, self.into_live(tab_id)))
    }
}

impl std::ops::Deref for StartedAgent {
    type Target = AcpClient;

    fn deref(&self) -> &AcpClient {
        self.client.as_ref().expect("agent already handed over")
    }
}

impl Drop for StartedAgent {
    fn drop(&mut self) {
        // Runs with no store lock held; `shutdown` returns at once.
        if let Some(client) = self.client.take() {
            LiveSession::from_client(&self.key, &self.role_id, client).shutdown();
        }
    }
}

/// Claude-only state the promoted tab records: the config dir it runs under,
/// the permission-mode note and the provider notice.
/// The mode a Claude chat start asks for: the per-role table, except that on
/// a pipeline stage (a chat hand-off's tab is tagged before it starts) the
/// stage's kind decides plan mode, so a copied Planner plans.
fn claude_start_mode(
    provider: &dyn crate::provider::Provider,
    state_store: &Mutex<StateStore>,
    tab_id: Option<&str>,
    role: &crate::roles::Role,
) -> Result<String, String> {
    let stage_kind = match tab_id {
        Some(id) => {
            let store = state_store.lock().map_err(|e| e.to_string())?;
            store.tab_stage_kind(id)
        }
        None => None,
    };
    Ok(provider.mode_for_role(&role.id, stage_kind, &role.default_mode, &[]))
}

fn record_claude_start(
    state_store: &Mutex<StateStore>,
    provider: &SharedProvider,
    tab_id: &str,
    role_id: &str,
    mode_id: &str,
    notice: Option<&str>,
) -> Result<(), String> {
    let mut store = state_store.lock().map_err(|e| e.to_string())?;
    if let Some(dir) = provider.config_dir() {
        store.remember_claude_config(tab_id, &dir.path)?;
    }
    let stage_kind = store.tab_stage_kind(tab_id);
    let wanted = crate::provider::claude::claude_role_mode(role_id, stage_kind);
    let note = (mode_id != wanted)
        .then(|| format!("the adapter did not offer {wanted} (using {mode_id})"));
    store.set_permission_note(tab_id, note)?;
    if let Some(notice) = notice {
        store.set_provider_notice(tab_id, Some(notice.to_string()))?;
    }
    Ok(())
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

    // Review H4 round 2: a chat start on a tab tagged as a copied Planner's
    // stage asks for plan mode; untagged, the copy keeps its role's mode.
    #[test]
    fn a_chat_start_on_a_planner_stage_asks_for_plan_mode() {
        use crate::pipelines::{register_for_test, unregister_for_test, PipelineDef};
        use crate::provider::claude::ClaudeProvider;
        use crate::provider::claude_config::{ConfigDirInfo, ConfigDirSource};
        use crate::store::StateStore;
        use crate::test_support::{role, TempDir};
        use std::sync::Mutex;
        let id = "copied_planner_chat_test";
        let def: PipelineDef = serde_json::from_value(serde_json::json!({
            "id": id, "name": "Copied planner",
            "stages": [{ "id": "plan", "roleId": "role_custom_planner", "title": "Planner copy", "kind": "planner" }]
        }))
        .unwrap();
        register_for_test(def);
        let dir = TempDir::new("chat_stage_mode");
        let mut store = StateStore::open_path(dir.join("state.json")).unwrap();
        let copy = role("role_custom_planner", "Planner copy");
        let tagged = store.create_draft_tab(&copy, "/tmp/p", true, None).unwrap();
        let chain = serde_json::from_value(serde_json::json!({
            "chainId": "ee_7", "kind": id, "step": 1, "total": 1
        }))
        .unwrap();
        store.set_tab_chain(&tagged, Some(chain), None).unwrap();
        let plain = store.create_draft_tab(&copy, "/tmp/p", true, None).unwrap();
        let store = Mutex::new(store);
        // Pinned inside the test: never the real ~/.claude.
        let provider = ClaudeProvider::with_config(
            &Default::default(),
            ConfigDirInfo {
                path: dir.join("claude").display().to_string(),
                display: "test".into(),
                source: ConfigDirSource::Setting,
                exists: false,
            },
        );
        assert!(provider.config.path.starts_with(&dir.path().display().to_string()));
        let on_stage = super::claude_start_mode(&provider, &store, Some(&tagged), &copy);
        let off_stage = super::claude_start_mode(&provider, &store, Some(&plain), &copy);
        unregister_for_test(id);
        assert_eq!(on_stage.unwrap(), "plan");
        assert_eq!(off_stage.unwrap(), "bypassPermissions");
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

    /// The Claude-only bookkeeping saves state.json. When that save fails
    /// after the agent connected, the start errors and the agent must not
    /// keep running: nothing else (Stop, quit) can reach it.
    #[test]
    fn a_start_that_fails_after_connecting_stops_the_agent() {
        use super::{record_claude_start, StartedAgent};
        use crate::acp::test_agent::FakeAgent;
        use crate::commands::session_flow_tests::{claude_scenario, connect};
        use crate::provider::ProviderId;
        use crate::store::{StateStore, TabSessionRef};
        use crate::test_support::{role, TempDir};
        use std::collections::HashMap;
        use std::sync::Mutex;
        use std::time::{Duration, Instant};

        // An agent that outlives its client's pipes: only a stop ends it.
        let mut scenario = claude_scenario(serde_json::json!([]));
        scenario["ignore_eof"] = serde_json::json!(true);
        let Some(agent) = FakeAgent::new("start_fails", &scenario)
        else {
            return;
        };
        let client = connect(&agent, ProviderId::Claude, "default");
        let process = client.process_handle();
        let provider = client.provider();
        let started = StartedAgent::new("tab-1", "role_implementer", client);

        let dir = TempDir::new("start_fails_state");
        let mut store = StateStore::open_path(dir.join("state.json")).unwrap();
        let role = role("role_implementer", "Implementer");
        let tab_id = store
            .promote_tab_to_running(
                None,
                &role,
                &HashMap::new(),
                "/w/app",
                "merged",
                TabSessionRef {
                    acp_session_id: "fake-session-1".into(),
                    mode_id: "default".into(),
                    injection_pending: false,
                    injected_at: None,
                },
                ProviderId::Claude,
            )
            .unwrap();
        // A directory where the save writes its temp file: every save fails.
        std::fs::create_dir(dir.join("state.json.tmp")).unwrap();
        let store = Mutex::new(store);

        let result = record_claude_start(
            &store,
            &provider,
            &tab_id,
            "role_implementer",
            "default",
            None,
        );
        assert!(result.is_err(), "the save should have failed");
        assert!(
            process.try_wait().unwrap().is_none(),
            "the agent runs until the start gives up"
        );
        drop(started);

        let deadline = Instant::now() + Duration::from_secs(5);
        while process.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let exited = process.try_wait().unwrap().is_some();
        process.kill_tree(); // never leave the fake behind, even when red
        assert!(exited, "the failed start left the agent process running");
    }

    /// A poisoned registry must not leak the agent: the lock is taken before
    /// the agent is handed over, so the error return still stops it.
    #[test]
    fn a_poisoned_registry_stops_the_agent_it_could_not_register() {
        use super::StartedAgent;
        use crate::acp::test_agent::FakeAgent;
        use crate::commands::dev_session::SessionRegistry;
        use crate::commands::session_flow_tests::{claude_scenario, connect};
        use crate::provider::ProviderId;
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        // An agent that outlives its client's pipes: only a stop ends it.
        let mut scenario = claude_scenario(serde_json::json!([]));
        scenario["ignore_eof"] = serde_json::json!(true);
        let Some(agent) = FakeAgent::new("poisoned_registry", &scenario)
        else {
            return;
        };
        let client = connect(&agent, ProviderId::Claude, "default");
        let process = client.process_handle();
        let started = StartedAgent::new("tab-1", "role_implementer", client);

        let registry = Arc::new(Mutex::new(SessionRegistry::new()));
        let poisoner = Arc::clone(&registry);
        let _ = std::thread::spawn(move || {
            let _held = poisoner.lock().unwrap();
            panic!("poison the registry");
        })
        .join();
        assert!(registry.is_poisoned());

        let result = started.into_live_locked(&registry, "tab-1");
        assert!(result.is_err(), "a poisoned registry cannot take the session");
        drop(result);

        let deadline = Instant::now() + Duration::from_secs(5);
        while process.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let exited = process.try_wait().unwrap().is_some();
        process.kill_tree(); // never leave the fake behind, even when red
        assert!(exited, "the unregistered agent was left running");
    }

    /// The guard only stops agents that never reached the registry: one that
    /// was handed over keeps running.
    #[test]
    fn a_successful_start_is_not_stopped_by_the_guard() {
        use super::StartedAgent;
        use crate::acp::test_agent::FakeAgent;
        use crate::commands::dev_session::SessionRegistry;
        use crate::commands::session_flow_tests::{claude_scenario, connect};
        use crate::provider::ProviderId;
        use std::sync::Mutex;
        use std::time::Duration;

        let mut scenario = claude_scenario(serde_json::json!([]));
        scenario["ignore_eof"] = serde_json::json!(true);
        let Some(agent) = FakeAgent::new("successful_start", &scenario)
        else {
            return;
        };
        let client = connect(&agent, ProviderId::Claude, "default");
        let process = client.process_handle();
        let started = StartedAgent::new("tab-1", "role_implementer", client);

        let registry = Mutex::new(SessionRegistry::new());
        let (guard, live) = started.into_live_locked(&registry, "tab-1").unwrap();
        drop(guard);
        // A wrongly armed guard sends SIGTERM at once on the proc-stop thread and
        // the fake exits at once on SIGTERM, so half a second is ample.
        std::thread::sleep(Duration::from_millis(500));
        let alive = process.try_wait().unwrap().is_none();
        process.kill_tree(); // never leave the fake behind, even when red
        drop(live);
        assert!(alive, "the guard stopped an agent that was handed over");
    }
}
