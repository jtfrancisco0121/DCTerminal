use super::ndjson::{
    acp_launch_args, consecutive_malformed_limit, parse_acp_line, read_capped_line, CappedRead,
    ParsedLine, MAX_ACP_LINE_BYTES,
};
use super::request_handler::response_for_agent_request;
use super::request_id::RequestId;
use crate::process_tree::{prepare_command, SharedProcess};
use crate::provider::{AgentRequestKind, CursorProvider, ProgramArgs, SharedProvider};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_IO_TIMEOUT: Duration = Duration::from_secs(30);
const STDERR_RING_MAX: usize = 40;
#[cfg(not(test))]
const CANCEL_GRACE: Duration = Duration::from_secs(20);
#[cfg(test)]
const CANCEL_GRACE: Duration = Duration::from_secs(2);
/// How long the next turn waits for a prompt given up on after the cancel
/// grace to finish, before it sends its own prompt.
#[cfg(not(test))]
const SETTLE_WAIT: Duration = Duration::from_secs(10);
#[cfg(test)]
const SETTLE_WAIT: Duration = Duration::from_secs(4);

pub type AgentRequestHandler = Box<dyn FnMut(&Value) -> Result<Option<Value>, String>>;
pub type NotificationHandler = Box<dyn FnMut(&Value)>;
/// Answers to agent requests the user decided on, keyed by the agent's own id.
pub type AgentOutbox = Arc<Mutex<Vec<(RequestId, Value)>>>;
/// Client requests to send during a turn (method, params). Responses are
/// ignored unless their id is the turn's own request.
pub type ClientFollowups = Arc<Mutex<Vec<(String, Value)>>>;
/// The agent's last stderr lines, shared with the stderr reader thread.
/// Readable without the client lock, which a turn holds until it ends.
pub type StderrTail = Arc<Mutex<Vec<String>>>;

enum ReaderMsg {
    Line(String),
    TooLarge,
}

pub struct TurnControl<'a> {
    pub cancel: &'a AtomicBool,
    pub session_id: &'a str,
    pub next_id: &'a mut u64,
    pub outbox: Option<AgentOutbox>,
    pub followups: Option<ClientFollowups>,
}

/// Most notifications a [`LineDispatch`] keeps. A `session/load` replay
/// only shows its first 2,000 updates (500 KB), so this leaves room for
/// updates the replay skips while still bounding a long call's memory.
pub const MAX_KEPT_NOTIFICATIONS: usize = 5_000;
/// Most line bytes of kept notifications (one line may be up to 8 MB).
pub const MAX_KEPT_NOTIFICATION_BYTES: usize = 64 * 1024 * 1024;

pub struct LineDispatch {
    /// The first notifications of the call, up to `keep_limit`.
    pub notifications: Vec<Value>,
    /// Every notification seen, kept or not.
    pub notification_count: usize,
    /// Notifications not kept because `notifications` was full.
    pub dropped_notifications: usize,
    keep_limit: usize,
    kept_bytes: usize,
    /// Reply text gathered as updates arrive (see [`Self::collect_agent_text`]).
    agent_text: Option<String>,
    on_notification: Option<NotificationHandler>,
    pub on_agent_request: Option<AgentRequestHandler>,
}

impl LineDispatch {
    pub fn new() -> Self {
        Self::with_keep_limit(MAX_KEPT_NOTIFICATIONS)
    }

    /// Keeps at most `keep_limit` notifications; later ones are counted only.
    pub fn with_keep_limit(keep_limit: usize) -> Self {
        Self {
            notifications: Vec::new(),
            notification_count: 0,
            dropped_notifications: 0,
            keep_limit,
            kept_bytes: 0,
            agent_text: None,
            on_notification: None,
            on_agent_request: None,
        }
    }

    /// Gathers the agent's reply text while the call runs, so a prompt turn
    /// needs no kept notifications to read it.
    pub fn collect_agent_text(&mut self) {
        self.agent_text.get_or_insert_with(String::new);
    }

    /// The reply text gathered so far (empty unless collecting).
    pub fn agent_text(&self) -> &str {
        self.agent_text.as_deref().unwrap_or("")
    }

    pub fn set_on_agent_request(&mut self, handler: AgentRequestHandler) {
        self.on_agent_request = Some(handler);
    }

    pub fn set_on_notification(&mut self, handler: NotificationHandler) {
        self.on_notification = Some(handler);
    }

    /// `line_bytes` is the size of the line the notification came on.
    fn record_notification(&mut self, value: &Value, line_bytes: usize) {
        self.notification_count += 1;
        let fits = self.kept_bytes.saturating_add(line_bytes) <= MAX_KEPT_NOTIFICATION_BYTES;
        if self.notifications.len() < self.keep_limit && fits {
            self.kept_bytes += line_bytes;
            self.notifications.push(value.clone());
        } else {
            self.dropped_notifications += 1;
        }
        if let Some(text) = &mut self.agent_text {
            if let Some(part) = super::text_extract::agent_reply_text(value) {
                text.push_str(&part);
            }
        }
        if let Some(handler) = &mut self.on_notification {
            handler(value);
        }
    }
}

impl Default for LineDispatch {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AcpConnection {
    process: SharedProcess,
    stdin: std::process::ChildStdin,
    lines: Receiver<ReaderMsg>,
    stderr_tail: StderrTail,
    /// Sorts agent requests (permission / plan / question / extension).
    provider: SharedProvider,
    /// Agent requests handed to the user and not answered yet.
    awaiting_user: HashSet<RequestId>,
    /// A prompt whose cancel grace ran out before the agent answered it.
    /// Its late updates and answer must not land in the next turn.
    abandoned_prompt: Option<u64>,
}

impl AcpConnection {
    pub fn spawn(agent_path: &Path, cwd: Option<&Path>) -> std::io::Result<Self> {
        Self::spawn_with_args(agent_path, cwd, &[])
    }

    /// Cursor `agent`: `global_args` go before `acp`, for example `--model <id>`.
    pub fn spawn_with_args(
        agent_path: &Path,
        cwd: Option<&Path>,
        global_args: &[String],
    ) -> std::io::Result<Self> {
        let mut args: Vec<String> = global_args.to_vec();
        args.extend(acp_launch_args().iter().map(|arg| (*arg).to_string()));
        let program = ProgramArgs::new(agent_path.display().to_string(), args);
        Self::spawn_program(&program, cwd, Arc::new(CursorProvider))
    }

    /// Spawn the provider's ACP agent: argv and extra env from `program`.
    pub fn spawn_program(
        program: &ProgramArgs,
        cwd: Option<&Path>,
        provider: SharedProvider,
    ) -> std::io::Result<Self> {
        let mut command = Command::new(&program.program);
        command.args(&program.args);
        for (key, value) in &program.env {
            command.env(key, value);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        prepare_command(&mut command);
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take();
        // Windows: still suspended and already in its job. Readers attach
        // before resume so the first ACP bytes are not written unread.
        let process = SharedProcess::from_child(child)?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_capped_line(&mut reader, MAX_ACP_LINE_BYTES) {
                    Ok(CappedRead::Line(bytes)) => {
                        let line = String::from_utf8_lossy(&bytes).into_owned();
                        if tx.send(ReaderMsg::Line(line)).is_err() {
                            break;
                        }
                    }
                    Ok(CappedRead::TooLarge) => {
                        if tx.send(ReaderMsg::TooLarge).is_err() {
                            break;
                        }
                    }
                    Ok(CappedRead::EofPartial(bytes)) => {
                        if !bytes.is_empty() {
                            let line = String::from_utf8_lossy(&bytes).into_owned();
                            let _ = tx.send(ReaderMsg::Line(line));
                        }
                        break;
                    }
                    Ok(CappedRead::Eof) | Err(_) => break,
                }
            }
        });
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        if let Some(stderr) = stderr {
            let ring = Arc::clone(&stderr_tail);
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                loop {
                    match read_capped_line(&mut reader, 64 * 1024) {
                        Ok(CappedRead::Line(bytes)) => {
                            let trimmed = String::from_utf8_lossy(&bytes).trim().to_string();
                            if trimmed.is_empty() {
                                continue;
                            }
                            if let Ok(mut buf) = ring.lock() {
                                buf.push(trimmed);
                                if buf.len() > STDERR_RING_MAX {
                                    let drop_n = buf.len() - STDERR_RING_MAX;
                                    buf.drain(0..drop_n);
                                }
                            }
                        }
                        Ok(CappedRead::TooLarge) | Ok(CappedRead::EofPartial(_)) => continue,
                        Ok(CappedRead::Eof) | Err(_) => break,
                    }
                }
            });
        }
        process.resume()?;
        Ok(Self {
            process,
            stdin,
            lines: rx,
            stderr_tail,
            provider,
            awaiting_user: HashSet::new(),
            abandoned_prompt: None,
        })
    }

    pub fn process_handle(&self) -> SharedProcess {
        self.process.clone()
    }

    pub fn stderr_handle(&self) -> StderrTail {
        Arc::clone(&self.stderr_tail)
    }

    pub fn request(&mut self, id: u64, method: &str, params: Value) -> Result<(), String> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_line(&payload)
    }

    fn write_line(&mut self, payload: &Value) -> Result<(), String> {
        let line = format!("{}\n", payload);
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("stdin write: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("stdin flush: {e}"))?;
        Ok(())
    }

    fn respond_result(&mut self, id: &RequestId, result: Value) -> Result<(), String> {
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id.to_value(),
            "result": result,
        }))
    }

    fn respond_error(&mut self, id: &RequestId, code: i32, message: &str) -> Result<(), String> {
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id.to_value(),
            "error": { "code": code, "message": message },
        }))
    }

    fn flush_agent_response_outbox(&mut self, outbox: &AgentOutbox) -> Result<(), String> {
        let pending: Vec<(RequestId, Value)> = outbox
            .lock()
            .map_err(|e| e.to_string())?
            .drain(..)
            .collect();
        for (id, result) in pending {
            self.awaiting_user.remove(&id);
            self.respond_result(&id, result)?;
        }
        Ok(())
    }

    fn handle_incoming_line(
        &mut self,
        value: &Value,
        line_bytes: usize,
        dispatch: &mut LineDispatch,
    ) -> Result<(), String> {
        let method = value.get("method").and_then(|m| m.as_str());
        if let Some(method) = method {
            // A number or a string: either way the answer echoes it back.
            if let Some(req_id) = RequestId::from_message(value) {
                if method == "session/update" {
                    dispatch.record_notification(value, line_bytes);
                    return Ok(());
                }
                let params = value.get("params").unwrap_or(&Value::Null);
                let kind = self.provider.classify_request(method, params);
                if matches!(
                    kind,
                    AgentRequestKind::Permission
                        | AgentRequestKind::Plan
                        | AgentRequestKind::Question
                ) {
                    if let Some(handler) = &mut dispatch.on_agent_request {
                        match handler(value)? {
                            Some(result) => self.respond_result(&req_id, result)?,
                            None => {
                                self.awaiting_user.insert(req_id);
                            }
                        }
                    } else {
                        let result = response_for_agent_request(value);
                        self.respond_result(&req_id, result)?;
                    }
                } else if kind == AgentRequestKind::UnknownExtension {
                    let result = response_for_agent_request(value);
                    self.respond_result(&req_id, result)?;
                } else if let Some(handler) = &mut dispatch.on_agent_request {
                    if let Some(result) = handler(value)? {
                        self.respond_result(&req_id, result)?;
                    }
                } else {
                    self.respond_error(&req_id, -32601, "Method not found")?;
                }
            } else {
                dispatch.record_notification(value, line_bytes);
            }
            return Ok(());
        }
        Ok(())
    }

    pub fn call(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let mut dispatch = LineDispatch::default();
        self.call_with_dispatch(id, method, params, timeout, &mut dispatch, None)
    }

    pub fn call_with_dispatch(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        timeout: Duration,
        dispatch: &mut LineDispatch,
        mut turn: Option<&mut TurnControl<'_>>,
    ) -> Result<Value, String> {
        if let Some(ctrl) = turn.as_deref() {
            // Cards of an earlier turn were dropped when it ended and can never
            // be answered; they must not pause this turn's idle limit, and
            // answers queued for them (a cancel racing the turn's end) must
            // not reach an agent that no longer waits for them.
            self.awaiting_user.clear();
            if let Some(outbox) = &ctrl.outbox {
                outbox.lock().map_err(|e| e.to_string())?.clear();
            }
            self.settle_abandoned_prompt(SETTLE_WAIT)?;
        }
        if let Err(err) = self.request(id, method, params) {
            return Err(self.write_error(err));
        }
        // A turn's limit counts silence, not length, and pauses while the user owes an answer.
        let idle_limit = turn.is_some();
        let mut deadline = Instant::now() + timeout;
        let mut consecutive_bad = 0u32;
        let mut cancel_deadline: Option<Instant> = None;
        while Instant::now() < deadline {
            if idle_limit && !self.awaiting_user.is_empty() {
                deadline = Instant::now() + timeout;
            }
            if let Some(ctrl) = turn.as_deref_mut() {
                if let Some(outbox) = ctrl.outbox.clone() {
                    self.flush_agent_response_outbox(&outbox)?;
                }
                if let Some(followups) = ctrl.followups.clone() {
                    let pending: Vec<(String, Value)> = followups
                        .lock()
                        .map_err(|e| e.to_string())?
                        .drain(..)
                        .collect();
                    for (method, params) in pending {
                        let cid = *ctrl.next_id;
                        *ctrl.next_id += 1;
                        self.request(cid, &method, params)?;
                    }
                }
            }
            let cancel_now = if let Some(ctrl) = turn.as_deref_mut() {
                if ctrl.cancel.swap(false, Ordering::SeqCst) {
                    let cid = *ctrl.next_id;
                    *ctrl.next_id += 1;
                    Some((cid, ctrl.session_id.to_string()))
                } else {
                    None
                }
            } else {
                None
            };
            if let Some((cid, sid)) = cancel_now {
                self.request(cid, "session/cancel", json!({ "sessionId": sid }))?;
                cancel_deadline = Some(Instant::now() + CANCEL_GRACE);
            }
            if let Some(limit) = cancel_deadline {
                if Instant::now() >= limit {
                    self.abandoned_prompt = Some(id);
                    return Ok(json!({ "stopReason": "cancelled" }));
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = remaining.min(Duration::from_millis(50));
            match self.lines.recv_timeout(wait) {
                Ok(ReaderMsg::TooLarge) => {
                    consecutive_bad += 1;
                    if consecutive_bad >= consecutive_malformed_limit() {
                        return Err(
                            "agent stdout sent too many oversized or malformed lines (line exceeded size limit)"
                                .to_string(),
                        );
                    }
                    continue;
                }
                Ok(ReaderMsg::Line(line)) => {
                    if idle_limit {
                        deadline = Instant::now() + timeout;
                    }
                    match parse_acp_line(&line) {
                        ParsedLine::Empty => continue,
                        ParsedLine::Malformed(msg) => {
                            consecutive_bad += 1;
                            if consecutive_bad >= consecutive_malformed_limit() {
                                return Err(format!(
                                    "agent stdout sent too many oversized or malformed lines ({msg})"
                                ));
                            }
                            continue;
                        }
                        ParsedLine::Value(value) => {
                            consecutive_bad = 0;
                            if value.get("method").is_some() {
                                self.handle_incoming_line(&value, line.len(), dispatch)?;
                                continue;
                            }
                            if value.get("id").and_then(|v| v.as_u64()) == Some(id) {
                                if let Some(err) = value.get("error") {
                                    return Err(err.to_string());
                                }
                                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                            }
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Checked only once no line is waiting, so a reply written just
                    // before the agent exits is still read.
                    if let Ok(Some(status)) = self.process.try_wait() {
                        return Err(self.exit_error(Some(status.to_string())));
                    }
                    if remaining <= Duration::from_millis(50) && cancel_deadline.is_none() {
                        return Err(format!("timeout waiting for response id={id}"));
                    }
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(self.exit_error(None));
                }
            }
        }
        if cancel_deadline.is_some() {
            self.abandoned_prompt = Some(id);
            return Ok(json!({ "stopReason": "cancelled" }));
        }
        Err(format!("timeout waiting for response id={id}"))
    }

    /// Before a new turn: let a prompt abandoned after its cancel grace
    /// finish (up to `wait`). Its updates are dropped and its agent requests
    /// answered as cancelled, so nothing of it reaches the new turn.
    fn settle_abandoned_prompt(&mut self, wait: Duration) -> Result<(), String> {
        let Some(id) = self.abandoned_prompt.take() else {
            return Ok(());
        };
        let deadline = Instant::now() + wait;
        let mut dispatch = LineDispatch::default();
        while Instant::now() < deadline {
            match self.lines.recv_timeout(Duration::from_millis(50)) {
                Ok(ReaderMsg::Line(line)) => {
                    let ParsedLine::Value(value) = parse_acp_line(&line) else {
                        continue;
                    };
                    if value.get("method").is_some() {
                        self.handle_incoming_line(&value, line.len(), &mut dispatch)?;
                        dispatch.notifications.clear();
                    } else if value.get("id").and_then(Value::as_u64) == Some(id) {
                        return Ok(());
                    }
                }
                Ok(ReaderMsg::TooLarge) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Ok(Some(status)) = self.process.try_wait() {
                        return Err(self.exit_error(Some(status.to_string())));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(self.exit_error(None)),
            }
        }
        Ok(())
    }

    /// A failed write to an agent that has exited says why it exited.
    fn write_error(&self, err: String) -> String {
        match self.process.try_wait() {
            Ok(Some(status)) => self.exit_error(Some(status.to_string())),
            _ => err,
        }
    }

    pub fn kill(&mut self) {
        self.process.kill_tree();
    }

    fn exit_error(&self, status: Option<String>) -> String {
        let tail = self
            .stderr_tail
            .lock()
            .map(|buf| buf.join(" | "))
            .unwrap_or_default();
        let claude = self.provider.id() == crate::provider::ProviderId::Claude;
        exit_error_text(claude, status, &tail)
    }
}

/// The stderr tail as text, one line per line.
pub fn stderr_text(tail: &StderrTail) -> String {
    tail.lock().map(|buf| buf.join("\n")).unwrap_or_default()
}

/// Why the agent process stopped, worded for the provider that was running.
fn exit_error_text(claude: bool, status: Option<String>, tail: &str) -> String {
    let base = match status {
        Some(status) => format!("agent exited ({status})"),
        None if claude => "agent stdout closed — the Claude ACP adapter exited".to_string(),
        None => "agent stdout closed — the Cursor agent process exited".to_string(),
    };
    let lower = tail.to_lowercase();
    if claude {
        if lower.contains("not logged in")
            || lower.contains("/login")
            || lower.contains("unauthorized")
            || lower.contains("not authenticated")
            || lower.contains("invalid api key")
        {
            return format!("AUTH_ERROR: {base}. {tail}");
        }
        return if tail.is_empty() {
            format!("{base}. Restart this tab. If it keeps happening, run `claude-agent-acp` in a terminal to see why it stops.")
        } else {
            format!("{base}: {tail}")
        };
    }
    if lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthorized")
        || lower.contains("not authenticated")
    {
        return format!(
                "AUTH_ERROR: {base}. {tail}. Run `agent login` in a terminal, then start the tab again."
            );
    }
    if tail.is_empty() {
        format!(
                "{base}. Restart this tab. If it keeps happening, run `agent login` and confirm `agent` is on PATH."
            )
    } else {
        format!("{base}: {tail}")
    }
}

pub fn default_io_timeout() -> Duration {
    DEFAULT_IO_TIMEOUT
}

#[cfg(test)]
mod exit_error_tests {
    use super::exit_error_text;

    #[test]
    fn claude_exit_names_the_adapter_not_cursor() {
        let msg = exit_error_text(true, None, "");
        assert!(msg.contains("Claude ACP adapter"));
        assert!(!msg.contains("agent login"));
        // Adapter log lines mention "session" phases, never treat them as auth.
        let msg = exit_error_text(true, Some("1".into()), "[session/create] phase=settings");
        assert!(!msg.starts_with("AUTH_ERROR"));
        let msg = exit_error_text(true, Some("1".into()), "Not logged in · Please run /login");
        assert!(msg.starts_with("AUTH_ERROR:"));
        assert!(!msg.contains("agent login"));
    }

    #[test]
    fn cursor_exit_keeps_agent_login_hint() {
        let msg = exit_error_text(false, None, "");
        assert!(msg.contains("Cursor agent process"));
        assert!(msg.contains("agent login"));
        assert!(exit_error_text(false, None, "unauthorized").starts_with("AUTH_ERROR:"));
    }
}

#[cfg(all(test, unix))]
mod turn_timeout_tests {
    use super::{AcpConnection, LineDispatch, TurnControl};
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    /// Runs `script` with the system shell, so no freshly written file has to pass
    /// macOS's first-launch checks inside the timing window.
    fn run_turn(
        script: &str,
        timeout: Duration,
        dispatch: &mut LineDispatch,
    ) -> Result<serde_json::Value, String> {
        let args = ["-c".to_string(), script.to_string()];
        let mut conn = AcpConnection::spawn_with_args(Path::new("/bin/sh"), None, &args).unwrap();
        let cancel = AtomicBool::new(false);
        let mut next_id = 100;
        let mut turn = TurnControl {
            cancel: &cancel,
            session_id: "s1",
            next_id: &mut next_id,
            outbox: None,
            followups: None,
        };
        let result = conn.call_with_dispatch(
            7,
            "session/prompt",
            serde_json::json!({}),
            timeout,
            dispatch,
            Some(&mut turn),
        );
        conn.kill();
        result
    }

    const UPDATE: &str = r#"echo '{"jsonrpc":"2.0","method":"session/update","params":{}}'"#;
    const DONE: &str = r#"echo '{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}'"#;

    #[test]
    fn a_busy_turn_outlives_the_limit() {
        let script = format!("for i in 1 2 3 4 5 6; do {UPDATE}; sleep 0.4; done\n{DONE}\nsleep 5");
        let result = run_turn(&script, Duration::from_millis(1500), &mut LineDispatch::new());
        assert_eq!(result.unwrap()["stopReason"], "end_turn");
    }

    #[test]
    fn a_turn_waiting_on_the_user_does_not_time_out() {
        let ask = r#"echo '{"jsonrpc":"2.0","id":50,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{},"options":[]}}'"#;
        let script = format!("{ask}\nsleep 2.5\n{DONE}\nsleep 5");
        let mut dispatch = LineDispatch::new();
        dispatch.set_on_agent_request(Box::new(|_| Ok(None)));
        let result = run_turn(&script, Duration::from_millis(1000), &mut dispatch);
        assert_eq!(result.unwrap()["stopReason"], "end_turn");
    }

    #[test]
    fn a_silent_turn_still_times_out() {
        let script = format!("sleep 2\n{DONE}\nsleep 5");
        let result = run_turn(&script, Duration::from_millis(400), &mut LineDispatch::new());
        assert!(result.unwrap_err().contains("timeout waiting for response id=7"));
    }

    /// Runs a turn whose agent asks a permission with `ask_id` (raw JSON),
    /// then waits for an answer line carrying that same id before ending.
    fn answered_turn(ask_id: &str, wait_for: &str, answer_with: crate::acp::RequestId) -> Result<serde_json::Value, String> {
        use std::sync::{Arc, Mutex};
        let ask = format!(
            r#"echo '{{"jsonrpc":"2.0","id":{ask_id},"method":"session/request_permission","params":{{"sessionId":"s1","toolCall":{{}},"options":[]}}}}'"#
        );
        let script = format!(
            "{ask}\nwhile read line; do case \"$line\" in *'{wait_for}'*) {DONE}; break;; esac; done\nsleep 5"
        );
        let args = ["-c".to_string(), script];
        let mut conn = AcpConnection::spawn_with_args(Path::new("/bin/sh"), None, &args).unwrap();
        let outbox: super::AgentOutbox = Arc::new(Mutex::new(Vec::new()));
        let answer = {
            let outbox = Arc::clone(&outbox);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                outbox
                    .lock()
                    .unwrap()
                    .push((answer_with, serde_json::json!({ "outcome": { "outcome": "cancelled" } })));
            })
        };
        let cancel = AtomicBool::new(false);
        let mut next_id = 100;
        let mut turn = TurnControl {
            cancel: &cancel,
            session_id: "s1",
            next_id: &mut next_id,
            outbox: Some(outbox),
            followups: None,
        };
        let mut dispatch = LineDispatch::new();
        dispatch.set_on_agent_request(Box::new(|_| Ok(None)));
        let result = conn.call_with_dispatch(
            7,
            "session/prompt",
            serde_json::json!({}),
            Duration::from_secs(3),
            &mut dispatch,
            Some(&mut turn),
        );
        answer.join().unwrap();
        conn.kill();
        result
    }

    #[test]
    fn a_string_request_id_is_answered_with_the_same_string() {
        let result = answered_turn(r#""perm-1""#, r#""id":"perm-1""#, "perm-1".into());
        assert_eq!(result.unwrap()["stopReason"], "end_turn");
    }

    #[test]
    fn a_numeric_request_id_is_still_answered_as_a_number() {
        let result = answered_turn("50", r#""id":50,"#, 50.into());
        assert_eq!(result.unwrap()["stopReason"], "end_turn");
    }

    #[test]
    fn an_unknown_method_with_a_string_id_gets_method_not_found() {
        let ask = r#"echo '{"jsonrpc":"2.0","id":"x-9","method":"weird/thing","params":{}}'"#;
        let script = format!(
            "{ask}\nwhile read line; do case \"$line\" in *'\"id\":\"x-9\"'*'-32601'*|*'-32601'*'\"id\":\"x-9\"'*) {DONE}; break;; esac; done\nsleep 5"
        );
        let result = run_turn(&script, Duration::from_secs(3), &mut LineDispatch::new());
        assert_eq!(result.unwrap()["stopReason"], "end_turn");
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::LineDispatch;
    use serde_json::json;

    fn update(text: &str) -> serde_json::Value {
        json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } } }
        })
    }

    #[test]
    fn kept_notifications_stop_at_the_cap_and_the_rest_are_counted() {
        let mut dispatch = LineDispatch::with_keep_limit(3);
        for i in 0..5 {
            dispatch.record_notification(&update(&i.to_string()), 10);
        }
        assert_eq!(dispatch.notifications.len(), 3);
        assert_eq!(dispatch.notification_count, 5);
        assert_eq!(dispatch.dropped_notifications, 2);
        // The first ones are the ones kept.
        assert_eq!(dispatch.notifications[0], update("0"));
    }

    #[test]
    fn a_turn_keeps_nothing_but_still_collects_the_reply() {
        let mut dispatch = LineDispatch::with_keep_limit(0);
        dispatch.collect_agent_text();
        dispatch.record_notification(&update("Hello "), 10);
        dispatch.record_notification(&update("there"), 10);
        assert!(dispatch.notifications.is_empty());
        assert_eq!(dispatch.notification_count, 2);
        assert_eq!(dispatch.agent_text(), "Hello there");
    }

    #[test]
    fn kept_notifications_stop_at_the_byte_budget() {
        let mut dispatch = LineDispatch::new();
        dispatch.record_notification(&update("a"), super::MAX_KEPT_NOTIFICATION_BYTES - 5);
        dispatch.record_notification(&update("b"), 10);
        dispatch.record_notification(&update("c"), 5);
        assert_eq!(dispatch.notifications.len(), 2);
        assert_eq!(dispatch.dropped_notifications, 1);
    }
}
