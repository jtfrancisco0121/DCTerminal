//! `fake_claude`: a stand-in for Claude Code's terminal session, for tests.
//! It never talks to a model. It follows a JSON scenario, draws a rough
//! screen to its terminal, and writes the session log the app reads
//! (`claude_session_log`). Run it in a PTY; `tests/fake_claude.rs` does.
//! Kept out of the app bundle by its `required-features` (see `Cargo.toml`).
//!
//! # Command line
//!
//! `fake_claude [--session-id <uuid> | --resume <uuid>] [--permission-mode <mode>]
//! [--model <id>] [<startup prompt>]`
//!
//! `--settings <json>` and `--mcp-config <json>` (inline JSON, or a file
//! holding it) give the hooks and MCP servers, as below. Other flags are
//! ignored. Those Claude Code gives a value (`--allowedTools <tools>`, …,
//! see `VALUE_FLAGS`) skip their value; any other unknown flag is taken as a
//! switch, so give it as `--flag=value`. Without `--session-id` or
//! `--resume` a new id is made up.
//! `--session-id` of an existing log and `--resume` of a missing one are
//! refused (exit 1), as Claude Code does.
//!
//! # Environment
//!
//! - `CLAUDE_CONFIG_DIR` (required): the log goes to
//!   `$CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<sessionId>.jsonl`. Unset,
//!   empty, or a path with a `.claude*` component (a real account) exits 2
//!   before anything is written. There is no `~/.claude` fallback.
//! - `DCT_FAKE_CLAUDE_SCENARIO` (required): the scenario file's path.
//!
//! The encoded cwd swaps every character other than an ASCII letter or digit
//! for `-` (`/private/tmp/a.b` → `-private-tmp-a-b`), as Claude Code does:
//! one `-` per UTF-16 unit, so an emoji gives two (`x😀y` → `x--y`).
//! The app's reader finds a log by `projects/*/<sessionId>.jsonl`, so it has
//! no encoding of its own to share.
//!
//! # Scenario
//!
//! ```json
//! { "write_chunk_ms": 0,
//!   "turns": [
//!     { "prompt": "optional", "steps": [ ... ], "turn_duration": true },
//!     { "exit": 0 } ] }
//! ```
//!
//! Turns run in order. A turn starts with a prompt: the startup prompt (first
//! turn only), else the turn's `prompt`, else a line typed into the terminal.
//! When it ends normally a `system` `turn_duration` record follows (unless
//! `"turn_duration": false`). A turn that is only `{"exit": <code>}` exits
//! when reached, without a prompt. Past the last turn, each typed prompt gets
//! a one-line reply. `write_chunk_ms` > 0 writes each log line in 64-byte
//! pieces that far apart, so a test can stop it mid-line.
//!
//! Steps (one kind each, plus that kind's options):
//! - `{"thinking": "…"}`: an assistant `thinking` block.
//! - `{"text": "…", "stop": null}`: an assistant `text` block; `stop` is its
//!   `stop_reason` (default null: still streaming).
//! - `{"reply": "…"}`: a `text` block with `stop_reason: "end_turn"`.
//! - `{"tool": "Bash", "input": {…}, "id": "toolu_…", "permission": false,
//!   "result": "ok", "error": false, "pending": false, "dialog": "…"}`: an
//!   assistant `tool_use` (`stop_reason: "tool_use"`), then its `tool_result`.
//!   `pending` leaves it unanswered. `permission` first draws the permission
//!   dialog (`dialog` replaces its question) and waits for a key: a digit
//!   picks that option, Enter picks 1. The last option ("No") or Esc rejects
//!   it: an `is_error` result, then `[Request interrupted by user for tool
//!   use]`, and the turn ends. `ExitPlanMode` draws a plan approval instead
//!   (its wording is not checked against Claude Code).
//! - `{"subagent": {"description": "…", "prompt": "…", "steps": [ … ]}}`: a
//!   `Task` tool_use, the sub-agent's records (`isSidechain: true`; thinking,
//!   text, reply and tool steps without permission), then the Task's result.
//! - `{"delay_ms": 500}`: wait.
//! - `{"interrupt": true}`: as if Esc was pressed.
//! - `{"crash": true}`: write half of the next record, no newline, and exit
//!   101 at once.
//! - `{"exit": 0}`: exit now with that code.
//! - `{"mcp": "submit_result", "server": "dcterminal", "arguments": {…}}`:
//!   a `tool_use` of `mcp__<server>__<tool>` (server defaults to
//!   `dcterminal`), PreToolUse hooks for it (a `deny` refuses it), then a
//!   `tools/call` to that `--mcp-config` server and its answer as the
//!   `tool_result` (`isError` → `is_error`).
//!
//! A turn may also carry `"on_block": [[steps], …]`: when a Stop hook blocks
//! the end of the turn, the next list runs (as Claude going on), then Stop
//! hooks run again with `stop_hook_active: true`. With no list left the turn
//! ends anyway, so a scenario never loops.
//!
//! # Hooks and MCP
//!
//! Hooks come from `--settings`' `hooks`, as Claude Code 2.1.287 runs them
//! (docs/claude-hooks-observed.md): `UserPromptSubmit` when a turn starts,
//! `Stop` when it ends normally (never after an interrupt), `PreToolUse`
//! before a `tool` or `mcp` step (matcher: empty, `*`, or `|`-separated
//! names). A `deny` refuses the tool with its `permissionDecisionReason` as
//! the error result and no dialog, and the turn goes on; an `allow` skips
//! the permission dialog. A `tool` step with `permission` runs
//! `PermissionRequest` hooks just before drawing the dialog, and the
//! `permission_prompt` `Notification` hooks just after (Claude Code sends
//! that one about 6 s later; matcher: the notification type). Each
//! `command` hook runs with its `args` (or through `sh -c` without), the
//! JSON payload on stdin (`session_id`, `transcript_path`, `cwd`,
//! `prompt_id` (one per turn), `permission_mode`, `hook_event_name`, plus
//! the event's own fields), in the session's folder. Exit 2 with a reason on
//! stderr, or `{"decision":"block","reason":…}` on stdout, blocks a Stop;
//! `hookSpecificOutput.permissionDecision` answers a PreToolUse. A blocked
//! Stop draws `Stop hook error: <reason>`.
//!
//! An `mcp` step starts its stdio server on first use (`command` and `args`
//! from `--mcp-config`' `mcpServers`), and shakes hands as Claude Code does
//! (`initialize`, `notifications/initialized`, `tools/list`). Permission
//! prompts for MCP tools are not drawn.
//!
//! Esc during a turn (between steps or in a wait) interrupts it: a `[Request
//! interrupted by user]` record, no `turn_duration`, and the turn ends.
//!
//! # Terminal
//!
//! Typed text echoes on the `❯` prompt line; Enter submits it, `/exit` or
//! Ctrl-D on an empty line exits 0. On SIGTERM it finishes the log line it is
//! writing and exits 143, which the S1 graceful stop relies on Claude Code
//! doing. The permission dialog uses the cursor moves Claude Code 2.1.287
//! does, which `src/terminal/permissionDialog.ts` reads (see its fixtures).

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::path::{Path, PathBuf};
use std::process::exit;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

const VERSION: &str = "2.1.287";
const ESC: u8 = 0x1b;
/// Piece size for `write_chunk_ms`.
const CHUNK: usize = 64;
const POLL: Duration = Duration::from_millis(10);
const INTERRUPTED: &str = "[Request interrupted by user]";
const REJECTED: &str = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
/// Flags Claude Code gives a value; their value is skipped.
const VALUE_FLAGS: &[&str] = &[
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--disallowed-tools",
    "--add-dir",
    "--append-system-prompt",
    "--system-prompt",
    "--effort",
    "--fallback-model",
    "--agents",
    "--setting-sources",
    "--output-format",
    "--input-format",
    "--plugin-dir",
    "--betas",
    "--debug-file",
];

static TERM: AtomicBool = AtomicBool::new(false);

fn main() {
    let args = parse_args(std::env::args().skip(1));
    let config = config_dir().unwrap_or_else(|why| refuse(&why));
    let scenario = load_scenario().unwrap_or_else(|why| refuse(&why));
    on_sigterm();
    let cwd = std::env::current_dir().unwrap_or_else(|err| fail(&format!("cwd: {err}")));
    let (session_id, path) = log_path(&config, &cwd, &args).unwrap_or_else(|why| fail(&why));
    let parent = last_uuid(&path);
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .unwrap_or_else(|err| fail(&format!("open {}: {err}", path.display())));
    let settings = json_flag(args.settings.as_deref(), "--settings");
    let mcp_config = json_flag(args.mcp_config.as_deref(), "--mcp-config");
    let mut fake = Fake {
        log,
        log_path: path.clone(),
        session_id,
        cwd: cwd.display().to_string(),
        model: args
            .model
            .clone()
            .unwrap_or_else(|| "claude-sonnet-4-5".into()),
        mode: args
            .permission_mode
            .clone()
            .unwrap_or_else(|| "default".into()),
        parent,
        side_parent: None,
        sidechain: false,
        chunk_ms: scenario.chunk_ms,
        tools: 0,
        titled: false,
        input: spawn_input(),
        typed: Vec::new(),
        queued: VecDeque::new(),
        tty: Tty::raw(),
        hooks: settings.get("hooks").cloned().unwrap_or(Value::Null),
        mcp_servers: mcp_config.get("mcpServers").cloned().unwrap_or(Value::Null),
        mcp: HashMap::new(),
        prompt_id: String::new(),
        last_text: String::new(),
    };
    fake.draw(&format!(
        "\x1b[38;5;174m✻\x1b[39m Welcome to fake_claude {VERSION}\r\n\x1b[38;5;246m  cwd: {}\x1b[39m\r\n",
        fake.cwd
    ));
    let code = fake.run(scenario.turns, args.prompt);
    fake.quit(code);
}

/// Bad setup: nothing was written.
fn refuse(why: &str) -> ! {
    eprintln!("fake_claude: {why}");
    exit(2);
}

fn fail(why: &str) -> ! {
    eprintln!("fake_claude: {why}");
    exit(1);
}

#[derive(Default)]
struct Args {
    session_id: Option<String>,
    resume: Option<String>,
    permission_mode: Option<String>,
    model: Option<String>,
    settings: Option<String>,
    mcp_config: Option<String>,
    prompt: Option<String>,
}

/// A JSON flag value: inline JSON, else the file it names. Absent: `{}`.
fn json_flag(value: Option<&str>, flag: &str) -> Value {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return json!({});
    };
    let text = if value.starts_with('{') {
        value.to_string()
    } else {
        std::fs::read_to_string(value).unwrap_or_else(|err| refuse(&format!("{flag} {value}: {err}")))
    };
    serde_json::from_str(&text).unwrap_or_else(|err| refuse(&format!("{flag}: {err}")))
}

fn parse_args(mut argv: impl Iterator<Item = String>) -> Args {
    let mut args = Args::default();
    let mut positional = Vec::new();
    while let Some(arg) = argv.next() {
        if arg == "--" {
            positional.extend(argv.by_ref());
            break;
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if arg.starts_with("--") => {
                (flag.to_string(), Some(value.to_string()))
            }
            _ => (arg.clone(), None),
        };
        let slot = match flag.as_str() {
            "--session-id" => Some(&mut args.session_id),
            "--resume" | "-r" => Some(&mut args.resume),
            "--permission-mode" => Some(&mut args.permission_mode),
            "--model" => Some(&mut args.model),
            "--settings" => Some(&mut args.settings),
            "--mcp-config" => Some(&mut args.mcp_config),
            _ => None,
        };
        if let Some(slot) = slot {
            *slot = inline.or_else(|| argv.next());
        } else if VALUE_FLAGS.contains(&flag.as_str()) {
            if inline.is_none() {
                argv.next();
            }
        } else if !arg.starts_with('-') {
            positional.push(arg);
        }
    }
    args.prompt = positional
        .into_iter()
        .next()
        .filter(|p| !p.trim().is_empty());
    args
}

/// `CLAUDE_CONFIG_DIR`, required, and never a real account's folder.
fn config_dir() -> Result<PathBuf, String> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .ok_or("CLAUDE_CONFIG_DIR must be set; fake_claude never falls back to ~/.claude")?;
    let real = dir
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with(".claude"));
    if real {
        return Err(format!(
            "CLAUDE_CONFIG_DIR {} looks like a real Claude account; use a temp folder",
            dir.display()
        ));
    }
    Ok(dir)
}

struct Scenario {
    chunk_ms: u64,
    turns: Vec<Value>,
}

fn load_scenario() -> Result<Scenario, String> {
    let path = std::env::var_os("DCT_FAKE_CLAUDE_SCENARIO")
        .filter(|path| !path.is_empty())
        .ok_or("DCT_FAKE_CLAUDE_SCENARIO must name a scenario file")?;
    let text = std::fs::read_to_string(&path)
        .map_err(|err| format!("read scenario {}: {err}", Path::new(&path).display()))?;
    let value: Value = serde_json::from_str(&text).map_err(|err| format!("scenario: {err}"))?;
    let turns = match value.get("turns") {
        None => Vec::new(),
        Some(Value::Array(turns)) => turns.clone(),
        Some(_) => return Err("scenario: `turns` must be a list".into()),
    };
    Ok(Scenario {
        chunk_ms: value
            .get("write_chunk_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        turns,
    })
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

/// The project folder name for `cwd`: non-alphanumerics become `-`, one per
/// UTF-16 unit (Claude Code's JS `replace(/[^a-zA-Z0-9]/g, "-")`).
fn encode_cwd(cwd: &Path) -> String {
    let mut out = String::new();
    for ch in cwd.display().to_string().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else {
            out.extend(std::iter::repeat_n('-', ch.len_utf16()));
        }
    }
    out
}

fn log_path(config: &Path, cwd: &Path, args: &Args) -> Result<(String, PathBuf), String> {
    let projects = config.join("projects");
    let existing = |id: &str| -> Option<PathBuf> {
        std::fs::read_dir(&projects)
            .ok()?
            .flatten()
            .map(|entry| entry.path().join(format!("{id}.jsonl")))
            .find(|path| path.is_file())
    };
    if let Some(id) = args.resume.as_deref() {
        if !valid_session_id(id) {
            return Err(format!("not a session id: {id}"));
        }
        return existing(id)
            .map(|path| (id.to_string(), path))
            .ok_or_else(|| format!("No conversation found with session ID: {id}"));
    }
    let id = match args.session_id.as_deref() {
        Some(id) if !valid_session_id(id) => return Err(format!("not a session id: {id}")),
        Some(id) => id.to_string(),
        None => uuid::Uuid::new_v4().to_string(),
    };
    if existing(&id).is_some() {
        return Err(format!("Session ID {id} is already in use."));
    }
    let folder = projects.join(encode_cwd(cwd));
    std::fs::create_dir_all(&folder)
        .map_err(|err| format!("create {}: {err}", folder.display()))?;
    let path = folder.join(format!("{id}.jsonl"));
    Ok((id, path))
}

/// The newest record's `uuid`, so a resumed chain continues from it.
fn last_uuid(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    text.lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|v| v.get("uuid").and_then(Value::as_str).map(str::to_string))
}

#[cfg(unix)]
fn on_sigterm() {
    extern "C" fn handle(_: i32) {
        TERM.store(true, Ordering::SeqCst);
    }
    extern "C" {
        fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize;
    }
    const SIGTERM: i32 = 15;
    // SAFETY: the handler only stores to an atomic, which is signal-safe.
    unsafe {
        signal(SIGTERM, handle);
    }
}

#[cfg(not(unix))]
fn on_sigterm() {}

fn terminated() -> bool {
    TERM.load(Ordering::SeqCst)
}

/// Bytes typed into the terminal, read on their own thread.
fn spawn_input() -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    });
    rx
}

/// The terminal without line buffering or echo, restored on exit.
struct Tty {
    saved: Option<String>,
}

impl Tty {
    fn raw() -> Self {
        if !std::io::stdin().is_terminal() {
            return Self { saved: None };
        }
        let saved = stty(&["-g"]);
        stty(&["-icanon", "-echo", "min", "1", "time", "0"]);
        Self { saved }
    }

    fn restore(&self) {
        if let Some(saved) = self.saved.as_deref() {
            stty(&[saved.trim()]);
        }
    }
}

fn stty(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("stty")
        .args(args)
        .stdin(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

enum Event {
    Line(String),
    Key(u8),
    Esc,
    Eof,
}

/// How a turn or step ended.
#[derive(PartialEq)]
enum Ended {
    Done,
    Interrupted,
}

struct Fake {
    log: File,
    log_path: PathBuf,
    session_id: String,
    cwd: String,
    model: String,
    mode: String,
    /// The main chain's newest record.
    parent: Option<String>,
    /// The sub-agent chain's newest record.
    side_parent: Option<String>,
    sidechain: bool,
    chunk_ms: u64,
    tools: u64,
    titled: bool,
    input: Receiver<Vec<u8>>,
    typed: Vec<u8>,
    /// Prompts typed during a turn, taken in order once it ends.
    queued: VecDeque<String>,
    tty: Tty,
    /// `--settings`' `hooks`, by event.
    hooks: Value,
    /// `--mcp-config`' `mcpServers`, by name.
    mcp_servers: Value,
    /// MCP servers started so far, by name.
    mcp: HashMap<String, McpClient>,
    /// The current turn's `prompt_id`, as hooks see it.
    prompt_id: String,
    /// The current turn's last assistant text (Stop's `last_assistant_message`).
    last_text: String,
}

/// What the hooks of one event answered.
#[derive(Default)]
struct HookReply {
    /// A Stop hook blocked, with this reason.
    block: Option<String>,
    /// A PreToolUse hook's `permissionDecision`.
    permission: Option<String>,
    /// Its `permissionDecisionReason`.
    reason: Option<String>,
}

/// A started stdio MCP server.
struct McpClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl McpClient {
    fn start(config: &Value) -> Result<Self, String> {
        let command = config
            .get("command")
            .and_then(Value::as_str)
            .ok_or("the server has no command")?;
        let args: Vec<String> = config
            .get("args")
            .and_then(Value::as_array)
            .map(|args| args.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let mut child = Command::new(command)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("start {command}: {err}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut client = Self { child, stdin, stdout, next_id: 0 };
        client.request(
            "initialize",
            json!({ "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": { "name": "fake_claude", "version": VERSION } }),
        )?;
        client.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        client.request("tools/list", json!({}))?;
        Ok(client)
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{message}")
            .and_then(|_| self.stdin.flush())
            .map_err(|err| format!("write to the server: {err}"))
    }

    /// A request and its result (an error reply is an `Err`).
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            let mut line = String::new();
            match self.stdout.read_line(&mut line) {
                Ok(0) => return Err("the server closed its output".into()),
                Ok(_) => {}
                Err(err) => return Err(format!("read from the server: {err}")),
            }
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if reply.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = reply.get("error") {
                return Err(format!("{method}: {error}"));
            }
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A hook matcher: empty or `*` matches every tool, else `|`-separated names.
fn matcher_matches(matcher: &str, tool: &str) -> bool {
    let matcher = matcher.trim();
    matcher.is_empty() || matcher == "*" || matcher.split('|').any(|name| name.trim() == tool)
}

impl Fake {
    fn run(&mut self, turns: Vec<Value>, startup: Option<String>) -> i32 {
        let mut startup = startup;
        for turn in turns {
            if turn.get("steps").is_none() {
                if let Some(code) = turn.get("exit").and_then(Value::as_i64) {
                    return code as i32;
                }
            }
            let given = startup.take().or_else(|| {
                turn.get("prompt")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            let Some(prompt) = given.or_else(|| self.read_prompt()) else {
                return 0;
            };
            self.start_turn(&prompt);
            let started = Instant::now();
            let steps = turn
                .get("steps")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let on_block: VecDeque<Vec<Value>> = turn
                .get("on_block")
                .and_then(Value::as_array)
                .map(|lists| {
                    lists
                        .iter()
                        .map(|list| list.as_array().cloned().unwrap_or_default())
                        .collect()
                })
                .unwrap_or_default();
            if self.steps(&steps) == Ended::Done
                && self.stop(on_block) == Ended::Done
                && turn.get("turn_duration").and_then(Value::as_bool) != Some(false)
            {
                self.turn_duration(started);
            }
        }
        loop {
            let Some(prompt) = startup.take().or_else(|| self.read_prompt()) else {
                return 0;
            };
            self.start_turn(&prompt);
            let started = Instant::now();
            self.reply("fake_claude: no scenario turn left.");
            self.stop(VecDeque::new());
            self.turn_duration(started);
        }
    }

    /// The turn ended normally: Stop hooks run, and while one blocks, the
    /// next `on_block` list runs and they run again.
    fn stop(&mut self, mut on_block: VecDeque<Vec<Value>>) -> Ended {
        let mut active = false;
        loop {
            let payload = json!({
                "stop_hook_active": active,
                "last_assistant_message": self.last_text,
                "background_tasks": [],
                "session_crons": [],
            });
            let Some(reason) = self.run_hooks("Stop", payload, None).block else {
                return Ended::Done;
            };
            self.draw(&format!(
                "\r\n\x1b[38;5;174m  ⎿  Stop hook error: {}\x1b[39m\r\n",
                screen_text(&reason)
            ));
            active = true;
            let Some(steps) = on_block.pop_front() else {
                return Ended::Done;
            };
            if self.steps(&steps) == Ended::Interrupted {
                return Ended::Interrupted;
            }
        }
    }

    /// Run `event`'s command hooks with the common fields added to `payload`.
    fn run_hooks(&mut self, event: &str, mut payload: Value, tool: Option<&str>) -> HookReply {
        let mut reply = HookReply::default();
        let Some(groups) = self.hooks.get(event).and_then(Value::as_array).cloned() else {
            return reply;
        };
        if let Some(fields) = payload.as_object_mut() {
            fields.insert("session_id".into(), json!(self.session_id));
            fields.insert("transcript_path".into(), json!(self.log_path.display().to_string()));
            fields.insert("cwd".into(), json!(self.cwd));
            fields.insert("prompt_id".into(), json!(self.prompt_id));
            fields.insert("permission_mode".into(), json!(self.mode));
            fields.insert("hook_event_name".into(), json!(event));
        }
        for group in &groups {
            let matcher = group.get("matcher").and_then(Value::as_str);
            if let (Some(tool), Some(matcher)) = (tool, matcher) {
                if !matcher_matches(matcher, tool) {
                    continue;
                }
            }
            let hooks = group.get("hooks").and_then(Value::as_array).cloned().unwrap_or_default();
            for hook in hooks.iter().filter(|h| h.get("type").and_then(Value::as_str) == Some("command")) {
                self.run_hook(event, hook, &payload, &mut reply);
            }
        }
        reply
    }

    fn run_hook(&mut self, event: &str, hook: &Value, payload: &Value, reply: &mut HookReply) {
        let Some(command) = hook.get("command").and_then(Value::as_str) else {
            return;
        };
        let mut process = match hook.get("args").and_then(Value::as_array) {
            Some(args) => {
                let mut process = Command::new(command);
                process.args(args.iter().filter_map(Value::as_str));
                process
            }
            None => {
                let mut process = Command::new("sh");
                process.args(["-c", command]);
                process
            }
        };
        let spawned = process
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let output = spawned.and_then(|mut child| {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(payload.to_string().as_bytes());
            }
            child.wait_with_output()
        });
        let output = match output {
            Ok(output) => output,
            Err(err) => {
                self.draw(&format!("\r\n  ⎿  {event} hook error: {err}\r\n"));
                return;
            }
        };
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        match output.status.code() {
            Some(0) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let Ok(answer) = serde_json::from_str::<Value>(stdout.trim()) else {
                    return;
                };
                if answer.get("decision").and_then(Value::as_str) == Some("block") {
                    let reason = answer.get("reason").and_then(Value::as_str).unwrap_or_default();
                    reply.block = Some(reason.to_string());
                }
                if let Some(decision) = answer
                    .pointer("/hookSpecificOutput/permissionDecision")
                    .and_then(Value::as_str)
                {
                    reply.permission = Some(decision.to_string());
                    reply.reason = answer
                        .pointer("/hookSpecificOutput/permissionDecisionReason")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
            Some(2) => reply.block = Some(stderr),
            code => self.draw(&format!(
                "\r\n  ⎿  {event} hook error (exit {}): {}\r\n",
                code.map_or("signal".to_string(), |c| c.to_string()),
                screen_text(&stderr)
            )),
        }
    }

    /// An `mcp` step: the tool_use, PreToolUse hooks, the call, its result.
    fn mcp_step(&mut self, tool: &str, step: &Value) -> Ended {
        let server = step.get("server").and_then(Value::as_str).unwrap_or("dcterminal").to_string();
        let name = format!("mcp__{server}__{tool}");
        let input = step.get("arguments").cloned().unwrap_or_else(|| json!({}));
        let id = self.next_tool_id();
        self.draw(&format!("\r\n⏺ {name}({})\r\n", screen_text(&input.to_string())));
        self.assistant(
            json!({ "type": "tool_use", "id": id, "name": name, "input": input }),
            Some("tool_use"),
        );
        let hooks = self.run_hooks(
            "PreToolUse",
            json!({ "tool_name": name, "tool_input": input, "tool_use_id": id }),
            Some(&name),
        );
        let (text, error) = if hooks.permission.as_deref() == Some("deny") {
            ("A PreToolUse hook denied this tool.".to_string(), true)
        } else {
            match self.mcp_call(&server, tool, &input) {
                Ok(answer) => answer,
                Err(why) => (format!("MCP error: {why}"), true),
            }
        };
        self.draw(&format!("  ⎿  {}\r\n", screen_text(&text)));
        self.tool_result(&id, &text, error);
        Ended::Done
    }

    /// `tools/call` on `server`, started on first use: the text and `isError`.
    fn mcp_call(&mut self, server: &str, tool: &str, input: &Value) -> Result<(String, bool), String> {
        if !self.mcp.contains_key(server) {
            let config = self
                .mcp_servers
                .get(server)
                .ok_or_else(|| format!("no MCP server {server:?} in --mcp-config"))?;
            let client = McpClient::start(config)?;
            self.mcp.insert(server.to_string(), client);
        }
        let client = self.mcp.get_mut(server).ok_or("the server is gone")?;
        let result = client.request("tools/call", json!({ "name": tool, "arguments": input }))?;
        let text = result
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
        Ok((text, error))
    }

    fn steps(&mut self, steps: &[Value]) -> Ended {
        for step in steps {
            if self.step(step) == Ended::Interrupted {
                return Ended::Interrupted;
            }
            if self.esc_pressed() {
                self.interrupted(INTERRUPTED);
                return Ended::Interrupted;
            }
        }
        Ended::Done
    }

    fn step(&mut self, step: &Value) -> Ended {
        let text_of = |key: &str| step.get(key).and_then(Value::as_str);
        let flag = |key: &str| step.get(key).and_then(Value::as_bool) == Some(true);
        if let Some(text) = text_of("thinking") {
            self.draw("\r\n\x1b[38;5;246m✻ Thinking…\x1b[39m\r\n");
            self.assistant(
                json!({ "type": "thinking", "thinking": text, "signature": "fake" }),
                None,
            );
        } else if let Some(text) = text_of("text") {
            self.draw(&format!("\r\n⏺ {}\r\n", screen_text(text)));
            if !self.sidechain {
                self.last_text = text.to_string();
            }
            self.assistant(json!({ "type": "text", "text": text }), text_of("stop"));
        } else if let Some(text) = text_of("reply") {
            self.reply(text);
        } else if let Some(name) = text_of("tool") {
            return self.tool(name, step);
        } else if let Some(tool) = text_of("mcp") {
            return self.mcp_step(tool, step);
        } else if let Some(agent) = step.get("subagent") {
            return self.subagent(agent);
        } else if let Some(ms) = step.get("delay_ms").and_then(Value::as_u64) {
            let until = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < until {
                match self.next_event(POLL, false) {
                    Some(Event::Esc) => {
                        self.interrupted(INTERRUPTED);
                        return Ended::Interrupted;
                    }
                    Some(Event::Line(line)) => self.queued.push_back(line),
                    _ => {}
                }
            }
        } else if flag("interrupt") {
            self.interrupted(INTERRUPTED);
            return Ended::Interrupted;
        } else if flag("crash") {
            let block = json!({ "type": "text", "text": "cut off mid-write" });
            let message = message(&self.model, block, None);
            let record = self.record("assistant", json!({ "message": message }));
            let line = serde_json::to_vec(&record).unwrap_or_default();
            let _ = self.log.write_all(&line[..line.len() / 2]);
            exit(101);
        } else if let Some(code) = step.get("exit").and_then(Value::as_i64) {
            self.quit(code as i32);
        } else {
            fail(&format!("unknown scenario step: {step}"));
        }
        Ended::Done
    }

    fn reply(&mut self, text: &str) {
        if !self.sidechain {
            self.last_text = text.to_string();
        }
        self.draw(&format!("\r\n⏺ {}\r\n", screen_text(text)));
        self.assistant(json!({ "type": "text", "text": text }), Some("end_turn"));
    }

    fn next_tool_id(&mut self) -> String {
        self.tools += 1;
        format!("toolu_fake_{:04}", self.tools)
    }

    fn tool(&mut self, name: &str, step: &Value) -> Ended {
        let input = step.get("input").cloned().unwrap_or_else(|| json!({}));
        let id = match step.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => self.next_tool_id(),
        };
        self.draw(&format!(
            "\r\n⏺ {name}({})\r\n",
            screen_text(&tool_detail(name, &input))
        ));
        self.assistant(
            json!({ "type": "tool_use", "id": id, "name": name, "input": input }),
            Some("tool_use"),
        );
        let hooks = self.run_hooks(
            "PreToolUse",
            json!({ "tool_name": name, "tool_input": input, "tool_use_id": id }),
            Some(name),
        );
        if hooks.permission.as_deref() == Some("deny") {
            // Refused before any dialog: the reason is the tool's error and
            // the turn goes on (V0 T7 for ExitPlanMode).
            let reason = hooks.reason.unwrap_or_else(|| "A PreToolUse hook denied this tool.".to_string());
            self.draw(&format!(
                "  ⎿  Error: PreToolUse:{name} hook error: {}\r\n",
                screen_text(&reason)
            ));
            self.tool_result(&id, &reason, true);
            return Ended::Done;
        }
        if step.get("pending").and_then(Value::as_bool) == Some(true) {
            return Ended::Done;
        }
        let allowed = hooks.permission.as_deref() == Some("allow");
        if step.get("permission").and_then(Value::as_bool) == Some(true) && !allowed {
            let question = step.get("dialog").and_then(Value::as_str);
            self.run_hooks(
                "PermissionRequest",
                json!({ "tool_name": name, "tool_input": input, "permission_suggestions": [] }),
                Some(name),
            );
            let options = self.draw_dialog(name, &input, question);
            // Claude Code sends this about 6 s after the dialog; here at once.
            self.run_hooks(
                "Notification",
                json!({ "message": "Claude needs your permission", "notification_type": "permission_prompt" }),
                Some("permission_prompt"),
            );
            let answer = loop {
                match self.next_event(POLL, false) {
                    Some(Event::Esc) => break options,
                    Some(Event::Line(_)) => break 1,
                    Some(Event::Key(key)) if usize::from(key - b'0') <= options => {
                        break usize::from(key - b'0')
                    }
                    Some(Event::Eof) => self.quit(0),
                    _ => {}
                }
            };
            self.draw("\r\n");
            if answer == options {
                self.tool_result(&id, REJECTED, true);
                self.interrupted("[Request interrupted by user for tool use]");
                return Ended::Interrupted;
            }
            // Approving a plan leaves plan mode: option 1 auto-accepts edits,
            // option 2 asks for each. Not checked against a live capture.
            if name == "ExitPlanMode" {
                self.mode = if answer == 1 {
                    "acceptEdits"
                } else {
                    "default"
                }
                .to_string();
            }
        }
        let result = step.get("result").and_then(Value::as_str).unwrap_or("ok");
        let error = step.get("error").and_then(Value::as_bool) == Some(true);
        self.draw(&format!("  ⎿  {}\r\n", screen_text(result)));
        self.tool_result(&id, result, error);
        Ended::Done
    }

    fn subagent(&mut self, agent: &Value) -> Ended {
        let description = agent
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("Sub-agent");
        let prompt = agent
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or(description);
        let id = self.next_tool_id();
        let input = json!({
            "description": description,
            "prompt": prompt,
            "subagent_type": "general-purpose",
        });
        self.draw(&format!("\r\n⏺ Task({})\r\n", screen_text(description)));
        self.assistant(
            json!({ "type": "tool_use", "id": id, "name": "Task", "input": input }),
            Some("tool_use"),
        );
        self.sidechain = true;
        self.side_parent = None;
        let record = self.record(
            "user",
            json!({ "message": { "role": "user", "content": prompt } }),
        );
        self.write(record);
        let steps = agent
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut last = String::new();
        let mut ended = Ended::Done;
        for step in &steps {
            if step.get("permission").is_some() || step.get("subagent").is_some() {
                fail("sub-agent steps cannot ask permission or nest");
            }
            if let Some(text) = step
                .get("reply")
                .or_else(|| step.get("text"))
                .and_then(Value::as_str)
            {
                last = text.to_string();
            }
            ended = self.step(step);
            if ended == Ended::Interrupted {
                break;
            }
        }
        self.sidechain = false;
        if ended == Ended::Interrupted {
            return ended;
        }
        self.draw(&format!("  ⎿  Done ({})\r\n", screen_text(&last)));
        self.tool_result(&id, &last, false);
        Ended::Done
    }

    /// The permission dialog, laid out the way Claude Code 2.1.287 draws it
    /// (words placed with CHA, lines stepped with `CR ESC[1C ESC[1B`).
    /// Returns the number of options; the last is "No".
    fn draw_dialog(&mut self, name: &str, input: &Value, question: Option<&str>) -> usize {
        let field = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default();
        let file = field("file_path")
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default();
        let (title, detail, ask, options) = match name {
            "ExitPlanMode" => (
                "Ready to code?",
                field("plan").to_string(),
                "Would you like to proceed?".to_string(),
                [
                    "Yes, and auto-accept edits",
                    "Yes, and manually approve edits",
                    "No, keep planning",
                ],
            ),
            "Write" => (
                "Create file",
                file.to_string(),
                format!("Do you want to create \x1b[1m{file}\x1b[22m?"),
                [
                    "Yes",
                    "Yes, and allow all edits during this session (shift+tab)",
                    "No",
                ],
            ),
            "Edit" | "MultiEdit" | "NotebookEdit" => (
                "Edit file",
                file.to_string(),
                format!("Do you want to make this edit to \x1b[1m{file}\x1b[22m?"),
                [
                    "Yes",
                    "Yes, and allow all edits during this session (shift+tab)",
                    "No",
                ],
            ),
            "Bash" => (
                "Bash command",
                field("command").to_string(),
                "Do you want to proceed?".to_string(),
                [
                    "Yes",
                    "Yes, and don't ask again for this command in this project",
                    "No",
                ],
            ),
            _ => (
                "Tool use",
                format!("{name}({})", tool_detail(name, input)),
                "Do you want to proceed?".to_string(),
                [
                    "Yes",
                    "Yes, and don't ask again for this tool in this project",
                    "No",
                ],
            ),
        };
        let step = "\r\x1b[1C\x1b[1B";
        let mut out = format!("\r\n\x1b[38;5;153m{}\x1b[39m{step}", "─".repeat(100));
        out.push_str(&format!("\x1b[1m{title}\x1b[22m{step}"));
        for line in detail.lines().filter(|line| !line.trim().is_empty()) {
            out.push_str(&format!("{}{step}", placed(2, line)));
        }
        out.push_str(&format!("{}{step}", placed(2, question.unwrap_or(&ask))));
        for (index, label) in options.iter().enumerate() {
            let cursor = if index == 0 {
                "\x1b[2G\x1b[38;5;153m❯\x1b[39m"
            } else {
                ""
            };
            out.push_str(&format!(
                "{cursor}\x1b[4G\x1b[38;5;246m{}.\x1b[39m{}\r\x1b[3C\x1b[1B",
                index + 1,
                placed(7, label)
            ));
        }
        out.push_str("\r\x1b[1C\x1b[2B\x1b[38;5;246mEsc to cancel · Tab to amend\x1b[39m\r\n");
        self.draw(&out);
        options.len()
    }

    fn start_turn(&mut self, prompt: &str) {
        self.prompt_id = uuid::Uuid::new_v4().to_string();
        self.last_text.clear();
        self.run_hooks("UserPromptSubmit", json!({ "prompt": prompt }), None);
        let snapshot = uuid::Uuid::new_v4().to_string();
        self.write(json!({
            "type": "file-history-snapshot",
            "messageId": snapshot,
            "snapshot": { "messageId": snapshot, "trackedFileBackups": {}, "timestamp": now() },
            "isSnapshotUpdate": false,
        }));
        let mut record = self.record(
            "user",
            json!({ "message": { "role": "user", "content": prompt } }),
        );
        record["permissionMode"] = json!(self.mode);
        self.write(record);
        if !self.titled {
            self.titled = true;
            let title: String = prompt.chars().take(60).collect();
            self.write(
                json!({ "type": "ai-title", "aiTitle": title, "sessionId": self.session_id }),
            );
        }
    }

    fn assistant(&mut self, block: Value, stop: Option<&str>) {
        let message = message(&self.model, block, stop);
        let record = self.record(
            "assistant",
            json!({
                "requestId": format!("req_fake_{}", uuid::Uuid::new_v4().simple()),
                "message": message,
            }),
        );
        self.write(record);
    }

    fn tool_result(&mut self, id: &str, content: &str, error: bool) {
        let record = self.record("user", json!({
            "message": { "role": "user", "content": [
                { "tool_use_id": id, "type": "tool_result", "content": content, "is_error": error }
            ] },
            "toolUseResult": content,
        }));
        self.write(record);
    }

    fn interrupted(&mut self, text: &str) {
        self.draw(
            "\r\n\x1b[38;5;246m  ⎿  Interrupted · What should Claude do instead?\x1b[39m\r\n",
        );
        let content = json!([{ "type": "text", "text": text }]);
        let record = self.record(
            "user",
            json!({ "message": { "role": "user", "content": content } }),
        );
        self.write(record);
    }

    fn turn_duration(&mut self, started: Instant) {
        let record = self.record(
            "system",
            json!({
                "subtype": "turn_duration",
                "durationMs": started.elapsed().as_millis() as u64,
                "isMeta": false,
            }),
        );
        self.write(record);
    }

    /// A chain record of `kind` with the common fields, plus `extra`'s.
    fn record(&mut self, kind: &str, extra: Value) -> Value {
        let uuid = uuid::Uuid::new_v4().to_string();
        let parent = if self.sidechain {
            self.side_parent.replace(uuid.clone())
        } else {
            self.parent.replace(uuid.clone())
        };
        let mut record = json!({
            "parentUuid": parent,
            "isSidechain": self.sidechain,
            "userType": "external",
            "cwd": self.cwd,
            "sessionId": self.session_id,
            "version": VERSION,
            "gitBranch": "",
            "type": kind,
            "uuid": uuid,
            "timestamp": now(),
        });
        if let (Some(fields), Value::Object(extra)) = (record.as_object_mut(), extra) {
            fields.extend(extra);
        }
        record
    }

    /// Append one whole line. A SIGTERM that lands mid-line is acted on only
    /// once the newline is written.
    fn write(&mut self, record: Value) {
        let mut line = serde_json::to_vec(&record).unwrap_or_default();
        line.push(b'\n');
        if self.chunk_ms == 0 {
            let _ = self.log.write_all(&line);
        } else {
            for piece in line.chunks(CHUNK) {
                let _ = self.log.write_all(piece);
                std::thread::sleep(Duration::from_millis(self.chunk_ms));
            }
        }
        let _ = self.log.flush();
        if terminated() {
            self.quit(143);
        }
    }

    fn draw(&self, text: &str) {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }

    fn quit(&self, code: i32) -> ! {
        self.tty.restore();
        exit(code);
    }

    /// Wait for a prompt typed on the `❯` line. `None` on `/exit` or EOF.
    fn read_prompt(&mut self) -> Option<String> {
        let mode = match self.mode.as_str() {
            "plan" => "⏸ plan mode on",
            "acceptEdits" => "⏵⏵ accept edits on",
            "auto" => "⏵⏵ auto mode on",
            _ => "? for shortcuts",
        };
        self.draw(&format!(
            "\r\n\x1b[38;5;246m{}\x1b[39m\r\n❯ \r\n\x1b[38;5;246m  {mode}\x1b[39m\x1b[1A\x1b[3G",
            "─".repeat(100)
        ));
        if let Some(line) = self.queued.pop_front() {
            return self.prompt_line(line);
        }
        loop {
            match self.next_event(Duration::from_millis(50), true) {
                Some(Event::Line(line)) if !line.trim().is_empty() => {
                    return self.prompt_line(line);
                }
                Some(Event::Eof) => return None,
                _ => {}
            }
        }
    }

    /// A submitted line: `None` for `/exit`.
    fn prompt_line(&mut self, line: String) -> Option<String> {
        let line = line.trim();
        if line == "/exit" {
            return None;
        }
        self.draw(&format!("{line}\r\n"));
        Some(line.to_string())
    }

    /// Whether Esc was pressed; a prompt typed meanwhile is queued.
    fn esc_pressed(&mut self) -> bool {
        match self.next_event(Duration::ZERO, false) {
            Some(Event::Esc) => true,
            Some(Event::Line(line)) => {
                self.queued.push_back(line);
                false
            }
            _ => false,
        }
    }

    /// The next input within `timeout`. Typed text collects (echoed when
    /// `echo`) until Enter; without `echo` a digit is a key. Exits 143 once
    /// SIGTERM has arrived.
    fn next_event(&mut self, timeout: Duration, echo: bool) -> Option<Event> {
        if terminated() {
            self.quit(143);
        }
        let bytes = match self
            .input
            .recv_timeout(timeout.max(Duration::from_millis(1)))
        {
            Ok(bytes) => bytes,
            Err(RecvTimeoutError::Timeout) => return None,
            Err(RecvTimeoutError::Disconnected) => {
                std::thread::sleep(timeout);
                return None;
            }
        };
        if bytes == [ESC] {
            self.typed.clear();
            return Some(Event::Esc);
        }
        if bytes.first() == Some(&ESC) {
            // An arrow key or another escape sequence.
            return None;
        }
        for byte in bytes {
            match byte {
                b'\r' | b'\n' => {
                    let line = String::from_utf8_lossy(&self.typed).into_owned();
                    self.typed.clear();
                    return Some(Event::Line(line));
                }
                0x04 if self.typed.is_empty() => return Some(Event::Eof),
                0x7f | 0x08 => {
                    if self.typed.pop().is_some() && echo {
                        self.draw("\x08 \x08");
                    }
                }
                b'1'..=b'9' if !echo => return Some(Event::Key(byte)),
                0x20.. => {
                    self.typed.push(byte);
                    if echo {
                        self.draw(&String::from_utf8_lossy(&[byte]));
                    }
                }
                _ => {}
            }
        }
        None
    }
}

fn message(model: &str, block: Value, stop: Option<&str>) -> Value {
    json!({
        "id": format!("msg_fake_{}", uuid::Uuid::new_v4().simple()),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [block],
        "stop_reason": stop,
        "stop_sequence": null,
        "usage": { "input_tokens": 1, "output_tokens": 1 },
    })
}

fn tool_detail(name: &str, input: &Value) -> String {
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    let detail = match name {
        "Bash" => field("command"),
        "WebFetch" => field("url"),
        _ => field("file_path")
            .or_else(|| field("pattern"))
            .or_else(|| field("description")),
    };
    detail.unwrap_or_default().to_string()
}

/// Words placed with CHA from column `col`, as Claude Code draws them.
fn placed(col: usize, text: &str) -> String {
    let mut out = String::new();
    let mut at = col;
    for word in text.split(' ').filter(|word| !word.is_empty()) {
        out.push_str(&format!("\x1b[{at}G{word}"));
        at += visible_len(word) + 1;
    }
    out
}

/// Characters shown, not counting SGR escapes.
fn visible_len(text: &str) -> usize {
    let mut count = 0;
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            count += 1;
        }
    }
    count
}

/// Text for the screen: CR LF between lines.
fn screen_text(text: &str) -> String {
    text.lines().collect::<Vec<_>>().join("\r\n  ")
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
