use super::connection::{default_io_timeout, AcpConnection, LineDispatch};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// Blueprint §16: `session/load` may replay a long transcript.
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCapabilities {
    pub load_session: bool,
    pub session_list: bool,
    pub session_resume: bool,
    pub session_close: bool,
}

pub fn capabilities_from_initialize(result: &Value) -> AgentCapabilities {
    let caps = result.get("agentCapabilities");
    let session = caps.and_then(|value| value.get("sessionCapabilities"));
    AgentCapabilities {
        load_session: caps
            .and_then(|value| value.get("loadSession"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        session_list: session.and_then(|value| value.get("list")).is_some(),
        session_resume: session.and_then(|value| value.get("resume")).is_some(),
        session_close: session.and_then(|value| value.get("close")).is_some(),
    }
}

pub fn load_session_params(session_id: &str, cwd: &str) -> Value {
    json!({
        "sessionId": session_id,
        "cwd": cwd,
        "mcpServers": []
    })
}

/// FR-003–004, FR-009: initialize → authenticate → session/new → set_mode.
pub fn handshake(
    conn: &mut AcpConnection,
    cwd: &Path,
    mode_id: &str,
) -> Result<(String, String), String> {
    let timeout = default_io_timeout();

    conn.call(1, "initialize", initialize_params(), timeout)?;

    match conn.call(2, "authenticate", json!({ "methodId": "cursor_login" }), timeout) {
        Ok(_) => {}
        Err(e) if is_auth_failure(&e) => {
            return Err(format!("AUTH_ERROR: {e}"));
        }
        Err(e) => return Err(e),
    }

    let new_result = conn.call(
        3,
        "session/new",
        json!({
            "cwd": cwd.display().to_string(),
            "mcpServers": []
        }),
        timeout,
    )?;

    let session_id = new_result
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "session/new missing sessionId".to_string())?
        .to_string();

    conn.call(
        4,
        "session/set_mode",
        json!({
            "sessionId": session_id,
            "modeId": mode_id
        }),
        timeout,
    )?;

    Ok((session_id, mode_id.to_string()))
}

/// Resume one ACP session. Caller must already know `loadSession` may be false;
/// this checks the live `initialize` result and refuses `session/load` when it is.
pub fn handshake_load(
    conn: &mut AcpConnection,
    cwd: &Path,
    mode_id: &str,
    session_id: &str,
) -> Result<(String, String, Vec<Value>), String> {
    let timeout = default_io_timeout();
    let init = conn.call(1, "initialize", initialize_params(), timeout)?;
    let caps = capabilities_from_initialize(&init);
    if !caps.load_session {
        return Err(
            "LOAD_UNSUPPORTED: this Cursor CLI did not advertise agentCapabilities.loadSession, so session/load was not sent"
                .to_string(),
        );
    }
    // `session/resume` is a different method. This path only sends `session/load`.

    match conn.call(2, "authenticate", json!({ "methodId": "cursor_login" }), timeout) {
        Ok(_) => {}
        Err(e) if is_auth_failure(&e) => {
            return Err(format!("AUTH_ERROR: {e}"));
        }
        Err(e) => return Err(e),
    }

    let mut dispatch = LineDispatch::default();
    conn.call_with_dispatch(
        3,
        "session/load",
        load_session_params(session_id, &cwd.display().to_string()),
        LOAD_TIMEOUT,
        &mut dispatch,
        None,
    )?;

    conn.call(
        4,
        "session/set_mode",
        json!({
            "sessionId": session_id,
            "modeId": mode_id
        }),
        timeout,
    )?;

    Ok((
        session_id.to_string(),
        mode_id.to_string(),
        dispatch.notifications,
    ))
}

fn is_auth_failure(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthorized")
        || lower.contains("not authenticated")
}

pub(crate) fn initialize_params() -> Value {
    json!({
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_initialize_advertises_load_and_list_but_not_resume() {
        let raw = include_str!("../../../fixtures/acp/initialize-response-2026-10-06.ndjson");
        let value: Value = serde_json::from_str(raw).unwrap();
        let result = value.get("result").cloned().unwrap_or(value);
        let caps = capabilities_from_initialize(&result);
        assert!(caps.load_session);
        assert!(caps.session_list);
        assert!(!caps.session_resume);
        assert!(!caps.session_close);
    }

    #[test]
    fn load_params_carry_the_same_session_id_and_cwd() {
        let params = load_session_params("sess_789xyz", r"C:\Work\App");
        assert_eq!(params["sessionId"], "sess_789xyz");
        assert_eq!(params["cwd"], r"C:\Work\App");
        assert_eq!(params["mcpServers"], serde_json::json!([]));
    }

    #[test]
    fn missing_load_session_is_not_treated_as_supported() {
        let caps = capabilities_from_initialize(&json!({ "agentCapabilities": {} }));
        assert!(!caps.load_session);
        assert!(!caps.session_list);
    }
}
