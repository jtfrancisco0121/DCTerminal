mod acp;
mod cli_detect;
mod commands;
pub mod roles;
pub mod store;
pub mod template;

use acp::{probe_acp, probe_acp_handshake};
use cli_detect::detect_cli;
use commands::{get_role, list_roles, validate_and_preview};
use store::RolesStore;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let store = RolesStore::load_or_seed(app.handle())?;
            app.manage(Mutex::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_cli,
            probe_acp,
            probe_acp_handshake,
            list_roles,
            get_role,
            validate_and_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
