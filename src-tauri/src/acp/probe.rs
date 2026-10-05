use super::connection::{default_io_timeout, AcpConnection};
use super::handshake::{probe_handshake, AcpHandshakeProbeResult};
use crate::cli_detect::resolve_agent_executable;
use serde::Serialize;
use serde_json::json;

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

    let cwd = std::env::current_dir().ok();
    let mut conn = match AcpConnection::spawn(&agent_path, cwd.as_deref()) {
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

    let result = conn.call(1, "initialize", init_params, default_io_timeout());
    conn.kill();

    match result {
        Ok(value) => {
            let line = value.to_string();
            AcpProbeResult {
                success: true,
                agent_path: Some(agent_path.display().to_string()),
                first_response_line: Some(line),
                stderr_tail: None,
                error: None,
            }
        }
        Err(e) => AcpProbeResult {
            success: false,
            agent_path: Some(agent_path.display().to_string()),
            first_response_line: None,
            stderr_tail: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn probe_acp_handshake() -> AcpHandshakeProbeResult {
    probe_handshake(None)
}

#[tauri::command]
pub fn probe_acp() -> AcpProbeResult {
    probe_initialize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires Cursor CLI and network/auth"]
    fn live_acp_probe() {
        let result = probe_initialize();
        eprintln!("{:#?}", result);
        assert!(result.agent_path.is_some());
        assert!(result.success, "probe failed: {:?}", result.error);
    }
}
