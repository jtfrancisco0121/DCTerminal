# fake-acp-agent

A small Node stand-in for the Cursor `agent` binary. End-to-end tests set `DCT_AGENT_PATH` to `agent` (Linux and macOS) or `agent.cmd` (Windows). It does not read or write `~/.cursor`.

- `agent --version` prints `0.0.0-dcterminal-fake` and exits.
- `agent --resume <id>` prints `resumed <id>` and echoes stdin.
- `agent` with no arguments prints `fake-agent ready` and echoes stdin.
- `agent acp` speaks newline-delimited JSON-RPC: `initialize`, `authenticate`, `session/new`, `session/load`, `session/set_mode`, `session/prompt`, and `session/cancel`.

`DCT_FAKE_AUTH=deny` makes `authenticate` fail with "not authenticated". `DCT_FAKE_LOAD=fail` makes `session/load` fail with "session not found". `DCT_FAKE_SESSION_ID` overrides the id returned by `session/new`.
