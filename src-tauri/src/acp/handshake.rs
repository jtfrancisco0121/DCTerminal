use super::connection::{default_io_timeout, AcpConnection};
use crate::cli_detect::resolve_agent_executable;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeStepResult {
    pub method: String,
    pub success: bool,
    pub response_json: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHandshakeProbeResult {
    pub success: bool,
    pub agent_path: Option<String>,
    pub session_id: Option<String>,
    pub mode_id: Option<String>,
    pub steps: Vec<HandshakeStepResult>,
    pub error: Option<String>,
}

pub fn probe_handshake(cwd: Option<PathBuf>) -> AcpHandshakeProbeResult {
    let agent_path = match resolve_agent_executable() {
        Some(p) => p,
        None => {
            return AcpHandshakeProbeResult {
                success: false,
                agent_path: None,
                session_id: None,
                mode_id: None,
                steps: vec![],
                error: Some("agent executable not found".to_string()),
            };
        }
    };

    let work_dir = cwd.or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| {
        PathBuf::from(".")
    });

    let mut conn = match AcpConnection::spawn(&agent_path, Some(&work_dir)) {
        Ok(c) => c,
        Err(e) => {
            return AcpHandshakeProbeResult {
                success: false,
                agent_path: Some(agent_path.display().to_string()),
                session_id: None,
                mode_id: None,
                steps: vec![],
                error: Some(format!("spawn failed: {e}")),
            };
        }
    };

    let timeout = default_io_timeout();
    let mut steps = Vec::new();
    let mut session_id: Option<String> = None;
    let mut mode_id: Option<String> = None;

    // id=1 initialize
    let init_params = json!({
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
    });
    steps.push(run_step(&mut conn, 1, "initialize", init_params, timeout));

    if !steps.last().map(|s| s.success).unwrap_or(false) {
        conn.kill();
        return finalize(agent_path, session_id, mode_id, steps, None);
    }

    // id=2 authenticate
    let auth_params = json!({ "methodId": "cursor_login" });
    steps.push(run_step(&mut conn, 2, "authenticate", auth_params, timeout));

    if !steps.last().map(|s| s.success).unwrap_or(false) {
        conn.kill();
        return finalize(agent_path, session_id, mode_id, steps, None);
    }

    // id=3 session/new
    let cwd_str = work_dir.display().to_string();
    let new_params = json!({
        "cwd": cwd_str,
        "mcpServers": []
    });
    let new_step = run_step(&mut conn, 3, "session/new", new_params, timeout);
    if new_step.success {
        if let Some(ref resp) = new_step.response_json {
            if let Ok(value) = serde_json::from_str::<Value>(resp) {
                session_id = value
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
    }
    steps.push(new_step);

    if session_id.is_none() {
        conn.kill();
        return finalize(
            agent_path,
            session_id,
            mode_id,
            steps,
            Some("session/new did not return sessionId".to_string()),
        );
    }

    // id=4 session/set_mode — use agent mode for smoke test
    let sid = session_id.clone().unwrap();
    let mode_params = json!({
        "sessionId": sid,
        "modeId": "agent"
    });
    let mode_step = run_step(&mut conn, 4, "session/set_mode", mode_params, timeout);
    if mode_step.success {
        mode_id = Some("agent".to_string());
    }
    steps.push(mode_step);

    conn.kill();
    finalize(agent_path, session_id, mode_id, steps, None)
}

fn run_step(
    conn: &mut AcpConnection,
    id: u64,
    method: &str,
    params: Value,
    timeout: std::time::Duration,
) -> HandshakeStepResult {
    match conn.call(id, method, params, timeout) {
        Ok(result) => HandshakeStepResult {
            method: method.to_string(),
            success: true,
            response_json: Some(result.to_string()),
            error: None,
        },
        Err(e) => HandshakeStepResult {
            method: method.to_string(),
            success: false,
            response_json: None,
            error: Some(e),
        },
    }
}

fn finalize(
    agent_path: PathBuf,
    session_id: Option<String>,
    mode_id: Option<String>,
    steps: Vec<HandshakeStepResult>,
    error: Option<String>,
) -> AcpHandshakeProbeResult {
    let all_ok = steps.iter().all(|s| s.success) && session_id.is_some();
    AcpHandshakeProbeResult {
        success: all_ok && error.is_none(),
        agent_path: Some(agent_path.display().to_string()),
        session_id,
        mode_id,
        steps,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires Cursor CLI login"]
    fn live_handshake_probe() {
        let result = probe_handshake(None);
        eprintln!("{:#?}", result);
        for step in &result.steps {
            eprintln!("{}: ok={}", step.method, step.success);
        }
        assert!(result.success, "handshake failed: {:?}", result.error);
        assert!(result.session_id.is_some());
    }
}
