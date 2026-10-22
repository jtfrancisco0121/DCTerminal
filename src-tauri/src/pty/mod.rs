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

    /// Which of `ids` run a program now (V5: a hidden stage has no view,
    /// so the frontend asks before closing its window).
    pub fn running_of(&self, ids: &[String]) -> Vec<String> {
        ids.iter()
            .filter(|id| {
                self.sessions
                    .get(id.as_str())
                    .is_some_and(|session| cfg!(not(unix)) || session.group().running())
            })
            .cloned()
            .collect()
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

/// The `--settings` value with DCTerminal's status line for a Claude
/// terminal, so the tab reports Claude usage (`status_line`, plan D32), and
/// has `UsageStore` read what it writes. It goes in
/// `TerminalLaunch::settings`, so the flag sits with the other Claude flags
/// (after a Windows `node` script). None when you set a status line of your
/// own (it wins; usage from the tab stays unknown) or the config folder or
/// the app's own path is unknown.
fn usage_status_line(
    app: &AppHandle,
    tab_id: &str,
    config_dir: Option<&str>,
    cwd: &std::path::Path,
) -> Option<serde_json::Value> {
    let config = config_dir.map(str::trim).filter(|dir| !dir.is_empty())?;
    if crate::status_line::user_has_status_line(std::path::Path::new(config), cwd) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let file = crate::status_line::file_for(&crate::data_dir::app_data_dir(app).path, tab_id);
    let usage = app.try_state::<Mutex<crate::usage::UsageStore>>()?;
    let mut usage = usage.lock().ok()?;
    usage.watch_status_line(tab_id, config, file.clone());
    drop(usage);
    Some(crate::status_line::settings(&crate::status_line::command(&exe, &file)))
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
    open_session_claimed(registry, id, spec, claude_session, stage_dir, output, None)
}

/// Register an open of `id` (see [`PtyRegistry::opening`]): a `kill` from
/// now on cancels it, and a newer open supersedes it.
fn claim_open(registry: &mut PtyRegistry, id: &str) -> u64 {
    registry.next_open += 1;
    let token = registry.next_open;
    registry.opening.insert(id.to_string(), token);
    token
}

/// Whether the open `token` of `id` may still go ahead: `Err` when the
/// terminal was closed meanwhile, `Ok(false)` when a newer open took over.
fn open_still_wanted(registry: &PtyRegistry, id: &str, token: u64) -> Result<bool, String> {
    match registry.opening.get(id) {
        Some(latest) if *latest == token => Ok(true),
        // A newer open of this id took over (it may have finished already).
        Some(_) => Ok(false),
        None if registry.sessions.contains_key(id) => Ok(false),
        None => Err("The terminal was closed while it was starting.".to_string()),
    }
}

/// [`open_session_to`], for an open already registered with
/// [`claim_open`] (`claimed`) before a wait of the caller's, so closing the
/// terminal during that wait cancels it too.
fn open_session_claimed(
    registry: &Mutex<PtyRegistry>,
    id: &str,
    spec: SpawnSpec,
    claude_session: Option<String>,
    stage_dir: Option<PathBuf>,
    output: Output,
    claimed: Option<u64>,
) -> Result<Option<u32>, String> {
    let size = (spec.cols, spec.rows);
    let (token, stopping) = {
        let mut registry = registry.lock().map_err(|err| err.to_string())?;
        let token = match claimed {
            Some(token) => {
                if !open_still_wanted(&registry, id, token)? {
                    return Ok(None);
                }
                token
            }
            None => claim_open(&mut registry, id),
        };
        registry.claude_sessions.remove(id);
        registry.forget_detached(id);
        registry.views.remove(id);
        registry.needs.remove(id);
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
    if !open_still_wanted(&registry, id, token)? {
        return Ok(None);
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
/// held during the wait. `stage_dir`: the stage folder the new program
/// reports through (V5's keystroke gate), `None` when it resumes unbridged.
fn replace_detached(
    registry: &Mutex<PtyRegistry>,
    id: &str,
    spec: SpawnSpec,
    claude_session: Option<String>,
    stage_dir: Option<PathBuf>,
    on_exit: OnExit,
    grace: Duration,
) -> Result<Option<u32>, String> {
    let (token, group, view) = {
        let mut registry = registry.lock().map_err(|err| err.to_string())?;
        // Registered before the wait: closing the tab meanwhile cancels the
        // resume, as it cancels any open (no `claude --resume` for a closed tab).
        let token = claim_open(&mut registry, id);
        let group = registry.sessions.get(id).map(|session| session.group());
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
        (token, group, view)
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
    let told = view.clone();
    let opened = open_session_claimed(
        registry,
        id,
        spec,
        claude_session,
        stage_dir,
        Output::Detached { on_exit, view },
        Some(token),
    );
    if let Ok(None) = opened {
        // A newer open of this tab (your Restart) took over during the wait:
        // nothing was resumed, and the view is that open's now.
        return Err("The terminal was restarted while autopilot was resuming it, so the round was not sent.".to_string());
    }
    if opened.is_err() {
        // The old program is gone and no new one runs: the view must not go
        // on looking like a live terminal.
        if let Some(channel) = told {
            let _ = channel.send(exit_packet(None));
        }
    }
    opened
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
            app.clone(),
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
    app: AppHandle,
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
    let mut claude_launch: Option<TerminalLaunch> = None;
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
        let request = TerminalLaunch {
            kind,
            model: Some(model),
            session_id: claude_session.clone(),
            settings: None,
        };
        // Fail before the tab is saved when the CLI is missing; the launch
        // is rebuilt with the status line once the tab id is known.
        let command = provider.terminal_command(&request)?;
        claude_launch = Some(request);
        command
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
            settings: None,
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
    let mut claude_config: Option<String> = None;
    let mut claude_provider = None;
    if launch == "claude-cli" {
        let mut state = store.lock().map_err(|err| err.to_string())?;
        let settings = settings.lock().map_err(|err| err.to_string())?;
        let provider = provider_for_window(
            &state,
            settings.providers(),
            ProviderId::Claude,
            Some(&tab_id),
        );
        claude_provider = Some(provider.clone());
        if let Some(dir) = provider.config_dir() {
            state.remember_claude_config(&tab_id, &dir.path)?;
            claude_config = Some(dir.path);
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
    if let (Some(provider), Some(request)) = (claude_provider, claude_launch) {
        let settings = usage_status_line(&app, &tab_id, claude_config.as_deref(), &cwd);
        if settings.is_some() {
            let env = std::mem::take(&mut command.env);
            command = provider.terminal_command(&TerminalLaunch { settings, ..request })?;
            command.env = env;
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
    /// The chain tag the new tab is about to join (a hand-off's next stage,
    /// tagged after the start). Its stage kind sets the permission mode, so
    /// a copied Planner launches in plan mode, and a bridged stage (Planner,
    /// reviewer, Implementer) of an engine-2 run launches with the bridge.
    /// Omitted: the tab's own chain.
    #[serde(default)]
    pub chain: Option<crate::store::ChainRef>,
    /// Eagle mode: this start begins a new chain of this kind (`eagle1`,
    /// `eagle2`). Its run is made just before the spawn, so its first stage
    /// launches with the bridge too. Ignored for a tab already in a chain.
    #[serde(default)]
    pub start_chain: Option<String>,
    /// C2: the ClickUp tickets Start fetched (`clickup_intake_snapshot`).
    /// A start that begins an engine-2 run writes them into the run folder
    /// as `tickets.json` and points the first stage at it; any other start
    /// puts their summary into the request.
    #[serde(default)]
    pub intake_id: Option<String>,
    /// F3: the size (S, M or L) the start screen picked for the run this
    /// start begins; kept on the run when it is that pipeline's size.
    #[serde(default)]
    pub size: Option<String>,
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

/// Which chain this start begins (`start_chain`, on a tab in none yet) and
/// the bridge plan for the stage it launches: that new run's first stage,
/// else the stage at `input.chain`, else the chain step the tab already
/// holds (a fanned-out lane's Implementer). No plan off Claude.
fn plan_start(
    store: &Mutex<StateStore>,
    input: &RoleTerminalInput,
    role_id: &str,
    claude: bool,
) -> Result<(Option<crate::store::ChainRef>, Option<crate::bridge::BridgePlan>), String> {
    let starting = starting_chain(store, input)?;
    let plan = match (&starting, claude) {
        (_, false) => None,
        (Some(chain), true) => crate::pipelines::find(&chain.kind)
            .and_then(|def| crate::bridge::launch::plan_for_new_run(&def, chain, role_id)),
        (None, true) => bridge_plan_for(store, input.chain.as_ref(), input.tab_id.as_deref(), role_id)?,
    };
    Ok((starting, plan))
}

/// A chain a start labelled its tab with ([`label_starting_chain`]).
#[derive(Debug, Clone, PartialEq, Eq)]
struct StartedChain {
    chain_id: String,
    run_id: Option<String>,
    /// The label made the run (it did not exist before).
    made_run: bool,
}

/// Label `tab_id` with the chain this start begins, just before the spawn:
/// its run is made here (engine 2, autopilot off), and the D24 gate decided
/// before the launch is recorded on it. `None` when the tab joined a chain
/// meanwhile.
fn label_starting_chain(
    events: &dyn crate::commands::chain_events::ChainEvents,
    store: &Mutex<StateStore>,
    tab_id: &str,
    chain: crate::store::ChainRef,
    gate: Option<(crate::bridge::gate::Gate, String)>,
) -> Result<Option<StartedChain>, String> {
    let mut state = store.lock().map_err(|err| err.to_string())?;
    if !state.tab_by_id(tab_id).is_some_and(|tab| tab.chain.is_none()) {
        return Ok(None);
    }
    let chain_id = chain.chain_id.clone();
    let made_run = state.chain_run_id(&chain_id).is_none();
    crate::commands::chain_events::set_tab_chain_and_notify(events, &mut state, tab_id, Some(chain), None)?;
    let run_id = state.chain_run_id(&chain_id);
    if let (Some((gate, stage_id)), Some(id)) = (gate, run_id.as_deref()) {
        if let Some(run) = state.pipeline_run_by_id_mut(id) {
            if crate::bridge::gate::apply(run, &gate, &stage_id).1 {
                state.save()?;
                events.chain_run_updated(id);
            }
        }
    }
    Ok(Some(StartedChain { chain_id, run_id, made_run }))
}

/// F3: keep `size` on the run `run_id` when it is that run's pipeline's size.
fn record_size(store: &Mutex<StateStore>, run_id: Option<&str>, size: Option<&str>) -> Result<(), String> {
    let Some(run_id) = run_id else { return Ok(()) };
    let mut state = store.lock().map_err(|err| err.to_string())?;
    let Some(run) = state.pipeline_run_by_id_mut(run_id) else { return Ok(()) };
    let Some(size) = crate::pipelines::sizes::checked_size(size, &run.kind) else { return Ok(()) };
    run.size = Some(size.to_string());
    state.save()
}

/// The rest of a start after [`label_starting_chain`] labelled `started`:
/// when it fails, the label is undone ([`undo_starting_chain`]).
fn after_starting_label<T>(
    events: &dyn crate::commands::chain_events::ChainEvents,
    store: &Mutex<StateStore>,
    tab_id: &str,
    started: Option<&StartedChain>,
    runs_root: impl FnOnce() -> Option<PathBuf>,
    rest: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let result = rest();
    if let (Err(_), Some(started)) = (&result, started) {
        // intentionally silent: the start's own error is what the form shows.
        let _ = undo_starting_chain(events, store, tab_id, started, runs_root);
    }
    result
}

/// A start that failed after [`label_starting_chain`]: the tab leaves the
/// chain and drops its stage tag, and the run that label made is removed,
/// with its run folder, unless something else holds it.
fn undo_starting_chain(
    events: &dyn crate::commands::chain_events::ChainEvents,
    store: &Mutex<StateStore>,
    tab_id: &str,
    started: &StartedChain,
    runs_root: impl FnOnce() -> Option<PathBuf>,
) -> Result<(), String> {
    let mut state = store.lock().map_err(|err| err.to_string())?;
    let labelled = state
        .tab_by_id(tab_id)
        .and_then(|tab| tab.chain.as_ref())
        .is_some_and(|chain| chain.chain_id == started.chain_id);
    if !labelled {
        return Ok(());
    }
    crate::commands::chain_events::set_tab_chain_and_notify(events, &mut state, tab_id, None, None)?;
    state.set_tab_bridge(tab_id, None)?;
    let Some(run_id) = started.run_id.as_deref().filter(|_| started.made_run) else {
        return Ok(());
    };
    if state.remove_unheld_run(run_id, &started.chain_id, tab_id)? {
        drop(state);
        events.chain_run_updated(run_id);
        if let Some(dir) = runs_root().and_then(|root| crate::bridge::folder::run_dir(&root, run_id)) {
            // intentionally silent: a folder left behind holds no run and is never read.
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    Ok(())
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

/// What the D24 gate reads, with no lock held: the CLI's `--version` text
/// (run once per executable, then cached) and whether a settings file turns
/// the hooks off for a stage in `cwd`.
fn gate_inputs(
    provider: &dyn crate::provider::Provider,
    cwd: &std::path::Path,
) -> (Option<String>, Option<crate::bridge::gate::HooksOff>) {
    let version = provider.cli_version();
    let config = provider.config_dir().map(|dir| PathBuf::from(dir.path));
    let hooks = crate::bridge::gate::hooks_off(config.as_deref(), cwd, crate::bridge::gate::managed_settings_path());
    (version, hooks)
}

/// The v1 key (`tab|session|prompt`) of the tab's last finished turn in its
/// session log under `(config folder, session id)`, read with no lock held.
fn last_turn_key(tab_id: &str, target: Option<&(PathBuf, String)>) -> Option<String> {
    let (dir, session) = target?;
    let path = crate::claude_session_log::find_session_log(dir, session)?;
    let log = crate::claude_session_log::reader::SessionLogReader::open(&path, session)?.summary();
    log.turn_done.then(|| crate::pipelines::recovery::turn_key(tab_id, &log))
}

/// What [`gate_run`] decided.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct GateRun {
    /// Launch bridged.
    bridged: bool,
    /// The run, which was running bridged, switched to engine 1, and
    /// autopilot is off for it from now on.
    manual_now: bool,
}

/// D24 and hooks-off for an engine-2 run that is already running bridged,
/// at a relaunch of `stage` or a later stage's bridged start (a stage key;
/// a lane suffix is dropped for the Timeline). An engine-1 outcome switches
/// the run for good (saved, with its notice); a run already on engine 1, or
/// gone, is never bridged; a newer CLI leaves the overview's note.
///
/// The bridge has decided turns the v1 path cannot recognise (a Resume
/// continues the same session). So a switch also turns autopilot off: the
/// run is manual from now on, as engine 1 runs are after V6, and the note
/// says why. (A chain's first stage gates before its run exists.)
fn gate_run(
    store: &Mutex<StateStore>,
    run_id: &str,
    stage: &str,
    version: Option<&str>,
    hooks_off: Option<&crate::bridge::gate::HooksOff>,
    decided_key: Option<&str>,
) -> Result<GateRun, String> {
    let decision = crate::bridge::gate::decide(version, hooks_off);
    let stage_id = stage.split('@').next().unwrap_or(stage);
    let mut state = store.lock().map_err(|err| err.to_string())?;
    let Some(run) = state.pipeline_run_by_id_mut(run_id).filter(|run| run.engine >= crate::bridge::launch::ENGINE_V2)
    else {
        return Ok(GateRun::default());
    };
    let (bridged, mut changed) = crate::bridge::gate::apply_with(run, &decision, stage_id, false);
    let manual_now = !bridged;
    if manual_now {
        crate::bridge::gate::make_manual(run, stage_id, decided_key);
        changed = true;
    }
    if changed {
        state.save()?;
    }
    Ok(GateRun { bridged, manual_now })
}

/// The gate at a stage's first bridged start on a run that exists already
/// (Fan out, Start lane). On engine 2 the run actor has been deciding its
/// turns, so this is mid-run: a switch to engine 1 makes the run manual,
/// as at a relaunch ([`actor_gate_on`]).
fn gate_bridged_launch(
    store: &Mutex<StateStore>,
    runs_root: &std::path::Path,
    plan: crate::bridge::BridgePlan,
    version: Option<&str>,
    hooks_off: Option<&crate::bridge::gate::HooksOff>,
) -> Result<Option<crate::bridge::BridgePlan>, String> {
    let bridged = actor_gate_on(store, runs_root, &plan.run_id, &plan.stage_id, version, hooks_off)?;
    Ok(bridged.then_some(plan))
}

/// `<app data>/runs` and this executable, for a bridged launch.
fn bridge_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let program = crate::bridge::launch::bridge_program()
        .ok_or_else(|| "DCTerminal could not find its own executable for the pipeline bridge.".to_string())?;
    Ok((runs_root(app), program))
}

/// The pipeline stage kind a role terminal launches as: the chain it is
/// about to join, else the chain its tab already has (a pipeline's first
/// stage or a lane is tagged before it starts). `None` off a pipeline.
pub(crate) fn launch_stage_kind(
    store: &StateStore,
    tab_id: Option<&str>,
    joining: Option<&crate::store::ChainRef>,
) -> Option<crate::pipelines::StageKind> {
    match joining {
        Some(chain) => crate::pipelines::stage_kind_for_chain(chain),
        None => tab_id.and_then(|id| store.tab_stage_kind(id)),
    }
}

/// How one role terminal start launches. Built by [`RoleLaunch::for_tab`],
/// which looks the stage kind up, so a start, a restart and a resume all
/// launch a pipeline stage in its kind's permission mode.
pub(crate) struct RoleLaunch {
    role_id: String,
    run_mode: RunMode,
    stage_kind: Option<crate::pipelines::StageKind>,
    model: String,
    session_id: Option<String>,
    /// Resume this Claude session (`RoleResume`) instead of a fresh start.
    resume: Option<String>,
}

impl RoleLaunch {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn for_tab(
        store: &Mutex<StateStore>,
        tab_id: Option<&str>,
        joining: Option<&crate::store::ChainRef>,
        role_id: &str,
        run_mode: RunMode,
        model: &str,
        session_id: Option<String>,
        resume: Option<String>,
    ) -> Result<Self, String> {
        let stage_kind = {
            let store = store.lock().map_err(|err| err.to_string())?;
            launch_stage_kind(&store, tab_id, joining)
        };
        Ok(Self {
            role_id: role_id.to_string(),
            run_mode,
            stage_kind,
            model: model.to_string(),
            session_id,
            resume,
        })
    }

    /// A stage the run actor starts (V3) or resumes (V4, D17): pinned to its
    /// session id, and a resume reopens that same session (`--resume <id>`,
    /// no new `--session-id`) with the stage kind's permission mode.
    pub(crate) fn for_actor_stage(
        launch: &crate::run_actor::StageLaunch,
        resume: bool,
        run_mode: RunMode,
        stage_kind: Option<crate::pipelines::StageKind>,
        model: &str,
    ) -> Self {
        Self {
            role_id: launch.role_id.clone(),
            run_mode,
            stage_kind,
            model: model.to_string(),
            session_id: Some(launch.session_id.clone()),
            resume: resume.then(|| launch.session_id.clone()),
        }
    }

    pub(crate) fn launch(&self, prompt: Option<String>) -> TerminalLaunch {
        TerminalLaunch {
            kind: match &self.resume {
                Some(id) => TerminalKind::RoleResume {
                    role_id: self.role_id.clone(),
                    run_mode: self.run_mode,
                    session_id: id.clone(),
                    prompt,
                    stage_kind: self.stage_kind,
                },
                None => TerminalKind::Role {
                    role_id: self.role_id.clone(),
                    run_mode: self.run_mode,
                    prompt,
                    stage_kind: self.stage_kind,
                },
            },
            model: Some(self.model.clone()),
            session_id: self.session_id.clone(),
            // H5's status line is added once the tab id is known.
            settings: None,
        }
    }
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
    mut input: RoleTerminalInput,
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
    let (starting, bridge) = plan_start(&store, &input, &role.id, provider.id() == ProviderId::Claude)?;
    // D24: the CLI version and disableAllHooks, read with no lock held
    // (`claude --version` runs once per executable, then it is cached). A
    // chain this start begins has no run yet: the gate is recorded on the
    // run once it is made, just before the spawn.
    let mut new_run_gate = None;
    let mut bridge = match bridge {
        Some(plan) => {
            let cwd = input.values.get("cwd").map(|value| PathBuf::from(value.trim())).unwrap_or_default();
            let (version, hooks_off) = gate_inputs(provider.as_ref(), &cwd);
            if starting.is_some() {
                let gate = crate::bridge::gate::decide(version.as_deref(), hooks_off.as_ref());
                let bridged = matches!(gate, crate::bridge::gate::Gate::Bridge { .. });
                new_run_gate = Some((gate, plan.stage_id.clone()));
                bridged.then_some(plan)
            } else {
                let runs = crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(&app).path);
                gate_bridged_launch(&store, &runs, plan, version.as_deref(), hooks_off.as_ref())?
            }
        }
        None => None,
    };
    // C2: tickets from ClickUp, taken for this window's account only. Only
    // a start that begins an engine-2 run, launching bridged, gets the run
    // folder's `tickets.json`; the note goes into the form before it merges.
    let mut intake = match input.intake_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(intake_id) => {
            let account = {
                let mut state = store.lock().map_err(|err| err.to_string())?;
                state.bind_window(input.window_id.as_deref());
                state.account_for_tab(input.tab_id.as_deref())
            };
            let pending = app.state::<crate::commands::IntakeState>();
            let snapshot = crate::commands::clickup_intake::take_pending(pending.inner(), intake_id, &account)?;
            let run_dir = match (&bridge, &starting) {
                (Some(plan), Some(_)) => crate::bridge::folder::run_dir(&runs_root(&app), &plan.run_id),
                _ => None,
            };
            Some(crate::commands::clickup_intake::intake_for_start(
                &role,
                &mut input.values,
                snapshot,
                run_dir.as_deref(),
            ))
        }
        None => None,
    };
    // Settings › Repos (L1): the Planner's prompt lists them, and the run
    // folder gets them for the bridge's tasks check. W1: merged with the
    // repos of the run's start folder when it is a workspace (the run's own
    // folder once it exists, else the folder this start is in).
    let repos = {
        let settings_repos = settings.lock().map_err(|err| err.to_string())?.repos().to_vec();
        let start_folder = match bridge.as_ref() {
            Some(plan) => {
                let state = store.lock().map_err(|err| err.to_string())?;
                state.pipeline_run_by_id(&plan.run_id).map(|run| run.cwd.clone())
            }
            None => None,
        }
        .or_else(|| input.values.get("cwd").cloned())
        .unwrap_or_default();
        if bridge.is_some() {
            crate::workspace_repos::workspace_repos(std::path::Path::new(start_folder.trim()), &settings_repos)
        } else {
            crate::workspace_repos::WorkspaceRepos { workspace: false, repos: settings_repos }
        }
    };
    // W1: an Implementer never starts in a workspace folder itself.
    if bridge.as_ref().is_some_and(|plan| plan.kind == crate::bridge::ResultKind::Implementer) {
        let cwd = input.values.get("cwd").map(|value| PathBuf::from(value.trim())).unwrap_or_default();
        if let Some(problem) = crate::workspace_repos::implementer_folder_problem(repos.workspace, &cwd) {
            return Err(problem);
        }
    }
    let mut instructions = bridge
        .as_ref()
        .map(|plan| {
            // F1: an artifact stage is told the run folder its documents go in.
            let run_dir = crate::bridge::folder::run_dir(&runs_root(&app), &plan.run_id);
            crate::bridge::schema::stage_instructions_for(plan.kind, &repos, run_dir.as_deref())
        })
        .unwrap_or_default();
    // L3: a lane's Implementer whose task has stories gets their list, and
    // the run records them.
    if let Some(plan) = bridge.as_ref() {
        let mut state = store.lock().map_err(|err| err.to_string())?;
        let section = match state.pipeline_run_by_id_mut(&plan.run_id) {
            Some(run) => {
                let (section, seeded) = crate::bridge::launch::launch_stories(&runs_root(&app), run, plan);
                if seeded {
                    state.save()?;
                }
                section
            }
            None => String::new(),
        };
        if !section.is_empty() {
            instructions = format!("{instructions}\n\n{section}");
        }
    }
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
    let mut prompt = handoff_terminal_prompt(&merged.text, input.handoff_plan.as_deref().unwrap_or(""));
    if let Some(tail) = intake.as_ref().map(|i| i.tail.trim()).filter(|t| !t.is_empty()) {
        prompt = format!("{prompt}\n\n{tail}");
    }
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
    let launch = RoleLaunch::for_tab(
        &store,
        input.tab_id.as_deref(),
        input.chain.as_ref().or(starting.as_ref()),
        &role.id,
        mode,
        &model,
        claude_session.clone(),
        None,
    )?;
    let role_launch = |prompt: Option<String>| launch.launch(prompt);
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
    let started = match starting {
        Some(chain) => {
            let started = label_starting_chain(&app, &store, &tab_id, chain, new_run_gate)?;
            if started.is_none() {
                // It joined a chain meanwhile: the planned run never came to be.
                bridge = None;
                // C2 (L1): so no tickets.json either; the request summary
                // takes the place of the note that named it.
                if let Some((from, to)) = intake.as_mut().and_then(|i| i.without_run()) {
                    prompt = prompt.replacen(&from, &to, 1);
                    let mut state = store.lock().map_err(|err| err.to_string())?;
                    crate::commands::clickup_intake::swap_tab_note(&mut state, &tab_id, &from, &to)?;
                }
            }
            started
        }
        None => None,
    };
    // F3: the run this start made keeps the size you picked.
    if let Some(started) = started.as_ref().filter(|started| started.made_run) {
        record_size(&store, started.run_id.as_deref(), input.size.as_deref())?;
    }
    // A failure from here on undoes the chain label above (and the run it made).
    let runs_root = || bridge_paths(&app).ok().map(|(runs, _)| runs);
    after_starting_label(&app, &store, &tab_id, started.as_ref(), runs_root, || {
        // The run folder is written before the launch, and the tab records the
        // stage it holds (or that it holds none, when reused for another role).
        // Its `mode` file decides whether you may type into it (V5, D27).
        let (bridge_flags, stage_dir) = match &bridge {
            Some(plan) => {
                let (runs, program) = bridge_paths(&app)?;
                let run_dir = crate::bridge::launch::prepare_stage(&runs, plan, &tab_id)?;
                crate::bridge::launch::write_workspace_repos(&run_dir, &repos)?;
                // L3: the story the stage starts on, for the bridge's check.
                {
                    let state = store.lock().map_err(|err| err.to_string())?;
                    if let Some(run) = state.pipeline_run_by_id(&plan.run_id) {
                        crate::bridge::launch::write_story_mark(&runs, run, &plan.stage_key, plan.lane.as_deref())?;
                    }
                }
                // C2: the run's intake snapshot, before the stage that reads it starts.
                if let Some(snapshot) = intake.as_ref().and_then(|i| i.write.as_ref()) {
                    crate::commands::clickup_intake::write_snapshot(&run_dir, snapshot)?;
                }
                let flags = crate::bridge::launch::launch_flags(
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
                (Some(flags), crate::bridge::launch::stage_dir_of(&runs, &tag))
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
        let mut request = role_launch(Some(delivery.argument.clone()));
        if provider.id() == ProviderId::Claude {
            let config = provider.config_dir().map(|dir| dir.path);
            request.settings = usage_status_line(&app, &tab_id, config.as_deref(), &cwd);
        }
        // One `--settings`: the bridge's hooks join the status line.
        let mut command =
            crate::bridge::launch::bridged_command(request, bridge_flags, |req| provider.terminal_command(req))?;
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
            tab_id: Some(tab_id.clone()),
            pid,
            used_prompt_file: delivery.stored_body.is_some(),
        })
    })
}

/// What [`PtyRegistry::paste`] writes: Ctrl+U, then `text` as one
/// bracketed paste, then Enter.
pub fn paste_bytes(text: &str) -> Vec<u8> {
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

/// The command for a stage the run actor opens: the status line (H5) and,
/// bridged, the bridge's hooks in one `--settings` (`bridged_command`).
fn actor_stage_command(
    mut request: TerminalLaunch,
    status_line: Option<serde_json::Value>,
    bridge: Option<crate::bridge::launch::BridgeFlags>,
    build: impl FnOnce(&TerminalLaunch) -> Result<crate::provider::ProgramArgs, String>,
) -> Result<crate::provider::ProgramArgs, String> {
    request.settings = status_line;
    crate::bridge::launch::bridged_command(request, bridge, build)
}

/// D24 and hooks-off for a stage the run actor opens bridged (V3): the CLI
/// version and the settings files are read with no lock held, then
/// [`gate_run`] applies the outcome to the run. True to launch bridged.
pub(crate) fn actor_stage_gate(
    app: &AppHandle,
    run_id: &str,
    stage_key: &str,
    cwd: &std::path::Path,
) -> Result<bool, String> {
    let store = app.state::<Mutex<StateStore>>();
    let settings = app.state::<Mutex<SettingsStore>>();
    let provider = {
        let state = store.lock().map_err(|err| err.to_string())?;
        let settings = settings.lock().map_err(|err| err.to_string())?;
        provider_for_window(&state, settings.providers(), ProviderId::Claude, None)
    };
    let (version, hooks_off) = gate_inputs(provider.as_ref(), cwd);
    let runs = crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(app).path);
    actor_gate_on(&store, &runs, run_id, stage_key, version.as_deref(), hooks_off.as_ref())
}

/// [`actor_stage_gate`] once the CLI version and settings are read. The
/// actor only ever opens a stage mid-run (a chain's first stage starts
/// through `startChain`), so the bridge has decided turns already: a switch
/// to engine 1 makes the run manual for good, as at a relaunch (V2a's
/// `make_manual`, one Timeline note), and the run's bridged tabs stop
/// enforcing a result (their hooks read `mode`). True to launch bridged.
pub(crate) fn actor_gate_on(
    store: &Mutex<StateStore>,
    runs_root: &std::path::Path,
    run_id: &str,
    stage_key: &str,
    version: Option<&str>,
    hooks_off: Option<&crate::bridge::gate::HooksOff>,
) -> Result<bool, String> {
    let gated = gate_run(store, run_id, stage_key, version, hooks_off, None)?;
    if gated.manual_now {
        if let Err(err) = crate::bridge::launch::set_run_manual_for_good(runs_root, run_id) {
            eprintln!("DCTerminal: could not switch the run folder to manual: {err}");
        }
    }
    Ok(gated.bridged)
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
    // Its `mode` file decides whether you may type into it (V5, D27). A
    // stage the D24 gate sent to engine 1 has no tag (and no flags) by now.
    let stage_dir = tag
        .filter(|_| launch.bridge.is_some())
        .and_then(|tag| crate::bridge::launch::stage_dir_of(&runs_root(app), &tag));
    // H4: the stage's kind (from the chain its tab was saved on) picks the
    // permission mode, so a Planner stage, a copied one included, plans. A
    // resume (V4) reopens the stage's own session with the same flags.
    let stage_kind = {
        let state = store.lock().map_err(|err| err.to_string())?;
        launch_stage_kind(&state, Some(tab_id), None)
    };
    let role_launch = RoleLaunch::for_actor_stage(launch, resume, mode, stage_kind, &model);
    let program = provider.terminal_command(&role_launch.launch(None))?.program;
    let delivery = store_prompt(app, tab_id, &program, &launch.prompt)?;
    // H5's status line, so the stage reports usage like any Claude terminal.
    let config = provider.config_dir().map(|dir| dir.path);
    let status = usage_status_line(app, tab_id, config.as_deref(), &launch.cwd);
    let mut command = actor_stage_command(
        role_launch.launch(Some(delivery.argument.clone())),
        status,
        launch.bridge.clone(),
        |req| provider.terminal_command(req),
    )?;
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
        replace_detached(&registry, tab_id, spec, session, stage_dir, on_exit, RESUME_STOP_GRACE)?;
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
                settings: None,
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
            let config = provider.config_dir().map(|dir| dir.path);
            let mut command = provider.terminal_command(&TerminalLaunch {
                kind,
                model: Some(model),
                session_id: Some(session_id.clone()),
                settings: usage_status_line(&app, &input.id, config.as_deref(), &cwd),
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
            // A pipeline stage restarts in its kind's mode, like its first launch.
            let launch = RoleLaunch::for_tab(
                &store,
                Some(&input.id),
                None,
                &role_id,
                mode,
                &model,
                claude_session.clone(),
                resume.clone(),
            )?;
            let role_launch = |prompt: Option<String>| launch.launch(prompt);
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
            let mut request = role_launch(argument);
            if provider.id() == ProviderId::Claude {
                let config = provider.config_dir().map(|dir| dir.path);
                request.settings = usage_status_line(&app, &input.id, config.as_deref(), &cwd);
            }
            // A bridged stage relaunches with the same bridge flags while it
            // still owns its stage; otherwise it is a plain role terminal now.
            let (tag, last_log) = {
                let state = store.lock().map_err(|err| err.to_string())?;
                let tab = state.tab_by_id(&input.id);
                let last_log = tab.and_then(|tab| {
                    let dir = tab.sessions.claude_config_dir.clone()?;
                    Some((PathBuf::from(dir), tab.sessions.claude_terminal_session_id.clone()?))
                });
                (tab.and_then(|tab| tab.bridge.clone()), last_log)
            };
            // The D24 gate again: the CLI or the hooks settings may have
            // changed since the first launch, and a run switched to engine 1
            // stays there. Without hooks a bridged tab would never end a turn.
            let mut flags = None;
            if let Some(tag) = tag {
                let gated = if provider.id() == ProviderId::Claude {
                    let (version, hooks_off) = gate_inputs(provider.as_ref(), &cwd);
                    let decided_key = last_turn_key(&input.id, last_log.as_ref());
                    gate_run(
                        &store,
                        &tag.run_id,
                        &tag.stage,
                        version.as_deref(),
                        hooks_off.as_ref(),
                        decided_key.as_deref(),
                    )?
                } else {
                    GateRun::default()
                };
                if gated.manual_now {
                    // The run's other bridged tabs stop enforcing a result
                    // (their hooks read `mode`), and the overview refreshes.
                    if let Ok((runs, _)) = bridge_paths(&app) {
                        if let Err(err) = crate::bridge::launch::set_run_manual_for_good(&runs, &tag.run_id) {
                            eprintln!("DCTerminal: could not switch the run folder to manual: {err}");
                        }
                    }
                    if let Ok(state) = store.lock() {
                        crate::commands::chain_events::notify_tab(&app, &state, &input.id);
                    }
                }
                if gated.bridged {
                    flags = match bridge_paths(&app) {
                        Ok((runs, program)) => {
                            crate::bridge::launch::relaunch_flags(&runs, &tag, &input.id, &program)
                        }
                        Err(_) => None,
                    };
                }
                if flags.is_some() {
                    // Its `mode` file decides whether you may type into it (V5, D27).
                    stage_dir = crate::bridge::launch::stage_dir_of(&runs_root(&app), &tag);
                } else {
                    let mut state = store.lock().map_err(|err| err.to_string())?;
                    state.set_tab_bridge(&input.id, None)?;
                }
            }
            // One `--settings`: the bridge's hooks join the status line.
            let mut command =
                crate::bridge::launch::bridged_command(request, flags, |req| provider.terminal_command(req))?;
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

/// Which of `ids` run a program now, viewed or not (V5): the "Close
/// window?" and "Replace the open tabs" questions count hidden stages too.
#[tauri::command]
pub fn pty_running(ids: Vec<String>, registry: State<Mutex<PtyRegistry>>) -> Result<Vec<String>, String> {
    Ok(registry.lock().map_err(|err| err.to_string())?.running_of(&ids))
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

    fn store_with_engine2_run(dir: &crate::test_support::TempDir) -> Mutex<StateStore> {
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: crate::store::AppStateFile::default(),
            new_tab_provider: ProviderId::DEFAULT,
            draft_window: crate::store::MAIN_WINDOW_ID.to_string(),
        };
        let mut run: crate::store::PipelineRun = serde_json::from_value(serde_json::json!({
            "id": "ee_1700000000000", "kind": "full", "cwd": "/repo", "stage": "pr_reviewer",
            "tabIds": {}, "createdAt": "2026-10-19T00:00:00Z", "status": "running"
        }))
        .unwrap();
        run.engine = crate::bridge::launch::ENGINE_V2;
        run.set_autopilot_enabled(true);
        store.data.pipeline_runs.push(run);
        Mutex::new(store)
    }

    fn reviewer_plan() -> crate::bridge::BridgePlan {
        crate::bridge::BridgePlan {
            run_id: "ee_1700000000000".into(),
            stage_id: "pr_reviewer".into(),
            role_id: "role_pr_reviewer".into(),
            lane: None,
            stage_key: "pr_reviewer".into(),
            kind: crate::bridge::ResultKind::Reviewer,
            autopilot: true,
        }
    }

    #[test]
    fn an_older_claude_code_or_hooks_turned_off_launch_the_run_as_engine_1_and_save_it() {
        let dir = crate::test_support::TempDir::new("gate_bridged_launch");
        let store = store_with_engine2_run(&dir);
        let runs = dir.join("runs");
        let planner = crate::bridge::BridgePlan {
            stage_id: "planner".into(),
            role_id: "role_planner".into(),
            stage_key: "planner".into(),
            kind: crate::bridge::ResultKind::Planner,
            ..reviewer_plan()
        };
        crate::bridge::launch::prepare_stage(&runs, &planner, "tab_planner").unwrap();
        let launched = gate_bridged_launch(&store, &runs, reviewer_plan(), Some("2.1.200 (Claude Code)"), None).unwrap();
        assert_eq!(launched, None, "an older CLI launches unbridged");
        let saved = StateStore::open_path(dir.join("state.json")).unwrap();
        let run = saved.pipeline_run_by_id("ee_1700000000000").unwrap();
        assert_eq!(run.engine, 1, "saved as engine 1");
        // V3: a stage started on a run that exists (Fan out, Start lane) is
        // mid-run, so the switch makes the run manual, as at a relaunch.
        assert!(!run.autopilot.as_ref().unwrap().enabled, "autopilot is off");
        assert!(run.manual_only, "for good");
        assert_eq!(run.events.len(), 1, "one Timeline notice: {:?}", run.events);
        assert!(run.engine_note.as_deref().unwrap().contains("2.1.200"));
        assert!(run.engine_note.as_deref().unwrap().contains("manual from now on"));
        let mode = std::fs::read_to_string(runs.join("ee_1700000000000/stages/planner/mode")).unwrap();
        assert_eq!(mode, "manual", "the still-bridged stages stop enforcing a result");

        let dir = crate::test_support::TempDir::new("gate_bridged_launch_hooks");
        let store = store_with_engine2_run(&dir);
        let off = crate::bridge::gate::HooksOff { file: dir.join("managed-settings.json"), setting: "disableAllHooks" };
        let launched =
            gate_bridged_launch(&store, &dir.join("runs"), reviewer_plan(), Some("2.1.287 (Claude Code)"), Some(&off)).unwrap();
        assert_eq!(launched, None, "hooks off launches unbridged");
        let state = store.lock().unwrap();
        assert_eq!(state.pipeline_run_by_id("ee_1700000000000").unwrap().engine, 1);

        let dir = crate::test_support::TempDir::new("gate_bridged_launch_newer");
        let store = store_with_engine2_run(&dir);
        let launched = gate_bridged_launch(&store, &dir.join("runs"), reviewer_plan(), Some("2.1.300 (Claude Code)"), None).unwrap();
        assert_eq!(launched, Some(reviewer_plan()), "a newer CLI is allowed");
        let saved = StateStore::open_path(dir.join("state.json")).unwrap();
        let run = saved.pipeline_run_by_id("ee_1700000000000").unwrap();
        assert_eq!(run.engine, crate::bridge::launch::ENGINE_V2);
        assert!(run.engine_note.as_deref().unwrap().starts_with("Claude Code version not yet verified"));
    }

    #[test]
    fn the_gate_reads_the_cli_and_settings_before_it_locks_the_store() {
        // Review rule (store/mod.rs): no store lock across a process spawn.
        let source = include_str!("mod.rs");
        let body = &source[source.find("fn role_terminal_start_blocking(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let inputs = body.find("gate_inputs(").expect("reads the version and settings");
        let gate = body.find("gate_bridged_launch(").expect("applies the gate");
        assert!(inputs < gate);
        assert!(!body[inputs..gate].contains(".lock()"), "no lock while reading the CLI and settings");
        let helper = &source[source.find("fn gate_inputs(").unwrap()..];
        let helper = &helper[..helper.find("\n}\n").unwrap()];
        assert!(helper.contains("cli_version()") && helper.contains("hooks_off("));
        assert!(!helper.contains(".lock()"));
    }

    /// V3's second launch path: a stage the run actor opens gets H5's status
    /// line merged with the bridge's hooks into one `--settings`, and the
    /// D24 / hooks-off gate, like every other bridged start.
    #[test]
    fn an_actor_stage_launches_with_the_status_line_and_through_the_gate() {
        let source = include_str!("mod.rs");
        let body = &source[source.find("pub(crate) fn start_actor_stage(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let status = body.find("usage_status_line(").expect("adds the status line");
        let merged = body.find("actor_stage_command(").expect("one merged --settings");
        assert!(status < merged);
        assert!(body.contains("RoleLaunch::for_actor_stage(launch, resume,"), "a resume reopens the stage's session");
        let gate = &source[source.find("pub(crate) fn actor_stage_gate(").expect("an actor gate")..];
        let gate = &gate[..gate.find("\n}\n").unwrap()];
        let inputs = gate.find("gate_inputs(").expect("reads the version and settings");
        let applied = gate.find("actor_gate_on(").expect("applies the gate to the run");
        assert!(inputs < applied);
        assert!(!gate[inputs..applied].contains(".lock()"), "no lock while reading the CLI and settings");
    }

    // V4 (D17): the app's own resume launch, as `start_actor_stage` builds
    // it: the stage's session again (`--resume`, no new `--session-id`),
    // the same bridge flags and one merged `--settings`, the prompt last.
    #[test]
    fn an_actor_stage_resume_reopens_its_session_with_the_same_flags() {
        use crate::bridge::ResultKind;
        const SID: &str = "6a1d3b0f-2c3d-4e5f-9a51-0123456789ab";
        let flags = crate::bridge::launch::launch_flags(
            ResultKind::Planner,
            std::path::Path::new("/opt/dcterminal"),
            std::path::Path::new("/data/runs/ee_1"),
            "ee_1",
            "planner",
            "tab_p",
        );
        let launch = crate::run_actor::StageLaunch {
            run_id: "ee_1".into(),
            tab_id: "tab_p".into(),
            role_id: "role_custom_planner".into(),
            cwd: std::path::PathBuf::from("/work"),
            prompt: "Review findings from the Plan Reviewer (round 1), saved in /data/runs/ee_1/findings-plan_reviewer-r1.json".into(),
            session_id: SID.into(),
            bridge: Some(flags),
        };
        let build = |req: &TerminalLaunch| {
            Ok(crate::provider::ProgramArgs::new("claude", crate::provider::claude::claude_terminal_args(req)?))
        };
        let status = serde_json::json!({ "statusLine": { "type": "command", "command": "dct --dct-status-line f" } });
        let args_for = |resume: bool| {
            let role = RoleLaunch::for_actor_stage(&launch, resume, RunMode::Default, Some(crate::pipelines::StageKind::Planner), "opus");
            actor_stage_command(role.launch(Some(launch.prompt.clone())), Some(status.clone()), launch.bridge.clone(), build)
                .unwrap()
                .args
        };
        let args = args_for(true);
        let resume_at = args.iter().position(|a| a == "--resume").unwrap_or_else(|| panic!("resumes its session: {args:?}"));
        assert_eq!(args[resume_at + 1], SID, "the same session id");
        assert!(!args.iter().any(|a| a == "--session-id"), "no new session: {args:?}");
        let mode_at = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[mode_at + 1], "plan", "the stage kind's mode, as at its first launch");
        let at: Vec<usize> = args.iter().enumerate().filter(|(_, a)| *a == "--settings").map(|(i, _)| i).collect();
        assert_eq!(at.len(), 1, "exactly one --settings: {args:?}");
        let settings: serde_json::Value = serde_json::from_str(&args[at[0] + 1]).unwrap();
        assert!(settings["statusLine"]["command"].as_str().unwrap().contains("--dct-status-line"), "{settings}");
        assert!(settings["hooks"]["Stop"].is_array(), "the bridge's hooks: {settings}");
        assert_eq!(args.last(), Some(&launch.prompt), "the prompt is the resumed turn, last");
        // The same flags as its first launch, but for the session flag.
        let first = args_for(false);
        let strip = |args: &[String], flag: &str| {
            let mut out = args.to_vec();
            if let Some(i) = out.iter().position(|a| a == flag) {
                out.drain(i..i + 2);
            }
            out
        };
        assert_eq!(strip(&args, "--resume"), strip(&first, "--session-id"));
    }

    #[test]
    fn an_actor_stage_command_has_one_settings_with_the_status_line_and_the_hooks() {
        use crate::bridge::ResultKind;
        let flags = crate::bridge::launch::launch_flags(
            ResultKind::Reviewer,
            std::path::Path::new("/opt/dcterminal"),
            std::path::Path::new("/data/runs/ee_1"),
            "ee_1",
            "pr_reviewer",
            "tab_r",
        );
        let request = TerminalLaunch {
            kind: TerminalKind::Role {
                role_id: "role_custom_pr_check".into(),
                run_mode: RunMode::Default,
                prompt: Some("Review PR1.".into()),
                stage_kind: Some(crate::pipelines::StageKind::Reviewer),
            },
            model: None,
            session_id: Some("6a1d3b0f-2c3d-4e5f-9a51-0123456789cd".into()),
            settings: None,
        };
        let status = serde_json::json!({ "statusLine": { "type": "command", "command": "dct --dct-status-line f" } });
        let args = actor_stage_command(request, Some(status), Some(flags), |req| {
            Ok(crate::provider::ProgramArgs::new("claude", crate::provider::claude::claude_terminal_args(req)?))
        })
        .unwrap()
        .args;
        let at: Vec<usize> = args.iter().enumerate().filter(|(_, a)| *a == "--settings").map(|(i, _)| i).collect();
        assert_eq!(at.len(), 1, "exactly one --settings: {args:?}");
        let settings: serde_json::Value = serde_json::from_str(&args[at[0] + 1]).unwrap();
        assert!(settings["statusLine"]["command"].as_str().unwrap().contains("--dct-status-line"), "{settings}");
        assert!(settings["hooks"]["Stop"].is_array(), "{settings}");
        assert!(args.iter().any(|a| a == "--mcp-config"));
        assert_eq!(args.last().map(String::as_str), Some("Review PR1."), "the prompt stays last");
        // Unbridged (the gate said engine 1): the status line alone.
        let request = TerminalLaunch {
            kind: TerminalKind::Role { role_id: "r".into(), run_mode: RunMode::Default, prompt: Some("P".into()), stage_kind: None },
            model: None,
            session_id: None,
            settings: None,
        };
        let args = actor_stage_command(request, Some(serde_json::json!({ "statusLine": {} })), None, |req| {
            Ok(crate::provider::ProgramArgs::new("claude", crate::provider::claude::claude_terminal_args(req)?))
        })
        .unwrap()
        .args;
        assert!(!args.iter().any(|a| a == "--mcp-config"));
        assert_eq!(args.iter().filter(|a| *a == "--settings").count(), 1);
    }

    #[derive(Default)]
    struct Recorded(std::cell::RefCell<Vec<String>>);

    impl crate::commands::chain_events::ChainEvents for Recorded {
        fn chain_run_updated(&self, chain_id: &str) {
            self.0.borrow_mut().push(chain_id.to_string());
        }
    }

    fn start_input(role_id: &str, tab_id: Option<&str>, start_chain: Option<&str>) -> RoleTerminalInput {
        serde_json::from_value(serde_json::json!({
            "roleId": role_id, "values": { "cwd": "/repo" }, "tabId": tab_id, "handoffPlan": null,
            "cols": 80, "rows": 24, "startChain": start_chain
        }))
        .unwrap()
    }

    fn draft_tab(store: &Mutex<StateStore>, role_id: &str) -> String {
        let role = crate::test_support::role(role_id, role_id);
        store.lock().unwrap().create_draft_tab(&role, "/repo", true, None).unwrap()
    }

    #[test]
    fn a_lane_implementer_started_with_no_chain_is_bridged_from_the_lane_chain_its_tab_holds() {
        let dir = crate::test_support::TempDir::new("plan_start_lane");
        let store = store_with_engine2_run(&dir);
        let tab = draft_tab(&store, "role_implementer");
        {
            let mut state = store.lock().unwrap();
            let run = state.pipeline_run_by_id_mut("ee_1700000000000").unwrap();
            run.lanes = serde_json::from_value(serde_json::json!([
                { "id": "pr1", "title": "PR1", "status": "active" }
            ]))
            .unwrap();
            state.data.tabs.iter_mut().find(|t| t.id == tab).unwrap().chain = Some(
                serde_json::from_value(serde_json::json!({
                    "chainId": "ee_1700000000000", "kind": "eagle1", "step": 3, "total": 4, "lane": "pr1"
                }))
                .unwrap(),
            );
        }
        // As laneStartTerminal sends it: no chain, no startChain.
        let input = start_input("role_implementer", Some(&tab), None);
        let (starting, plan) = plan_start(&store, &input, "role_implementer", true).unwrap();
        assert_eq!(starting, None);
        let plan = plan.expect("the lane's Implementer launches bridged");
        assert_eq!(plan.kind, crate::bridge::ResultKind::Implementer);
        assert_eq!(plan.stage_key, "implementer@pr1");
        assert_eq!(plan.lane.as_deref(), Some("pr1"));
        assert_eq!(plan.run_id, "ee_1700000000000");
        // Off Claude, nothing is bridged.
        assert_eq!(plan_start(&store, &input, "role_implementer", false).unwrap().1, None);
    }

    #[test]
    fn a_form_start_with_start_chain_plans_and_labels_its_first_stage_as_a_new_engine_2_run() {
        let dir = crate::test_support::TempDir::new("plan_start_new_chain");
        let store = store_with_engine2_run(&dir);
        let tab = draft_tab(&store, "role_planner");
        let input = start_input("role_planner", Some(&tab), Some("eagle1"));
        let (starting, plan) = plan_start(&store, &input, "role_planner", true).unwrap();
        let chain = starting.expect("the start begins a chain");
        assert!(chain.chain_id.starts_with("ee_"), "{chain:?}");
        assert_eq!((chain.kind.as_str(), chain.step), ("eagle1", 1));
        let plan = plan.expect("the first stage launches bridged");
        assert_eq!(plan.run_id, chain.chain_id);
        assert_eq!(plan.kind, crate::bridge::ResultKind::Planner);
        assert!(!plan.autopilot);
        // Labelled before the spawn: the run exists, engine 2, autopilot off.
        let events = Recorded::default();
        let started = label_starting_chain(&events, &store, &tab, chain.clone(), None).unwrap().expect("labelled");
        assert!(started.made_run);
        let state = store.lock().unwrap();
        let run = state.pipeline_run_by_id(&chain.chain_id).expect("run made");
        assert_eq!(run.engine, crate::bridge::launch::ENGINE_V2);
        assert!(!run.autopilot.as_ref().is_some_and(|a| a.enabled));
        assert_eq!(state.tab_by_id(&tab).unwrap().chain.as_ref().map(|c| c.chain_id.clone()), Some(chain.chain_id.clone()));
        assert_eq!(*events.0.borrow(), vec![chain.chain_id.clone()]);
    }

    /// F3: a size-L start from the form begins Eagle-Eye L, its Analyst
    /// launches bridged as an artifact stage, and the run keeps the size;
    /// a size that is not the pipeline's is not kept.
    #[test]
    fn a_size_l_start_begins_eagle_eye_l_and_the_run_keeps_its_size() {
        let dir = crate::test_support::TempDir::new("plan_start_size_l");
        let store = store_with_engine2_run(&dir);
        let tab = draft_tab(&store, "role_analyst");
        let mut input = start_input("role_analyst", Some(&tab), Some("eagle-eye-l"));
        input.size = Some("L".into());
        let (starting, plan) = plan_start(&store, &input, "role_analyst", true).unwrap();
        let chain = starting.expect("the start begins Eagle-Eye L");
        assert_eq!((chain.kind.as_str(), chain.total), ("eagle-eye-l", 7));
        assert_eq!(plan.expect("bridged").kind, crate::bridge::ResultKind::Artifact);
        let started = label_starting_chain(&Recorded::default(), &store, &tab, chain.clone(), None).unwrap().unwrap();
        record_size(&store, started.run_id.as_deref(), input.size.as_deref()).unwrap();
        {
            let state = store.lock().unwrap();
            let run = state.pipeline_run_by_id(&chain.chain_id).unwrap();
            assert_eq!((run.engine, run.size.as_deref()), (crate::bridge::launch::ENGINE_V2, Some("L")));
        }
        record_size(&store, started.run_id.as_deref(), Some("S")).unwrap();
        let state = store.lock().unwrap();
        assert_eq!(state.pipeline_run_by_id(&chain.chain_id).unwrap().size.as_deref(), Some("L"), "S is not Eagle-Eye L's size");
    }

    #[test]
    fn a_tab_already_in_a_chain_ignores_start_chain() {
        let dir = crate::test_support::TempDir::new("plan_start_chained");
        let store = store_with_engine2_run(&dir);
        let tab = draft_tab(&store, "role_planner");
        let held: crate::store::ChainRef = serde_json::from_value(serde_json::json!({
            "chainId": "ee_1700000000000", "kind": "eagle1", "step": 1, "total": 4
        }))
        .unwrap();
        store.lock().unwrap().data.tabs.iter_mut().find(|t| t.id == tab).unwrap().chain = Some(held.clone());
        let input = start_input("role_planner", Some(&tab), Some("eagle1"));
        let (starting, plan) = plan_start(&store, &input, "role_planner", true).unwrap();
        assert_eq!(starting, None, "no new chain");
        assert_eq!(plan.map(|p| p.run_id), Some("ee_1700000000000".to_string()), "its own run's Planner");
        // A label raced in after planning: the start leaves it alone.
        let fresh = crate::bridge::launch::new_chain(&crate::pipelines::find("eagle1").unwrap(), "eagle1", 5);
        assert_eq!(label_starting_chain(&Recorded::default(), &store, &tab, fresh, None).unwrap(), None);
        assert_eq!(store.lock().unwrap().tab_by_id(&tab).unwrap().chain, Some(held));
    }

    #[test]
    fn an_older_claude_code_on_a_new_chain_records_engine_1_on_the_run_it_makes() {
        let dir = crate::test_support::TempDir::new("label_new_chain_gate");
        let store = store_with_engine2_run(&dir);
        let tab = draft_tab(&store, "role_planner");
        let chain = crate::bridge::launch::new_chain(&crate::pipelines::find("eagle1").unwrap(), "eagle1", 6);
        let gate = crate::bridge::gate::decide(Some("2.1.200 (Claude Code)"), None);
        label_starting_chain(&Recorded::default(), &store, &tab, chain.clone(), Some((gate, "planner".into())))
            .unwrap()
            .unwrap();
        let saved = StateStore::open_path(dir.join("state.json")).unwrap();
        let run = saved.pipeline_run_by_id(&chain.chain_id).unwrap();
        assert_eq!(run.engine, 1);
        assert!(run.engine_note.as_deref().unwrap().contains("2.1.200"));
    }

    #[test]
    fn a_start_that_fails_after_labelling_a_new_chain_leaves_no_run_behind() {
        let dir = crate::test_support::TempDir::new("failed_start_new_chain");
        let store = store_with_engine2_run(&dir);
        let runs = dir.join("runs");
        let tab = draft_tab(&store, "role_planner");
        let chain = crate::bridge::launch::new_chain(&crate::pipelines::find("eagle1").unwrap(), "eagle1", 8);
        let events = Recorded::default();
        let started = label_starting_chain(&events, &store, &tab, chain.clone(), None).unwrap().unwrap();
        // The run folder was written, then the spawn failed.
        let plan = crate::bridge::launch::plan_for_new_run(&crate::pipelines::find("eagle1").unwrap(), &chain, "role_planner")
            .unwrap();
        crate::bridge::launch::prepare_stage(&runs, &plan, &tab).unwrap();
        store
            .lock()
            .unwrap()
            .set_tab_bridge(&tab, Some(crate::bridge::BridgeTag { run_id: plan.run_id.clone(), stage: plan.stage_key.clone() }))
            .unwrap();
        let failed: Result<(), String> =
            after_starting_label(&events, &store, &tab, Some(&started), || Some(runs.clone()), || Err("spawn failed".into()));
        assert_eq!(failed, Err("spawn failed".to_string()));
        let saved = StateStore::open_path(dir.join("state.json")).unwrap();
        assert!(saved.pipeline_run_by_id(&chain.chain_id).is_none(), "no run left behind");
        let record = saved.tab_by_id(&tab).unwrap();
        assert_eq!(record.chain, None, "the tab left the chain");
        assert_eq!(record.bridge, None, "and holds no stage");
        assert!(!runs.join(&chain.chain_id).exists(), "its run folder is gone");
        assert!(saved.pipeline_run_by_id("ee_1700000000000").is_some(), "other runs stay");
        assert_eq!(events.0.borrow().last(), Some(&chain.chain_id), "its overview refetches");
        // A success keeps the label.
        let other = draft_tab(&store, "role_planner");
        let chain = crate::bridge::launch::new_chain(&crate::pipelines::find("eagle1").unwrap(), "eagle1", 9);
        let started = label_starting_chain(&events, &store, &other, chain.clone(), None).unwrap().unwrap();
        after_starting_label(&events, &store, &other, Some(&started), || None, || Ok(())).unwrap();
        assert!(store.lock().unwrap().pipeline_run_by_id(&chain.chain_id).is_some());
    }

    #[test]
    fn a_start_with_clickup_tickets_writes_tickets_json_into_the_run_folder_before_the_spawn() {
        let source = include_str!("mod.rs");
        let body = &source[source.find("fn role_terminal_start_blocking(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let take = body.find("take_pending(").expect("takes the window account's snapshot");
        let merge = body.find("merge_role_prompt_with(").expect("merges the prompt");
        assert!(take < merge, "the note is in the form before it merges");
        let undo = body.find("after_starting_label(").unwrap();
        let prepare = body.find("prepare_stage(").unwrap();
        let write = body.find("write_snapshot(").expect("writes tickets.json");
        let spawn = body.find("open_session_to(").unwrap();
        assert!(
            undo < prepare && prepare < write && write < spawn,
            "written in the run folder, under the undo, before the stage starts"
        );
        // Only a bridged start of a new run gets a run folder for it.
        let run_dir = &body[take..merge];
        assert!(run_dir.contains("(Some(plan), Some(_))"), "{run_dir}");
        // L1: a start that joined a chain meanwhile swaps the note for the request summary.
        let label = body.find("label_starting_chain(").unwrap();
        let swap = body.find("without_run()").expect("swaps the note when no run is made");
        assert!(label < swap && swap < undo && body[swap..undo].contains("swap_tab_note("));
    }

    #[test]
    fn role_terminal_start_runs_everything_after_the_chain_label_under_its_undo() {
        let source = include_str!("mod.rs");
        let body = &source[source.find("fn role_terminal_start_blocking(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let label = body.find("label_starting_chain(").expect("labels the chain");
        let undo = body.find("after_starting_label(").expect("undoes the label on a failure");
        assert!(label < undo);
        for step in ["prepare_stage(", "set_tab_bridge(", "store_prompt(", "bridged_command(", "open_session_to("] {
            assert!(body.find(step).expect(step) > undo, "{step} runs under the undo");
        }
    }

    #[test]
    fn a_failed_start_keeps_a_run_something_else_holds() {
        let dir = crate::test_support::TempDir::new("failed_start_held_run");
        let store = store_with_engine2_run(&dir);
        let tab = draft_tab(&store, "role_planner");
        let chain = crate::bridge::launch::new_chain(&crate::pipelines::find("eagle1").unwrap(), "eagle1", 10);
        let events = Recorded::default();
        let started = label_starting_chain(&events, &store, &tab, chain.clone(), None).unwrap().unwrap();
        // Another tab joined the run meanwhile.
        let reviewer = draft_tab(&store, "role_plan_reviewer");
        let mut step2 = chain.clone();
        step2.step = 2;
        store.lock().unwrap().set_tab_chain(&reviewer, Some(step2), Some("the plan")).unwrap();
        let _ = after_starting_label(&events, &store, &tab, Some(&started), || None, || Err::<(), _>("no".into()));
        let state = store.lock().unwrap();
        assert!(state.pipeline_run_by_id(&chain.chain_id).is_some(), "held by the other tab");
        assert_eq!(state.tab_by_id(&tab).unwrap().chain, None, "the failed tab still leaves it");
        drop(state);
        // A run that existed before the label is never removed.
        let tab2 = draft_tab(&store, "role_planner");
        let existing = StartedChain { chain_id: "ee_1700000000000".into(), run_id: Some("ee_1700000000000".into()), made_run: false };
        let _ = after_starting_label(&events, &store, &tab2, Some(&existing), || None, || Err::<(), _>("no".into()));
        assert!(store.lock().unwrap().pipeline_run_by_id("ee_1700000000000").is_some());
    }

    #[test]
    fn a_bridged_restart_runs_the_same_gate_before_it_relaunches_bridged() {
        let source = include_str!("mod.rs");
        let body = &source[source.find("fn pty_open_blocking(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let inputs = body.find("gate_inputs(").expect("restart reads the version and settings");
        let gate = body.find("gate_run(").expect("restart applies the gate");
        let flags = body.find("relaunch_flags(").expect("relaunch flags");
        assert!(inputs < gate && gate < flags, "the gate decides before the bridge flags are built");
    }

    #[test]
    fn a_relaunch_reads_the_tab_s_last_finished_turn_under_its_v1_key() {
        let dir = crate::test_support::TempDir::new("last_turn_key");
        let config = dir.join("claude-config");
        assert!(config.starts_with(dir.path()), "pinned to the temp dir");
        let sid = "7a1b2c3d-4e5f-4a6b-8c7d-0123456789ab";
        let folder = config.join("projects").join("-tmp-p");
        std::fs::create_dir_all(&folder).unwrap();
        let record = |kind: &str, at: &str, message: serde_json::Value| {
            serde_json::json!({ "parentUuid": null, "isSidechain": false, "type": kind, "uuid": format!("u-{at}"),
                "timestamp": at, "cwd": "/tmp/p", "sessionId": sid, "version": "2.1.0", "message": message })
        };
        let prompt = record("user", "2026-10-19T10:00:00Z", serde_json::json!({ "role": "user", "content": "Review" }));
        let reply = record("assistant", "2026-10-19T10:01:00Z", serde_json::json!({ "id": "m1", "type": "message",
            "role": "assistant", "model": "t", "content": [{ "type": "text", "text": "Done." }], "stop_reason": "end_turn" }));
        let target = (config.clone(), sid.to_string());
        std::fs::write(folder.join(format!("{sid}.jsonl")), format!("{prompt}\n")).unwrap();
        assert_eq!(last_turn_key("tab_r", Some(&target)), None, "a turn still running is not decided");
        std::fs::write(folder.join(format!("{sid}.jsonl")), format!("{prompt}\n{reply}\n")).unwrap();
        let key = last_turn_key("tab_r", Some(&target)).expect("finished turn");
        assert!(key.starts_with(&format!("tab_r|{sid}|")), "{key}");
        assert_eq!(last_turn_key("tab_r", None), None);
    }

    #[test]
    fn the_relaunch_gate_respects_engine_1_and_switches_when_hooks_were_turned_off() {
        let dir = crate::test_support::TempDir::new("gate_relaunch");
        let store = store_with_engine2_run(&dir);
        let run_id = "ee_1700000000000";
        let ok = Some("2.1.287 (Claude Code)");
        let decided_key = Some("tab_r|6a1d3b0f-2c3d-4e5f-9a51-0123456789cd|2026-10-20T10:00:00Z");
        assert!(gate_run(&store, run_id, "pr_reviewer", ok, None, decided_key).unwrap().bridged, "still bridged");
        let events_before = store.lock().unwrap().pipeline_run_by_id(run_id).unwrap().events.len();
        // Hooks turned off since the first launch (a Resume mid-run): engine
        // 1 with a notice, and autopilot off, so the turn the bridge already
        // decided is never decided again the v1 way.
        let off = crate::bridge::gate::HooksOff { file: dir.join("settings.json"), setting: "disableAllHooks" };
        let gated = gate_run(&store, run_id, "pr_reviewer@pr1", ok, Some(&off), decided_key).unwrap();
        assert_eq!(gated, GateRun { bridged: false, manual_now: true });
        {
            let state = store.lock().unwrap();
            let run = state.pipeline_run_by_id(run_id).unwrap();
            assert_eq!(run.engine, 1);
            assert_eq!(run.events.last().unwrap().stage_id.as_deref(), Some("pr_reviewer"));
            let note = run.engine_note.as_deref().unwrap();
            assert!(note.contains("disableAllHooks") && note.contains("manual from now on"), "{note}");
            assert!(!run.autopilot.as_ref().unwrap().enabled, "autopilot is off");
            assert_eq!(run.status, crate::store::RunStatus::Stopped);
            assert_eq!(run.stop_reason, None, "not paused_by_you: the note says why");
            // One Timeline note, the manual one (not the engine-1 notice).
            let added: Vec<(&str, &str)> =
                run.events[events_before..].iter().map(|e| (e.kind.as_str(), e.summary.as_str())).collect();
            assert_eq!(added, vec![("note", note)], "{added:?}");
            assert!(run.manual_only, "manual for good");
            // Belt and braces: the tab's current turn counts as decided under its v1 key too.
            assert!(run.autopilot.as_ref().unwrap().decided.iter().any(|k| Some(k.as_str()) == decided_key));
            let saved = StateStore::open_path(dir.join("state.json")).unwrap();
            assert!(!saved.pipeline_run_by_id(run_id).unwrap().autopilot.as_ref().unwrap().enabled, "saved");
        }
        // Autopilot cannot be turned back on for a run made manual this way.
        {
            let mut state = store.lock().unwrap();
            let err = crate::commands::pipeline::set_autopilot(&mut state, run_id, true).unwrap_err();
            assert!(err.contains("manual from now on"), "{err}");
            assert!(!state.pipeline_run_by_id(run_id).unwrap().autopilot.as_ref().unwrap().enabled);
        }
        // An engine-1 run never relaunches bridged, whatever the CLI.
        assert_eq!(gate_run(&store, run_id, "pr_reviewer", ok, None, None).unwrap(), GateRun::default());
        assert_eq!(gate_run(&store, "ee_missing", "pr_reviewer", ok, None, None).unwrap(), GateRun::default());
    }

    /// A pipeline of your own: a copy of the Planner (Settings › Roles ›
    /// Duplicate) as stage 1, then the built-in Planner on a generic stage.
    fn copied_planner_pipeline(id: &str) -> crate::pipelines::PipelineDef {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": "Copied planner",
            "stages": [
                { "id": "plan", "roleId": "role_custom_planner", "title": "Planner copy", "kind": "planner" },
                { "id": "notes", "roleId": "role_planner", "title": "Notes", "kind": "generic" }
            ]
        }))
        .unwrap()
    }

    fn on_chain(kind: &str, step: u32) -> crate::store::ChainRef {
        serde_json::from_value(serde_json::json!({
            "chainId": "ee_9", "kind": kind, "step": step, "total": 2
        }))
        .unwrap()
    }

    fn mode_of(role_id: &str, stage_kind: Option<crate::pipelines::StageKind>) -> String {
        let args = crate::provider::claude::claude_terminal_args(&TerminalLaunch {
            kind: TerminalKind::Role {
                role_id: role_id.into(),
                run_mode: RunMode::Default,
                prompt: None,
                stage_kind,
            },
            model: None,
            session_id: None,
            settings: None,
        })
        .unwrap();
        let at = args.iter().position(|a| a == "--permission-mode").unwrap();
        args[at + 1].clone()
    }

    // Review H4 (MEDIUM): a copied Planner on a pipeline launched in `auto`,
    // because the permission mode was keyed on the role id.
    #[test]
    fn a_pipeline_stage_launches_in_its_kind_s_permission_mode() {
        use crate::pipelines::{register_for_test, unregister_for_test, StageKind};
        let id = "copied_planner_launch_test";
        register_for_test(copied_planner_pipeline(id));
        let dir = crate::test_support::TempDir::new("stage_kind_launch");
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: crate::store::AppStateFile::default(),
            new_tab_provider: ProviderId::DEFAULT,
            draft_window: crate::store::MAIN_WINDOW_ID.to_string(),
        };
        let role = crate::test_support::role("role_custom_planner", "Planner copy");
        let first = store.create_draft_tab(&role, "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&first, Some(on_chain(id, 1)), None).unwrap();
        let plain = store.create_draft_tab(&role, "/tmp/p", true, None).unwrap();

        // Stage 1 is tagged before it starts: its tab's chain says planner.
        let first_kind = launch_stage_kind(&store, Some(&first), None);
        // A hand-off's new tab is tagged after the start: the chain it joins says.
        let notes_kind = launch_stage_kind(&store, None, Some(&on_chain(id, 2)));
        let joining_wins = launch_stage_kind(&store, Some(&first), Some(&on_chain(id, 2)));
        let off_pipeline = launch_stage_kind(&store, Some(&plain), None);
        unregister_for_test(id);

        assert_eq!(first_kind, Some(StageKind::Planner));
        assert_eq!(notes_kind, Some(StageKind::Generic));
        assert_eq!(joining_wins, Some(StageKind::Generic));
        assert_eq!(off_pipeline, None);
        assert_eq!(mode_of("role_custom_planner", first_kind), "plan", "the copy plans like the built-in");
        assert_eq!(mode_of("role_planner", notes_kind), "auto", "the kind decides, not the role id");
        // Off a pipeline the built-in Planner still plans, and a copy does not.
        assert_eq!(mode_of("role_planner", None), "plan");
        assert_eq!(mode_of("role_custom_planner", off_pipeline), "auto");
        // Cursor follows the kind too.
        assert_eq!(
            crate::pty::launch::role_terminal_flags("role_custom_planner", first_kind, RunMode::Default)[0],
            "--plan"
        );
        // Chat: the session mode, and the plan card for its ExitPlanMode.
        assert_eq!(crate::provider::claude::claude_role_mode("role_custom_planner", first_kind), "plan");
        assert_eq!(
            crate::provider::claude::claude_role_mode("role_planner", notes_kind),
            "bypassPermissions"
        );
    }

    // Review H4 round 2: the start, restart and resume paths build their
    // launch with `RoleLaunch::for_tab`, which looks the stage kind up.
    #[test]
    fn start_restart_and_resume_of_a_copied_planner_stage_launch_in_plan_mode() {
        use crate::pipelines::{register_for_test, unregister_for_test};
        const SESSION: &str = "11111111-2222-4333-8444-555555555555";
        let id = "copied_planner_paths_test";
        register_for_test(copied_planner_pipeline(id));
        let dir = crate::test_support::TempDir::new("stage_kind_paths");
        let mut state = StateStore {
            path: dir.join("state.json"),
            data: crate::store::AppStateFile::default(),
            new_tab_provider: ProviderId::DEFAULT,
            draft_window: crate::store::MAIN_WINDOW_ID.to_string(),
        };
        let role = crate::test_support::role("role_custom_planner", "Planner copy");
        let tagged = state.create_draft_tab(&role, "/tmp/p", true, None).unwrap();
        state.set_tab_chain(&tagged, Some(on_chain(id, 1)), None).unwrap();
        let store = Mutex::new(state);
        let mode = |tab: Option<&str>, joining: Option<&crate::store::ChainRef>, role_id: &str, resume: Option<&str>| {
            let launch = RoleLaunch::for_tab(
                &store,
                tab,
                joining,
                role_id,
                RunMode::Default,
                "default",
                Some(SESSION.to_string()),
                resume.map(str::to_string),
            )
            .unwrap()
            .launch(None);
            let args = crate::provider::claude::claude_terminal_args(&launch).unwrap();
            let at = args.iter().position(|a| a == "--permission-mode").unwrap();
            (args[at + 1].clone(), args.contains(&"--resume".to_string()))
        };
        // A start (pipeline first stage) and a restart: the tab's own chain.
        let started = mode(Some(&tagged), None, "role_custom_planner", None);
        // A resume after a crash keeps the stage's mode.
        let resumed = mode(Some(&tagged), None, "role_custom_planner", Some(SESSION));
        // A hand-off's new tab: the chain it is about to join.
        let handed = mode(None, Some(&on_chain(id, 1)), "role_custom_planner", None);
        let notes = mode(None, Some(&on_chain(id, 2)), "role_planner", None);
        let untagged = mode(None, None, "role_custom_planner", None);
        unregister_for_test(id);
        assert_eq!(started, ("plan".to_string(), false));
        assert_eq!(resumed, ("plan".to_string(), true));
        assert_eq!(handed, ("plan".to_string(), false));
        assert_eq!(notes.0, "auto", "the built-in Planner on a generic stage");
        assert_eq!(untagged.0, "auto", "off a pipeline a copy does not plan");
    }

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
            None,
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
        replace_detached(&registry, "p", sh_spec(dir.path(), "printf 'resumed planner'; read line; exit 5"), None, None, new_exit, RESUME_STOP_GRACE)
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
        let grace = Duration::from_millis(200);
        replace_detached(&registry, "s", sh_spec(dir.path(), "sleep 5"), None, None, new_exit, grace).unwrap();
        let took = began.elapsed();
        assert!(took >= grace, "it waited the grace out first");
        // The SIGKILL is the resume's own: S1's stop-on-drop would only kill
        // the old program after STOP_GRACE (1.5 s) more.
        let backstop = grace + crate::process_tree::STOP_GRACE / 2;
        assert!(took < backstop, "the resume killed it at the grace, not S1's backstop: took {took:?}");
        assert!(!old.running(), "then killed it");
        assert!(registry.lock().unwrap().running("s"), "and started the new program");
        registry.lock().unwrap().shutdown_all();
    }

    // V5: a hidden stage has no view, so "Close window?" asks the backend.
    #[cfg(unix)]
    #[test]
    fn running_of_names_the_terminals_whose_program_runs_with_or_without_a_view() {
        let dir = crate::test_support::TempDir::new("pty_running_of");
        let registry = Mutex::new(PtyRegistry::new());
        let (on_exit, _exits) = exit_probe();
        open_session_to(&registry, "hidden", sh_spec(dir.path(), "sleep 5"), None, None, Output::Detached { on_exit, view: None })
            .unwrap();
        let ids = vec!["hidden".to_string(), "never".to_string()];
        assert_eq!(registry.lock().unwrap().running_of(&ids), vec!["hidden".to_string()]);
        registry.lock().unwrap().kill("hidden");
        assert!(registry.lock().unwrap().running_of(&ids).is_empty());
    }

    // V5 with V4: a resumed stage reports through the stage folder it is
    // given. One the D24 gate sent to engine 1 resumes unbridged, so the
    // keystroke gate no longer reads its old `mode` file.
    #[cfg(unix)]
    #[test]
    fn a_resume_records_the_stage_folder_it_runs_under() {
        let dir = crate::test_support::TempDir::new("pty_resume_stage_dir");
        let stage = dir.join("stage");
        let registry = Mutex::new(PtyRegistry::new());
        let (old_exit, _old) = exit_probe();
        open_session_to(&registry, "s", sh_spec(dir.path(), "sleep 5"), None, Some(stage.clone()), Output::Detached { on_exit: old_exit, view: None })
            .unwrap();
        assert_eq!(registry.lock().unwrap().input_gate("s").0, Some(stage.clone()));
        let (again, _again) = exit_probe();
        replace_detached(&registry, "s", sh_spec(dir.path(), "sleep 5"), None, Some(stage.clone()), again, Duration::from_millis(200))
            .unwrap();
        assert_eq!(registry.lock().unwrap().input_gate("s").0, Some(stage), "a bridged resume keeps its stage folder");
        let (unbridged, _unbridged) = exit_probe();
        replace_detached(&registry, "s", sh_spec(dir.path(), "sleep 5"), None, None, unbridged, Duration::from_millis(200))
            .unwrap();
        assert_eq!(registry.lock().unwrap().input_gate("s").0, None, "an unbridged resume has none");
        registry.lock().unwrap().kill("s");
    }

    #[test]
    fn every_bridged_launch_records_its_stage_folder() {
        let source = include_str!("mod.rs");
        let body = |name: &str| {
            let body = &source[source.find(name).expect(name)..];
            body[..body.find("\n}\n").unwrap()].to_string()
        };
        let start = body("fn role_terminal_start_blocking(");
        assert!(start.contains("stage_dir_of(") && start.contains("stage_dir,\n            Output::View(on_output)"), "a role terminal's start");
        let actor = body("pub(crate) fn start_actor_stage(");
        assert!(actor.contains("stage_dir_of("), "an actor stage");
        assert!(actor.contains("replace_detached(&registry, tab_id, spec, session, stage_dir,"), "an actor stage's resume");
        assert!(actor.contains("open_session_to(&registry, tab_id, spec, session, stage_dir,"), "an actor stage's first launch");
        let open = body("fn pty_open_blocking(");
        assert!(open.contains("stage_dir = crate::bridge::launch::stage_dir_of(") && open.contains("stage_dir,\n        Output::View(on_output)"), "a relaunch");
    }

    // A resume whose new program cannot start leaves no live-looking view:
    // the view hears the stage ended.
    #[cfg(unix)]
    #[test]
    fn a_resume_that_cannot_start_tells_the_view_the_program_ended() {
        let dir = crate::test_support::TempDir::new("pty_resume_spawn_fails");
        let missing = SpawnSpec { program: dir.join("no-such-claude").display().to_string(), ..sh_spec(dir.path(), "true") };
        // A stage the actor started, with a view attached.
        let registry = Mutex::new(PtyRegistry::new());
        let (old_exit, _old_exits) = exit_probe();
        let script = "trap 'exit 143' TERM\nprintf 'old program'\nwhile :; do sleep 0.05; done";
        open_session_to(&registry, "s", sh_spec(dir.path(), script), None, None, Output::Detached { on_exit: old_exit, view: None })
            .unwrap();
        let (view, seen) = recording_view();
        loop {
            attach_detached(&registry, "s", &view, None).unwrap();
            if seen.lock().unwrap().iter().any(|p| p.1.contains("old program")) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let (new_exit, _new_exits) = exit_probe();
        let result = replace_detached(&registry, "s", missing.clone(), None, None, new_exit, RESUME_STOP_GRACE);
        assert!(result.is_err(), "{result:?}");
        wait_seen(&seen, "the stage's view hears it ended", |p| p.0 == "exit");
        // A terminal you opened yourself (its own view).
        let (own, own_seen) = recording_view();
        open_session(&registry, "p", sh_spec(dir.path(), script), None, own).unwrap();
        wait_seen(&own_seen, "the view streams it", |p| p.1.contains("old program"));
        let (new_exit, _new_exits) = exit_probe();
        let result = replace_detached(&registry, "p", missing, None, None, new_exit, RESUME_STOP_GRACE);
        assert!(result.is_err(), "{result:?}");
        wait_seen(&own_seen, "your view hears it ended", |p| p.0 == "exit");
        registry.lock().unwrap().shutdown_all();
    }

    // Closing the tab while a resume waits for the old program to stop
    // cancels the resume: no `claude --resume` runs for a closed tab.
    #[cfg(unix)]
    #[test]
    fn closing_a_stage_while_it_is_resumed_starts_nothing() {
        let dir = crate::test_support::TempDir::new("pty_resume_closed");
        let registry = Arc::new(Mutex::new(PtyRegistry::new()));
        let ready = dir.join("ready");
        let started = dir.join("started");
        let script = format!("trap 'sleep 0.5; exit 0' TERM\ntouch '{}'\nwhile :; do sleep 0.05; done", ready.display());
        let (old_exit, _old_exits) = exit_probe();
        open_session_to(&registry, "s", sh_spec(dir.path(), &script), None, None, Output::Detached { on_exit: old_exit, view: None })
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(std::time::Instant::now() < deadline, "the old program is ready");
            thread::sleep(Duration::from_millis(20));
        }
        let resuming = {
            let registry = registry.clone();
            let spec = sh_spec(dir.path(), &format!("touch '{}'; sleep 5", started.display()));
            thread::spawn(move || {
                let (new_exit, _new_exits) = exit_probe();
                replace_detached(&registry, "s", spec, Some("sid".into()), None, new_exit, RESUME_STOP_GRACE)
            })
        };
        thread::sleep(Duration::from_millis(150));
        registry.lock().unwrap().kill("s");
        let result = resuming.join().unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(result.is_err(), "closed tab got a resumed program anyway: {result:?}");
        assert!(!started.exists(), "the resumed program never ran");
        let registry = registry.lock().unwrap();
        assert!(!registry.sessions.contains_key("s") && !registry.claude_sessions.contains_key("s"));
    }

    // Your own Restart of the tab while a resume waits for the old program to
    // stop takes over: the resume starts nothing and says so, so the run
    // actor puts the stage's turn back and stops the run instead of counting
    // a round that never reached the stage.
    #[cfg(unix)]
    #[test]
    fn a_restart_while_a_stage_is_resumed_makes_the_resume_fail() {
        let dir = crate::test_support::TempDir::new("pty_resume_superseded");
        let registry = Arc::new(Mutex::new(PtyRegistry::new()));
        let ready = dir.join("ready");
        let started = dir.join("started");
        let restarted = dir.join("restarted");
        let script = format!("trap 'sleep 0.5; exit 0' TERM\ntouch '{}'\nwhile :; do sleep 0.05; done", ready.display());
        let (old_exit, _old_exits) = exit_probe();
        open_session_to(&registry, "s", sh_spec(dir.path(), &script), None, None, Output::Detached { on_exit: old_exit, view: None })
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(std::time::Instant::now() < deadline, "the old program is ready");
            thread::sleep(Duration::from_millis(20));
        }
        let resuming = {
            let registry = registry.clone();
            let spec = sh_spec(dir.path(), &format!("touch '{}'; sleep 5", started.display()));
            thread::spawn(move || {
                let (new_exit, _new_exits) = exit_probe();
                replace_detached(&registry, "s", spec, Some("sid".into()), None, new_exit, RESUME_STOP_GRACE)
            })
        };
        thread::sleep(Duration::from_millis(150));
        let (restart_exit, _restart_exits) = exit_probe();
        let spec = sh_spec(dir.path(), &format!("touch '{}'; sleep 5", restarted.display()));
        open_session_to(&registry, "s", spec, None, None, Output::Detached { on_exit: restart_exit, view: None }).unwrap();
        let result = resuming.join().unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(result.is_err(), "a resume your Restart replaced reports success: {result:?}");
        assert!(!started.exists(), "the resumed program never ran");
        assert!(restarted.exists(), "your Restart runs");
        assert!(registry.lock().unwrap().sessions.contains_key("s"));
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
        replace_detached(&registry, "s", sh_spec(dir.path(), "printf 'back again'; sleep 5"), None, None, new_exit, RESUME_STOP_GRACE)
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
