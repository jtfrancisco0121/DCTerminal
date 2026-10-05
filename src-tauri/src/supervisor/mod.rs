//! Spawns and stops `agent acp` child processes (T1.2).

use crate::acp::connection::AcpConnection;
use crate::cli_detect::resolve_agent_executable;
use std::path::{Path, PathBuf};

pub struct AgentSupervisor;

impl AgentSupervisor {
    pub fn resolve_agent() -> Result<PathBuf, String> {
        resolve_agent_executable().ok_or_else(|| {
            "Cursor CLI (agent) not found. Install it or set DCT_AGENT_PATH.".to_string()
        })
    }

    pub fn spawn_acp(agent_path: &Path, cwd: &Path) -> Result<AcpConnection, String> {
        AcpConnection::spawn(agent_path, Some(cwd)).map_err(|e| format!("spawn agent acp: {e}"))
    }

    pub fn spawn_default(cwd: &Path) -> Result<AcpConnection, String> {
        let agent = Self::resolve_agent()?;
        Self::spawn_acp(&agent, cwd)
    }
}
