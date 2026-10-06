use super::request_handler::{is_permission_method, response_for_agent_request};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc::{self, Receiver}};
use std::time::{Duration, Instant};

const DEFAULT_IO_TIMEOUT: Duration = Duration::from_secs(30);
const STDERR_RING_MAX: usize = 200;

pub type AgentRequestHandler = Box<dyn FnMut(&Value) -> Result<Option<Value>, String>>;

pub struct LineDispatch {
    pub notifications: Vec<Value>,
    on_notification: Option<Box<dyn FnMut(&Value)>>,
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

    pub fn set_on_notification(&mut self, handler: Box<dyn FnMut(&Value)>) {
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
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

impl AcpConnection {
    pub fn spawn(agent_path: &Path, cwd: Option<&Path>) -> std::io::Result<Self> {
        let mut command = Command::new(agent_path);
        command
            .arg("acp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok() {
                if line.trim().is_empty() {
                    line.clear();
                    continue;
                }
                if tx.send(line.clone()).is_err() {
                    break;
                }
                line.clear();
            }
        });
        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                let ring: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
                while reader.read_line(&mut line).is_ok() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut buf) = ring.lock() {
                            buf.push(trimmed.to_string());
                            if buf.len() > STDERR_RING_MAX {
                                let drop = buf.len() - STDERR_RING_MAX;
                                buf.drain(0..drop);
                            }
                        }
                    }
                    line.clear();
                }
            });
        }
        Ok(Self {
            child,
            stdin,
            lines: rx,
        })
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

    fn flush_agent_response_outbox(
        &mut self,
        outbox: &Arc<Mutex<Vec<(u64, Value)>>>,
    ) -> Result<(), String> {
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
                        match handler(value)? {
                            Some(result) => self.respond_result(req_id, result)?,
                            None => {}
                        }
                    } else {
                        let result = response_for_agent_request(value);
                        self.respond_result(req_id, result)?;
                    }
                } else if method.starts_with("cursor/") {
                    let result = response_for_agent_request(value);
                    self.respond_result(req_id, result)?;
                } else if let Some(handler) = &mut dispatch.on_agent_request {
                    match handler(value)? {
                        Some(result) => self.respond_result(req_id, result)?,
                        None => {}
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
        agent_response_outbox: Option<Arc<Mutex<Vec<(u64, Value)>>>>,
    ) -> Result<Value, String> {
        self.request(id, method, params)?;
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(outbox) = &agent_response_outbox {
                self.flush_agent_response_outbox(outbox)?;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = remaining.min(Duration::from_millis(50));
            match self.lines.recv_timeout(wait) {
                Ok(line) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let value: Value = serde_json::from_str(trimmed)
                        .map_err(|e| format!("invalid JSON line: {e}"))?;

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
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if remaining <= Duration::from_millis(50) {
                        return Err(format!("timeout waiting for response id={id}"));
                    }
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("agent stdout closed".to_string());
                }
            }
        }
        Err(format!("timeout waiting for response id={id}"))
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

pub fn default_io_timeout() -> Duration {
    DEFAULT_IO_TIMEOUT
}
