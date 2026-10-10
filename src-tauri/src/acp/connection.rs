use super::ndjson::{
    acp_launch_args, consecutive_malformed_limit, parse_acp_line, read_capped_line, CappedRead,
    ParsedLine, MAX_ACP_LINE_BYTES,
};
use super::request_handler::response_for_agent_request;
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
const CANCEL_GRACE: Duration = Duration::from_secs(20);

pub type AgentRequestHandler = Box<dyn FnMut(&Value) -> Result<Option<Value>, String>>;
pub type NotificationHandler = Box<dyn FnMut(&Value)>;
pub type AgentOutbox = Arc<Mutex<Vec<(u64, Value)>>>;
/// Client requests to send during a turn (method, params). Responses are
/// ignored unless their id is the turn's own request.
pub type ClientFollowups = Arc<Mutex<Vec<(String, Value)>>>;

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

pub struct LineDispatch {
    pub notifications: Vec<Value>,
    on_notification: Option<NotificationHandler>,
    pub on_agent_request: Option<AgentRequestHandler>,
}

impl LineDispatch {
    pub fn new() -> Self {
        Self {
            notifications: Vec::new(),
            on_notification: None,
            on_agent_request: None,
        }
    }

    pub fn set_on_agent_request(&mut self, handler: AgentRequestHandler) {
        self.on_agent_request = Some(handler);
    }

    pub fn set_on_notification(&mut self, handler: NotificationHandler) {
        self.on_notification = Some(handler);
    }

    fn record_notification(&mut self, value: &Value) {
        self.notifications.push(value.clone());
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
    stderr_tail: Arc<Mutex<Vec<String>>>,
    /// Sorts agent requests (permission / plan / question / extension).
    provider: SharedProvider,
    /// Agent requests handed to the user and not answered yet.
    awaiting_user: HashSet<u64>,
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
        })
    }

    pub fn process_handle(&self) -> SharedProcess {
        self.process.clone()
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

    fn respond_result(&mut self, id: u64, result: Value) -> Result<(), String> {
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }))
    }

    fn respond_error(&mut self, id: u64, code: i32, message: &str) -> Result<(), String> {
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }))
    }

    fn flush_agent_response_outbox(&mut self, outbox: &AgentOutbox) -> Result<(), String> {
        let pending: Vec<(u64, Value)> = outbox
            .lock()
            .map_err(|e| e.to_string())?
            .drain(..)
            .collect();
        for (id, result) in pending {
            self.awaiting_user.remove(&id);
            self.respond_result(id, result)?;
        }
        Ok(())
    }

    fn handle_incoming_line(
        &mut self,
        value: &Value,
        dispatch: &mut LineDispatch,
    ) -> Result<(), String> {
        let method = value.get("method").and_then(|m| m.as_str());
        if let Some(method) = method {
            if let Some(req_id) = value.get("id").and_then(|v| v.as_u64()) {
                if method == "session/update" {
                    dispatch.record_notification(value);
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
                            Some(result) => self.respond_result(req_id, result)?,
                            None => {
                                self.awaiting_user.insert(req_id);
                            }
                        }
                    } else {
                        let result = response_for_agent_request(value);
                        self.respond_result(req_id, result)?;
                    }
                } else if kind == AgentRequestKind::UnknownExtension {
                    let result = response_for_agent_request(value);
                    self.respond_result(req_id, result)?;
                } else if let Some(handler) = &mut dispatch.on_agent_request {
                    if let Some(result) = handler(value)? {
                        self.respond_result(req_id, result)?;
                    }
                } else {
                    self.respond_error(req_id, -32601, "Method not found")?;
                }
            } else {
                dispatch.record_notification(value);
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
        self.request(id, method, params)?;
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
                    return Ok(json!({ "stopReason": "cancelled" }));
                }
            }
            if let Ok(Some(status)) = self.process.try_wait() {
                return Err(self.exit_error(Some(status.to_string())));
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
                                self.handle_incoming_line(&value, dispatch)?;
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
            return Ok(json!({ "stopReason": "cancelled" }));
        }
        Err(format!("timeout waiting for response id={id}"))
    }

    pub fn kill(&mut self) {
        self.process.kill_tree();
    }

    pub fn stderr_tail_text(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|buf| buf.join("\n"))
            .unwrap_or_default()
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
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    fn fake_agent(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dct-turn-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn run_turn(
        agent: &Path,
        timeout: Duration,
        dispatch: &mut LineDispatch,
    ) -> Result<serde_json::Value, String> {
        let mut conn = AcpConnection::spawn(agent, None).unwrap();
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
        let body = format!("for i in 1 2 3 4 5 6; do {UPDATE}; sleep 0.4; done\n{DONE}\nsleep 5");
        let agent = fake_agent("busy", &body);
        let result = run_turn(&agent, Duration::from_millis(1500), &mut LineDispatch::new());
        assert_eq!(result.unwrap()["stopReason"], "end_turn");
    }

    #[test]
    fn a_turn_waiting_on_the_user_does_not_time_out() {
        let ask = r#"echo '{"jsonrpc":"2.0","id":50,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{},"options":[]}}'"#;
        let agent = fake_agent("ask", &format!("{ask}\nsleep 2.5\n{DONE}\nsleep 5"));
        let mut dispatch = LineDispatch::new();
        dispatch.set_on_agent_request(Box::new(|_| Ok(None)));
        let result = run_turn(&agent, Duration::from_millis(1000), &mut dispatch);
        assert_eq!(result.unwrap()["stopReason"], "end_turn");
    }

    #[test]
    fn a_silent_turn_still_times_out() {
        let agent = fake_agent("silent", &format!("sleep 2\n{DONE}\nsleep 5"));
        let result = run_turn(&agent, Duration::from_millis(400), &mut LineDispatch::new());
        assert!(result.unwrap_err().contains("timeout waiting for response id=7"));
    }
}
