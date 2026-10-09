use crate::claude_history::{list_claude_history as scan_claude_history, ClaudeHistoryEntry};
use crate::cursor_history::{
    annotate_history, cli_chat_required, cursor_data_dir, first_heading, list_cursor_history,
    user_text_from_answers, CursorHistoryEntry, RoleHeading,
};
use crate::session_id::validate_acp_session_id;
use crate::store::{RolesStore, StateStore};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn list_cursor_cli_history(
    cwd: String,
    store: State<Mutex<StateStore>>,
    roles: State<Mutex<RolesStore>>,
) -> Result<Vec<CursorHistoryEntry>, String> {
    let Some(root) = cursor_data_dir() else {
        return Ok(Vec::new());
    };
    let mut entries = list_cursor_history(&root, cwd.trim());
    let store = store.lock().map_err(|err| err.to_string())?;
    let roles = roles.lock().map_err(|err| err.to_string())?;
    let local = local_session_labels(&store);
    let headings = roles
        .data
        .roles
        .iter()
        .map(|role| RoleHeading {
            role_name: role.name.clone(),
            heading: first_heading(&role.template_text),
        })
        .collect::<Vec<_>>();
    annotate_history(&mut entries, &local, &headings);
    Ok(entries)
}

/// ACP id → (role name, first user-entered text). Open tabs win over closed ones.
fn local_session_labels(store: &StateStore) -> HashMap<String, (String, Option<String>)> {
    let mut labels = HashMap::new();
    for closed in &store.data.closed_tabs {
        let Some(id) = closed.acp_session_id.clone() else {
            continue;
        };
        labels.insert(
            id,
            (
                closed.role_snapshot.name.clone(),
                user_text_from_answers(&closed.answers),
            ),
        );
    }
    for tab in &store.data.tabs {
        let Some(id) = tab
            .session
            .as_ref()
            .map(|session| session.acp_session_id.clone())
        else {
            continue;
        };
        labels.insert(
            id,
            (
                tab.role_snapshot.name.clone(),
                user_text_from_answers(&tab.answers),
            ),
        );
    }
    labels
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHistoryView {
    pub entries: Vec<ClaudeHistoryEntry>,
    /// Resolved config dir that was scanned (`<dir>/projects`).
    pub config_dir: String,
    pub config_display: String,
    pub exists: bool,
}

/// Read-only Claude sessions for `cwd` from the resolved config dir.
/// Never `~/.claude` unless that is the resolved dir.
#[tauri::command]
pub fn list_claude_history(
    cwd: String,
    settings: State<Mutex<crate::store::SettingsStore>>,
) -> Result<ClaudeHistoryView, String> {
    let config = {
        let settings = settings.lock().map_err(|err| err.to_string())?;
        crate::provider::claude_config::resolve_claude_config_dir(
            settings.providers().claude.config_dir.as_deref(),
        )
    };
    let entries = if config.exists {
        scan_claude_history(std::path::Path::new(&config.path), cwd.trim())
    } else {
        Vec::new()
    };
    Ok(ClaudeHistoryView {
        entries,
        config_dir: config.path,
        config_display: config.display,
        exists: config.exists,
    })
}

#[tauri::command]
pub fn open_in_cursor_cli(session_id: String, cwd: String) -> Result<String, String> {
    let id = session_id.trim();
    let folder = cwd.trim();
    validate_acp_session_id(id)?;
    let root = cursor_data_dir().ok_or_else(|| {
        "Cursor's home folder was not found, so this chat cannot be opened.".to_string()
    })?;
    cli_chat_required(&root, folder, id)?;
    // The window opens this chat itself, in a terminal tab. This command only
    // checks that the id is a CLI chat. It does not spawn a process.
    Ok("terminal".to_string())
}
