mod acp;
mod attachments;
pub mod bridge;
mod claude_history;
mod claude_session_log;
mod cli_detect;
mod cli_launch;
pub mod clickup;
mod commands;
mod crash_log;
mod cursor_history;
mod data_dir;
mod files;
mod github;
mod history_search;
#[cfg(target_os = "macos")]
mod macos_terminate;
mod models;
mod orchestrator;
mod paths;
mod pipelines;
mod permissions;
mod process_tree;
pub mod provider;
mod pty;
pub mod roles;
mod run_actor;
mod session_id;
mod shell_env;
pub mod status_line;
pub mod store;
pub mod supervisor;
pub mod template;
pub mod turn_changes;
mod usage;
mod windows;
pub mod worktree;

/// What `tests/fake_claude.rs` drives: the PTY and the session-log reader.
/// Cargo hands the `fake_claude` bin's path only to integration tests, so
/// those scenario tests cannot be unit tests. Not used by the app.
#[doc(hidden)]
pub mod testing {
    pub use crate::claude_session_log::reader::SessionLogReader;
    pub use crate::claude_session_log::{find_session_log, TerminalSessionLog, ToolCallStatus};
    pub use crate::pty::session::{PtyOutput, PtySession, SpawnSpec};
    pub use crate::pipelines::find as find_pipeline;
    pub use crate::pipelines::autopilot::{decide, FindingReport, TurnReport};
    pub use crate::pipelines::StageKind;
    pub use crate::pipelines::recovery::{
        reconcile_run, stop_stalled, current_stage_tabs, working, turn_key, Reconciled, StallObservation,
        StallWatch,
    };
    pub use crate::store::{PipelineRun, RunStatus, StopReason, StoryStatus};
    pub use crate::bridge::launch::{
        bridged_command, launch_flags, prepare_stage, read_run_tasks, read_stage_turn, runs_root, write_run_repos,
        BridgePlan, BridgeTag,
    };
    pub use crate::commands::pipeline::{fan_out, LaneInput};
    pub use crate::bridge::watch::{drain_inbox, InboxEvent};
    pub use crate::provider::claude::claude_terminal_args;
    pub use crate::provider::{ProgramArgs, TerminalKind, TerminalLaunch};
    pub use crate::pty::{paste_bytes, RunMode};
    pub use crate::bridge::{BridgeNeeds, BridgeTurn, NeedsSource, ResultKind, TurnOutcome};
    pub use crate::run_actor::{ActorMsg, Host, RunActors, StageLaunch, UserAction, UserOutcome};
    pub use crate::pipelines::{GateDef, GateResult};
    pub use crate::roles::Role;
    pub use crate::store::{bundled_seed, AppStateFile, ChainRef, RepoEntry, StateStore, MAIN_WINDOW_ID};
}
#[cfg(test)]
mod coverage_tests;
#[cfg(test)]
pub(crate) mod test_support;

use acp::{probe_acp, probe_acp_handshake};
use cli_detect::{cli_login_status, detect_cli};
use commands::history_search;
use commands::{
    acp_set_effort, acp_set_model, get_claude_usage, check_working_folder, close_tab, create_execution_pipeline_tabs,
    create_pipeline_tabs, open_github_tab, open_preview_tab, set_preview_url, cursor_approval_mode, get_pipeline_run,
    pipeline_approve, pipeline_defs_list, pipeline_defs_save, pipeline_fan_out, pipeline_lane_status,
    pipeline_turn_finished,
    pipeline_run_gates,
    pipeline_set_autopilot, pipeline_promote_plan, spawn_run_recovery,
    pipeline_set_candidate_plan, pipeline_run_tasks, pipeline_actor_message, pipeline_run_round,
    autopilot_pending_stops, StartupStops,
    dev_session_cancel, dev_session_live, dev_session_send, dev_session_start, dev_session_stop,
    diagnostics_read_log, diagnostics_set_capture, diagnostics_status, get_app_state,
    get_form_recall, get_layout, get_role, get_tab,
    handoff_attach, handoff_bind_tab, handoff_get, handoff_list, handoff_save, list_claude_history,
    list_cursor_cli_history, list_roles,
    new_draft_tab, ack_provider_notice, chain_loop_back, open_chain_overview, set_tab_chain, start_eagle_eye,
    open_in_cursor_cli, projects_list, projects_remember, projects_remove,
    projects_toggle_favorite, reopen_closed_tab, reset_builtin_role, respond_permission_request,
    respond_plan_request, respond_question_request, role_session_start, save_form_draft,
    save_role, scratch_load, scratch_save, session_agent_logs,
    select_active_tab, set_layout,
    export_text_file, set_tab_color, set_tab_label, sync_active_tab_form, transcript_load,
    transcript_save,
    validate_and_preview, SessionRegistry,
};
use commands::{
    activity_clear, activity_list, terminal_chat_entries, terminal_chat_unwatch,
    terminal_chat_watch, terminal_session_log,
};
use commands::{clickup_status, clickup_test, clickup_token_clear, clickup_token_set};
use commands::{
    clickup_intake_check, clickup_intake_preview, clickup_intake_pull, clickup_intake_snapshot,
    clickup_intake_status,
};
use commands::{
    clickup_list_statuses, clickup_status_map_set, clickup_status_maps, clickup_writeback_edit,
    clickup_writeback_load, clickup_writeback_send,
};
use commands::{
    github_claim_notifications, github_feed, github_push_commits, github_save_filters,
    github_status,
};
use commands::{changes_file_diff, changes_list, changes_revert, changes_snapshot, ChangesRoot};
use commands::{first_run_complete, first_run_status, provider_status};
use commands::{startup_notices, storage_cleanup, storage_status};
use commands::{create_role, delete_role, duplicate_role, export_role, import_role, preview_role_template};
use commands::{
    claude_account_logins, get_provider_settings, set_provider_settings, set_tab_provider,
};
use commands::{attachment_add, attachment_read_file, attachment_remove};
use commands::{git_repo_info, worktree_tab_check, worktree_tab_new, worktree_tab_remove};
use commands::{
    prompt_clear_recent, prompt_delete, prompt_library_get, prompt_mark_used, prompt_record_send,
    prompt_save,
};
use commands::{workspace_delete, workspace_open, workspace_save, workspaces_list};
use files::{files_list, files_markdown_image, files_read, files_resolve, files_reveal, files_write};
use models::{get_model_settings, list_models, set_model_settings, set_tab_model};
use pty::{
    get_terminal_settings, pty_detach, pty_input_state, pty_kill, pty_open, pty_resize, pty_running, pty_set_scheme, pty_stage_needs,
    pty_write, role_terminal_start,
    set_terminal_settings, shell_terminal_start, terminal_plan_file, PtyRegistry,
};
use std::sync::Mutex;
use store::repos_settings::{get_repos_settings, set_repos_settings};
use store::{
    get_notification_settings, get_ui_settings, set_notification_settings, set_ui_settings,
    ActivityStore, FormsStore, HandoffStore, ProjectsStore, PromptStore, RolesStore, ScratchStore,
    SettingsStore, StateStore, TranscriptStore, WorkspaceStore,
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

/// The steps that change process env at the start of [`run`], in the order
/// they run. Each is only sound while the main thread is the only thread.
///
/// - `DCT_CLICKUP_TOKEN` is moved out of the env first, before any step can
///   start a child: on a first run, or with a stale PATH cache,
///   `apply_login_path` runs `$SHELL -l -i -c …`, and that shell (and
///   anything its rc files start) would inherit the token.
/// - The scrub drops a parent Claude Code session's variables, so Claude tabs
///   (and a `claude` typed in a shell tab) don't take themselves for nested
///   sessions and skip their session log. It also runs before the login
///   shell, so that shell never sees a parent session's tokens either. The
///   per-command `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_EXECUTABLE` are applied
///   later and are untouched.
/// - The login PATH replaces the inherited one. A cached login PATH is
///   refreshed from `setup`, never from a thread started here.
const STARTUP_ENV_STEPS: [(&str, fn()); 4] = [
    ("take_clickup_token", clickup::secret::take_env_token),
    (
        "scrub_parent_claude_session",
        shell_env::scrub_parent_claude_session,
    ),
    ("apply_login_path", shell_env::apply_login_path),
    ("isolate_webview_data_dir", isolate_webview_data_dir),
];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything else, on the main thread with no other thread yet.
    for (_, step) in STARTUP_ENV_STEPS {
        step();
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // First, so a panic anywhere below lands in logs/crash.log.
            crash_log::install(&data_dir::app_data_dir(app.handle()).path);
            // Roles first, so your pipelines are checked against the roles
            // that exist; both before any chain run is read.
            let store = RolesStore::load_or_seed(app.handle())?;
            store.publish_role_ids();
            let pipeline_store =
                store::PipelineStore::open(&data_dir::app_data_dir(app.handle()).path)?;
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
            let github_store = store::github_store::GithubStore::open(&data_dir)?;
            let github_cache = store::github_store::GithubCache::open(&data_dir)?;
            state_store.new_tab_provider = settings_store.default_provider();
            let known_tabs = commands::storage::known_tab_ids(&state_store);
            app.manage(ChangesRoot::open(&data_dir, &known_tabs));
            app.manage(attachments::AttachmentStore::open(&data_dir, &known_tabs));
            app.manage(Mutex::new(ActivityStore::open(&data_dir, &known_tabs)));
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
            app.manage(Mutex::new(pipeline_store));
            app.manage(Mutex::new(github_store));
            app.manage(Mutex::new(github_cache));
            app.manage(github::GithubSync::new());
            // C2: ClickUp intake snapshots waiting for their start, and change checks.
            app.manage(commands::IntakeState::default());
            // C3: keeps a send of ClickUp updates apart from edits to them.
            app.manage(commands::WritebackState::default());
            app.manage(Mutex::new(crate::usage::UsageStore::open(&data_dir)));
            app.manage(Mutex::new(SessionRegistry::new()));
            app.manage(Mutex::new(PtyRegistry::new()));
            app.manage(claude_session_log::reader::SessionLogReaders::new());
            app.manage(StartupStops::default());
            windows::install_macos_menu(app)?;
            windows::restore_saved_windows(app.handle());
            // After the stores are managed, on its own thread: the window
            // does not wait for the sweep's directory walk.
            commands::storage::spawn_startup_sweep(app.handle(), data_dir.clone(), known_tabs);
            // Track H3, on its own thread: runs that were running when the
            // app closed are checked against their logs, then watched for stalls.
            spawn_run_recovery(app.handle().clone());
            // Pipeline v2 (ADR-015): one run actor per active engine-2 run
            // (V3); finished turns the bridge drops in a run's inbox go to it.
            app.manage(run_actor::app_host::AppActors::new(std::sync::Arc::new(
                run_actor::app_host::AppHost::new(app.handle().clone()),
            )));
            bridge::watch::spawn(
                bridge::launch::runs_root(&data_dir),
                run_actor::app_host::deliver_inbox(app.handle().clone()),
            );
            // The env-changing steps at the start of `run()` are done, so a
            // thread may ask the login shell again (it only rewrites the
            // PATH cache, for the next launch).
            shell_env::spawn_login_path_refresh();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_cli,
            cli_login_status,
            first_run_status,
            first_run_complete,
            get_provider_settings,
            claude_account_logins,
            provider_status,
            set_provider_settings,
            set_tab_provider,
            probe_acp,
            probe_acp_handshake,
            list_roles,
            get_role,
            validate_and_preview,
            save_role,
            reset_builtin_role,
            preview_role_template,
            create_role,
            duplicate_role,
            delete_role,
            import_role,
            export_role,
            get_app_state,
            get_tab,
            select_active_tab,
            close_tab,
            new_draft_tab,
            ack_provider_notice,
            set_tab_chain,
            chain_loop_back,
            open_chain_overview,
            start_eagle_eye,
            create_pipeline_tabs,
            create_execution_pipeline_tabs,
            open_preview_tab,
            open_github_tab,
            github_status,
            github_feed,
            github_push_commits,
            github_claim_notifications,
            github_save_filters,
            clickup_status,
            clickup_token_set,
            clickup_token_clear,
            clickup_test,
            clickup_intake_status,
            clickup_intake_preview,
            clickup_intake_snapshot,
            clickup_intake_check,
            clickup_intake_pull,
            clickup_writeback_load,
            clickup_writeback_edit,
            clickup_writeback_send,
            clickup_list_statuses,
            clickup_status_map_set,
            clickup_status_maps,
            set_preview_url,
            get_pipeline_run,
            pipeline_defs_list,
            pipeline_defs_save,
            pipeline_run_gates,
            pipeline_set_autopilot,
            autopilot_pending_stops,
            pipeline_turn_finished,
            pipeline_fan_out,
            pipeline_lane_status,
            pipeline_approve,
            pipeline_promote_plan,
            pipeline_set_candidate_plan,
            pipeline_run_tasks,
            pipeline_actor_message,
            pipeline_run_round,
            sync_active_tab_form,
            get_form_recall,
            save_form_draft,
            dev_session_start,
            dev_session_send,
            attachment_add,
            attachment_remove,
            attachment_read_file,
            dev_session_cancel,
            dev_session_stop,
            dev_session_live,
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
            list_claude_history,
            list_cursor_cli_history,
            open_in_cursor_cli,
            transcript_save,
            transcript_load,
            export_text_file,
            handoff_save,
            handoff_bind_tab,
            handoff_attach,
            handoff_list,
            handoff_get,
            diagnostics_status,
            diagnostics_set_capture,
            diagnostics_read_log,
            storage_status,
            storage_cleanup,
            startup_notices,
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
            pty_detach,
            pty_input_state,
            pty_stage_needs,
            pty_running,
            pty_set_scheme,
            get_terminal_settings,
            set_terminal_settings,
            terminal_plan_file,
            terminal_session_log,
            terminal_chat_entries,
            terminal_chat_watch,
            terminal_chat_unwatch,
            list_models,
            get_model_settings,
            set_model_settings,
            set_tab_model,
            acp_set_model,
            acp_set_effort,
            get_claude_usage,
            get_notification_settings,
            set_notification_settings,
            get_ui_settings,
            set_ui_settings,
            get_repos_settings,
            set_repos_settings,
            git_repo_info,
            worktree_tab_new,
            worktree_tab_check,
            worktree_tab_remove,
            changes_list,
            changes_snapshot,
            changes_file_diff,
            changes_revert,
            activity_list,
            activity_clear,
            history_search,
            get_layout,
            set_layout,
            files_list,
            files_read,
            files_write,
            files_resolve,
            files_reveal,
            files_markdown_image,
            windows::window_context,
            windows::open_account_window,
            windows::reopen_closed_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            windows::handle_run_event(app_handle, event);
        });
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    /// The token must be gone before `apply_login_path` can spawn the login
    /// shell, or that shell inherits it.
    #[test]
    fn the_clickup_token_leaves_the_env_before_any_child_can_start() {
        let names: Vec<&str> = STARTUP_ENV_STEPS.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            names,
            [
                "take_clickup_token",
                "scrub_parent_claude_session",
                "apply_login_path",
                "isolate_webview_data_dir",
            ]
        );
        // The names match the functions, so a reorder cannot hide behind them.
        let first: fn() = clickup::secret::take_env_token;
        assert!(std::ptr::fn_addr_eq(STARTUP_ENV_STEPS[0].1, first));
        let scrub: fn() = shell_env::scrub_parent_claude_session;
        assert!(std::ptr::fn_addr_eq(STARTUP_ENV_STEPS[1].1, scrub));
        let shell: fn() = shell_env::apply_login_path;
        assert!(std::ptr::fn_addr_eq(STARTUP_ENV_STEPS[2].1, shell));
    }
}
