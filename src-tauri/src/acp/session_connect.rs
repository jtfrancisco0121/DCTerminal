use super::connection::{default_io_timeout, AcpConnection};
use serde_json::{json, Value};
use std::path::Path;

/// FR-003–004, FR-009: initialize → authenticate → session/new → set_mode.
pub fn handshake(
    conn: &mut AcpConnection,
    cwd: &Path,
    mode_id: &str,
) -> Result<(String, String), String> {
    let timeout = default_io_timeout();

    conn.call(1, "initialize", initialize_params(), timeout)?;

    conn.call(2, "authenticate", json!({ "methodId": "cursor_login" }), timeout)?;

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

fn initialize_params() -> Value {
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
