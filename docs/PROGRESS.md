# DCTerminal — progress log

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). Update this file before pushing.

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — Phase 1b ACP client (pending push) |
| **Branch** | `master` |
| **Current phase** | Phase 1 — core plumbing |
| **Active task** | T2.1 orchestrator + T2.8 startup form UI |

## Completed since last push

- [x] **T1.2** — `supervisor/` spawn/kill `agent acp`
- [x] **T1.3 (core)** — `AcpClient`, interactive `call_with_dispatch`, permission/cursor auto-cancel, `-32601` for unknown requests
- [x] Shared `session_connect::handshake`
- [x] Dev commands: `dev_session_start` / `dev_session_send` / `dev_session_stop` + UI panel

## Next up

1. **T2.8** — Startup form → `validate_and_preview` → orchestrator
2. **T2.1** — Tab FSM + `create_tab` with merged prompt injection
3. **T2.6** — Stream `session/update` to UI (events)

## Quick commands

```bash
npm run tauri dev
cd src-tauri && cargo test
cargo test live_handshake_probe -- --ignored --nocapture
```
