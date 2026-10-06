use crate::acp::{map_session_update, SESSION_UPDATE_EVENT};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub fn emit_session_update(app: &AppHandle, tab_id: &str, session_id: &str, line: &Value) {
    if let Some(payload) = map_session_update(tab_id, session_id, line) {
        let _ = app.emit(SESSION_UPDATE_EVENT, payload);
    }
}
