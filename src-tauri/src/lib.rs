mod acp;
mod cli_detect;
mod cli_launch;
mod commands;
mod cursor_history;
mod data_dir;
mod files;
mod history_search;
mod models;
mod orchestrator;
mod paths;
mod permissions;
mod process_tree;
pub mod provider;
mod pty;
pub mod roles;
mod session_id;
pub mod store;
pub mod supervisor;
pub mod template;
pub mod turn_changes;
pub mod worktree;

use acp::{probe_acp, probe_acp_handshake};
use cli_detect::{cli_login_status, detect_cli};
use commands::history_search;
use commands::{
    acp_set_model, check_working_folder, close_tab, create_execution_pipeline_tabs,
    create_pipeline_tabs, cursor_approval_mode, get_pipeline_run, pipeline_promote_plan,
    pipeline_set_candidate_plan,
    dev_session_cancel, dev_session_send, dev_session_start, dev_session_stop,
    diagnostics_read_log, diagnostics_set_capture, diagnostics_status, get_app_state,
    get_form_recall, get_layout, get_role, get_tab,
    handoff_bind_tab, handoff_get, handoff_list, handoff_save, list_cursor_cli_history, list_roles,
    new_draft_tab, open_in_cursor_cli, projects_list, projects_remember, projects_remove,
    projects_toggle_favorite, reopen_closed_tab, reset_builtin_role, respond_permission_request,
    respond_plan_request, respond_question_request, role_session_start, save_form_draft,
    save_role, scratch_load, scratch_save, session_agent_logs,
    select_active_tab, set_layout,
    export_text_file, set_tab_color, set_tab_label, sync_active_tab_form, transcript_load,
    transcript_save,
    validate_and_preview, SessionRegistry,
};
use commands::{changes_file_diff, changes_list, changes_revert, changes_snapshot, ChangesRoot};
use commands::{first_run_complete, first_run_status};
use commands::{git_repo_info, worktree_tab_check, worktree_tab_new, worktree_tab_remove};
use commands::{
    prompt_clear_recent, prompt_delete, prompt_library_get, prompt_mark_used, prompt_record_send,
    prompt_save,
};
use commands::{workspace_delete, workspace_open, workspace_save, workspaces_list};
use files::{files_list, files_read, files_reveal, files_write};
use models::{get_model_settings, list_models, set_model_settings, set_tab_model};
use pty::{
    get_terminal_settings, pty_kill, pty_open, pty_resize, pty_write, role_terminal_start,
    set_terminal_settings, shell_terminal_start, terminal_plan_file, PtyRegistry,
};
use std::sync::Mutex;
use store::{
    get_notification_settings, get_ui_settings, set_notification_settings, set_ui_settings,
    FormsStore, HandoffStore, ProjectsStore, PromptStore, RolesStore, ScratchStore, SettingsStore,
    StateStore, TranscriptStore, WorkspaceStore,
};
use tauri::Manager;

/// WebView2 ignores `APPDATA` and would otherwise share the real profile.
/// The runner usually sets `WEBVIEW2_USER_DATA_FOLDER` itself. This covers a
/// launch that only set `DCT_DATA_DIR`. Called before any other thread starts.
fn isolate_webview_data_dir() {
    #[cfg(windows)]
    {
        if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some_and(|value| !value.is_empty()) {
            return;
        }
        let Some(data) = std::env::var_os("DCT_DATA_DIR").filter(|value| !value.is_empty()) else {
            return;
        };
        let dir = std::path::PathBuf::from(data).join("webview2");
        if std::fs::create_dir_all(&dir).is_ok() {
            // Safety: this runs on the main thread before the runtime starts.
            unsafe { std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir) };
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    isolate_webview_data_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let store = RolesStore::load_or_seed(app.handle())?;
            let mut state_store = StateStore::load_or_default(app.handle())?;
            state_store.reconcile_stale_running_tabs()?;
            let forms_store = FormsStore::load_or_default(app.handle())?;
            let resolved = data_dir::app_data_dir(app.handle());
            if let Some(warning) = &resolved.warning {
                eprintln!("DCTerminal: {warning}");
            }
            let data_dir = resolved.path;
            let scratch_store = ScratchStore::open(&data_dir)?;
            let projects_store = ProjectsStore::open(&data_dir)?;
            let settings_store = SettingsStore::open(&data_dir)?;
            let transcript_store = TranscriptStore::open(&data_dir)?;
            let handoff_store = HandoffStore::open(&data_dir)?;
            let prompt_store = PromptStore::open(&data_dir)?;
            let workspace_store = WorkspaceStore::open(&data_dir)?;
            state_store.new_tab_provider = settings_store.default_provider();
            let known_tabs: Vec<String> = state_store
                .data
                .tabs
                .iter()
                .map(|tab| tab.id.clone())
                .chain(
                    state_store
                        .data
                        .closed_tabs
                        .iter()
                        .map(|tab| tab.id.clone()),
                )
                .collect();
            app.manage(ChangesRoot::open(&data_dir, &known_tabs));
            app.manage(Mutex::new(store));
            app.manage(Mutex::new(state_store));
            app.manage(Mutex::new(forms_store));
            app.manage(Mutex::new(scratch_store));
            app.manage(Mutex::new(projects_store));
            app.manage(Mutex::new(settings_store));
            app.manage(Mutex::new(transcript_store));
            app.manage(Mutex::new(handoff_store));
            app.manage(Mutex::new(prompt_store));
            app.manage(Mutex::new(workspace_store));
            app.manage(Mutex::new(SessionRegistry::new()));
            app.manage(Mutex::new(PtyRegistry::new()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_cli,
            cli_login_status,
            first_run_status,
            first_run_complete,
            probe_acp,
            probe_acp_handshake,
            list_roles,
            get_role,
            validate_and_preview,
            save_role,
            reset_builtin_role,
            get_app_state,
            get_tab,
            select_active_tab,
            close_tab,
            new_draft_tab,
            create_pipeline_tabs,
            create_execution_pipeline_tabs,
            get_pipeline_run,
            pipeline_promote_plan,
            pipeline_set_candidate_plan,
            sync_active_tab_form,
            get_form_recall,
            save_form_draft,
            dev_session_start,
            dev_session_send,
            dev_session_cancel,
            dev_session_stop,
            respond_permission_request,
            respond_plan_request,
            respond_question_request,
            role_session_start,
            scratch_load,
            prompt_library_get,
            prompt_save,
            prompt_delete,
            prompt_mark_used,
            prompt_record_send,
            prompt_clear_recent,
            workspaces_list,
            workspace_save,
            workspace_delete,
            workspace_open,
            scratch_save,
            projects_list,
            projects_remember,
            projects_toggle_favorite,
            projects_remove,
            check_working_folder,
            cursor_approval_mode,
            list_cursor_cli_history,
            open_in_cursor_cli,
            transcript_save,
            transcript_load,
            export_text_file,
            handoff_save,
            handoff_bind_tab,
            handoff_list,
            handoff_get,
            diagnostics_status,
            diagnostics_set_capture,
            diagnostics_read_log,
            session_agent_logs,
            reopen_closed_tab,
            set_tab_label,
            set_tab_color,
            shell_terminal_start,
            role_terminal_start,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
            get_terminal_settings,
            set_terminal_settings,
            terminal_plan_file,
            list_models,
            get_model_settings,
            set_model_settings,
            set_tab_model,
            acp_set_model,
            get_notification_settings,
            set_notification_settings,
            get_ui_settings,
            set_ui_settings,
            git_repo_info,
            worktree_tab_new,
            worktree_tab_check,
            worktree_tab_remove,
            changes_list,
            changes_snapshot,
            changes_file_diff,
            changes_revert,
            history_search,
            get_layout,
            set_layout,
            files_list,
            files_read,
            files_write,
            files_reveal,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app_handle.try_state::<Mutex<SessionRegistry>>() {
                    if let Ok(mut guard) = state.lock() {
                        guard.shutdown_all();
                    }
                }
                if let Some(state) = app_handle.try_state::<Mutex<PtyRegistry>>() {
                    if let Ok(mut guard) = state.lock() {
                        guard.shutdown_all();
                    }
                }
            }
        });
}
