// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `dcterminal bridge …` (a pipeline stage's hook or MCP server): run it
    // and exit before Tauri starts, so no window or Dock icon appears.
    if let Some(code) = dcterminal_lib::bridge::main_from_args() {
        std::process::exit(code);
    }
    // Started by Claude Code as a terminal tab's status line: record the
    // usage it reports and exit, without starting the app.
    if dcterminal_lib::status_line::run_if_requested() {
        return;
    }
    dcterminal_lib::run()
}
