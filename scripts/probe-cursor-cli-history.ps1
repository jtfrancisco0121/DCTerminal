# Probe Cursor CLI history integration on a logged-in Windows machine.
# Spawns real `agent` processes and spends a few model turns.
# Prints what create-chat binding, `agent --resume <acpSessionId>`, and
# ACP `session/load` actually do. Does not assert a pass/fail verdict.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $Root "src-tauri")
cargo test live_cli_history_probe -- --ignored --nocapture --test-threads=1
