mod acp;
mod cli_detect;

use acp::probe_acp;
use cli_detect::detect_cli;

// Planned: supervisor, orchestrator, template, store, commands

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![detect_cli, probe_acp])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
