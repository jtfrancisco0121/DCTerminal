//! Embedded terminals. One PTY per id, streamed to the webview on a channel.

pub(crate) mod launch;
pub(crate) mod plans;
mod session;
mod shell;

use crate::paths::validate_working_folder;
use crate::provider::{
    provider_for_account, CursorProvider, Provider, ProviderId, TerminalKind, TerminalLaunch,
};
pub use crate::pty::launch::RunMode;
use crate::pty::launch::{
    deliver_prompt_limited, handoff_terminal_prompt, inline_prompt_limit, PromptDelivery,
};
use crate::pty::plans::{cursor_plans_dir, newest_plan_since};
use crate::pty::session::{PtyOutput, PtySession, SpawnSpec};
use crate::pty::shell::resolve_shell_for_host;
use crate::store::{
    tab_label, RoleSnapshot, SettingsStore, StateStore, TerminalSettings, TerminalTabDraft,
};
use crate::template::{merge_role_prompt, FieldError};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyPacket {
    pub kind: String,
    pub data: String,
    pub code: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResult {
    pub errors: Vec<FieldError>,
    pub tab_id: Option<String>,
    pub pid: Option<u32>,
    pub used_prompt_file: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFileInfo {
    pub path: String,
    pub name: String,
    pub modified_ms: u64,
    pub text: String,
}

pub struct PtyRegistry {
    sessions: HashMap<String, PtySession>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn kill(&mut self, id: &str) {
        self.sessions.remove(id);
    }

    pub fn kill_tab(&mut self, tab_id: &str) {
        let pane = format!("{tab_id}::pane");
        self.sessions.remove(tab_id);
        self.sessions.remove(&pane);
    }

    pub fn shutdown_all(&mut self) {
        self.sessions.clear();
    }
}

impl Drop for PtyRegistry {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

fn forward(output: Receiver<PtyOutput>, channel: Channel<PtyPacket>) {
    while let Ok(event) = output.recv() {
        let packet = match event {
            PtyOutput::Data(bytes) => PtyPacket {
                kind: "data".to_string(),
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
                code: None,
            },
            PtyOutput::Exit { code } => PtyPacket {
                kind: "exit".to_string(),
                data: String::new(),
                code,
            },
        };
        if channel.send(packet).is_err() {
            break;
        }
    }
}

fn open_session(
    registry: &mut PtyRegistry,
    id: &str,
    spec: SpawnSpec,
    on_output: Channel<PtyPacket>,
) -> Result<u32, String> {
    registry.kill(id);
    let mut session = PtySession::spawn(spec).map_err(|err| err.to_string())?;
    let pid = session.pid();
    if let Some(rx) = session.take_output() {
        thread::Builder::new()
            .name(format!("pty-fwd-{id}"))
            .spawn(move || forward(rx, on_output))
            .map_err(|err| err.to_string())?;
    }
    registry.sessions.insert(id.to_string(), session);
    Ok(pid)
}

fn store_prompt(
    app: &AppHandle,
    id: &str,
    program: &str,
    prompt: &str,
) -> Result<PromptDelivery, String> {
    let file = prompt_file(app, id)?;
    let delivery = deliver_prompt_limited(prompt, &file, inline_prompt_limit(program));
    if let Some(body) = &delivery.stored_body {
        std::fs::write(&file, body).map_err(|err| format!("prompt file: {err}"))?;
    }
    Ok(delivery)
}

fn prompt_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = crate::data_dir::app_data_dir(app)
        .path
        .join("terminal-prompts");
    std::fs::create_dir_all(&dir).map_err(|err| format!("prompt dir: {err}"))?;
    let safe: String = id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .take(80)
        .collect();
    let name = if safe.is_empty() {
        "prompt".to_string()
    } else {
        safe
    };
    Ok(dir.join(format!("{name}.txt")))
}

fn folder_name(cwd: &str) -> &str {
    let trimmed = cwd.trim().trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(trimmed)
}

fn shell_snapshot(launch: &str) -> (String, RoleSnapshot, String) {
    if launch == "claude-cli" {
        (
            "claude-cli".to_string(),
            RoleSnapshot {
                name: "Claude Code".to_string(),
                template_version: 0,
                mode: "agent".to_string(),
                injection: "none".to_string(),
            },
            "#d97757".to_string(),
        )
    } else if launch == "cursor-cli" {
        (
            "cursor-cli".to_string(),
            RoleSnapshot {
                name: "Cursor CLI".to_string(),
                template_version: 0,
                mode: "agent".to_string(),
                injection: "none".to_string(),
            },
            "#58a6ff".to_string(),
        )
    } else {
        (
            "terminal".to_string(),
            RoleSnapshot {
                name: "Terminal".to_string(),
                template_version: 0,
                mode: "shell".to_string(),
                injection: "none".to_string(),
            },
            "#2dd4bf".to_string(),
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellTerminalInput {
    pub tab_id: Option<String>,
    pub cwd: String,
    pub launch: String,
    pub cols: u16,
    pub rows: u16,
    /// CLI chat id. When set, the tab runs `agent --resume <id>`.
    #[serde(default)]
    pub resume_session_id: Option<String>,
    /// Window this terminal belongs to. Omitted means the original window.
    #[serde(default)]
    pub window_id: Option<String>,
}

fn provider_for_window(
    state: &StateStore,
    settings: &crate::store::settings_store::ProvidersSettings,
    id: ProviderId,
    tab_id: Option<&str>,
) -> crate::provider::SharedProvider {
    let account = state.account_for_tab(tab_id);
    provider_for_account(id, settings, Some(&account))
}

#[tauri::command]
pub fn shell_terminal_start(
    input: ShellTerminalInput,
    on_output: Channel<PtyPacket>,
    settings: State<Mutex<SettingsStore>>,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<TerminalStartResult, String> {
    let launch = match input.launch.as_str() {
        "cursor-cli" => "cursor-cli",
        "claude-cli" => "claude-cli",
        _ => "shell",
    };
    let cwd = match validate_working_folder(&input.cwd) {
        Ok(path) => path,
        Err(err) => {
            return Ok(TerminalStartResult {
                errors: vec![FieldError {
                    key: "cwd".to_string(),
                    message: err.message(),
                }],
                tab_id: None,
                pid: None,
                used_prompt_file: false,
            });
        }
    };
    let (role_id, snapshot, color) = shell_snapshot(launch);
    let label = match launch {
        "cursor-cli" => format!("Cursor CLI · {}", folder_name(&input.cwd)),
        "claude-cli" => format!("Claude Code · {}", folder_name(&input.cwd)),
        _ => format!("Terminal · {}", folder_name(&input.cwd)),
    };
    let configured = {
        let settings = settings.lock().map_err(|err| err.to_string())?;
        settings.terminal().shell.clone()
    };
    let mut resume_id = input
        .resume_session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string());
    let mut claude_notice: Option<String> = None;
    if resume_id.is_some() && launch != "cursor-cli" && launch != "claude-cli" {
        return Err("Resume is only used for a Cursor CLI or Claude Code terminal.".to_string());
    }
    if launch == "cursor-cli" {
        if let Some(id) = &resume_id {
            let root = crate::cursor_history::cursor_data_dir().ok_or_else(|| {
                "Cursor's home folder was not found, so this chat cannot be opened.".to_string()
            })?;
            crate::cursor_history::cli_chat_required(&root, &cwd.display().to_string(), id)?;
        }
    }
    if launch == "claude-cli" {
        let (sessions, current) = {
            let mut state = store.lock().map_err(|err| err.to_string())?;
            state.bind_window(input.window_id.as_deref());
            let settings = settings.lock().map_err(|err| err.to_string())?;
            let sessions = input
                .tab_id
                .as_deref()
                .and_then(|id| state.tab_by_id(id))
                .map(|tab| tab.sessions.clone())
                .unwrap_or_default();
            let provider = provider_for_window(
                &state,
                settings.providers(),
                ProviderId::Claude,
                input.tab_id.as_deref(),
            );
            let current = provider
                .config_dir()
                .map(|info| info.path)
                .unwrap_or_default();
            (sessions, current)
        };
        let (id, notice) = crate::provider::claude::decide_claude_resume(
            resume_id.as_deref(),
            &sessions,
            &current,
        );
        resume_id = id;
        claude_notice = notice;
    }
    let command = if launch == "claude-cli" {
        let provider = {
            let mut state = store.lock().map_err(|err| err.to_string())?;
            state.bind_window(input.window_id.as_deref());
            let settings = settings.lock().map_err(|err| err.to_string())?;
            provider_for_window(
                &state,
                settings.providers(),
                ProviderId::Claude,
                input.tab_id.as_deref(),
            )
        };
        let model = crate::models::model_for_tab_provider(
            &store,
            &settings,
            input.tab_id.as_deref(),
            "claude-cli",
            ProviderId::Claude,
        )?;
        let kind = match &resume_id {
            Some(id) => TerminalKind::Resume {
                session_id: id.clone(),
            },
            None => TerminalKind::Plain,
        };
        provider.terminal_command(&TerminalLaunch {
            kind,
            model: Some(model),
        })?
    } else if launch == "cursor-cli" {
        let model =
            crate::models::model_for_tab(&store, &settings, input.tab_id.as_deref(), "cursor-cli")?;
        let kind = match &resume_id {
            Some(id) => TerminalKind::Resume {
                session_id: id.clone(),
            },
            None => TerminalKind::Plain,
        };
        CursorProvider.terminal_command(&TerminalLaunch {
            kind,
            model: Some(model),
        })?
    } else {
        let resolved = resolve_shell_for_host(&configured);
        launch::ProgramArgs::new(resolved.program, resolved.args)
    };
    let tab_id = {
        let mut store = store.lock().map_err(|err| err.to_string())?;
        store.bind_window(input.window_id.as_deref());
        store.save_terminal_tab(
            input.tab_id.as_deref(),
            TerminalTabDraft {
                launch: launch.to_string(),
                cwd: cwd.display().to_string(),
                label,
                role_id,
                role_snapshot: snapshot,
                color,
                answers: {
                    let mut answers =
                        HashMap::from([("cwd".to_string(), cwd.display().to_string())]);
                    if let Some(id) = &resume_id {
                        answers.insert("resumeSessionId".to_string(), id.clone());
                    }
                    answers
                },
                merged_prompt: String::new(),
                startup_prompt_sent: false,
                provider: match launch {
                    "cursor-cli" => Some(ProviderId::Cursor),
                    "claude-cli" => Some(ProviderId::Claude),
                    _ => None,
                },
            },
        )?
    };
    if launch == "claude-cli" {
        let mut state = store.lock().map_err(|err| err.to_string())?;
        let settings = settings.lock().map_err(|err| err.to_string())?;
        let provider = provider_for_window(
            &state,
            settings.providers(),
            ProviderId::Claude,
            Some(&tab_id),
        );
        if let Some(dir) = provider.config_dir() {
            state.remember_claude_config(&tab_id, &dir.path)?;
        }
        if let Some(id) = &resume_id {
            state.remember_provider_session(&tab_id, ProviderId::Claude, Some(id.clone()))?;
        }
        if claude_notice.is_some() {
            state.set_provider_notice(&tab_id, claude_notice)?;
        }
    }
    let mut registry = registry.lock().map_err(|err| err.to_string())?;
    let pid = open_session(
        &mut registry,
        &tab_id,
        SpawnSpec {
            program: command.program,
            args: command.args,
            env: command.env,
            cwd,
            cols: input.cols,
            rows: input.rows,
        },
        on_output,
    )?;
    Ok(TerminalStartResult {
        errors: Vec::new(),
        tab_id: Some(tab_id),
        pid: Some(pid),
        used_prompt_file: false,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleTerminalInput {
    pub role_id: String,
    pub values: HashMap<String, String>,
    pub tab_id: Option<String>,
    pub handoff_plan: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Window this terminal belongs to. Omitted means the original window.
    #[serde(default)]
    pub window_id: Option<String>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn role_terminal_start(
    app: AppHandle,
    input: RoleTerminalInput,
    on_output: Channel<PtyPacket>,
    roles: State<Mutex<crate::store::RolesStore>>,
    settings: State<Mutex<SettingsStore>>,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<TerminalStartResult, String> {
    let role = {
        let roles = roles.lock().map_err(|err| err.to_string())?;
        roles
            .role_by_id(&input.role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {}", input.role_id))?
    };
    let preview = merge_role_prompt(&role, &input.values);
    if !preview.errors.is_empty() {
        return Ok(TerminalStartResult {
            errors: preview.errors,
            tab_id: None,
            pid: None,
            used_prompt_file: false,
        });
    }
    let merged = preview
        .merged
        .ok_or_else(|| "merge succeeded but produced no text".to_string())?;
    let cwd_raw = input
        .values
        .get("cwd")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "cwd is required".to_string())?;
    let cwd = match validate_working_folder(cwd_raw) {
        Ok(path) => path,
        Err(err) => {
            return Ok(TerminalStartResult {
                errors: vec![FieldError {
                    key: "cwd".to_string(),
                    message: err.message(),
                }],
                tab_id: None,
                pid: None,
                used_prompt_file: false,
            });
        }
    };
    let prompt = handoff_terminal_prompt(&merged.text, input.handoff_plan.as_deref().unwrap_or(""));
    let mode = {
        let settings = settings.lock().map_err(|err| err.to_string())?;
        RunMode::parse(&settings.run_mode_for(&role.id))
    };
    let provider = {
        let mut store = store.lock().map_err(|err| err.to_string())?;
        store.bind_window(input.window_id.as_deref());
        let settings = settings.lock().map_err(|err| err.to_string())?;
        provider_for_window(
            &store,
            settings.providers(),
            store.provider_for_start(input.tab_id.as_deref()),
            input.tab_id.as_deref(),
        )
    };
    let model = crate::models::model_for_tab_provider(
        &store,
        &settings,
        input.tab_id.as_deref(),
        &role.id,
        provider.id(),
    )?;
    let role_launch = |prompt: Option<String>| TerminalLaunch {
        kind: TerminalKind::Role {
            role_id: role.id.clone(),
            run_mode: mode,
            prompt,
        },
        model: Some(model.clone()),
    };
    // Fail before the tab is saved when the CLI is missing.
    let program = provider.terminal_command(&role_launch(None))?.program;
    let tab_id = {
        let mut store = store.lock().map_err(|err| err.to_string())?;
        store.bind_window(input.window_id.as_deref());
        let title_answers = input.values.clone();
        let label = tab_label(&role.name, &title_answers);
        store.save_terminal_tab(
            input.tab_id.as_deref(),
            TerminalTabDraft {
                launch: "role".to_string(),
                cwd: cwd.display().to_string(),
                label,
                role_id: role.id.clone(),
                role_snapshot: RoleSnapshot {
                    name: role.name.clone(),
                    template_version: role.template_version,
                    mode: role.default_mode.clone(),
                    injection: role.injection.clone(),
                },
                color: role.color.clone(),
                answers: input.values.clone(),
                merged_prompt: prompt.clone(),
                startup_prompt_sent: true,
                provider: Some(provider.id()),
            },
        )?
    };
    if provider.id() == ProviderId::Claude {
        let mut state = store.lock().map_err(|err| err.to_string())?;
        if let Some(dir) = provider.config_dir() {
            state.remember_claude_config(&tab_id, &dir.path)?;
        }
    }
    let delivery = store_prompt(&app, &tab_id, &program, &prompt)?;
    let command = provider.terminal_command(&role_launch(Some(delivery.argument.clone())))?;
    let mut registry = registry.lock().map_err(|err| err.to_string())?;
    let pid = open_session(
        &mut registry,
        &tab_id,
        SpawnSpec {
            program: command.program,
            args: command.args,
            env: command.env,
            cwd,
            cols: input.cols,
            rows: input.rows,
        },
        on_output,
    )?;
    Ok(TerminalStartResult {
        errors: Vec::new(),
        tab_id: Some(tab_id),
        pid: Some(pid),
        used_prompt_file: delivery.stored_body.is_some(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpenInput {
    pub id: String,
    pub cwd: String,
    pub launch: String,
    pub role_id: Option<String>,
    pub prompt: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// CLI chat id. When set, argv is `agent --resume <id>`.
    #[serde(default)]
    pub resume_session_id: Option<String>,
    /// Window this terminal belongs to. Omitted means the original window.
    #[serde(default)]
    pub window_id: Option<String>,
}

fn claude_terminal_resume(
    store: &Mutex<StateStore>,
    tab_id: &str,
    requested: Option<&str>,
    current_config: String,
) -> Result<Option<String>, String> {
    let mut state = store.lock().map_err(|err| err.to_string())?;
    let sessions = state
        .tab_by_id(tab_id)
        .map(|tab| tab.sessions.clone())
        .unwrap_or_default();
    let (id, notice) =
        crate::provider::claude::decide_claude_resume(requested, &sessions, &current_config);
    if notice.is_some() && state.tab_by_id(tab_id).is_some() {
        state.set_provider_notice(tab_id, notice)?;
    }
    Ok(id)
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    input: PtyOpenInput,
    on_output: Channel<PtyPacket>,
    settings: State<Mutex<SettingsStore>>,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<u32, String> {
    let cwd = validate_working_folder(&input.cwd).map_err(|err| err.message())?;
    let configured = {
        let settings = settings.lock().map_err(|err| err.to_string())?;
        settings.terminal().shell.clone()
    };
    let (program, mut args, env) = match input.launch.as_str() {
        "cursor-cli" => {
            let kind = if let Some(id) = input
                .resume_session_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
            {
                let root = crate::cursor_history::cursor_data_dir().ok_or_else(|| {
                    "Cursor's home folder was not found, so this chat cannot be opened.".to_string()
                })?;
                crate::cursor_history::cli_chat_required(&root, &cwd.display().to_string(), id)?;
                TerminalKind::Resume {
                    session_id: id.to_string(),
                }
            } else {
                TerminalKind::Plain
            };
            let model =
                crate::models::model_for_tab(&store, &settings, Some(&input.id), "cursor-cli")?;
            let command = CursorProvider.terminal_command(&TerminalLaunch {
                kind,
                model: Some(model),
            })?;
            (command.program, command.args, command.env)
        }
        "claude-cli" => {
            let provider = {
                let mut state = store.lock().map_err(|err| err.to_string())?;
                state.bind_window(input.window_id.as_deref());
                let settings = settings.lock().map_err(|err| err.to_string())?;
                provider_for_window(&state, settings.providers(), ProviderId::Claude, Some(&input.id))
            };
            let resume = claude_terminal_resume(
                &store,
                &input.id,
                input.resume_session_id.as_deref(),
                provider
                    .config_dir()
                    .map(|info| info.path)
                    .unwrap_or_default(),
            )?;
            let model = crate::models::model_for_tab_provider(
                &store,
                &settings,
                Some(&input.id),
                "claude-cli",
                ProviderId::Claude,
            )?;
            let kind = match resume {
                Some(id) => TerminalKind::Resume { session_id: id },
                None => TerminalKind::Plain,
            };
            let mut command = provider.terminal_command(&TerminalLaunch {
                kind,
                model: Some(model),
            })?;
            let resuming = input
                .resume_session_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty());
            if !resuming {
                if let Some(text) = input
                    .prompt
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    let delivery = store_prompt(&app, &input.id, &command.program, text)?;
                    command.args.push(delivery.argument);
                }
            }
            (command.program, command.args, command.env)
        }
        "role" => {
            let role_id = input.role_id.unwrap_or_default();
            let mode = {
                let settings = settings.lock().map_err(|err| err.to_string())?;
                RunMode::parse(&settings.run_mode_for(&role_id))
            };
            let provider = {
                let mut store = store.lock().map_err(|err| err.to_string())?;
                store.bind_window(input.window_id.as_deref());
                let settings = settings.lock().map_err(|err| err.to_string())?;
                let id = store
                    .tab_by_id(&input.id)
                    .map(|tab| ProviderId::resolve(tab.provider))
                    .unwrap_or(ProviderId::LEGACY);
                provider_for_window(&store, settings.providers(), id, Some(&input.id))
            };
            let model = crate::models::model_for_tab_provider(
                &store,
                &settings,
                Some(&input.id),
                &role_id,
                provider.id(),
            )?;
            let role_launch = |prompt: Option<String>| TerminalLaunch {
                kind: TerminalKind::Role {
                    role_id: role_id.clone(),
                    run_mode: mode,
                    prompt,
                },
                model: Some(model.clone()),
            };
            let program = provider.terminal_command(&role_launch(None))?.program;
            let prompt = input
                .prompt
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            let argument = match prompt {
                Some(text) => Some(store_prompt(&app, &input.id, &program, text)?.argument),
                None => None,
            };
            let command = provider.terminal_command(&role_launch(argument))?;
            (command.program, command.args, command.env)
        }
        _ => {
            let resolved = resolve_shell_for_host(&configured);
            (resolved.program, resolved.args, Vec::new())
        }
    };
    let resuming = input
        .resume_session_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty());
    if input.launch == "cursor-cli" && !resuming {
        if let Some(text) = input
            .prompt
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            args.push(text.to_string());
        }
    }
    let mut registry = registry.lock().map_err(|err| err.to_string())?;
    open_session(
        &mut registry,
        &input.id,
        SpawnSpec {
            program,
            args,
            env,
            cwd,
            cols: input.cols,
            rows: input.rows,
        },
        on_output,
    )
}

#[tauri::command]
pub fn pty_write(
    id: String,
    data: String,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<(), String> {
    let registry = registry.lock().map_err(|err| err.to_string())?;
    let session = registry
        .sessions
        .get(&id)
        .ok_or_else(|| format!("no terminal: {id}"))?;
    session
        .write(data.as_bytes())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<(), String> {
    let registry = registry.lock().map_err(|err| err.to_string())?;
    let session = registry
        .sessions
        .get(&id)
        .ok_or_else(|| format!("no terminal: {id}"))?;
    session.resize(cols, rows).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn pty_kill(id: String, registry: State<Mutex<PtyRegistry>>) -> Result<(), String> {
    let mut registry = registry.lock().map_err(|err| err.to_string())?;
    registry.kill(&id);
    Ok(())
}

#[tauri::command]
pub fn get_terminal_settings(
    settings: State<Mutex<SettingsStore>>,
) -> Result<TerminalSettings, String> {
    let settings = settings.lock().map_err(|err| err.to_string())?;
    Ok(settings.terminal().clone())
}

#[tauri::command]
pub fn set_terminal_settings(
    terminal: TerminalSettings,
    settings: State<Mutex<SettingsStore>>,
) -> Result<TerminalSettings, String> {
    let mut settings = settings.lock().map_err(|err| err.to_string())?;
    settings.set_terminal(terminal)?;
    Ok(settings.terminal().clone())
}

/// Newest plan file written since the terminal started, read-only from the
/// tab's provider: `~/.cursor/plans` (Cursor) or `<configDir>/plans` (Claude).
#[tauri::command]
pub fn terminal_plan_file(
    started_at_ms: u64,
    tab_id: Option<String>,
    settings: State<Mutex<SettingsStore>>,
    store: State<Mutex<StateStore>>,
) -> Result<Option<PlanFileInfo>, String> {
    let started = UNIX_EPOCH + Duration::from_millis(started_at_ms);
    let dir = {
        let store = store.lock().map_err(|err| err.to_string())?;
        let settings = settings.lock().map_err(|err| err.to_string())?;
        let id = tab_id
            .as_deref()
            .and_then(|id| store.tab_by_id(id))
            .map(|tab| ProviderId::resolve(tab.provider))
            .unwrap_or(ProviderId::LEGACY);
        provider_for_window(&store, settings.providers(), id, tab_id.as_deref())
            .plans_dir()
            .unwrap_or_else(cursor_plans_dir)
    };
    let found = newest_plan_since(&dir, started)?;
    Ok(found.map(|plan| PlanFileInfo {
        path: plan.path.display().to_string(),
        name: plan.name,
        modified_ms: plan
            .modified
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
        text: plan.text,
    }))
}

pub fn kill_tab_pty(registry: &Mutex<PtyRegistry>, tab_id: &str) {
    if let Ok(mut registry) = registry.lock() {
        registry.kill_tab(tab_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_tile_is_its_own_launch() {
        let (role_id, snapshot, _) = shell_snapshot("claude-cli");
        assert_eq!(role_id, "claude-cli");
        assert_eq!(snapshot.name, "Claude Code");
        let (role_id, snapshot, _) = shell_snapshot("cursor-cli");
        assert_eq!(role_id, "cursor-cli");
        assert_eq!(snapshot.name, "Cursor CLI");
        assert_eq!(shell_snapshot("shell").0, "terminal");
    }
}
