# ACP — observed behavior (T0.3)

Recorded from the local **Phase 0** probe (`src-tauri/src/acp/probe.rs`).

## Environment

| Field | Value |
|--------|--------|
| `agent --version` | `2026.10.01-e373342` |
| Agent path | `C:\Users\user\AppData\Local\cursor-agent\agent.cmd` |
| OS | Windows |
| DCTerminal | Phase 0 probe (not yet tagged) |

## T0.1 — Spawn `agent acp` with piped stdio

- **Result:** Success on Windows using `Command::new(agent.cmd).arg("acp")` with piped stdin/stdout/stderr.
- **No** `cmd.exe /d /s /c` wrapper required for this install (direct `.cmd` execution works).

## `initialize` (protocolVersion 1)

**Client request (sent):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": false, "writeTextFile": false },
      "terminal": false
    },
    "clientInfo": {
      "name": "DCTerminal",
      "title": "DCTerminal",
      "version": "0.1.0"
    }
  }
}
```

**First response line:** saved in [fixtures/acp/initialize-response-2026-10-06.ndjson](../fixtures/acp/initialize-response-2026-10-06.ndjson).

**Notable capabilities (this CLI build):**

| Capability | Observed |
|------------|----------|
| `loadSession` | `true` (P2 resume is viable) |
| `sessionCapabilities.list` | present (P3 `session/list`) |
| `promptCapabilities.image` | `true` |
| `authMethods` | `[{ "id": "cursor_login", ... }]` |

## Not yet probed

- `authenticate` / `session/new` / `session/set_mode` / `session/prompt`
- `session/request_permission`, `cursor/create_plan`, `cursor/ask_question`
- `session/cancel`, `session/load`, `session/list`
- Timeouts under hang / malformed NDJSON (edge cases E6, E11)

Re-run live probe: `cargo test live_acp_probe -- --ignored --nocapture` from `src-tauri/`.
