// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `dcterminal bridge …` (a pipeline stage's hook or MCP server): run it
    // and exit before Tauri starts, so no window or Dock icon appears.
    if let Some(code) = dcterminal_lib::bridge::main_from_args() {
        std::process::exit(code);
    }
    dcterminal_lib::run()
}
