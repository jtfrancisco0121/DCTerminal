use crate::claude_session_log::{load_session_log, TerminalSessionLog};
use crate::pty::PtyRegistry;
use crate::store::StateStore;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

/// The config folder the tab started with and the Claude session it writes:
/// the live PTY's pinned id, else the one saved on the tab.
pub(crate) fn tab_session_target(
    state: &StateStore,
    registry: &PtyRegistry,
    tab_id: &str,
) -> Option<(PathBuf, String)> {
    let tab = state.tab_by_id(tab_id)?;
    let config_dir = tab
        .sessions
        .claude_config_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())?;
    let session_id = registry
        .claude_session(tab_id)
        .map(str::to_string)
        .or_else(|| tab.sessions.claude_terminal_session_id.clone())?;
    Some((PathBuf::from(config_dir), session_id))
}

#[tauri::command]
pub fn terminal_session_log(
    tab_id: String,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
) -> Result<Option<TerminalSessionLog>, String> {
    let target = {
        let state = store.lock().map_err(|err| err.to_string())?;
        let registry = registry.lock().map_err(|err| err.to_string())?;
        tab_session_target(&state, &registry, tab_id.trim())
    };
    // Locks are released before the (up to 8 MB) read.
    Ok(target.and_then(|(dir, id)| load_session_log(&dir, &id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderId;
    use crate::store::{RoleSnapshot, TerminalTabDraft};
    use crate::test_support::TempDir;
    use std::collections::HashMap;

    const SID: &str = "11111111-2222-4333-8444-555555555555";

    #[test]
    fn the_saved_session_id_survives_a_reopen_and_reads_only_its_config_dir() {
        let dir = TempDir::new("session_log_cmd");
        let account = dir.join("claude-account1");
        let mut store = StateStore::open_path(dir.join("state.json")).unwrap();
        let tab_id = store
            .save_terminal_tab(
                None,
                TerminalTabDraft {
                    launch: "role".into(),
                    cwd: dir.path().display().to_string(),
                    label: "Planner".into(),
                    role_id: "role_planner".into(),
                    role_snapshot: RoleSnapshot {
                        name: "Planner".into(),
                        template_version: 1,
                        mode: "plan".into(),
                        injection: "none".into(),
                    },
                    color: "#fff".into(),
                    answers: HashMap::new(),
                    merged_prompt: String::new(),
                    startup_prompt_sent: true,
                    provider: Some(ProviderId::Claude),
                },
            )
            .unwrap();
        let registry = PtyRegistry::new();
        assert!(tab_session_target(&store, &registry, &tab_id).is_none());
        store
            .remember_claude_config(&tab_id, &account.display().to_string())
            .unwrap();
        store
            .remember_claude_terminal_session(&tab_id, SID)
            .unwrap();
        drop(store);
        let store = StateStore::open_path(dir.join("state.json")).unwrap();
        let (config, id) = tab_session_target(&store, &registry, &tab_id).unwrap();
        assert_eq!(config, account);
        assert_eq!(id, SID);
        assert!(load_session_log(&config, &id).is_none());
        let folder = account.join("projects").join("-x");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(format!("{SID}.jsonl")), "{}\n").unwrap();
        let log = load_session_log(&config, &id).unwrap();
        assert_eq!(log.session_id, SID);
        assert!(!log.turn_done);
    }
}
