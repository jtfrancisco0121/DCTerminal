use super::ndjson::{
    acp_launch_args, consecutive_malformed_limit, parse_acp_line, read_capped_line, CappedRead,
    ParsedLine, MAX_ACP_LINE_BYTES,
};
use super::request_handler::{is_permission_method, response_for_agent_request};
use crate::process_tree::{prepare_command, SharedProcess};
use serde_json::{json, Value};
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

enum ReaderMsg {
    Line(String),
    TooLarge,
}

pub struct TurnControl<'a> {
    pub cancel: &'a AtomicBool,
    pub session_id: &'a str,
    pub next_id: &'a mut u64,
    pub outbox: Option<AgentOutbox>,
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
}

impl AcpConnection {
    pub fn spawn(agent_path: &Path, cwd: Option<&Path>) -> std::io::Result<Self> {
        let mut command = Command::new(agent_path);
        for arg in acp_launch_args() {
            command.arg(*arg);
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
        let process = SharedProcess::from_child(child);
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
        Ok(Self {
            process,
            stdin,
            lines: rx,
            stderr_tail,
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
        self.stdin.flush().map_err(|e| format!("stdin flush: {e}"))?;
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
                let is_permission = is_permission_method(method);
                if is_permission {
                    if let Some(handler) = &mut dispatch.on_agent_request {
                        if let Some(result) = handler(value)? {
                            self.respond_result(req_id, result)?;
                        }
                    } else {
                        let result = response_for_agent_request(value);
                        self.respond_result(req_id, result)?;
                    }
                } else if method.starts_with("cursor/") {
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
        let deadline = Instant::now() + timeout;
        let mut consecutive_bad = 0u32;
        let mut cancel_deadline: Option<Instant> = None;
        while Instant::now() < deadline {
            if let Some(ctrl) = turn.as_deref_mut() {
                if let Some(outbox) = ctrl.outbox.clone() {
                    self.flush_agent_response_outbox(&outbox)?;
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
                Ok(ReaderMsg::Line(line)) => match parse_acp_line(&line) {
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
                },
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

    fn exit_error(&self, status: Option<String>) -> String {
        let tail = self
            .stderr_tail
            .lock()
            .map(|buf| buf.join(" | "))
            .unwrap_or_default();
        let base = match status {
            Some(status) => format!("agent exited ({status})"),
            None => "agent stdout closed — the Cursor agent process exited".to_string(),
        };
        let lower = tail.to_lowercase();
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
}

pub fn default_io_timeout() -> Duration {
    DEFAULT_IO_TIMEOUT
}
