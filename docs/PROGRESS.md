# DCTerminal — progress log

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). Update this file before pushing.

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — session/update events + tab phase (local) |
| **Branch** | `master` |
| **Current phase** | Phase 2 — single-tab vertical slice |
| **Active task** | T2.1 multi-tab store + T2.6 rich transcript |

## Completed since last push

- [x] **Pushed** `f72064e` — Phase 2 startup form + `role_session_start`
- [x] **T2.6 (slice)** — `acp/session-update` Tauri events + live transcript panel
- [x] **T2.1 (slice)** — `TabPhase` FSM gate on role session start/stop
- [x] **T2.8 (MVP)** — Schema-driven `StartupForm`, `validate_and_preview`, role picker + cwd
- [x] **`role_session_start`** — merge → ACP connect (role `defaultMode`) → `send_on_start` injection
- [x] **Orchestrator (lite)** — `InjectionStrategy`, `attach_to_first_message` on first Send
- [x] **`merge_role_prompt`** shared helper; `default-run = dcterminal` + README Windows PATH note

## Next up

1. **T2.1** — Tab FSM + `create_tab` / `AwaitingInput` persistence
2. **T2.6** — Stream `session/update` to UI (Tauri events)
3. **T2.3** — Merged-prompt snapshot on tab state

## Quick commands

```bash
npm run tauri dev
cd src-tauri && cargo test
cargo test live_handshake_probe -- --ignored --nocapture
```
