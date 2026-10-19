use crate::claude_session_log::chat::ChatEntriesUpdate;
use crate::claude_session_log::reader::SessionLogReaders;
use crate::claude_session_log::watch::spawn_watch;
use crate::claude_session_log::TerminalSessionLog;
use crate::pty::PtyRegistry;
use crate::store::StateStore;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

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

/// `tab_session_target` under the store and PTY locks, released on return.
fn locked_target(
    store: &Mutex<StateStore>,
    registry: &Mutex<PtyRegistry>,
    tab_id: &str,
) -> Result<Option<(PathBuf, String)>, String> {
    let state = store.lock().map_err(|err| err.to_string())?;
    let registry = registry.lock().map_err(|err| err.to_string())?;
    Ok(tab_session_target(&state, &registry, tab_id.trim()))
}

/// The summary of the tab's session log. Reads only what was appended since
/// the last read (see `claude_session_log::reader`). Async with the work on
/// a blocking thread: a tab's first read walks the config folder and parses
/// up to 8 MB.
#[tauri::command]
pub async fn terminal_session_log(
    app: AppHandle,
    tab_id: String,
) -> Result<Option<TerminalSessionLog>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_log_blocking(tab_id, app.state(), app.state(), app.state())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn session_log_blocking(
    tab_id: String,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
    readers: State<SessionLogReaders>,
) -> Result<Option<TerminalSessionLog>, String> {
    // Locks are released before the file is read.
    let Some((dir, id)) = locked_target(&store, &registry, &tab_id)? else {
        return Ok(None);
    };
    let Some(reader) = readers.tab_reader(tab_id.trim(), &dir, &id) else {
        return Ok(None);
    };
    let reader = reader.lock().map_err(|err| err.to_string())?;
    Ok(Some(reader.summary()))
}

/// The tab's chat entries changed after revision `since` (all of them, with
/// `reset`, when `since` is missing or stale). `None` until the log exists.
/// On a blocking thread, like `terminal_session_log`.
#[tauri::command]
pub async fn terminal_chat_entries(
    app: AppHandle,
    tab_id: String,
    since: Option<u64>,
) -> Result<Option<ChatEntriesUpdate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        chat_entries_blocking(tab_id, since, app.state(), app.state(), app.state())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn chat_entries_blocking(
    tab_id: String,
    since: Option<u64>,
    store: State<Mutex<StateStore>>,
    registry: State<Mutex<PtyRegistry>>,
    readers: State<SessionLogReaders>,
) -> Result<Option<ChatEntriesUpdate>, String> {
    let Some((dir, id)) = locked_target(&store, &registry, &tab_id)? else {
        return Ok(None);
    };
    let Some(reader) = readers.tab_reader(tab_id.trim(), &dir, &id) else {
        return Ok(None);
    };
    let reader = reader.lock().map_err(|err| err.to_string())?;
    Ok(Some(reader.chat_since(since)))
}

/// Stream the tab's chat entries on `on_update`: what changed after `since`
/// first (when anything did), then each change. Replaces the tab's previous
/// watch. Ends on `terminal_chat_unwatch`, when the tab closes or its PTY is
/// killed, or when the channel is gone.
#[tauri::command]
pub fn terminal_chat_watch(
    app: AppHandle,
    tab_id: String,
    since: Option<u64>,
    on_update: Channel<ChatEntriesUpdate>,
    readers: State<SessionLogReaders>,
) -> Result<(), String> {
    let tab_id = tab_id.trim().to_string();
    if tab_id.is_empty() {
        return Err("no tab".into());
    }
    let target_tab = tab_id.clone();
    let watch = spawn_watch(
        readers.inner().clone(),
        tab_id.clone(),
        since,
        move || {
            let store = app.try_state::<Mutex<StateStore>>()?;
            let registry = app.try_state::<Mutex<PtyRegistry>>()?;
            locked_target(&store, &registry, &target_tab).ok().flatten()
        },
        move |update| on_update.send(update).is_ok(),
    );
    readers.set_watch(&tab_id, watch);
    Ok(())
}

#[tauri::command]
pub fn terminal_chat_unwatch(tab_id: String, readers: State<SessionLogReaders>) {
    readers.stop_watch(tab_id.trim());
}

/// A tab closed: stop its watch and drop its reader.
pub(crate) fn forget_tab_session_log(app: &AppHandle, tab_id: &str) {
    if let Some(readers) = app.try_state::<SessionLogReaders>() {
        readers.forget(tab_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_session_log::load_session_log;
    use crate::provider::ProviderId;
    use crate::store::{RoleSnapshot, TerminalTabDraft};
    use crate::test_support::TempDir;
    use std::collections::HashMap;

    const SID: &str = "11111111-2222-4333-8444-555555555555";

    // Review: after a restart each terminal tab's first read walks the
    // config folder's projects and parses up to 8 MB of log. As plain
    // commands those reads ran on the main thread, one tab after another;
    // as sync `(async)` commands they would hold async runtime workers.
    #[test]
    fn session_log_reads_run_on_blocking_threads_off_the_main_thread() {
        let source = include_str!("session_log.rs");
        for name in ["terminal_session_log", "terminal_chat_entries"] {
            let at = source
                .find(&format!("pub async fn {name}("))
                .unwrap_or_else(|| panic!("{name} is not an async command"));
            let body = &source[at..];
            let end = body.find("\n}\n").expect("end of command");
            assert!(
                body[..end].contains("spawn_blocking("),
                "{name} reads the log on an async runtime worker"
            );
        }
    }

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
