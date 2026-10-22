//! One-time move of provider-less tabs onto Claude (Task 6.3).
//!
//! A tab saved before providers existed has `provider: null` and a Cursor
//! session id. After this runs it is a Claude tab with an empty
//! `sessions.claude`, so restore starts a fresh Claude session. The Cursor
//! id stays in `sessions.cursor` for a switch back. Files are copied to
//! `*.pre-claude-first.json` in app data before the new file is written.
//! Nothing here touches `~/.claude` or `~/.cursor`.

use super::state_types::{AppStateFile, ClosedTabRecord, TabRecord};
use crate::provider::ProviderId;
use std::path::Path;

pub const CLAUDE_MIGRATION_NOTICE: &str =
    "Now using Claude. Your earlier Cursor session is kept — switch this tab to Cursor to reopen it.";

/// Copy `state.json` to `state.pre-claude-first.json` beside it. A second
/// run does not overwrite the backup.
pub fn backup_pre_claude_first(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("state.json");
    let stem = name.trim_end_matches(".json");
    let backup = path.with_file_name(format!("{stem}.pre-claude-first.json"));
    if backup.exists() {
        return Ok(());
    }
    std::fs::copy(path, &backup).map_err(|err| format!("backup {name}: {err}"))?;
    Ok(())
}

/// `true` when the file still needed the migration (caller should back up
/// the on-disk file, then save).
pub fn migrate_state(data: &mut AppStateFile) -> bool {
    if data.migrations.claude_first {
        return false;
    }
    for tab in &mut data.tabs {
        migrate_tab(tab);
    }
    for closed in &mut data.closed_tabs {
        migrate_closed(closed);
    }
    data.migrations.claude_first = true;
    true
}

fn migrate_tab(tab: &mut TabRecord) {
    if tab.provider.is_some() {
        return;
    }
    park_cursor_id(tab);
    tab.session = None;
    tab.provider = Some(ProviderId::Claude);
    if tab.sessions.cursor.is_some() {
        tab.provider_notice = Some(CLAUDE_MIGRATION_NOTICE.to_string());
    }
}

fn park_cursor_id(tab: &mut TabRecord) {
    if tab.sessions.cursor.is_none() {
        if let Some(session) = &tab.session {
            tab.sessions.cursor = Some(session.acp_session_id.clone());
        }
    }
    if let Some(id) = tab.answers.get("resumeSessionId").cloned() {
        let id = id.trim().to_string();
        if !id.is_empty() && tab.sessions.cursor.is_none() {
            tab.sessions.cursor = Some(id);
        }
        tab.answers.remove("resumeSessionId");
    }
}

fn migrate_closed(closed: &mut ClosedTabRecord) {
    if closed.provider.is_some() {
        return;
    }
    if closed.sessions.cursor.is_none() {
        closed.sessions.cursor = closed
            .acp_session_id
            .clone()
            .filter(|id| !id.trim().is_empty());
    }
    if let Some(id) = closed.answers.get("resumeSessionId").cloned() {
        let id = id.trim().to_string();
        if !id.is_empty() && closed.sessions.cursor.is_none() {
            closed.sessions.cursor = Some(id);
        }
        closed.answers.remove("resumeSessionId");
    }
    // Reopen rebuilds `session` from this field. Leave it empty so a Cursor
    // id is not loaded under Claude.
    closed.acp_session_id = None;
    closed.provider = Some(ProviderId::Claude);
    if closed.sessions.cursor.is_some() {
        closed.provider_notice = Some(CLAUDE_MIGRATION_NOTICE.to_string());
    }
}

