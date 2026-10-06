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

## Probed on a logged-in CLI (2026-10-06, CLI 2026.10.01)

- `session/load` of a previous ACP `sessionId` replayed the thread (the probe code word was in the replay) and a follow-up prompt on that session worked. DCTerminal uses this for Continue and for ACP rows in Cursor CLI history. Details: [cursor-cli-history.md](./cursor-cli-history.md).
- `agent --resume <acpSessionId>` exited 1. `agent ls` does not list ACP ids. `session/new` did not bind to an `agent create-chat` id.
- `session/list` is advertised and is not called. The history list reads `meta.json` only.

## Not yet probed on a live CLI

- Hang / malformed line edge cases beyond the unit tests
- Models (Job 1): whether `session/new` returns `configOptions` with a `model` category (DCTerminal then sends `session/set_config_option {sessionId, configId, value}`) or a `models` field (`session/set_model {sessionId, modelId}`). Without either, DCTerminal restarts `agent --model <id> acp` and calls `session/load` with the same session id. `agent --list-models` is parsed as a header line, then `<id> - <label>` lines with zero-width spaces, double spaces, `(current)`, and `(default)` removed. The fake agent in `tools/fake-acp-agent` covers both paths (`DCT_FAKE_MODELS=none` turns the config option off).

## Client implementation notes

- `acp/connection.rs` — NDJSON over stdio, skip notifications until matching `id` response.
- Next (T1.3): persistent connection per tab, request map, timeouts, `-32601` for unknown agent requests.
