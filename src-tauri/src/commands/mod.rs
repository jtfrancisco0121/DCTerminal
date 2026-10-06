pub(crate) mod acp_events;
mod agent_requests;
mod app_state;
mod dev_session;
mod forms;
mod handoff;
mod prompt_worker;
mod role_session;
mod roles;
mod workspace;

pub use agent_requests::{respond_permission_request, respond_plan_request};
pub use app_state::{
    close_tab, get_app_state, get_tab, new_draft_tab, reopen_closed_tab, select_active_tab,
    set_tab_color, set_tab_label, sync_active_tab_form,
};
pub use dev_session::{
    dev_session_cancel, dev_session_send, dev_session_start, dev_session_stop, SessionRegistry,
};
pub use forms::{get_form_recall, save_form_draft};
pub use handoff::{handoff_bind_tab, handoff_get, handoff_list, handoff_save};
pub use role_session::role_session_start;
pub use roles::{get_role, list_roles, validate_and_preview};
pub use workspace::{
    check_working_folder, diagnostics_set_capture, diagnostics_status, projects_list,
    projects_remember, projects_remove, projects_toggle_favorite, scratch_load, scratch_save,
    transcript_load, transcript_save,
};
