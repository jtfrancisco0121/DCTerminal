pub(crate) mod acp_events;
mod agent_requests;
mod app_state;
pub(crate) mod changes;
mod cursor_cli;
mod dev_session;
mod forms;
mod handoff;
mod pipeline;
mod model_session;
mod prompt_worker;
mod prompts;
mod providers;
mod role_session;
mod usage;
mod roles;
mod setup;
mod workspace;
mod workspaces;
mod worktree_tabs;

pub use agent_requests::{
    respond_permission_request, respond_plan_request, respond_question_request,
};
pub use app_state::{
    ack_provider_notice, close_tab, create_execution_pipeline_tabs, create_pipeline_tabs,
    get_app_state, get_layout, get_tab, new_draft_tab, reopen_closed_tab, select_active_tab,
    set_layout, set_tab_chain, set_tab_color, set_tab_label, start_eagle_eye, sync_active_tab_form,
};
pub use changes::{changes_file_diff, changes_list, changes_revert, changes_snapshot, ChangesRoot};
pub use cursor_cli::{list_claude_history, list_cursor_cli_history, open_in_cursor_cli};
pub use dev_session::{
    dev_session_cancel, dev_session_send, dev_session_start, dev_session_stop, session_agent_logs,
    SessionRegistry,
};
pub use forms::{get_form_recall, save_form_draft};
pub use handoff::{handoff_bind_tab, handoff_get, handoff_list, handoff_save};
pub use pipeline::{get_pipeline_run, pipeline_promote_plan, pipeline_set_candidate_plan};
pub use model_session::acp_set_model;
pub use usage::get_claude_usage;
pub use prompts::{
    prompt_clear_recent, prompt_delete, prompt_library_get, prompt_mark_used, prompt_record_send,
    prompt_save,
};
pub use providers::{
    claude_account_logins, get_provider_settings, set_provider_settings, set_tab_provider,
};
pub use role_session::role_session_start;
pub use roles::{get_role, list_roles, reset_builtin_role, save_role, validate_and_preview};
pub use setup::{first_run_complete, first_run_status, provider_status};
pub use workspace::{
    check_working_folder, cursor_approval_mode, diagnostics_read_log, diagnostics_set_capture,
    diagnostics_status, history_search, projects_list, projects_remember, projects_remove,
    projects_toggle_favorite, export_text_file, scratch_load, scratch_save, transcript_load,
    transcript_save,
};
pub use workspaces::{workspace_delete, workspace_open, workspace_save, workspaces_list};
pub use worktree_tabs::{git_repo_info, worktree_tab_check, worktree_tab_new, worktree_tab_remove};
