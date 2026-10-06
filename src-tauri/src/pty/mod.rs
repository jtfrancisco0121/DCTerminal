//! Embedded terminals. One PTY per id, streamed to the webview on a channel.

mod launch;
mod plans;
mod session;
mod shell;

use crate::cli_detect::{agent_missing_message, resolve_agent_executable};
use crate::paths::validate_working_folder;
use crate::pty::launch::{
    deliver_prompt, handoff_terminal_prompt, plain_agent_args, role_agent_command, RunMode,
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
    if launch == "cursor-cli" {
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
}

#[tauri::command]
pub fn shell_terminal_start(
    input: ShellTerminalInput,
    on_output: Channel<PtyPacket>,
    settings: State<Mutex<SettingsStore>>,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<TerminalStartResult, String> {
    let launch = if input.launch == "cursor-cli" {
        "cursor-cli"
    } else {
        "shell"
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
    let label = if launch == "cursor-cli" {
        format!("Cursor CLI · {}", folder_name(&input.cwd))
    } else {
        format!("Terminal · {}", folder_name(&input.cwd))
    };
    let configured = {
        let settings = settings.lock().map_err(|err| err.to_string())?;
        settings.terminal().shell.clone()
    };
    let resume_id = input
        .resume_session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string());
    if resume_id.is_some() && launch != "cursor-cli" {
        return Err("agent --resume is only used for a Cursor CLI terminal.".to_string());
    }
    if let Some(id) = &resume_id {
        let root = crate::cursor_history::cursor_data_dir().ok_or_else(|| {
            "Cursor's home folder was not found, so this chat cannot be opened.".to_string()
        })?;
        crate::cursor_history::cli_chat_required(&root, &cwd.display().to_string(), id)?;
    }
    let command = if launch == "cursor-cli" {
        let program = resolve_agent_executable().ok_or_else(agent_missing_message)?;
        let args = if let Some(id) = &resume_id {
            crate::cli_launch::resume_agent_args(id)?
        } else {
            plain_agent_args()
        };
        launch::ProgramArgs {
            program: program.display().to_string(),
            args,
        }
    } else {
        let resolved = resolve_shell_for_host(&configured);
        launch::ProgramArgs {
            program: resolved.program,
            args: resolved.args,
        }
    };
    let tab_id = {
        let mut store = store.lock().map_err(|err| err.to_string())?;
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
            },
        )?
    };
    let mut registry = registry.lock().map_err(|err| err.to_string())?;
    let pid = open_session(
        &mut registry,
        &tab_id,
        SpawnSpec {
            program: command.program,
            args: command.args,
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
    let program = resolve_agent_executable().ok_or_else(agent_missing_message)?;
    let tab_id = {
        let mut store = store.lock().map_err(|err| err.to_string())?;
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
            },
        )?
    };
    let file = prompt_file(&app, &tab_id)?;
    let delivery = deliver_prompt(&prompt, &file);
    if let Some(body) = &delivery.stored_body {
        std::fs::write(&file, body).map_err(|err| format!("prompt file: {err}"))?;
    }
    let command = role_agent_command(
        &program.display().to_string(),
        &role.id,
        mode,
        Some(&delivery.argument),
    );
    let mut registry = registry.lock().map_err(|err| err.to_string())?;
    let pid = open_session(
        &mut registry,
        &tab_id,
        SpawnSpec {
            program: command.program,
            args: command.args,
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
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    input: PtyOpenInput,
    on_output: Channel<PtyPacket>,
    settings: State<Mutex<SettingsStore>>,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<u32, String> {
    let cwd = validate_working_folder(&input.cwd).map_err(|err| err.message())?;
    let configured = {
        let settings = settings.lock().map_err(|err| err.to_string())?;
        settings.terminal().shell.clone()
    };
    let (program, mut args) = match input.launch.as_str() {
        "cursor-cli" => {
            let program = resolve_agent_executable().ok_or_else(agent_missing_message)?;
            let args = if let Some(id) = input
                .resume_session_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
            {
                let root = crate::cursor_history::cursor_data_dir().ok_or_else(|| {
                    "Cursor's home folder was not found, so this chat cannot be opened.".to_string()
                })?;
                crate::cursor_history::cli_chat_required(&root, &cwd.display().to_string(), id)?;
                crate::cli_launch::resume_agent_args(id)?
            } else {
                plain_agent_args()
            };
            (program.display().to_string(), args)
        }
        "role" => {
            let role_id = input.role_id.unwrap_or_default();
            let mode = {
                let settings = settings.lock().map_err(|err| err.to_string())?;
                RunMode::parse(&settings.run_mode_for(&role_id))
            };
            let program = resolve_agent_executable().ok_or_else(agent_missing_message)?;
            let prompt = input
                .prompt
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            let mut command_args = launch::role_terminal_flags(&role_id, mode);
            if let Some(text) = prompt {
                let file = prompt_file(&app, &input.id)?;
                let delivery = deliver_prompt(text, &file);
                if let Some(body) = &delivery.stored_body {
                    std::fs::write(&file, body).map_err(|err| format!("prompt file: {err}"))?;
                }
                command_args.push(delivery.argument);
            }
            (program.display().to_string(), command_args)
        }
        _ => {
            let resolved = resolve_shell_for_host(&configured);
            (resolved.program, resolved.args)
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

#[tauri::command]
pub fn terminal_plan_file(started_at_ms: u64) -> Result<Option<PlanFileInfo>, String> {
    let started = UNIX_EPOCH + Duration::from_millis(started_at_ms);
    let found = newest_plan_since(&cursor_plans_dir(), started)?;
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
