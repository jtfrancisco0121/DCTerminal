use crate::cli_launch::open_agent_resume;
use crate::cursor_history::{cursor_data_dir, list_cursor_history, CursorHistoryEntry};
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
    open_agent_resume(PathBuf::from(cwd.trim()).as_path(), session_id.trim())
}
