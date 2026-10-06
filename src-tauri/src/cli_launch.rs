//! `agent --resume <chatId>` as a direct argument list.
//!
//! Open in Cursor CLI runs this inside the in-app terminal. It does not open
//! Windows Terminal or a separate PowerShell window. The id is checked before
//! it is placed in argv so a chat id cannot become another flag.

use crate::session_id::validate_acp_session_id;

pub fn resume_agent_args(session_id: &str) -> Result<Vec<String>, String> {
    let id = session_id.trim();
    validate_acp_session_id(id)?;
    Ok(vec!["--resume".to_string(), id.to_string()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_args_are_the_flag_and_the_id() {
        let args = resume_agent_args("11111111-2222-3333-4444-555555555555").unwrap();
        assert_eq!(
            args,
            vec![
                "--resume".to_string(),
                "11111111-2222-3333-4444-555555555555".to_string(),
            ]
        );
    }

    #[test]
    fn rejects_a_session_id_with_shell_metacharacters() {
        assert!(resume_agent_args("11111111-2222;calc").is_err());
    }
}
