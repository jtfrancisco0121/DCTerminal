use crate::cli_detect::resolve_agent_executable;
use serde::Serialize;
use serde_json::json;
use std::io::{BufRead, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProbeResult {
    pub success: bool,
    pub agent_path: Option<String>,
    pub first_response_line: Option<String>,
    pub stderr_tail: Option<String>,
    pub error: Option<String>,
}

/// T0.1 / T0.3: spawn `agent acp`, send `initialize`, read first NDJSON line.
pub fn probe_initialize() -> AcpProbeResult {
    let agent_path = match resolve_agent_executable() {
        Some(p) => p,
        None => {
            return AcpProbeResult {
                success: false,
                agent_path: None,
                first_response_line: None,
                stderr_tail: None,
                error: Some("agent executable not found".to_string()),
            };
        }
    };

    let mut child = match spawn_agent_acp(&agent_path) {
        Ok(c) => c,
        Err(e) => {
            return AcpProbeResult {
                success: false,
                agent_path: Some(agent_path.display().to_string()),
                first_response_line: None,
                stderr_tail: None,
                error: Some(format!("spawn failed: {e}")),
            };
        }
    };

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false
            },
            "clientInfo": {
                "name": "DCTerminal",
                "title": "DCTerminal",
                "version": "0.1.0"
            }
        }
    });

    if let Some(mut stdin) = child.stdin.take() {
        let line = format!("{}\n", request);
        if let Err(e) = stdin.write_all(line.as_bytes()) {
            let _ = child.kill();
            return fail_probe(agent_path, None, format!("stdin write failed: {e}"));
        }
        if let Err(e) = stdin.flush() {
            let _ = child.kill();
            return fail_probe(agent_path, None, format!("stdin flush failed: {e}"));
        }
    }

    let stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel();

    if let Some(out) = stdout {
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(out);
            let mut line = String::new();
            if reader.read_line(&mut line).is_ok() && !line.is_empty() {
                let _ = tx.send(line);
            }
        });
    }

    let first_line = match rx.recv_timeout(INITIALIZE_TIMEOUT) {
        Ok(line) => line,
        Err(_) => {
            let stderr_tail = drain_stderr_tail(&mut child);
            let _ = child.kill();
            return AcpProbeResult {
                success: false,
                agent_path: Some(agent_path.display().to_string()),
                first_response_line: None,
                stderr_tail,
                error: Some(format!(
                    "no response within {}s",
                    INITIALIZE_TIMEOUT.as_secs()
                )),
            };
        }
    };

    let stderr_tail = drain_stderr_tail(&mut child);
    let _ = child.kill();

    let success = first_line.contains("jsonrpc") && first_line.contains("result");

    AcpProbeResult {
        success,
        agent_path: Some(agent_path.display().to_string()),
        first_response_line: Some(first_line.trim_end().to_string()),
        stderr_tail,
        error: if success {
            None
        } else {
            Some("unexpected initialize response".to_string())
        },
    }
}

#[tauri::command]
pub fn probe_acp() -> AcpProbeResult {
    probe_initialize()
}

fn spawn_agent_acp(agent_path: &std::path::Path) -> std::io::Result<std::process::Child> {
    Command::new(agent_path)
        .arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

fn drain_stderr_tail(child: &mut std::process::Child) -> Option<String> {
    if let Some(mut stderr) = child.stderr.take() {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            return None;
        }
        let lines: Vec<&str> = trimmed.lines().collect();
        let tail: Vec<&str> = lines.into_iter().rev().take(20).rev().collect();
        return Some(tail.join("\n"));
    }
    None
}

fn fail_probe(
    agent_path: std::path::PathBuf,
    stderr_tail: Option<String>,
    error: String,
) -> AcpProbeResult {
    AcpProbeResult {
        success: false,
        agent_path: Some(agent_path.display().to_string()),
        first_response_line: None,
        stderr_tail,
        error: Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run with: cargo test live_acp_probe -- --ignored --nocapture
    #[test]
    #[ignore = "requires Cursor CLI and network/auth"]
    fn live_acp_probe() {
        let result = probe_initialize();
        eprintln!("{:#?}", result);
        assert!(result.agent_path.is_some());
        assert!(result.success, "probe failed: {:?}", result.error);
    }
}
