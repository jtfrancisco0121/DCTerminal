//! Launch the interactive Cursor CLI in an external terminal.
//!
//! Windows is the primary target: Windows Terminal when `wt.exe` can be
//! spawned, otherwise a new PowerShell console. The session id is validated
//! before it is placed in the PowerShell command string.

use crate::cli_detect::resolve_agent_executable;
use crate::paths::validate_working_folder;
use crate::session_id::validate_acp_session_id;
use std::path::Path;
#[cfg(windows)]
use std::process::Command;

pub fn powershell_resume_command(agent: &Path, session_id: &str) -> Result<String, String> {
    validate_acp_session_id(session_id)?;
    let agent_display = agent.display().to_string();
    if agent_display.contains('\0') || agent_display.contains('\n') || agent_display.contains('\r')
    {
        return Err("agent path cannot be passed to PowerShell".to_string());
    }
    Ok(format!(
        "& {} --resume {}",
        powershell_single_quote(&agent_display),
        session_id.trim()
    ))
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Opens `agent --resume <session_id>` in the folder. Does not write `~/.cursor`.
pub fn open_agent_resume(cwd: &Path, session_id: &str) -> Result<String, String> {
    let folder = validate_working_folder(&cwd.display().to_string()).map_err(|err| err.message())?;
    let agent = resolve_agent_executable().ok_or_else(|| {
        "Cursor CLI (agent) was not found, so it cannot be opened in a terminal.".to_string()
    })?;
    let command = powershell_resume_command(&agent, session_id)?;
    spawn_external_terminal(&folder, &command)
}

fn spawn_external_terminal(cwd: &Path, powershell_command: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        spawn_windows(cwd, powershell_command)
    }
    #[cfg(not(windows))]
    {
        let _ = (cwd, powershell_command);
        Err(
            "Open in Cursor CLI starts Windows Terminal or PowerShell. This process is not running on Windows."
                .to_string(),
        )
    }
}

#[cfg(windows)]
fn spawn_windows(cwd: &Path, powershell_command: &str) -> Result<String, String> {
    let cwd_text = cwd.display().to_string();
    let wt = Command::new("wt.exe")
        .arg("-d")
        .arg(&cwd_text)
        .arg("powershell.exe")
        .arg("-NoExit")
        .arg("-Command")
        .arg(powershell_command)
        .spawn();
    if wt.is_ok() {
        return Ok("Windows Terminal".to_string());
    }
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    Command::new("powershell.exe")
        .current_dir(cwd)
        .arg("-NoExit")
        .arg("-Command")
        .arg(powershell_command)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(|err| format!("Could not open PowerShell: {err}"))?;
    Ok("PowerShell".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn quotes_the_agent_path_and_appends_the_session_id() {
        let command = powershell_resume_command(
            Path::new(r"C:\Users\JT\AppData\Local\cursor-agent\agent.cmd"),
            "11111111-2222-3333-4444-555555555555",
        )
        .unwrap();
        assert_eq!(
            command,
            r"& 'C:\Users\JT\AppData\Local\cursor-agent\agent.cmd' --resume 11111111-2222-3333-4444-555555555555"
        );
    }

    #[test]
    fn escapes_single_quotes_in_the_agent_path() {
        let command = powershell_resume_command(
            Path::new(r"C:\O'Brien\agent.cmd"),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        )
        .unwrap();
        assert!(command.contains(r"'C:\O''Brien\agent.cmd'"));
        assert!(command.ends_with("--resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
    }

    #[test]
    fn rejects_a_session_id_with_shell_metacharacters() {
        let err = powershell_resume_command(
            &PathBuf::from("agent"),
            "11111111-2222;calc",
        );
        assert!(err.is_err());
    }
}
