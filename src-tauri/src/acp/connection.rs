use super::request_handler::response_for_agent_request;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const DEFAULT_IO_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct LineDispatch {
    pub notifications: Vec<Value>,
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

    fn handle_incoming_line(
        &mut self,
        value: &Value,
        dispatch: &mut LineDispatch,
    ) -> Result<(), String> {
        let method = value.get("method").and_then(|m| m.as_str());
        if let Some(method) = method {
            if let Some(req_id) = value.get("id").and_then(|v| v.as_u64()) {
                if method == "session/update" {
                    dispatch.notifications.push(value.clone());
                    return Ok(());
                }
                if method == "session/request_permission" || method.starts_with("cursor/") {
                    let result = response_for_agent_request(value);
                    self.respond_result(req_id, result)?;
                } else {
                    self.respond_error(req_id, -32601, "Method not found")?;
                }
            } else {
                dispatch.notifications.push(value.clone());
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
        self.call_with_dispatch(id, method, params, timeout, &mut dispatch)
    }

    pub fn call_with_dispatch(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        timeout: Duration,
        dispatch: &mut LineDispatch,
    ) -> Result<Value, String> {
        self.request(id, method, params)?;
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(remaining) {
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
                    return Err(format!("timeout waiting for response id={id}"));
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
