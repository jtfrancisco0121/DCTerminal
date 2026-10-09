use super::session_connect::handshake as run_handshake;
use crate::cli_detect::resolve_agent_executable;
use crate::supervisor::AgentSupervisor;
use serde::Serialize;
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

    let work_dir = cwd
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));

    let mut conn = match AgentSupervisor::spawn_acp(&agent_path, &work_dir) {
        Ok(c) => c,
        Err(e) => {
            return AcpHandshakeProbeResult {
                success: false,
                agent_path: Some(agent_path.display().to_string()),
                session_id: None,
                mode_id: None,
                steps: vec![],
                error: Some(e),
            };
        }
    };

    match run_handshake(&mut conn, &crate::provider::CursorProvider, &work_dir, "agent") {
        Ok((session_id, mode_id, _models)) => {
            conn.kill();
            AcpHandshakeProbeResult {
                success: true,
                agent_path: Some(agent_path.display().to_string()),
                session_id: Some(session_id),
                mode_id: Some(mode_id),
                steps: vec![HandshakeStepResult {
                    method: "initialize → authenticate → session/new → set_mode".into(),
                    success: true,
                    response_json: None,
                    error: None,
                }],
                error: None,
            }
        }
        Err(e) => {
            conn.kill();
            AcpHandshakeProbeResult {
                success: false,
                agent_path: Some(agent_path.display().to_string()),
                session_id: None,
                mode_id: None,
                steps: vec![HandshakeStepResult {
                    method: "handshake".into(),
                    success: false,
                    response_json: None,
                    error: Some(e.clone()),
                }],
                error: Some(e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires Cursor CLI login"]
    fn live_handshake_probe() {
        let result = probe_handshake(None);
        assert!(result.success, "handshake failed: {:?}", result.error);
        assert!(result.session_id.is_some());
    }
}
