//! Embedded terminals. One PTY per id, streamed to the webview on a channel.
//!
//! Pipeline stages the run actor starts are hidden (V5, D25 to D27): they
//! run at 120×40 with no view, keep their newest 2 MB of output in a ring
//! buffer ([`DetachedOutput`]), and a view that attaches (Watch) gets the
//! ring replayed, then the live stream, then one resize so the program
//! redraws. Closing a view (`pty_detach`) never stops the stage. A bridged
//! stage on autopilot takes keystrokes only while it needs you or you took
//! it over ([`StageInput`]); the run actor's own pastes are not gated.

pub(crate) mod launch;
pub(crate) mod plans;
pub(crate) mod session;
mod shell;

use crate::paths::validate_working_folder;
use crate::process_tree::STOP_GRACE;
use crate::provider::{
    new_claude_session_id, provider_for_account, CursorProvider, Provider, ProviderId,
    TerminalKind, TerminalLaunch,
};
pub use crate::pty::launch::RunMode;
use crate::pty::launch::{
    deliver_prompt_limited, handoff_terminal_prompt, inline_prompt_limit, PromptDelivery,
};
use crate::pty::plans::{cursor_plans_dir, terminal_plan};
use crate::pty::session::{PtyOutput, PtySession, SpawnSpec};
use crate::pty::shell::resolve_shell_for_host;
use crate::store::{
    tab_label, RoleSnapshot, SettingsStore, StateStore, TerminalSettings, TerminalTabDraft,
};
use crate::template::{merge_role_prompt_with, FieldError};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

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
    pub truncated: bool,
}

pub struct PtyRegistry {
    sessions: HashMap<String, PtySession>,
    /// Claude session id per live PTY (the `<id>.jsonl` it writes).
    claude_sessions: HashMap<String, String>,
    /// The latest open per id. A `kill` meanwhile cancels it; a newer open
    /// of the same id supersedes it.
    opening: HashMap<String, u64>,
    next_open: u64,
    /// A replaced program that may still be stopping, so every open of that
    /// id waits for it, not only the one that replaced it.
    stopping: HashMap<String, crate::process_tree::PtyGroup>,
    /// Terminals the run actor started with no view (V3): their output, kept
    /// until a view attaches (`pty_open` of that id).
    detached: HashMap<String, Arc<Mutex<DetachedOutput>>>,
    /// Every other terminal's view, so a stage the run actor resumes (V4)
    /// keeps the view it was opened with.
    views: HashMap<String, ViewOutput>,
    /// Bridged pipeline stages (ADR-015): the stage folder whose `mode`
    /// file says whether you may type into the terminal (V5, D27).
    stage_dirs: HashMap<String, PathBuf>,
    /// Bridged stages that need you now (a permission dialog, a question):
    /// typing is allowed while they do (V5, D27).
    needs: HashSet<String>,
}

/// A view a terminal streams to ([`forward`]).
#[derive(Clone)]
struct ViewOutput {
    channel: Channel<PtyPacket>,
    state: Arc<Mutex<ViewState>>,
}

#[derive(Default)]
struct ViewState {
    /// The program's exit was sent to the view.
    exited: bool,
    /// The run actor resumed the terminal: the old program's exit is not sent.
    quiet: bool,
}

/// Output of a terminal the run actor started with no view (a hidden
/// stage, V5, D25): the newest [`DETACHED_BUFFER`] bytes it printed stay in
/// a ring buffer whether or not a view is attached. A view that attaches
/// (Watch) gets the whole ring, then everything live; one that closes
/// (`pty_detach`) or goes away (a reload) leaves the program running, and
/// the next view replays the ring again.
pub(crate) struct DetachedOutput {
    channel: Option<Channel<PtyPacket>>,
    buffer: VecDeque<u8>,
    exit: Option<Option<i32>>,
    /// Closed or replaced: its exit is nobody's news.
    replaced: bool,
    /// The terminal's size now: 120×40 (D26) until a view resizes it.
    size: (u16, u16),
}

impl DetachedOutput {
    fn new(view: Option<Channel<PtyPacket>>, size: (u16, u16)) -> Self {
        Self {
            channel: view,
            buffer: VecDeque::new(),
            exit: None,
            replaced: false,
            size,
        }
    }

    /// Keep `bytes`, dropping the oldest past [`DETACHED_BUFFER`].
    fn keep(&mut self, bytes: &[u8]) {
        self.buffer.extend(bytes);
        if self.buffer.len() > DETACHED_BUFFER {
            let drop = self.buffer.len() - DETACHED_BUFFER;
            self.buffer.drain(..drop);
        }
    }
}

/// Most bytes a hidden stage keeps for the views that attach later (D25).
const DETACHED_BUFFER: usize = 2 * 1024 * 1024;

/// The sizes a view attaching at `view` sends a terminal now at `current`,
/// so its program redraws the whole screen once (D25): one resize when the
/// sizes differ. The same size would send no SIGWINCH, so it steps one row
/// away and back.
fn redraw_sizes(current: (u16, u16), view: (u16, u16)) -> Vec<(u16, u16)> {
    let view = (view.0.max(1), view.1.max(1));
    if current != view {
        return vec![view];
    }
    let step = if view.1 > 1 { view.1 - 1 } else { 2 };
    vec![(view.0, step), view]
}

/// Whether you may type into a terminal now (V5, D27). A bridged stage on
/// autopilot is watch-only, so you and autopilot never drive it at once,
/// except while it needs you (a permission dialog or a question) or you
/// have taken it over. Every other terminal, and a stage whose run has
/// autopilot off, takes keystrokes as usual.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageInput {
    /// Keystrokes go through.
    pub open: bool,
    /// The terminal is a bridged pipeline stage.
    pub stage: bool,
    /// You took the stage over (its `mode` file says `takeover`).
    pub taken_over: bool,
    /// It needs you now.
    pub needs: bool,
}

/// [`StageInput`] from the stage's mode (`None`: not a bridged stage) and
/// whether it needs you.
pub(crate) fn stage_input(mode: Option<crate::bridge::StageMode>, needs: bool) -> StageInput {
    use crate::bridge::StageMode;
    let open = match mode {
        None | Some(StageMode::Manual) | Some(StageMode::Takeover) => true,
        Some(StageMode::Autopilot) => needs,
    };
    StageInput {
        open,
        stage: mode.is_some(),
        taken_over: mode == Some(StageMode::Takeover),
        needs,
    }
}

/// What a keystroke into a watch-only stage hears.
pub(crate) const WATCH_ONLY: &str =
    "Autopilot drives this stage, so its terminal is read-only. Take it over to type, or wait until it needs you.";

/// How long a stage the run actor resumes gets to exit on SIGTERM before it
/// is killed (D17): Claude finishes its session log first (T11: 0.6 s).
pub(crate) const RESUME_STOP_GRACE: Duration = Duration::from_secs(10);

/// Ctrl+U: clears the input line. After an Esc, Claude Code puts the
/// interrupted prompt back in the input box (D40), so a paste clears it first.
const CLEAR_INPUT: &[u8] = b"\x15";

fn data_packet(bytes: &[u8]) -> PtyPacket {
    PtyPacket {
        kind: "data".to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        code: None,
    }
}

fn exit_packet(code: Option<i32>) -> PtyPacket {
    PtyPacket {
        kind: "exit".to_string(),
        data: String::new(),
        code,
    }
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            claude_sessions: HashMap::new(),
            opening: HashMap::new(),
            next_open: 0,
            stopping: HashMap::new(),
            detached: HashMap::new(),
            views: HashMap::new(),
            stage_dirs: HashMap::new(),
            needs: HashSet::new(),
        }
    }

    fn forget_detached(&mut self, id: &str) {
        if let Some(output) = self.detached.remove(id) {
            if let Ok(mut output) = output.lock() {
                output.replaced = true;
            }
        }
    }

    /// The terminal's program is running.
    pub fn running(&self, id: &str) -> bool {
        self.sessions.get(id).is_some_and(|session| session.group().running())
    }

    /// Paste `text` into the terminal `id` and press Enter, as the scratch
    /// pad's Send does (`src/terminal/paste.ts`): one bracketed paste, then
    /// CR. The input box is cleared first (D40): an interrupted prompt Claude
    /// put back there would otherwise be sent along.
    pub fn paste(&self, id: &str, text: &str) -> Result<(), String> {
        let session = self.sessions.get(id).ok_or_else(|| format!("no terminal: {id}"))?;
        session.write(&paste_bytes(text)).map_err(|err| err.to_string())
    }

    /// Close the terminal `id`. A replaced program it was still stopping
    /// is forgotten too; its control thread kills it within the grace.
    pub fn kill(&mut self, id: &str) {
        self.forget_detached(id);
        self.views.remove(id);
        self.stage_dirs.remove(id);
        self.needs.remove(id);
        self.sessions.remove(id);
        self.claude_sessions.remove(id);
        self.opening.remove(id);
        self.stopping.remove(id);
    }

    pub fn kill_tab(&mut self, tab_id: &str) {
        let pane = format!("{tab_id}::pane");
        self.kill(tab_id);
        self.kill(&pane);
    }

    pub fn shutdown_all(&mut self) {
        let ids: Vec<String> = self.detached.keys().cloned().collect();
        for id in ids {
            self.forget_detached(&id);
        }
        self.views.clear();
        self.stage_dirs.clear();
        self.needs.clear();
        self.sessions.clear();
        self.claude_sessions.clear();
        self.opening.clear();
        self.stopping.clear();
    }

    /// App exit, step 1: every terminal's running process group, so the
    /// caller can SIGTERM them and wait without holding this lock. A
    /// terminal whose program already exited and was reaped is skipped: its
    /// pid may now lead an unrelated group. A replaced program that is still
    /// stopping (a reopen is waiting on it) is included.
    pub fn running_groups(&self) -> Vec<crate::process_tree::PtyGroup> {
        self.sessions
            .values()
            .map(PtySession::group)
            .chain(self.stopping.values().cloned())
            .filter(|group| group.running())
            .collect()
    }

    /// Terminals whose program is still running (what a quit would stop).
    /// Windows cannot tell, so every open terminal counts there.
    pub fn live_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|session| cfg!(not(unix)) || session.group().running())
            .count()
    }

    /// How long the terminal `id` has printed nothing; `None` when it is not open.
    pub fn quiet_for(&self, id: &str) -> Option<Duration> {
        self.sessions.get(id).map(PtySession::quiet_for)
    }

    pub fn claude_session(&self, id: &str) -> Option<&str> {
        self.claude_sessions.get(id).map(String::as_str)
    }

    /// A bridged stage needs you (or no longer does): typing is allowed
    /// while it does (D27). Ignored for a terminal that is not a stage.
    pub fn set_needs(&mut self, id: &str, needs: bool) {
        if needs && self.stage_dirs.contains_key(id) {
            self.needs.insert(id.to_string());
        } else {
            self.needs.remove(id);
        }
    }

    /// What decides whether you may type into `id`: its stage folder (when
    /// it is a bridged stage) and whether it needs you. The `mode` file is
    /// read by the caller, without this lock held.
    fn input_gate(&self, id: &str) -> (Option<PathBuf>, bool) {
        (self.stage_dirs.get(id).cloned(), self.needs.contains(id))
    }

    fn pin_claude_session(&mut self, id: &str, session_id: Option<String>) {
        if let Some(session_id) = session_id {
            self.claude_sessions.insert(id.to_string(), session_id);
        }
    }
}

/// Persist the Claude session a terminal tab writes, so it survives a restart.
fn remember_terminal_session(
    store: &Mutex<StateStore>,
    tab_id: &str,
    session_id: Option<&str>,
) -> Result<(), String> {
    let Some(session_id) = session_id else {
        return Ok(());
    };
    let mut state = store.lock().map_err(|err| err.to_string())?;
    if state.tab_by_id(tab_id).is_some() {
        state.remember_claude_terminal_session(tab_id, session_id)?;
    }
    Ok(())
}

impl Drop for PtyRegistry {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

fn forward(output: Receiver<PtyOutput>, view: ViewOutput) {
    while let Ok(event) = output.recv() {
        let packet = match event {
            PtyOutput::Data(bytes) => data_packet(&bytes),
            PtyOutput::Exit { code } => {
                let Ok(mut state) = view.state.lock() else {
                    return;
                };
                if !state.quiet {
                    state.exited = true;
                    let _ = view.channel.send(exit_packet(code));
                }
                return;
            }
        };
        if view.channel.send(packet).is_err() {
            break;
        }
    }
}

/// [`forward`] for a terminal with no view yet (see [`DetachedOutput`]).
/// `on_exit` hears the program's exit unless the terminal was closed or
/// replaced first.
fn forward_detached(output: Receiver<PtyOutput>, sink: Arc<Mutex<DetachedOutput>>, on_exit: OnExit) {
    while let Ok(event) = output.recv() {
        let Ok(mut out) = sink.lock() else {
            return;
        };
        match event {
            PtyOutput::Data(bytes) => {
                out.keep(&bytes);
                let sent = out.channel.as_ref().is_some_and(|channel| channel.send(data_packet(&bytes)).is_ok());
                if !sent {
                    out.channel = None;
                }
            }
            PtyOutput::Exit { code } => {
                out.exit = Some(code);
                if let Some(channel) = out.channel.as_ref() {
                    let _ = channel.send(exit_packet(code));
                }
                let replaced = out.replaced;
                drop(out);
                if !replaced {
                    on_exit(code);
                }
                return;
            }
        }
    }
}

/// Called once with a detached terminal's exit code.
pub(crate) type OnExit = Box<dyn FnOnce(Option<i32>) + Send>;

/// Where a terminal's output goes.
enum Output {
    /// A view's channel (every terminal the frontend opens).
    View(Channel<PtyPacket>),
    /// The run actor's stages: to `view` when one is attached (a resumed
    /// stage keeps its old process's view, V4), else kept for a view that
    /// attaches later.
    Detached { on_exit: OnExit, view: Option<Channel<PtyPacket>> },
}

/// A view attaching to a terminal the run actor started (`pty_open` with
/// `attach`; Watch, V5): the whole ring buffer (D25), then everything live.
/// It replaces a view attached before (one a reload left behind). With
/// `size` (the view's), the terminal is then resized once so its program
/// redraws the screen cleanly ([`redraw_sizes`]). `None` when `id` is not
/// such a terminal; `pty_open` then starts one as usual.
fn attach_detached(
    registry: &Mutex<PtyRegistry>,
    id: &str,
    channel: &Channel<PtyPacket>,
    size: Option<(u16, u16)>,
) -> Result<Option<u32>, String> {
    let (pid, handle, steps) = {
        let registry = registry.lock().map_err(|err| err.to_string())?;
        let (Some(sink), Some(session)) = (registry.detached.get(id), registry.sessions.get(id)) else {
            return Ok(None);
        };
        let mut out = sink.lock().map_err(|err| err.to_string())?;
        // Sent under the lock, so no live packet goes ahead of the replay.
        if !out.buffer.is_empty() {
            channel.send(data_packet(out.buffer.make_contiguous())).map_err(|err| err.to_string())?;
        }
        if let Some(code) = out.exit {
            let _ = channel.send(exit_packet(code));
        }
        out.channel = Some(channel.clone());
        let steps = match size {
            Some(view) if out.exit.is_none() => redraw_sizes(out.size, view),
            _ => Vec::new(),
        };
        if let Some(last) = steps.last() {
            out.size = *last;
        }
        (session.pid(), session.handle(), steps)
    };
    // Queued, never waited on (like `pty_resize`).
    for (cols, rows) in steps {
        let _ = handle.resize(cols, rows);
    }
    Ok(Some(pid))
}

/// A Watch view closed (`pty_detach`): the terminal the run actor started
/// stops streaming to it and keeps running, its output kept in the ring
/// buffer for the next view. False when `id` is not such a terminal (one a
/// view started streams to that view for as long as it runs).
fn detach_view(registry: &Mutex<PtyRegistry>, id: &str) -> Result<bool, String> {
    let registry = registry.lock().map_err(|err| err.to_string())?;
    let Some(sink) = registry.detached.get(id) else {
        return Ok(false);
    };
    sink.lock().map_err(|err| err.to_string())?.channel = None;
    Ok(true)
}

/// Whether you may type into `id` now ([`StageInput`]). The stage's `mode`
/// file is read with no lock held.
fn input_state(registry: &Mutex<PtyRegistry>, id: &str) -> Result<StageInput, String> {
    let (stage_dir, needs) = registry.lock().map_err(|err| err.to_string())?.input_gate(id);
    let mode = stage_dir.map(|dir| crate::bridge::folder::read_mode(&dir));
    Ok(stage_input(mode, needs))
}

/// True while the app theme is a light one. Claude Code reads COLORFGBG to pick
/// its own light or dark palette (theme "auto"), so a Claude terminal is told
/// the app theme through that variable. Nothing is written to ~/.claude*.
static LIGHT_SCHEME: AtomicBool = AtomicBool::new(false);

fn claude_scheme_env() -> (String, String) {
    let value = if LIGHT_SCHEME.load(Ordering::Relaxed) {
        "0;15"
    } else {
        "15;0"
    };
    ("COLORFGBG".to_string(), value.to_string())
}

#[tauri::command]
pub fn pty_set_scheme(light: bool) {
    LIGHT_SCHEME.store(light, Ordering::Relaxed);
}

/// Start the terminal `id`, replacing the one running under that id.
///
/// Blocking: runs on a `spawn_blocking` thread, never the UI thread or a
/// Tokio worker. A replaced program is stopped first, and the new one
/// starts only once its group has exited (at most [`STOP_GRACE`] plus a
/// margin), so a Claude resumed with the same session id never writes
/// `<id>.jsonl` alongside the old one. The registry lock is not held during
/// that wait. Closing the terminal meanwhile cancels the open (an error); a
/// newer open of the same id supersedes it (`Ok(None)`, nothing started).
fn open_session(
    registry: &Mutex<PtyRegistry>,
    id: &str,
    spec: SpawnSpec,
    claude_session: Option<String>,
    on_output: Channel<PtyPacket>,
) -> Result<Option<u32>, String> {
    open_session_to(registry, id, spec, claude_session, None, Output::View(on_output))
}

/// [`open_session`] with its output going to `output`. `stage_dir`: the
/// bridged stage the terminal runs (see [`StageInput`]).
fn open_session_to(
    registry: &Mutex<PtyRegistry>,
    id: &str,
    spec: SpawnSpec,
    claude_session: Option<String>,
    stage_dir: Option<PathBuf>,
    output: Output,
) -> Result<Option<u32>, String> {
    let size = (spec.cols, spec.rows);
    let (token, stopping) = {
        let mut registry = registry.lock().map_err(|err| err.to_string())?;
        registry.claude_sessions.remove(id);
        registry.forget_detached(id);
        registry.views.remove(id);
        registry.needs.remove(id);
        registry.next_open += 1;
        let token = registry.next_open;
        registry.opening.insert(id.to_string(), token);
        let stopping = match registry.sessions.remove(id) {
            Some(old) => {
                let group = old.group();
                // Dropping the session asks its control thread to stop the program.
                drop(old);
                registry.stopping.insert(id.to_string(), group.clone());
                Some(group)
            }
            None => registry.stopping.get(id).cloned(),
        };
        (token, stopping)
    };
    if let Some(group) = stopping {
        wait_until_stopped(&group);
    }
    let mut registry = registry.lock().map_err(|err| err.to_string())?;
    match registry.opening.get(id) {
        Some(latest) if *latest == token => {}
        // A newer open of this id took over (it may have finished already).
        Some(_) => return Ok(None),
        None if registry.sessions.contains_key(id) => return Ok(None),
        None => return Err("The terminal was closed while it was starting.".to_string()),
    }
    registry.opening.remove(id);
    registry.stopping.remove(id);
    let mut session = PtySession::spawn(spec).map_err(|err| err.to_string())?;
    let pid = session.pid();
    if let Some(rx) = session.take_output() {
        let name = format!("pty-fwd-{id}");
        match output {
            Output::View(channel) => {
                let view = ViewOutput {
                    channel,
                    state: Arc::new(Mutex::new(ViewState::default())),
                };
                registry.views.insert(id.to_string(), view.clone());
                thread::Builder::new().name(name).spawn(move || forward(rx, view))
            }
            Output::Detached { on_exit, view } => {
                let sink = Arc::new(Mutex::new(DetachedOutput::new(view, size)));
                registry.detached.insert(id.to_string(), sink.clone());
                thread::Builder::new().name(name).spawn(move || forward_detached(rx, sink, on_exit))
            }
        }
        .map_err(|err| err.to_string())?;
    }
    registry.sessions.insert(id.to_string(), session);
    match stage_dir {
        Some(dir) => registry.stage_dirs.insert(id.to_string(), dir),
        None => registry.stage_dirs.remove(id),
    };
    registry.pin_claude_session(id, claude_session);
    Ok(Some(pid))
}

/// Resume a stage the run actor started (V4, D17): stop its program with
/// SIGTERM, wait up to `grace` for it to exit, SIGKILL it if it has not,
/// then start `spec` (the same session, `--resume`) under the same id. The
/// old program's exit is nobody's news, and a view attached to it (a stage
/// the actor started, or one you started, like the Planner) stays attached
/// and streams the new one. A view that already saw the old one
/// exit attaches again (`pty_open`). Blocking; the registry lock is not
/// held during the wait.
fn replace_detached(
    registry: &Mutex<PtyRegistry>,
    id: &str,
    spec: SpawnSpec,
    claude_session: Option<String>,
    on_exit: OnExit,
    grace: Duration,
) -> Result<Option<u32>, String> {
    let (group, view, stage_dir) = {
        let registry = registry.lock().map_err(|err| err.to_string())?;
        let group = registry.sessions.get(id).map(|session| session.group());
        let stage_dir = registry.stage_dirs.get(id).cloned();
        // A view that heard the old program exit shows it ended; it attaches anew.
        let view = match (registry.detached.get(id), registry.views.get(id)) {
            (Some(sink), _) => {
                let mut out = sink.lock().map_err(|err| err.to_string())?;
                out.replaced = true;
                let view = out.channel.take();
                view.filter(|_| out.exit.is_none())
            }
            // A stage you started yourself (the Planner) streams to its view.
            (None, Some(view)) => {
                let mut state = view.state.lock().map_err(|err| err.to_string())?;
                state.quiet = !state.exited;
                state.quiet.then(|| view.channel.clone())
            }
            (None, None) => None,
        };
        (group, view, stage_dir)
    };
    if let Some(group) = group {
        group.terminate();
        let deadline = std::time::Instant::now() + grace;
        while group.running() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        if group.running() {
            group.kill();
        }
    }
    open_session_to(registry, id, spec, claude_session, stage_dir, Output::Detached { on_exit, view })
}

/// Wait until a replaced terminal's program group has exited. Its control
/// thread kills it after [`STOP_GRACE`]; the margin covers that last step.
fn wait_until_stopped(group: &crate::process_tree::PtyGroup) {
    let deadline = std::time::Instant::now() + STOP_GRACE + Duration::from_millis(500);
    while group.running() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
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

/// Terminal tabs add their folder to Recent, like chat tabs do.
fn remember_folder(projects: &State<Mutex<crate::store::ProjectsStore>>, folder: &str) {
    if let Ok(mut projects) = projects.lock() {
        projects.remember(folder, &chrono::Utc::now().to_rfc3339());
        if let Err(err) = projects.save() {
            eprintln!("DCTerminal: could not save recent folder ({err})");
        }
    }
}

/// Async with the work on a blocking thread: replacing a running terminal
/// waits for its program to exit (see `open_session`).
#[tauri::command]
pub async fn shell_terminal_start(
    app: AppHandle,
    input: ShellTerminalInput,
    on_output: Channel<PtyPacket>,
) -> Result<TerminalStartResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        shell_terminal_start_blocking(
            input,
            on_output,
            app.state(),
            app.state(),
            app.state(),
            app.state(),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

fn shell_terminal_start_blocking(
    input: ShellTerminalInput,
    on_output: Channel<PtyPacket>,
    settings: State<Mutex<SettingsStore>>,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
    projects: State<Mutex<crate::store::ProjectsStore>>,
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
    let recent_folder = cwd.display().to_string();
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
    let claude_session = (launch == "claude-cli")
        .then(|| resume_id.clone().unwrap_or_else(new_claude_session_id));
    let mut command = if launch == "claude-cli" {
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
            session_id: claude_session.clone(),
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
            session_id: None,
        })?
    } else {
        let resolved = resolve_shell_for_host(&configured);
        launch::ProgramArgs::new(resolved.program, resolved.args)
    };
    if launch == "claude-cli" {
        command.env.push(claude_scheme_env());
    }
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
        if let Some(id) = &claude_session {
            state.remember_claude_terminal_session(&tab_id, id)?;
        }
    }
    let pid = open_session(
        &registry,
        &tab_id,
        SpawnSpec {
            program: command.program,
            args: command.args,
            env: command.env,
            cwd,
            cols: input.cols,
            rows: input.rows,
        },
        claude_session,
        on_output,
    )?;
    remember_folder(&projects, &recent_folder);
    Ok(TerminalStartResult {
        errors: Vec::new(),
        tab_id: Some(tab_id),
        pid,
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
    /// Provider to launch as (a hand-off's new tab keeps its source's).
    /// Omitted: the tab's own, or the window's new-tab provider.
    #[serde(default)]
    pub provider: Option<ProviderId>,
    /// The pipeline step this terminal is opened for (a hand-off on a
    /// chain). A bridged stage of an engine-2 run launches with the bridge.
    #[serde(default)]
    pub chain: Option<crate::store::ChainRef>,
    /// Eagle mode: this start begins a new chain of this kind (`eagle1`,
    /// `eagle2`). Its run is made just before the spawn, so its first stage
    /// launches with the bridge too. Ignored for a tab already in a chain.
    #[serde(default)]
    pub start_chain: Option<String>,
}

/// The chain this start begins (`RoleTerminalInput::start_chain`), when the
/// tab is in none yet.
fn starting_chain(
    store: &Mutex<StateStore>,
    input: &RoleTerminalInput,
) -> Result<Option<crate::store::ChainRef>, String> {
    let Some(kind) = input.start_chain.as_deref().map(str::trim).filter(|k| !k.is_empty()) else {
        return Ok(None);
    };
    if input.chain.is_some() {
        return Ok(None);
    }
    let state = store.lock().map_err(|err| err.to_string())?;
    let chained = input
        .tab_id
        .as_deref()
        .and_then(|id| state.tab_by_id(id))
        .is_some_and(|tab| tab.chain.is_some());
    drop(state);
    if chained {
        return Ok(None);
    }
    Ok(crate::pipelines::find(kind)
        .map(|def| crate::bridge::launch::new_chain(&def, kind, chrono::Utc::now().timestamp_millis())))
}

/// The bridge plan for a role terminal opened at `chain`, when that stage
/// launches bridged (`bridge::launch::plan_for`). Without a `chain`, the
/// chain step the tab already holds: a fanned-out lane's Implementer, or a
/// prefilled stage form you start yourself.
fn bridge_plan_for(
    store: &Mutex<StateStore>,
    chain: Option<&crate::store::ChainRef>,
    tab_id: Option<&str>,
    role_id: &str,
) -> Result<Option<crate::bridge::BridgePlan>, String> {
    let state = store.lock().map_err(|err| err.to_string())?;
    let held = tab_id
        .and_then(|id| state.tab_by_id(id))
        .and_then(|tab| tab.chain.clone());
    let Some(chain) = chain.cloned().or(held) else {
        return Ok(None);
    };
    let chain = &chain;
    let run = state
        .chain_run_id(&chain.chain_id)
        .and_then(|id| state.pipeline_run_by_id(&id));
    Ok(run.and_then(|run| {
        let def = crate::pipelines::find(&run.kind)?;
        crate::bridge::launch::plan_for(run, &def, chain, role_id)
    }))
}

/// `<app data>/runs`.
fn runs_root(app: &AppHandle) -> PathBuf {
    crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(app).path)
}

/// `<app data>/runs` and this executable, for a bridged launch.
fn bridge_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let program = crate::bridge::launch::bridge_program()
        .ok_or_else(|| "DCTerminal could not find its own executable for the pipeline bridge.".to_string())?;
    Ok((runs_root(app), program))
}

/// Async with the work on a blocking thread, like [`shell_terminal_start`].
#[tauri::command]
pub async fn role_terminal_start(
    app: AppHandle,
    input: RoleTerminalInput,
    on_output: Channel<PtyPacket>,
) -> Result<TerminalStartResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        role_terminal_start_blocking(
            app.clone(),
            input,
            on_output,
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[allow(clippy::too_many_arguments)]
fn role_terminal_start_blocking(
    app: AppHandle,
    input: RoleTerminalInput,
    on_output: Channel<PtyPacket>,
    roles: State<Mutex<crate::store::RolesStore>>,
    settings: State<Mutex<SettingsStore>>,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
    projects: State<Mutex<crate::store::ProjectsStore>>,
) -> Result<TerminalStartResult, String> {
    let role = {
        let roles = roles.lock().map_err(|err| err.to_string())?;
        roles
            .role_by_id(&input.role_id)
            .cloned()
            .ok_or_else(|| format!("unknown role: {}", input.role_id))?
    };
    let provider = {
        let mut store = store.lock().map_err(|err| err.to_string())?;
        store.bind_window(input.window_id.as_deref());
        let settings = settings.lock().map_err(|err| err.to_string())?;
        provider_for_window(
            &store,
            settings.providers(),
            store.provider_for_start_as(input.tab_id.as_deref(), input.provider),
            input.tab_id.as_deref(),
        )
    };
    // Pipeline v2 (ADR-015): a bridged stage of an engine-2 run reports
    // through the bridge, and its prompt says how. A chain this start
    // begins is planned as the engine-2 run it is about to get.
    let starting = starting_chain(&store, &input)?;
    let mut bridge = match (&starting, provider.id() == ProviderId::Claude) {
        (_, false) => None,
        (Some(chain), true) => crate::pipelines::find(&chain.kind)
            .and_then(|def| crate::bridge::launch::plan_for_new_run(&def, chain, &role.id)),
        (None, true) => bridge_plan_for(&store, input.chain.as_ref(), input.tab_id.as_deref(), &role.id)?,
    };
    let instructions = bridge
        .as_ref()
        .map(|plan| crate::bridge::schema::result_instructions(plan.kind))
        .unwrap_or_default();
    let preview = merge_role_prompt_with(&role, &input.values, &instructions);
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
    let recent_folder = cwd.display().to_string();
    let prompt = handoff_terminal_prompt(&merged.text, input.handoff_plan.as_deref().unwrap_or(""));
    let mode = {
        let settings = settings.lock().map_err(|err| err.to_string())?;
        RunMode::parse(&settings.run_mode_for(&role.id))
    };
    let model = crate::models::model_for_tab_provider(
        &store,
        &settings,
        input.tab_id.as_deref(),
        &role.id,
        provider.id(),
    )?;
    let claude_session = (provider.id() == ProviderId::Claude).then(new_claude_session_id);
    let role_launch = |prompt: Option<String>| TerminalLaunch {
        kind: TerminalKind::Role {
            role_id: role.id.clone(),
            run_mode: mode,
            prompt,
        },
        model: Some(model.clone()),
        session_id: claude_session.clone(),
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
    if let Ok(state) = store.lock() {
        crate::commands::chain_events::notify_tab(&app, &state, &tab_id);
    }
    if provider.id() == ProviderId::Claude {
        let mut state = store.lock().map_err(|err| err.to_string())?;
        if let Some(dir) = provider.config_dir() {
            state.remember_claude_config(&tab_id, &dir.path)?;
        }
        if let Some(id) = &claude_session {
            state.remember_claude_terminal_session(&tab_id, id)?;
        }
    }
    // The chain this start begins: its run exists before the spawn (and
    // before the run folder below), labelled the way the frontend used to
    // label it once the terminal ran.
    if let Some(chain) = starting {
        let mut state = store.lock().map_err(|err| err.to_string())?;
        if state.tab_by_id(&tab_id).is_some_and(|tab| tab.chain.is_none()) {
            crate::commands::chain_events::set_tab_chain_and_notify(&app, &mut state, &tab_id, Some(chain), None)?;
        } else {
            // It joined a chain meanwhile: the planned run never came to be.
            bridge = None;
        }
    }
    // The run folder is written before the launch, and the tab records the
    // stage it holds (or that it holds none, when reused for another role).
    let (bridge_args, stage_dir) = match &bridge {
        Some(plan) => {
            let (runs, program) = bridge_paths(&app)?;
            let run_dir = crate::bridge::launch::prepare_stage(&runs, plan, &tab_id)?;
            let args = crate::bridge::launch::launch_args(
                plan.kind,
                &program,
                &run_dir,
                &plan.run_id,
                &plan.stage_key,
                &tab_id,
            );
            let tag = crate::bridge::BridgeTag {
                run_id: plan.run_id.clone(),
                stage: plan.stage_key.clone(),
            };
            (Some(args), crate::bridge::launch::stage_dir_of(&runs, &tag))
        }
        None => (None, None),
    };
    {
        let mut state = store.lock().map_err(|err| err.to_string())?;
        let tag = bridge.as_ref().map(|plan| crate::bridge::BridgeTag {
            run_id: plan.run_id.clone(),
            stage: plan.stage_key.clone(),
        });
        state.set_tab_bridge(&tab_id, tag)?;
    }
    let delivery = store_prompt(&app, &tab_id, &program, &prompt)?;
    let mut command = provider.terminal_command(&role_launch(Some(delivery.argument.clone())))?;
    if let Some(extra) = bridge_args {
        let has_prompt = !delivery.argument.trim().is_empty();
        crate::bridge::launch::insert_before_prompt(&mut command.args, has_prompt, extra);
    }
    if provider.id() == ProviderId::Claude {
        command.env.push(claude_scheme_env());
    }
    let pid = open_session_to(
        &registry,
        &tab_id,
        SpawnSpec {
            program: command.program,
            args: command.args,
            env: command.env,
            cwd,
            cols: input.cols,
            rows: input.rows,
        },
        claude_session,
        stage_dir,
        Output::View(on_output),
    )?;
    remember_folder(&projects, &recent_folder);
    Ok(TerminalStartResult {
        errors: Vec::new(),
        tab_id: Some(tab_id),
        pid,
        used_prompt_file: delivery.stored_body.is_some(),
    })
}

/// What [`PtyRegistry::paste`] writes: Ctrl+U, then `text` as one
/// bracketed paste, then Enter.
fn paste_bytes(text: &str) -> Vec<u8> {
    let mut bytes = CLEAR_INPUT.to_vec();
    bytes.extend_from_slice(b"\x1b[200~");
    bytes.extend_from_slice(clean_paste_text(text).as_bytes());
    bytes.extend_from_slice(b"\x1b[201~\r");
    bytes
}

/// Text safe to paste (`cleanPasteText` in `src/terminal/paste.ts`):
/// newlines as `\n`, and no control byte but `\t` and `\n`, so nothing in
/// it can end the bracketed paste early.
pub(crate) fn clean_paste_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&ch| ch == '\n' || ch == '\t' || !ch.is_control())
        .collect()
}

/// Start a stage terminal for the run actor (V3), with no view: as
/// [`role_terminal_start`] starts a role terminal (the role's account,
/// model and run mode, the prompt file for a long prompt), plus the bridge
/// flags, at 120×40 (D26). A view attaches with `pty_open`. Blocking; no
/// store lock is held across the spawn. `on_exit` hears the program exit.
///
/// `resume` (V4, D17): the stage's terminal already ran this session. Its
/// program is stopped ([`RESUME_STOP_GRACE`]) and `claude --resume <id>`
/// starts in its place with the same flags and `launch.prompt` as its turn;
/// the view stays (see [`replace_detached`]).
pub(crate) fn start_actor_stage(
    app: &AppHandle,
    launch: &crate::run_actor::StageLaunch,
    resume: bool,
    on_exit: OnExit,
) -> Result<(), String> {
    let store = app.state::<Mutex<StateStore>>();
    let settings = app.state::<Mutex<SettingsStore>>();
    let registry = app.state::<Mutex<PtyRegistry>>();
    let tab_id = launch.tab_id.as_str();
    let provider = {
        let state = store.lock().map_err(|err| err.to_string())?;
        let settings = settings.lock().map_err(|err| err.to_string())?;
        provider_for_window(&state, settings.providers(), ProviderId::Claude, Some(tab_id))
    };
    let mode = {
        let settings = settings.lock().map_err(|err| err.to_string())?;
        RunMode::parse(&settings.run_mode_for(&launch.role_id))
    };
    let model = crate::models::model_for_tab_provider(&store, &settings, Some(tab_id), &launch.role_id, ProviderId::Claude)?;
    let tag = {
        let mut state = store.lock().map_err(|err| err.to_string())?;
        if let Some(dir) = provider.config_dir() {
            state.remember_claude_config(tab_id, &dir.path)?;
        }
        state.tab_by_id(tab_id).and_then(|tab| tab.bridge.clone())
    };
    // Its `mode` file decides whether you may type into it (V5, D27).
    let stage_dir = tag.and_then(|tag| crate::bridge::launch::stage_dir_of(&runs_root(app), &tag));
    let role_launch = |prompt: Option<String>| TerminalLaunch {
        kind: if resume {
            TerminalKind::RoleResume {
                role_id: launch.role_id.clone(),
                run_mode: mode,
                session_id: launch.session_id.clone(),
                prompt,
            }
        } else {
            TerminalKind::Role {
                role_id: launch.role_id.clone(),
                run_mode: mode,
                prompt,
            }
        },
        model: Some(model.clone()),
        session_id: Some(launch.session_id.clone()),
    };
    let program = provider.terminal_command(&role_launch(None))?.program;
    let delivery = store_prompt(app, tab_id, &program, &launch.prompt)?;
    let mut command = provider.terminal_command(&role_launch(Some(delivery.argument.clone())))?;
    let has_prompt = !delivery.argument.trim().is_empty();
    crate::bridge::launch::insert_before_prompt(&mut command.args, has_prompt, launch.bridge_args.clone());
    command.env.push(claude_scheme_env());
    let spec = SpawnSpec {
        program: command.program,
        args: command.args,
        env: command.env,
        cwd: launch.cwd.clone(),
        cols: 120,
        rows: 40,
    };
    let session = Some(launch.session_id.clone());
    if resume {
        replace_detached(&registry, tab_id, spec, session, on_exit, RESUME_STOP_GRACE)?;
    } else {
        open_session_to(&registry, tab_id, spec, session, stage_dir, Output::Detached { on_exit, view: None })?;
    }
    Ok(())
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
    /// A view opening (not restarting) the terminal: a stage the run actor
    /// started with no view is attached to instead of started again.
    #[serde(default)]
    pub attach: bool,
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

/// The session a Claude role terminal may resume: only the one saved on the
/// tab, and only under the config folder it was started with.
fn role_resume_id(
    requested: Option<&str>,
    saved_session: Option<&str>,
    saved_config: Option<&str>,
    current_config: &str,
) -> Result<Option<String>, String> {
    let Some(id) = requested.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    if saved_session != Some(id) {
        return Err("This terminal has no saved session with that id. Start fresh instead.".to_string());
    }
    if let Some(saved) = saved_config {
        if !crate::provider::claude::same_config_dir(saved, current_config) {
            return Err(
                "This session belongs to another Claude account. Start fresh instead.".to_string(),
            );
        }
    }
    Ok(Some(id.to_string()))
}

/// Async with the work on a blocking thread, like [`shell_terminal_start`].
#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    input: PtyOpenInput,
    on_output: Channel<PtyPacket>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pty_open_blocking(
            app.clone(),
            input,
            on_output,
            app.state(),
            app.state(),
            app.state(),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

fn pty_open_blocking(
    app: AppHandle,
    input: PtyOpenInput,
    on_output: Channel<PtyPacket>,
    settings: State<Mutex<SettingsStore>>,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<u32, String> {
    // A stage the run actor started with no view: this view attaches to it.
    if input.attach {
        if let Some(pid) = attach_detached(&registry, &input.id, &on_output, Some((input.cols, input.rows)))? {
            return Ok(pid);
        }
    }
    let cwd = validate_working_folder(&input.cwd).map_err(|err| err.message())?;
    let configured = {
        let settings = settings.lock().map_err(|err| err.to_string())?;
        settings.terminal().shell.clone()
    };
    let mut claude_session: Option<String> = None;
    let mut stage_dir: Option<PathBuf> = None;
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
                session_id: None,
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
            let session_id = resume.clone().unwrap_or_else(new_claude_session_id);
            let kind = match resume {
                Some(id) => TerminalKind::Resume { session_id: id },
                None => TerminalKind::Plain,
            };
            let mut command = provider.terminal_command(&TerminalLaunch {
                kind,
                model: Some(model),
                session_id: Some(session_id.clone()),
            })?;
            command.env.push(claude_scheme_env());
            remember_terminal_session(&store, &input.id, Some(&session_id))?;
            claude_session = Some(session_id);
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
            let resume = if provider.id() == ProviderId::Claude {
                let state = store.lock().map_err(|err| err.to_string())?;
                let sessions = state.tab_by_id(&input.id).map(|tab| tab.sessions.clone());
                role_resume_id(
                    input.resume_session_id.as_deref(),
                    sessions
                        .as_ref()
                        .and_then(|s| s.claude_terminal_session_id.as_deref()),
                    sessions
                        .as_ref()
                        .and_then(|s| s.claude_config_dir.as_deref()),
                    &provider
                        .config_dir()
                        .map(|info| info.path)
                        .unwrap_or_default(),
                )?
            } else {
                None
            };
            if provider.id() == ProviderId::Claude {
                // A restart may run under another account: plan files follow it.
                if let Some(dir) = provider.config_dir() {
                    let mut state = store.lock().map_err(|err| err.to_string())?;
                    if state.tab_by_id(&input.id).is_some() {
                        state.remember_claude_config(&input.id, &dir.path)?;
                    }
                }
            }
            let model = crate::models::model_for_tab_provider(
                &store,
                &settings,
                Some(&input.id),
                &role_id,
                provider.id(),
            )?;
            // A restart relaunches the role fresh under a new pinned id, unless
            // the user resumes the saved session (same id, same permission mode).
            claude_session = (provider.id() == ProviderId::Claude)
                .then(|| resume.clone().unwrap_or_else(new_claude_session_id));
            let role_launch = |prompt: Option<String>| TerminalLaunch {
                kind: match &resume {
                    Some(id) => TerminalKind::RoleResume {
                        role_id: role_id.clone(),
                        run_mode: mode,
                        session_id: id.clone(),
                        prompt: None,
                    },
                    None => TerminalKind::Role {
                        role_id: role_id.clone(),
                        run_mode: mode,
                        prompt,
                    },
                },
                model: Some(model.clone()),
                session_id: claude_session.clone(),
            };
            let program = provider.terminal_command(&role_launch(None))?.program;
            let prompt = input
                .prompt
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .filter(|_| resume.is_none());
            let argument = match prompt {
                Some(text) => Some(store_prompt(&app, &input.id, &program, text)?.argument),
                None => None,
            };
            let has_prompt = argument.is_some();
            let mut command = provider.terminal_command(&role_launch(argument))?;
            // A bridged stage relaunches with the same bridge flags while it
            // still owns its stage; otherwise it is a plain role terminal now.
            let tag = {
                let state = store.lock().map_err(|err| err.to_string())?;
                state.tab_by_id(&input.id).and_then(|tab| tab.bridge.clone())
            };
            if let Some(tag) = tag {
                let extra = match (provider.id() == ProviderId::Claude).then(|| bridge_paths(&app)) {
                    Some(Ok((runs, program))) => {
                        crate::bridge::launch::relaunch_args(&runs, &tag, &input.id, &program)
                    }
                    _ => None,
                };
                match extra {
                    Some(extra) => {
                        crate::bridge::launch::insert_before_prompt(&mut command.args, has_prompt, extra);
                        stage_dir = crate::bridge::launch::stage_dir_of(&runs_root(&app), &tag);
                    }
                    None => {
                        let mut state = store.lock().map_err(|err| err.to_string())?;
                        state.set_tab_bridge(&input.id, None)?;
                    }
                }
            }
            if provider.id() == ProviderId::Claude {
                command.env.push(claude_scheme_env());
            }
            remember_terminal_session(&store, &input.id, claude_session.as_deref())?;
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
    let pid = open_session_to(
        &registry,
        &input.id,
        SpawnSpec {
            program,
            args,
            env,
            cwd,
            cols: input.cols,
            rows: input.rows,
        },
        claude_session,
        stage_dir,
        Output::View(on_output),
    )?;
    // The frontend does not use the pid; 0 means a newer open replaced this one.
    Ok(pid.unwrap_or(0))
}

/// Keystrokes from a view. A bridged stage on autopilot refuses them unless
/// it needs you or you took it over (V5, D27); the run actor's own pastes
/// never come this way.
#[tauri::command]
pub fn pty_write(
    id: String,
    data: String,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<(), String> {
    write_input(&registry, &id, data.as_bytes())
}

fn write_input(registry: &Mutex<PtyRegistry>, id: &str, data: &[u8]) -> Result<(), String> {
    if !input_state(registry, id)?.open {
        return Err(WATCH_ONLY.to_string());
    }
    let registry = registry.lock().map_err(|err| err.to_string())?;
    let session = registry
        .sessions
        .get(id)
        .ok_or_else(|| format!("no terminal: {id}"))?;
    session.write(data).map_err(|err| err.to_string())
}

/// Whether you may type into the terminal `id` now (V5, D27): the Watch
/// view shows it read-only while you may not. Reads one small file.
#[tauri::command]
pub fn pty_input_state(id: String, registry: State<Mutex<PtyRegistry>>) -> Result<StageInput, String> {
    input_state(&registry, &id)
}

/// The view says a bridged stage needs you, or no longer does (a question
/// or a permission dialog it read from the session log or the screen; the
/// bridge's PermissionRequest sets it too). Returns what typing allows now.
#[tauri::command]
pub fn pty_stage_needs(id: String, needs: bool, registry: State<Mutex<PtyRegistry>>) -> Result<StageInput, String> {
    registry.lock().map_err(|err| err.to_string())?.set_needs(&id, needs);
    input_state(&registry, &id)
}

/// A Watch view closed (V5): the hidden stage keeps running and keeps its
/// output for the next view. False when `id` is not a hidden stage, so the
/// view keeps its stream.
#[tauri::command]
pub fn pty_detach(id: String, registry: State<Mutex<PtyRegistry>>) -> Result<bool, String> {
    detach_view(&registry, &id)
}

/// Stays sync: async commands run on a pool and could apply resizes out of
/// order. It only queues the resize, so it never waits on the terminal.
#[tauri::command]
pub fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<(), String> {
    resize_terminal(&registry, &id, cols, rows)
}

fn resize_terminal(
    registry: &Mutex<PtyRegistry>,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Clone the handle and drop the lock before sending, so a busy terminal
    // never holds up another terminal's input or resize.
    let handle = {
        let registry = registry.lock().map_err(|err| err.to_string())?;
        let handle = registry
            .sessions
            .get(id)
            .map(PtySession::handle)
            .ok_or_else(|| format!("no terminal: {id}"))?;
        // A hidden stage remembers its size, so the next Watch knows whether
        // its resize alone redraws the screen.
        if let Some(mut out) = registry.detached.get(id).and_then(|sink| sink.lock().ok()) {
            out.size = (cols.max(1), rows.max(1));
        }
        handle
    };
    handle.resize(cols, rows).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn pty_kill(
    id: String,
    registry: State<Mutex<PtyRegistry>>,
    readers: State<crate::claude_session_log::reader::SessionLogReaders>,
) -> Result<(), String> {
    {
        let mut registry = registry.lock().map_err(|err| err.to_string())?;
        registry.kill(&id);
    }
    // The chat view watches again once the tab has a new PTY.
    readers.stop_watch(&id);
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

/// The terminal's plan file, read-only from the tab's provider:
/// `~/.cursor/plans` (Cursor) or `<configDir>/plans` (Claude, the folder the
/// tab was started with). `mentioned`: plan names in this terminal's output.
/// `claimed`: names other open terminals print.
#[tauri::command]
pub fn terminal_plan_file(
    started_at_ms: u64,
    tab_id: Option<String>,
    mentioned: Option<Vec<String>>,
    claimed: Option<Vec<String>>,
    settings: State<Mutex<SettingsStore>>,
    store: State<Mutex<StateStore>>,
) -> Result<Option<PlanFileInfo>, String> {
    let started = UNIX_EPOCH + Duration::from_millis(started_at_ms);
    let dir = {
        let store = store.lock().map_err(|err| err.to_string())?;
        let settings = settings.lock().map_err(|err| err.to_string())?;
        let tab = tab_id.as_deref().and_then(|id| store.tab_by_id(id));
        let id = tab
            .map(|tab| ProviderId::resolve(tab.provider))
            .unwrap_or(ProviderId::LEGACY);
        let started_with = tab
            .and_then(|tab| tab.sessions.claude_config_dir.as_deref())
            .map(str::trim)
            .filter(|dir| !dir.is_empty());
        match (id, started_with) {
            (ProviderId::Claude, Some(dir)) => PathBuf::from(dir).join("plans"),
            _ => provider_for_window(&store, settings.providers(), id, tab_id.as_deref())
                .plans_dir()
                .unwrap_or_else(cursor_plans_dir),
        }
    };
    let found = terminal_plan(
        &dir,
        started,
        &mentioned.unwrap_or_default(),
        &claimed.unwrap_or_default(),
    )?;
    Ok(found.map(|plan| PlanFileInfo {
        path: plan.path.display().to_string(),
        name: plan.name,
        modified_ms: plan
            .modified
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
        text: plan.text,
        truncated: plan.truncated,
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
    fn a_role_resume_only_takes_the_saved_session_in_its_own_account() {
        let id = "11111111-2222-4333-8444-555555555555";
        assert_eq!(role_resume_id(None, Some(id), None, "/a"), Ok(None));
        assert_eq!(role_resume_id(Some("  "), Some(id), None, "/a"), Ok(None));
        assert_eq!(
            role_resume_id(Some(id), Some(id), Some("/a"), "/a"),
            Ok(Some(id.to_string()))
        );
        // An id the tab never wrote is refused.
        assert!(role_resume_id(Some(id), None, None, "/a").is_err());
        assert!(role_resume_id(Some("other"), Some(id), None, "/a").is_err());
        // Another account cannot see the log.
        assert!(role_resume_id(Some(id), Some(id), Some("/a"), "/b").is_err());
    }

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

    // Review: Quit SIGTERMed (and then waited on and SIGKILLed) the pid of a
    // terminal whose program had already exited and been reaped. That pid
    // may since lead an unrelated process group.
    #[cfg(unix)]
    #[test]
    fn quitting_skips_a_terminal_whose_program_already_exited() {
        let dir = crate::test_support::TempDir::new("pty_exited");
        let session = PtySession::spawn(SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 0".into()],
            env: Vec::new(),
            cwd: dir.path().to_path_buf(),
            cols: 80,
            rows: 24,
        })
        .expect("spawn sh");
        let mut exited = false;
        for _ in 0..100 {
            if matches!(
                session.recv_timeout(std::time::Duration::from_millis(50)),
                Ok(Some(session::PtyOutput::Exit { .. }))
            ) {
                exited = true;
                break;
            }
        }
        assert!(exited, "the program exited on its own");
        let mut registry = PtyRegistry::new();
        registry.sessions.insert("done".into(), session);
        // The control thread finishes with the group right after reporting
        // the exit; give it a moment.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut left = registry.running_groups();
        while !left.is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
            left = registry.running_groups();
        }
        assert!(left.is_empty(), "an exited, reaped terminal is not signalled or waited on");
    }

    /// `sh -c script` in a PTY under `dir`.
    #[cfg(unix)]
    fn sh_spec(dir: &std::path::Path, script: &str) -> SpawnSpec {
        SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: Vec::new(),
            cwd: dir.to_path_buf(),
            cols: 80,
            rows: 24,
        }
    }

    /// Every packet a view got, decoded: (kind, text, code).
    type Seen = Arc<Mutex<Vec<(String, String, Option<i32>)>>>;

    fn recording_view() -> (Channel<PtyPacket>, Seen) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = seen.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let packet: serde_json::Value = serde_json::from_str(&json).unwrap();
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(packet["data"].as_str().unwrap_or_default())
                    .unwrap_or_default();
                into.lock().unwrap().push((
                    packet["kind"].as_str().unwrap_or_default().to_string(),
                    String::from_utf8_lossy(&bytes).into_owned(),
                    packet["code"].as_i64().map(|c| c as i32),
                ));
            }
            Ok(())
        });
        (channel, seen)
    }

    // V3: the run actor starts stage terminals before any view exists.
    #[cfg(unix)]
    #[test]
    fn a_terminal_started_with_no_view_keeps_its_output_for_the_view_that_attaches() {
        let dir = crate::test_support::TempDir::new("pty_detached");
        let registry = Mutex::new(PtyRegistry::new());
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();
        let on_exit: OnExit = Box::new(move |code| {
            let _ = exit_tx.send(code);
        });
        let script = "printf 'hello from the stage'; read line; printf 'bye'; exit 3";
        open_session_to(&registry, "s", sh_spec(dir.path(), script), None, None, Output::Detached { on_exit, view: None }).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let buffered = {
                let registry = registry.lock().unwrap();
                let out = registry.detached["s"].lock().unwrap();
                String::from_utf8_lossy(&out.buffer.iter().copied().collect::<Vec<u8>>()).into_owned()
            };
            if buffered.contains("hello from the stage") {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "no output kept: {buffered:?}");
            thread::sleep(Duration::from_millis(20));
        }
        assert!(registry.lock().unwrap().running("s"));
        let (view, seen) = recording_view();
        assert!(attach_detached(&registry, "s", &view, None).unwrap().is_some(), "the first view attaches");
        assert!(seen.lock().unwrap()[0].1.contains("hello from the stage"), "what it printed so far");
        // A view after a reload takes over (the ring replayed again, V5).
        let (other, _) = recording_view();
        assert!(attach_detached(&registry, "s", &other, None).unwrap().is_some());
        assert!(attach_detached(&registry, "s", &view, None).unwrap().is_some(), "back to the first view");
        registry.lock().unwrap().sessions["s"].write(b"\r").unwrap();
        assert_eq!(exit_rx.recv_timeout(Duration::from_secs(5)).unwrap(), Some(3), "the exit is reported");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !seen.lock().unwrap().iter().any(|p| p.0 == "exit") {
            assert!(std::time::Instant::now() < deadline, "the view hears the exit");
            thread::sleep(Duration::from_millis(20));
        }
        assert!(seen.lock().unwrap().iter().any(|p| p.1.contains("bye")), "and streams live after attaching");

        // A terminal closed (or replaced) before it exits reports nothing.
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();
        let on_exit: OnExit = Box::new(move |code| {
            let _ = exit_tx.send(code);
        });
        open_session_to(&registry, "t", sh_spec(dir.path(), "sleep 30"), None, None, Output::Detached { on_exit, view: None }).unwrap();
        registry.lock().unwrap().kill("t");
        assert!(exit_rx.recv_timeout(Duration::from_secs(5)).is_err(), "a closed terminal's exit is nobody's news");
        assert!(!registry.lock().unwrap().detached.contains_key("t"), "closing forgets it");
        registry.lock().unwrap().shutdown_all();
    }

    #[test]
    fn a_paste_keeps_newlines_and_drops_what_could_end_it_early() {
        assert_eq!(clean_paste_text("a\r\nb\rc\n\td"), "a\nb\nc\n\td");
        assert_eq!(clean_paste_text("x\u{1b}[201~y\u{7}"), "x[201~y");
    }

    // D40: after an Esc, Claude Code puts the interrupted prompt back in the
    // input box; a paste that did not clear it first would be appended to it.
    #[test]
    fn a_paste_clears_the_input_box_first() {
        assert_eq!(paste_bytes("fix it"), b"\x15\x1b[200~fix it\x1b[201~\r".to_vec());
    }

    /// Wait until `seen` has a packet that `found` accepts.
    fn wait_seen(seen: &Seen, what: &str, found: impl Fn(&(String, String, Option<i32>)) -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !seen.lock().unwrap().iter().any(&found) {
            assert!(std::time::Instant::now() < deadline, "{what}: {:?}", seen.lock().unwrap());
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn exit_probe() -> (OnExit, std::sync::mpsc::Receiver<Option<i32>>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (
            Box::new(move |code| {
                let _ = tx.send(code);
            }),
            rx,
        )
    }

    // V4 (D17): a loop-back stops the stage's program gracefully and resumes
    // its session in the same terminal; the view stays on it.
    #[cfg(unix)]
    #[test]
    fn resuming_a_stage_stops_it_gracefully_and_keeps_its_view() {
        let dir = crate::test_support::TempDir::new("pty_resume_view");
        let registry = Mutex::new(PtyRegistry::new());
        let stopped = dir.join("stopped");
        let script = format!(
            "trap 'sleep 0.3; touch \"{}\"; exit 143' TERM\nprintf 'old program'\nwhile :; do sleep 0.05; done",
            stopped.display()
        );
        let (old_exit, old_exits) = exit_probe();
        open_session_to(&registry, "s", sh_spec(dir.path(), &script), None, None, Output::Detached { on_exit: old_exit, view: None })
            .unwrap();
        let (view, seen) = recording_view();
        // The view attaches once the old program has printed.
        loop {
            attach_detached(&registry, "s", &view, None).unwrap();
            if seen.lock().unwrap().iter().any(|p| p.1.contains("old program")) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let (new_exit, new_exits) = exit_probe();
        replace_detached(
            &registry,
            "s",
            sh_spec(dir.path(), "printf 'resumed program'; read line; exit 4"),
            Some("sid".into()),
            new_exit,
            RESUME_STOP_GRACE,
        )
        .unwrap();
        assert!(stopped.exists(), "SIGTERM first, and the new program waited for the old one to finish");
        wait_seen(&seen, "the same view streams the resumed program", |p| p.1.contains("resumed program"));
        assert!(old_exits.recv_timeout(Duration::from_millis(300)).is_err(), "the old exit is nobody's news");
        assert!(!seen.lock().unwrap().iter().any(|p| p.0 == "exit"), "the view never hears the old program end");
        assert_eq!(registry.lock().unwrap().claude_sessions.get("s").map(String::as_str), Some("sid"));
        registry.lock().unwrap().sessions["s"].write(b"\r").unwrap();
        assert_eq!(new_exits.recv_timeout(Duration::from_secs(5)).unwrap(), Some(4), "the new exit is reported");
        wait_seen(&seen, "and the view hears it", |p| p.0 == "exit");
        registry.lock().unwrap().shutdown_all();
    }

    // The Planner you started yourself has a view from the start: a resume
    // keeps it too.
    #[cfg(unix)]
    #[test]
    fn resuming_a_terminal_you_opened_keeps_its_view() {
        let dir = crate::test_support::TempDir::new("pty_resume_own");
        let registry = Mutex::new(PtyRegistry::new());
        let (view, seen) = recording_view();
        let script = "trap 'exit 143' TERM\nprintf 'your planner'\nwhile :; do sleep 0.05; done";
        open_session(&registry, "p", sh_spec(dir.path(), script), None, view).unwrap();
        wait_seen(&seen, "the view streams it", |p| p.1.contains("your planner"));
        let (new_exit, new_exits) = exit_probe();
        replace_detached(&registry, "p", sh_spec(dir.path(), "printf 'resumed planner'; read line; exit 5"), None, new_exit, RESUME_STOP_GRACE)
            .unwrap();
        wait_seen(&seen, "the same view streams the resumed program", |p| p.1.contains("resumed planner"));
        assert!(!seen.lock().unwrap().iter().any(|p| p.0 == "exit"), "the view never hears the old program end");
        registry.lock().unwrap().sessions["p"].write(b"\r").unwrap();
        assert_eq!(new_exits.recv_timeout(Duration::from_secs(5)).unwrap(), Some(5));
        wait_seen(&seen, "and the view hears the new one end", |p| p.0 == "exit" && p.2 == Some(5));
        registry.lock().unwrap().shutdown_all();
    }

    // D17: SIGKILL when the program has not exited within the grace.
    #[cfg(unix)]
    #[test]
    fn resuming_a_stage_kills_a_program_that_ignores_sigterm() {
        let dir = crate::test_support::TempDir::new("pty_resume_kill");
        let registry = Mutex::new(PtyRegistry::new());
        let ready = dir.join("ready");
        let script = format!("trap '' TERM\ntouch '{}'\nwhile :; do sleep 0.05; done", ready.display());
        let (old_exit, _old_exits) = exit_probe();
        open_session_to(&registry, "s", sh_spec(dir.path(), &script), None, None, Output::Detached { on_exit: old_exit, view: None })
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(std::time::Instant::now() < deadline, "the old program is ready");
            thread::sleep(Duration::from_millis(20));
        }
        let old = registry.lock().unwrap().sessions["s"].group();
        let (new_exit, _new_exits) = exit_probe();
        let began = std::time::Instant::now();
        let grace = Duration::from_millis(400);
        replace_detached(&registry, "s", sh_spec(dir.path(), "sleep 5"), None, new_exit, grace).unwrap();
        assert!(began.elapsed() >= grace, "it waited the grace out first");
        assert!(!old.running(), "then killed it");
        assert!(registry.lock().unwrap().running("s"), "and started the new program");
        registry.lock().unwrap().shutdown_all();
    }

    // A stage whose program already exited (its view showed that) is resumed
    // too; the view attaches anew and gets what the new program printed.
    #[cfg(unix)]
    #[test]
    fn resuming_an_exited_stage_keeps_the_new_output_for_the_next_view() {
        let dir = crate::test_support::TempDir::new("pty_resume_exited");
        let registry = Mutex::new(PtyRegistry::new());
        let (old_exit, old_exits) = exit_probe();
        open_session_to(&registry, "s", sh_spec(dir.path(), "exit 1"), None, None, Output::Detached { on_exit: old_exit, view: None })
            .unwrap();
        let (view, seen) = recording_view();
        attach_detached(&registry, "s", &view, None).unwrap();
        assert_eq!(old_exits.recv_timeout(Duration::from_secs(5)).unwrap(), Some(1));
        wait_seen(&seen, "the view saw it exit", |p| p.0 == "exit");
        let (new_exit, _new_exits) = exit_probe();
        replace_detached(&registry, "s", sh_spec(dir.path(), "printf 'back again'; sleep 5"), None, new_exit, RESUME_STOP_GRACE)
            .unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(!seen.lock().unwrap().iter().any(|p| p.1.contains("back again")), "not into the ended view");
        let (next, next_seen) = recording_view();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            attach_detached(&registry, "s", &next, None).unwrap();
            if next_seen.lock().unwrap().iter().any(|p| p.1.contains("back again")) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "the next view gets it");
            thread::sleep(Duration::from_millis(20));
        }
        registry.lock().unwrap().shutdown_all();
    }

    /// Open a terminal whose program takes 0.4 s to exit on SIGTERM (like
    /// Claude finishing its session log); returns its group once the trap
    /// is set.
    #[cfg(unix)]
    fn open_slow_stopper(
        registry: &Mutex<PtyRegistry>,
        dir: &std::path::Path,
        id: &str,
    ) -> crate::process_tree::PtyGroup {
        let ready = dir.join(format!("{id}.ready"));
        let script = format!(
            "trap 'sleep 0.4; exit 0' TERM\ntouch '{}'\nwhile :; do sleep 0.05; done",
            ready.display()
        );
        open_session(registry, id, sh_spec(dir, &script), None, Channel::new(|_| Ok(())))
            .expect("open old terminal");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready.exists() {
            assert!(std::time::Instant::now() < deadline, "old terminal ready");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        registry.lock().unwrap().sessions[id].group()
    }

    // Review: restarting a Claude terminal stopped the old one in the
    // background and at once spawned `claude --resume <same id>`, so both
    // could append to <id>.jsonl while the old one finished on SIGTERM.
    #[cfg(unix)]
    #[test]
    fn reopening_a_terminal_waits_until_the_old_program_has_exited() {
        let dir = crate::test_support::TempDir::new("pty_reopen");
        let registry = Mutex::new(PtyRegistry::new());
        let old = open_slow_stopper(&registry, dir.path(), "t");
        open_session(
            &registry,
            "t",
            sh_spec(dir.path(), "sleep 5"),
            None,
            Channel::new(|_| Ok(())),
        )
        .expect("reopen");
        assert!(!old.running(), "the old program exited before the new one started");
        assert!(registry.lock().unwrap().sessions.contains_key("t"));
        registry.lock().unwrap().shutdown_all();
    }

    // The wait above holds no lock, so the tab can be closed during it; the
    // open must then not leave a terminal running for a closed tab.
    #[cfg(unix)]
    #[test]
    fn closing_a_terminal_while_it_reopens_cancels_the_open() {
        let dir = crate::test_support::TempDir::new("pty_reopen_closed");
        let registry = Mutex::new(PtyRegistry::new());
        open_slow_stopper(&registry, dir.path(), "t");
        let started = dir.join("started");
        std::thread::scope(|scope| {
            let reopen = scope.spawn(|| {
                open_session(
                    &registry,
                    "t",
                    sh_spec(dir.path(), &format!("touch '{}'; sleep 5", started.display())),
                    None,
                    Channel::new(|_| Ok(())),
                )
            });
            std::thread::sleep(std::time::Duration::from_millis(100));
            registry.lock().unwrap().kill("t");
            assert!(reopen.join().unwrap().is_err(), "the open was cancelled");
        });
        assert!(!registry.lock().unwrap().sessions.contains_key("t"));
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!started.exists(), "the new program never started");
    }

    // Review: two opens of the same id. The first stopped the old program
    // and waited; the second saw no old session and spawned while the old
    // program still ran, and the first then failed as "closed".
    #[cfg(unix)]
    #[test]
    fn a_second_open_of_the_same_terminal_also_waits_and_the_first_yields() {
        let dir = crate::test_support::TempDir::new("pty_reopen_twice");
        let registry = Mutex::new(PtyRegistry::new());
        let old = open_slow_stopper(&registry, dir.path(), "t");
        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                open_session(
                    &registry,
                    "t",
                    sh_spec(dir.path(), "sleep 5"),
                    None,
                    Channel::new(|_| Ok(())),
                )
            });
            std::thread::sleep(std::time::Duration::from_millis(100));
            let second = scope.spawn(|| {
                let opened = open_session(
                    &registry,
                    "t",
                    sh_spec(dir.path(), "sleep 5"),
                    None,
                    Channel::new(|_| Ok(())),
                );
                (opened, old.running())
            });
            (first.join().unwrap(), second.join().unwrap())
        });
        let (second, old_running) = second;
        assert!(!old_running, "the second open also waited for the old program");
        assert!(matches!(second, Ok(Some(_))), "the newer open runs: {second:?}");
        assert_eq!(first, Ok(None), "the older open yields quietly");
        let registry = registry.lock().unwrap();
        assert_eq!(
            registry.sessions["t"].pid(),
            second.unwrap().unwrap(),
            "the newer open's terminal is the one kept"
        );
    }

    // Review: an open left its `opening` entry behind, and a kill left the
    // replaced program in `stopping`.
    #[cfg(unix)]
    #[test]
    fn opens_and_kills_leave_no_bookkeeping_behind() {
        let dir = crate::test_support::TempDir::new("pty_bookkeeping");
        let registry = Mutex::new(PtyRegistry::new());
        let empty = |registry: &Mutex<PtyRegistry>| {
            let registry = registry.lock().unwrap();
            registry.opening.is_empty() && registry.stopping.is_empty()
        };
        open_slow_stopper(&registry, dir.path(), "t");
        assert!(empty(&registry), "nothing left after an open");
        std::thread::scope(|scope| {
            let reopen = scope.spawn(|| {
                open_session(
                    &registry,
                    "t",
                    sh_spec(dir.path(), "sleep 5"),
                    None,
                    Channel::new(|_| Ok(())),
                )
            });
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(!registry.lock().unwrap().stopping.is_empty(), "old program is stopping");
            registry.lock().unwrap().kill_tab("t");
            assert!(empty(&registry), "nothing left after a kill");
            assert!(reopen.join().unwrap().is_err());
        });
        open_slow_stopper(&registry, dir.path(), "u");
        open_session(
            &registry,
            "u",
            sh_spec(dir.path(), "sleep 5"),
            None,
            Channel::new(|_| Ok(())),
        )
        .expect("reopen");
        assert!(empty(&registry), "nothing left after a reopen");
    }

    // Quit asks first when a terminal is still running; one whose program
    // ended, or that was closed, is not counted.
    #[cfg(unix)]
    #[test]
    fn running_terminals_count_as_live_work_for_quit() {
        let dir = crate::test_support::TempDir::new("pty_live_count");
        let registry = Mutex::new(PtyRegistry::new());
        assert_eq!(registry.lock().unwrap().live_count(), 0);
        open_slow_stopper(&registry, dir.path(), "a");
        open_slow_stopper(&registry, dir.path(), "b");
        assert_eq!(registry.lock().unwrap().live_count(), 2);
        registry.lock().unwrap().kill_tab("a");
        assert_eq!(registry.lock().unwrap().live_count(), 1, "a closed terminal is not live");
        open_session(&registry, "c", sh_spec(dir.path(), "exit 0"), None, Channel::new(|_| Ok(())))
            .expect("open short terminal");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while registry.lock().unwrap().live_count() != 1 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(registry.lock().unwrap().live_count(), 1, "an ended program is not live");
        registry.lock().unwrap().kill_tab("b");
    }

    // Review: quit walked only live sessions, so a replaced program still
    // stopping was neither waited on nor killed.
    #[cfg(unix)]
    #[test]
    fn quitting_also_stops_a_replaced_program_that_is_still_stopping() {
        let dir = crate::test_support::TempDir::new("pty_quit_stopping");
        let registry = Mutex::new(PtyRegistry::new());
        let old = open_slow_stopper(&registry, dir.path(), "t");
        std::thread::scope(|scope| {
            let reopen = scope.spawn(|| {
                open_session(
                    &registry,
                    "t",
                    sh_spec(dir.path(), "sleep 5"),
                    None,
                    Channel::new(|_| Ok(())),
                )
            });
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(old.running(), "the old program is still finishing");
            let groups = registry.lock().unwrap().running_groups();
            assert_eq!(groups.len(), 1, "quit waits on the stopping program");
            registry.lock().unwrap().kill("t");
            let _ = reopen.join();
        });
    }

    // Regression: a resize waited up to 2 s for a busy terminal's ack while
    // holding the registry lock, so every other terminal's input and resize
    // (and pty_open, pty_kill) waited too.
    #[test]
    fn a_resize_on_a_stuck_terminal_does_not_hold_the_registry() {
        let registry = Mutex::new(PtyRegistry::new());
        let (stuck, resizes) = PtySession::stalled_for_test();
        registry.lock().unwrap().sessions.insert("stuck".into(), stuck);
        std::thread::scope(|scope| {
            let resize = scope.spawn(|| {
                let start = std::time::Instant::now();
                let result = resize_terminal(&registry, "stuck", 100, 30);
                (result, start.elapsed())
            });
            let arrived = resizes.recv_timeout(std::time::Duration::from_secs(1));
            assert_eq!(arrived, Ok((100, 30)), "the resize reached the terminal");
            let free = registry.try_lock().is_ok();
            let (result, took) = resize.join().unwrap();
            assert!(free, "registry is free while the terminal is busy");
            assert_eq!(result, Ok(()));
            assert!(took < std::time::Duration::from_millis(200), "resize took {took:?}");
        });
    }

    // V5 (D25): every Watch replays the ring buffer, then goes live; closing
    // one only stops the streaming, never the stage.
    #[cfg(unix)]
    #[test]
    fn every_watch_replays_the_ring_buffer_and_closing_one_never_stops_the_stage() {
        let dir = crate::test_support::TempDir::new("pty_watch_ring");
        let registry = Mutex::new(PtyRegistry::new());
        let (on_exit, exits) = exit_probe();
        let script = "printf 'planning'; read line; printf 'reviewing'; read line; exit 0";
        open_session_to(&registry, "s", sh_spec(dir.path(), script), None, None, Output::Detached { on_exit, view: None })
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let (first, first_seen) = recording_view();
        loop {
            attach_detached(&registry, "s", &first, None).unwrap();
            if first_seen.lock().unwrap().iter().any(|p| p.1.contains("planning")) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "the first Watch sees the stage");
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(detach_view(&registry, "s"), Ok(true), "closing the Watch view detaches it");
        assert!(registry.lock().unwrap().running("s"), "the stage keeps running");
        let packets_before = first_seen.lock().unwrap().len();
        registry.lock().unwrap().sessions["s"].write(b"\r").unwrap();
        // A second Watch replays everything, including what ran while nobody watched.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let (second, second_seen) = recording_view();
        loop {
            attach_detached(&registry, "s", &second, None).unwrap();
            let replay = second_seen.lock().unwrap().last().map(|p| p.1.clone()).unwrap_or_default();
            if replay.contains("planning") && replay.contains("reviewing") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "a second Watch replays all the stage printed: {:?}",
                second_seen.lock().unwrap()
            );
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(first_seen.lock().unwrap().len(), packets_before, "a closed view gets nothing more");
        assert!(exits.recv_timeout(Duration::from_millis(100)).is_err(), "nothing stopped the stage");
        registry.lock().unwrap().sessions["s"].write(b"\r").unwrap();
        assert_eq!(exits.recv_timeout(Duration::from_secs(5)).unwrap(), Some(0));
        // A terminal a view started streams to it for as long as it runs.
        open_session(&registry, "v", sh_spec(dir.path(), "sleep 5"), None, Channel::new(|_| Ok(()))).unwrap();
        assert_eq!(detach_view(&registry, "v"), Ok(false));
        registry.lock().unwrap().shutdown_all();
    }

    #[test]
    fn the_ring_buffer_keeps_the_newest_two_megabytes() {
        let mut out = DetachedOutput::new(None, (120, 40));
        out.keep(&vec![b'a'; DETACHED_BUFFER]);
        out.keep(b"newest");
        assert_eq!(out.buffer.len(), DETACHED_BUFFER);
        let kept: Vec<u8> = out.buffer.iter().copied().collect();
        assert!(kept.ends_with(b"newest"));
        assert!(kept.starts_with(b"aaa"));
    }

    // D25/D26: a hidden stage runs at 120×40; the view attaching resizes it
    // once so its program redraws, even when the view is 120×40 too.
    #[test]
    fn a_watch_resizes_the_hidden_stage_once_to_redraw_it() {
        assert_eq!(redraw_sizes((120, 40), (100, 30)), vec![(100, 30)]);
        assert_eq!(redraw_sizes((120, 40), (120, 40)), vec![(120, 39), (120, 40)]);
        assert_eq!(redraw_sizes((80, 1), (80, 1)), vec![(80, 2), (80, 1)]);

        let registry = Mutex::new(PtyRegistry::new());
        let (stuck, resizes) = PtySession::stalled_for_test();
        {
            let mut registry = registry.lock().unwrap();
            registry.sessions.insert("s".into(), stuck);
            registry.detached.insert("s".into(), Arc::new(Mutex::new(DetachedOutput::new(None, (120, 40)))));
        }
        let (view, _) = recording_view();
        attach_detached(&registry, "s", &view, Some((100, 30))).unwrap();
        assert_eq!(resizes.recv_timeout(Duration::from_secs(1)), Ok((100, 30)));
        assert!(resizes.recv_timeout(Duration::from_millis(100)).is_err(), "once");
        // The view's own fits keep the size known, so the next Watch at the
        // same size still forces a redraw.
        resize_terminal(&registry, "s", 90, 20).unwrap();
        assert_eq!(resizes.recv_timeout(Duration::from_secs(1)), Ok((90, 20)));
        attach_detached(&registry, "s", &view, Some((90, 20))).unwrap();
        assert_eq!(resizes.recv_timeout(Duration::from_secs(1)), Ok((90, 19)));
        assert_eq!(resizes.recv_timeout(Duration::from_secs(1)), Ok((90, 20)));
    }

    // D27: typing into a bridged stage on autopilot is refused, except
    // while it needs you or you took it over. Other terminals take it.
    #[test]
    fn a_stage_on_autopilot_takes_keystrokes_only_while_it_needs_you_or_is_taken_over() {
        use crate::bridge::StageMode::*;
        assert!(stage_input(None, false).open, "not a stage");
        assert!(!stage_input(Some(Autopilot), false).open);
        assert!(stage_input(Some(Autopilot), true).open, "needs you");
        assert!(stage_input(Some(Takeover), false).open, "taken over");
        assert!(stage_input(Some(Takeover), false).taken_over);
        assert!(stage_input(Some(Manual), false).open, "autopilot off: every stage is yours");

        let dir = crate::test_support::TempDir::new("pty_watch_input");
        let stage = dir.join("stages/pr_review");
        std::fs::create_dir_all(&stage).unwrap();
        crate::bridge::folder::write_mode(&stage, Autopilot).unwrap();
        let registry = Mutex::new(PtyRegistry::new());
        let (stuck, _) = PtySession::stalled_for_test();
        let (plain, _) = PtySession::stalled_for_test();
        {
            let mut registry = registry.lock().unwrap();
            registry.sessions.insert("s".into(), stuck);
            registry.stage_dirs.insert("s".into(), stage.clone());
            registry.sessions.insert("plain".into(), plain);
        }
        assert_eq!(write_input(&registry, "s", b"y"), Err(WATCH_ONLY.to_string()));
        assert_eq!(write_input(&registry, "plain", b"y"), Ok(()));
        registry.lock().unwrap().set_needs("s", true);
        assert_eq!(write_input(&registry, "s", b"1"), Ok(()), "a permission dialog is up");
        registry.lock().unwrap().set_needs("s", false);
        assert!(write_input(&registry, "s", b"y").is_err());
        crate::bridge::folder::write_mode(&stage, Takeover).unwrap();
        assert_eq!(write_input(&registry, "s", b"y"), Ok(()), "taken over");
        let state = input_state(&registry, "s").unwrap();
        assert!(state.open && state.stage && state.taken_over && !state.needs);
        crate::bridge::folder::write_mode(&stage, Autopilot).unwrap();
        assert!(write_input(&registry, "s", b"y").is_err(), "handed back");
        // A terminal that is not a stage never records needs.
        registry.lock().unwrap().set_needs("plain", true);
        assert!(!input_state(&registry, "plain").unwrap().needs);
        // Closing forgets the stage.
        registry.lock().unwrap().kill("s");
        assert!(registry.lock().unwrap().input_gate("s").0.is_none());
    }
}
