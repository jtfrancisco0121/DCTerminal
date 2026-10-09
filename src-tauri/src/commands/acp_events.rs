use crate::acp::{map_session_update, SESSION_UPDATE_EVENT};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub fn emit_session_update(app: &AppHandle, tab_id: &str, session_id: &str, line: &Value) {
    if let Some(payload) = map_session_update(tab_id, session_id, line) {
        if payload.kind == "usage_update" {
            note_usage(app, tab_id, &payload.raw_json);
        }
        let _ = app.emit(SESSION_UPDATE_EVENT, payload);
    }
}

fn note_usage(app: &AppHandle, tab_id: &str, raw_json: &str) {
    use tauri::Manager;
    let Some(usage) = app.try_state::<std::sync::Mutex<crate::usage::UsageStore>>() else {
        return;
    };
    let Some(settings) = app.try_state::<std::sync::Mutex<crate::store::SettingsStore>>() else {
        return;
    };
    let Ok(settings) = settings.lock() else {
        return;
    };
    let dir = crate::provider::claude_config::resolve_claude_config_dir(
        settings.providers().claude.config_dir.as_deref(),
    );
    drop(settings);
    let Ok(mut usage) = usage.lock() else {
        return;
    };
    let seen = chrono::Utc::now().timestamp_millis();
    usage.note(&dir.path, tab_id, raw_json, seen);
}
