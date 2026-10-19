//! One Claude account per window, on macOS and Windows.
//!
//! Closing the last window on macOS leaves the process running (a normal Mac
//! app). A Dock click with no windows restores that window. On Windows and
//! other platforms the last window quits the process. Either way the last
//! window's tabs and account stay in `state.json`, so relaunch or the Dock
//! brings them back. Closing a window while another is still open drops that
//! window from the restore list and keeps it, with all its tabs and its
//! account, for File > Reopen Closed Window. Quit (a programmatic exit,
//! including the macOS Quit item) does not drop windows that are still open.

use crate::process_tree::STOP_GRACE;
use crate::provider::claude_config::ConfigDirInfo;
use crate::store::settings_store::{account_display_name, resolved_account_config};
use crate::store::{SettingsStore, StateStore};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub const MAIN_WINDOW: &str = "main";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const NEW_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+N";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const NEW_WINDOW_EVENT: &str = "new-window";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const REOPEN_WINDOW_ITEM: &str = "reopen-closed-window";

/// File > Reopen Closed Window, kept to enable it only when a closed window
/// is there to reopen.
#[cfg(target_os = "macos")]
struct ReopenWindowItem(tauri::menu::MenuItem<tauri::Wry>);

/// Set while a real quit is in progress so closing windows does not archive them.
static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn window_title(account_name: &str) -> String {
    let name = account_name.trim();
    if name.is_empty() {
        "DCTerminal".to_string()
    } else {
        format!("DCTerminal — {name}")
    }
}

/// `false` only on macOS: the process stays up with no windows.
pub fn quit_when_last_window_closes(os: &str) -> bool {
    !os.eq_ignore_ascii_case("macos")
}

pub fn host_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Dock click (`applicationShouldHandleReopen`) with nothing visible.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn dock_reopen_creates_window(has_visible_windows: bool) -> bool {
    !has_visible_windows
}

/// The last open window is kept so Dock or the next launch can restore it.
pub fn should_keep_window_for_restore(other_windows: usize) -> bool {
    other_windows == 0
}

pub fn install_macos_menu(app: &tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
        let new_window = MenuItem::with_id(
            app,
            "new-window",
            "New Window",
            true,
            Some(NEW_WINDOW_ACCELERATOR),
        )?;
        // No shortcut of its own; enabled while a closed window is kept.
        let reopen_window = MenuItem::with_id(
            app,
            REOPEN_WINDOW_ITEM,
            "Reopen Closed Window",
            has_archived_windows(app.handle()),
            None::<&str>,
        )?;
        let file = Submenu::with_items(app, "File", true, &[&new_window, &reopen_window])?;
        app.manage(ReopenWindowItem(reopen_window));
        let quit = PredefinedMenuItem::quit(app, None)?;
        let app_menu = Submenu::with_items(app, "DCTerminal", true, &[&quit])?;
        // Without these, Cmd+C/V/X/A/Z never reach text fields on macOS.
        let edit = Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )?;
        let menu = Menu::with_items(app, &[&app_menu, &file, &edit])?;
        app.set_menu(menu)?;
        app.on_menu_event(|app, event| match event.id().as_ref() {
            "new-window" => request_new_window(app),
            REOPEN_WINDOW_ITEM => {
                // Off the main thread: transcripts load from disk, and the
                // window build hands itself to the main thread and waits.
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Err(err) = reopen_last_closed_window(&app) {
                        eprintln!("DCTerminal: reopen closed window failed: {err}");
                    }
                });
            }
            _ => {}
        });
    }
    let _ = app;
    Ok(())
}

/// Ask the focused window to open the account picker. With no window, restore one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn focused_label(app: &AppHandle) -> Option<String> {
    app.webview_windows().into_iter().find_map(|(label, window)| {
        window
            .is_focused()
            .ok()
            .filter(|focused| *focused)
            .map(|_| label)
    })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn request_new_window(app: &AppHandle) {
    if let Some(label) = focused_label(app) {
        let _ = app.emit_to(label, NEW_WINDOW_EVENT, ());
        return;
    }
    let _ = restore_a_window(app);
}

pub fn handle_run_event(app: &AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::Exit => shutdown_processes(app),
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if code.is_none() && !quit_when_last_window_closes(host_os()) {
                api.prevent_exit();
            } else {
                QUITTING.store(true, Ordering::SeqCst);
            }
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => on_window_destroyed(app, &label),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows, ..
        } if dock_reopen_creates_window(has_visible_windows) => {
            let _ = restore_a_window(app);
        }
        _ => {}
    }
}

/// App exit: SIGTERM every agent and terminal at once, wait for all of them
/// together for at most [`STOP_GRACE`] (no registry lock held), then kill
/// what is left. Claude gets the same chance to finish its session log as
/// on Stop. Windows has no SIGTERM, so nothing waits there. The login PATH
/// refresh's shell is killed first; it holds nothing worth waiting for.
fn shutdown_processes(app: &AppHandle) {
    crate::shell_env::stop_login_path_refresh();
    let sessions = app.try_state::<Mutex<crate::commands::SessionRegistry>>();
    let terminals = app.try_state::<Mutex<crate::pty::PtyRegistry>>();
    let agents = sessions
        .as_ref()
        .and_then(|state| state.lock().ok().map(|guard| guard.terminate_all()))
        .unwrap_or_default();
    let ptys = terminals
        .as_ref()
        .and_then(|state| state.lock().ok().map(|guard| guard.terminate_all()))
        .unwrap_or_default();
    if cfg!(unix) {
        let deadline = Instant::now() + STOP_GRACE;
        while Instant::now() < deadline
            && (agents
                .iter()
                .any(|agent| matches!(agent.try_wait(), Ok(None)))
                || ptys.iter().any(crate::process_tree::PtyGroup::running))
        {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    if let Some(state) = sessions {
        if let Ok(mut guard) = state.lock() {
            guard.kill_all();
        }
    }
    for group in ptys {
        group.kill();
    }
    if let Some(state) = terminals {
        if let Ok(mut guard) = state.lock() {
            guard.shutdown_all();
        }
    }
}

fn on_window_destroyed(app: &AppHandle, label: &str) {
    let tab_ids = {
        let Some(state) = app.try_state::<Mutex<StateStore>>() else {
            return;
        };
        let Ok(state) = state.lock() else {
            return;
        };
        state
            .data
            .tabs
            .iter()
            .filter(|tab| crate::store::window_matches(&tab.window_id, label))
            .map(|tab| tab.id.clone())
            .collect::<Vec<_>>()
    };
    if let Some(sessions) = app.try_state::<Mutex<crate::commands::SessionRegistry>>() {
        if let Ok(mut guard) = sessions.lock() {
            for id in &tab_ids {
                guard.shutdown_tab(id);
            }
        }
    }
    if let Some(terminals) = app.try_state::<Mutex<crate::pty::PtyRegistry>>() {
        for id in &tab_ids {
            crate::pty::kill_tab_pty(&terminals, id);
            crate::commands::forget_tab_session_log(app, id);
        }
    }
    let Some(state) = app.try_state::<Mutex<StateStore>>() else {
        return;
    };
    let Ok(mut state) = state.lock() else {
        return;
    };
    let _ = state.stop_window_tabs(label);
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let others = app
        .webview_windows()
        .keys()
        .filter(|key| key.as_str() != label)
        .count();
    if should_keep_window_for_restore(others) {
        return;
    }
    let _ = state.archive_window(label);
    drop(state);
    refresh_reopen_window_item(app);
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn has_archived_windows(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<Mutex<StateStore>>() else {
        return false;
    };
    let archived = state.lock().map(|state| state.has_archived_windows());
    archived.unwrap_or(false)
}

/// Enable File > Reopen Closed Window only while a closed window is kept.
/// Takes the state lock: never call it while holding that lock.
fn refresh_reopen_window_item(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(item) = app.try_state::<ReopenWindowItem>() {
        let _ = item.0.set_enabled(has_archived_windows(app));
    }
    let _ = app;
}

/// Build the most recently closed window again, with its tabs and account.
/// `None` when no closed window is kept.
pub fn reopen_last_closed_window(app: &AppHandle) -> Result<Option<String>, String> {
    let state = app
        .try_state::<Mutex<StateStore>>()
        .ok_or_else(|| "state is not ready".to_string())?;
    let transcripts = app
        .try_state::<Mutex<crate::store::TranscriptStore>>()
        .ok_or_else(|| "transcripts are not ready".to_string())?;
    let result = reopen_archived_window_with(
        &state,
        |id| {
            let transcripts = transcripts.lock().ok()?;
            transcripts
                .load(id)
                .ok()
                .flatten()
                .map(|loaded| loaded.text)
                .filter(|text| !text.trim().is_empty())
        },
        |window| {
            let title = title_for(app, &window.id);
            build_window(app, &window.id, &title)
        },
    );
    refresh_reopen_window_item(app);
    result
}

/// The store side of [`reopen_last_closed_window`]: `transcript` loads a
/// tab's saved chat and `build` opens the window. Transcripts load before
/// the state lock is taken. If the window cannot be built it is archived
/// again, so it stays in File > Reopen Closed Window.
pub(crate) fn reopen_archived_window_with(
    state: &Mutex<StateStore>,
    transcript: impl Fn(&str) -> Option<String>,
    build: impl FnOnce(&crate::store::WindowRecord) -> Result<(), String>,
) -> Result<Option<String>, String> {
    let tab_ids = {
        let state = state.lock().map_err(|err| err.to_string())?;
        match state.data.archived_windows.first() {
            Some(archived) => archived.tab_ids.clone(),
            None => return Ok(None),
        }
    };
    let mut loaded: std::collections::HashMap<String, Option<String>> = tab_ids
        .into_iter()
        .map(|id| {
            let text = transcript(&id);
            (id, text)
        })
        .collect();
    let reopened = {
        let mut state = state.lock().map_err(|err| err.to_string())?;
        // Another window may have been archived meanwhile: a tab not loaded
        // above loads here (lock order: state, then transcripts).
        state.reopen_archived_window(|id| loaded.remove(id).unwrap_or_else(|| transcript(id)))?
    };
    let Some(window) = reopened else {
        return Ok(None);
    };
    if let Err(err) = build(&window) {
        // The build error is the cause; a failed put-back is only added to it.
        let archived = state
            .lock()
            .map_err(|err| err.to_string())
            .and_then(|mut state| state.archive_window(&window.id));
        return Err(match archived {
            Ok(()) => err,
            Err(archive_err) => {
                format!("{err} (and it could not be kept for Reopen Closed Window: {archive_err})")
            }
        });
    }
    Ok(Some(window.id))
}

/// File > Reopen Closed Window from the page. Returns the reopened label.
#[tauri::command]
pub async fn reopen_closed_window(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || reopen_last_closed_window(&app))
        .await
        .map_err(|err| err.to_string())?
}

/// Recreate saved windows other than the one Tauri already opened, and title them.
pub fn restore_saved_windows(app: &AppHandle) {
    let labels = {
        let Some(state) = app.try_state::<Mutex<StateStore>>() else {
            return;
        };
        let Ok(state) = state.lock() else {
            return;
        };
        state
            .data
            .windows
            .iter()
            .map(|window| window.id.clone())
            .collect::<Vec<_>>()
    };
    if labels.is_empty() {
        let _ = build_window(app, MAIN_WINDOW, &window_title(""));
    }
    for label in labels {
        if app.get_webview_window(&label).is_some() {
            let _ = retitle(app, &label);
        } else {
            let title = title_for(app, &label);
            let _ = build_window(app, &label, &title);
        }
    }
}

fn title_for(app: &AppHandle, label: &str) -> String {
    let Some(state) = app.try_state::<Mutex<StateStore>>() else {
        return window_title("");
    };
    let Some(settings) = app.try_state::<Mutex<SettingsStore>>() else {
        return window_title("");
    };
    let Ok(state) = state.lock() else {
        return window_title("");
    };
    let Ok(settings) = settings.lock() else {
        return window_title("");
    };
    let account = state.account_for_window(label);
    window_title(&account_display_name(settings.providers(), &account))
}

fn retitle(app: &AppHandle, label: &str) -> Result<(), String> {
    let title = title_for(app, label);
    if let Some(window) = app.get_webview_window(label) {
        window.set_title(&title).map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Show an existing window, or recreate the saved one (main, else the last record).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn restore_a_window(app: &AppHandle) -> Result<(), String> {
    let label = {
        let state = app
            .try_state::<Mutex<StateStore>>()
            .ok_or_else(|| "state is not ready".to_string())?;
        let state = state.lock().map_err(|err| err.to_string())?;
        if state.data.windows.iter().any(|window| window.id == MAIN_WINDOW) {
            MAIN_WINDOW.to_string()
        } else {
            state
                .data
                .windows
                .last()
                .map(|window| window.id.clone())
                .unwrap_or_else(|| MAIN_WINDOW.to_string())
        }
    };
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        retitle(app, &label)?;
        return Ok(());
    }
    if !window_is_saved(app, &label) {
        remember_window(app, &label, "default")?;
    }
    let title = title_for(app, &label);
    build_window(app, &label, &title)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn window_is_saved(app: &AppHandle, label: &str) -> bool {
    let Some(state) = app.try_state::<Mutex<StateStore>>() else {
        return false;
    };
    let Ok(state) = state.lock() else {
        return false;
    };
    state
        .data
        .windows
        .iter()
        .any(|window| window.id == label)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn remember_window(app: &AppHandle, label: &str, account_id: &str) -> Result<(), String> {
    let state = app
        .try_state::<Mutex<StateStore>>()
        .ok_or_else(|| "state is not ready".to_string())?;
    let mut state = state.lock().map_err(|err| err.to_string())?;
    state.ensure_window(label, account_id)
}

fn build_window(app: &AppHandle, label: &str, title: &str) -> Result<(), String> {
    if app.get_webview_window(label).is_some() {
        return retitle(app, label);
    }
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1400.0, 900.0)
        // Lets the WebView see HTML5 drops (images dropped into a chat).
        .disable_drag_drop_handler()
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowContext {
    pub id: String,
    pub account_id: String,
    pub account_name: String,
    pub title: String,
    pub config: ConfigDirInfo,
}

#[tauri::command]
pub fn window_context(
    window: tauri::WebviewWindow,
    state: State<'_, Mutex<StateStore>>,
    settings: State<'_, Mutex<SettingsStore>>,
) -> Result<WindowContext, String> {
    let label = window.label().to_string();
    let ctx = {
        let state = state.lock().map_err(|err| err.to_string())?;
        let settings = settings.lock().map_err(|err| err.to_string())?;
        let account_id = state.account_for_window(&label);
        let account_name = account_display_name(settings.providers(), &account_id);
        let config = resolved_account_config(&settings.providers().claude, &account_id);
        let title = window_title(&account_name);
        WindowContext {
            id: label,
            account_id,
            account_name,
            title,
            config,
        }
    };
    let _ = window.set_title(&ctx.title);
    Ok(ctx)
}

/// Retitle every open window after an account rename.
pub fn retitle_open_windows(app: &AppHandle) {
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .map(|label| label.to_string())
        .collect();
    for label in labels {
        let _ = retitle(app, &label);
    }
}

/// Open another window on `account_id`. Two windows may share an account.
#[tauri::command]
pub async fn open_account_window(app: AppHandle, account_id: String) -> Result<String, String> {
    let account_id = account_id.trim().to_string();
    if account_id.is_empty() {
        return Err("Pick an account for the new window.".into());
    }
    let (label, title) = {
        let settings = app
            .try_state::<Mutex<SettingsStore>>()
            .ok_or_else(|| "settings are not ready".to_string())?;
        let settings = settings.lock().map_err(|err| err.to_string())?;
        if !settings
            .providers()
            .claude
            .accounts
            .iter()
            .any(|account| account.id == account_id)
        {
            return Err("That Claude account is not in Settings.".into());
        }
        let title = window_title(&account_display_name(settings.providers(), &account_id));
        drop(settings);
        let state = app
            .try_state::<Mutex<StateStore>>()
            .ok_or_else(|| "state is not ready".to_string())?;
        let mut state = state.lock().map_err(|err| err.to_string())?;
        let label = state.next_window_label();
        state.ensure_window(&label, &account_id)?;
        (label, title)
    };
    let app_for_build = app.clone();
    let label_for_build = label.clone();
    tauri::async_runtime::spawn_blocking(move || build_window(&app_for_build, &label_for_build, &title))
        .await
        .map_err(|err| err.to_string())??;
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_include_the_account_on_every_platform() {
        assert_eq!(window_title("Personal"), "DCTerminal — Personal");
        assert_eq!(window_title(" Company "), "DCTerminal — Company");
        assert_eq!(window_title("  "), "DCTerminal");
    }

    #[test]
    fn last_window_quits_except_on_macos() {
        assert!(!quit_when_last_window_closes("macos"));
        assert!(!quit_when_last_window_closes("MacOS"));
        assert!(quit_when_last_window_closes("windows"));
        assert!(quit_when_last_window_closes("linux"));
    }

    #[test]
    fn dock_click_reopens_only_when_nothing_is_visible() {
        assert!(dock_reopen_creates_window(false));
        assert!(!dock_reopen_creates_window(true));
    }

    #[test]
    fn only_the_last_window_is_kept_for_restore() {
        assert!(should_keep_window_for_restore(0));
        assert!(!should_keep_window_for_restore(1));
    }

    #[test]
    fn shortcut_is_command_on_mac_and_control_on_windows() {
        assert_eq!(NEW_WINDOW_ACCELERATOR, "CmdOrCtrl+Shift+N");
        assert!(NEW_WINDOW_ACCELERATOR.contains("Shift+N"));
        assert!(NEW_WINDOW_ACCELERATOR.starts_with("CmdOrCtrl+"));
    }
}
