use crate::cli_launch::open_agent_resume;
use crate::cursor_history::{
    cli_chat_required, cursor_data_dir, list_cursor_history, CursorHistoryEntry,
};
use crate::session_id::validate_acp_session_id;
use std::path::PathBuf;

#[tauri::command]
pub fn list_cursor_cli_history(cwd: String) -> Result<Vec<CursorHistoryEntry>, String> {
    let Some(root) = cursor_data_dir() else {
        return Ok(Vec::new());
    };
    Ok(list_cursor_history(&root, cwd.trim()))
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
    // The in-app Terminal tab (interactive `agent`) is not on master yet.
    // Until it is, a real CLI chat opens in Windows Terminal or PowerShell.
    open_agent_resume(PathBuf::from(folder).as_path(), id)
}
