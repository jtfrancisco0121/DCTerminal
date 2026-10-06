mod acp;
mod cli_detect;
mod commands;
mod orchestrator;
pub mod roles;
pub mod store;
pub mod supervisor;
pub mod template;

use acp::{probe_acp, probe_acp_handshake};
use cli_detect::detect_cli;
use commands::{
    close_tab, dev_session_cancel, dev_session_send, dev_session_start, dev_session_stop,
    get_app_state, respond_permission_request,
    get_form_recall, get_role, get_tab, list_roles, new_draft_tab, role_session_start,
    save_form_draft, select_active_tab, sync_active_tab_form, validate_and_preview,
    DevSessionState,
};
use store::{FormsStore, RolesStore, StateStore};
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let store = RolesStore::load_or_seed(app.handle())?;
            let mut state_store = StateStore::load_or_default(app.handle())?;
            state_store.reconcile_stale_running_tabs()?;
            let forms_store = FormsStore::load_or_default(app.handle())?;
            app.manage(Mutex::new(store));
            app.manage(Mutex::new(state_store));
            app.manage(Mutex::new(forms_store));
            app.manage(Mutex::new(DevSessionState::new()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_cli,
            probe_acp,
            probe_acp_handshake,
            list_roles,
            get_role,
            validate_and_preview,
            get_app_state,
            get_tab,
            select_active_tab,
            close_tab,
            new_draft_tab,
            sync_active_tab_form,
            get_form_recall,
            save_form_draft,
            dev_session_start,
            dev_session_send,
            dev_session_cancel,
            dev_session_stop,
            respond_permission_request,
            role_session_start,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
