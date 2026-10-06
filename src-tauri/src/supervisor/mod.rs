//! Spawns and stops `agent acp` child processes (T1.2).

use crate::acp::connection::AcpConnection;
use crate::cli_detect::{agent_missing_message, resolve_agent_executable};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub struct AgentSupervisor;

impl AgentSupervisor {
    pub fn resolve_agent() -> Result<PathBuf, String> {
        resolve_agent_executable().ok_or_else(agent_missing_message)
    }

    pub fn spawn_acp(agent_path: &Path, cwd: &Path) -> Result<AcpConnection, String> {
        Self::spawn_acp_with(agent_path, cwd, &[])
    }

    pub fn spawn_acp_with(
        agent_path: &Path,
        cwd: &Path,
        global_args: &[String],
    ) -> Result<AcpConnection, String> {
        AcpConnection::spawn_with_args(agent_path, Some(cwd), global_args).map_err(|e| {
            if e.kind() == ErrorKind::NotFound {
                agent_missing_message()
            } else {
                format!(
                    "Could not start Cursor CLI (`agent acp`) at {}: {e}. \
                     Confirm that path is the agent executable (on Windows, agent.cmd is OK) \
                     and that you are logged in (`agent login`).",
                    agent_path.display()
                )
            }
        })
    }

    pub fn spawn_default(cwd: &Path) -> Result<AcpConnection, String> {
        Self::spawn_default_with(cwd, &[])
    }

    pub fn spawn_default_with(cwd: &Path, global_args: &[String]) -> Result<AcpConnection, String> {
        let agent = Self::resolve_agent()?;
        Self::spawn_acp_with(&agent, cwd, global_args)
    }
}
