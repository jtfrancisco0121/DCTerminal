use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const DEFAULT_IO_TIMEOUT: Duration = Duration::from_secs(30);

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
        let line = format!("{}\n", payload);
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("write {method}: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("flush {method}: {e}"))?;
        Ok(())
    }

    /// Read NDJSON lines until a JSON-RPC response for `id` arrives (skips notifications).
    pub fn wait_response(
        &self,
        id: u64,
        timeout: Duration,
    ) -> Result<Value, String> {
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
                    if value.get("id").and_then(|v| v.as_u64()) == Some(id) {
                        if let Some(err) = value.get("error") {
                            return Err(err.to_string());
                        }
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                    // Notification or unrelated response — keep reading.
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

    pub fn call(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.request(id, method, params)?;
        self.wait_response(id, timeout)
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

pub fn default_io_timeout() -> Duration {
    DEFAULT_IO_TIMEOUT
}
