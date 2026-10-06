//! ACP / CLI session ids that may be passed to `agent --resume` or `session/load`.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStartBind {
    CreateNew,
    LoadExisting { session_id: String },
}

/// Cursor chat and ACP session ids observed in the wild are UUIDs.
/// Restrict the alphabet so an id can be a CLI argument without a shell.
pub fn validate_acp_session_id(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.len() < 8 || id.len() > 128 {
        return Err(
            "session id length is outside 8–128 characters, so it was not sent to the CLI"
                .to_string(),
        );
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(
            "session id contains characters that cannot be passed as a CLI argument".to_string(),
        );
    }
    Ok(())
}

/// `resume_session_id` set means load that ACP session. Empty means `session/new`.
pub fn session_start_bind(resume_session_id: Option<&str>) -> Result<SessionStartBind, String> {
    let Some(id) = resume_session_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(SessionStartBind::CreateNew);
    };
    validate_acp_session_id(id)?;
    Ok(SessionStartBind::LoadExisting {
        session_id: id.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_resume_id_starts_a_new_session() {
        assert_eq!(
            session_start_bind(None).unwrap(),
            SessionStartBind::CreateNew
        );
        assert_eq!(
            session_start_bind(Some("  ")).unwrap(),
            SessionStartBind::CreateNew
        );
    }

    #[test]
    fn a_session_id_binds_to_session_load() {
        let bind = session_start_bind(Some(" 11111111-2222-3333-4444-555555555555 ")).unwrap();
        assert_eq!(
            bind,
            SessionStartBind::LoadExisting {
                session_id: "11111111-2222-3333-4444-555555555555".to_string(),
            }
        );
    }

    #[test]
    fn rejects_ids_that_could_change_the_shell_command() {
        assert!(validate_acp_session_id("short").is_err());
        assert!(validate_acp_session_id("has space-in-id").is_err());
        assert!(validate_acp_session_id("id;rm").is_err());
        assert!(validate_acp_session_id("../../etc/passwd-extra").is_err());
    }
}
