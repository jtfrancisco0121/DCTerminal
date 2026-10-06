# ACP — observed behavior (T0.3)

Recorded from local probes (`src-tauri/src/acp/`). Live tests:  
`cargo test live_handshake_probe -- --ignored --nocapture` (from `src-tauri/`).

## Environment

| Field | Value |
|--------|--------|
| `agent --version` | `2026.10.01-e373342` |
| Agent path | `C:\Users\user\AppData\Local\cursor-agent\agent.cmd` |
| OS | Windows |
| Protocol | JSON-RPC 2.0, NDJSON lines on stdin/stdout |

## T0.1 — Spawn `agent acp`

- Direct `Command::new(agent.cmd).arg("acp")` with piped stdio works on Windows (no `cmd.exe` wrapper needed for this install).

## Handshake sequence (verified)

| Step | Method | Result |
|------|--------|--------|
| 1 | `initialize` | `protocolVersion: 1`, `loadSession: true`, `sessionCapabilities.list`, `authMethods: [cursor_login]` |
| 2 | `authenticate` | `{ "methodId": "cursor_login" }` → `{}` |
| 3 | `session/new` | `{ "cwd", "mcpServers": [] }` → `sessionId` + **rich payload** (see below) |
| 4 | `session/set_mode` | `{ "sessionId", "modeId": "agent" }` → `{}` |

Fixture for `initialize` only: [initialize-response-2026-10-06.ndjson](../fixtures/acp/initialize-response-2026-10-06.ndjson).

### `session/new` response shape (this CLI build)

Beyond `sessionId`, the result includes:

- `modes.availableModes` — `agent`, `plan`, `ask` (matches blueprint)
- `modes.currentModeId` — e.g. `agent`
- `models` — large `availableModels` list (omit from fixtures; changes frequently)
- `configOptions` — UI-oriented mode/model selectors

**Implication:** `session/set_mode` works as documented; default mode may already be `agent` after `session/new`.

## Not yet probed on a live CLI

- `session/load` and `session/list` against a logged-in CLI. The captured `initialize` advertises both `loadSession` and `sessionCapabilities.list`, and not `sessionCapabilities.resume`. What that does on disk is recorded in [cursor-cli-history.md](./cursor-cli-history.md). Probe: `cargo test live_cli_history_probe -- --ignored --nocapture --test-threads=1` from `src-tauri/`.
- Hang / malformed line edge cases beyond the unit tests

## Client implementation notes

- `acp/connection.rs` — NDJSON over stdio, skip notifications until matching `id` response.
- Next (T1.3): persistent connection per tab, request map, timeouts, `-32601` for unknown agent requests.
