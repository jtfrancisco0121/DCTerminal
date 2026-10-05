# DCTerminal — progress log

Use this file to record **where we left off** before each commit/push. Keep it short; details live in [TASKS.md](./TASKS.md) and the [blueprint](./DCTerminal-Project-Blueprint.md).

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). One phase ≈ one logical commit or a small series on the same branch; always update this file before pushing.

## How to update (every commit)

1. Set **Last updated** (date + optional commit hash after push).
2. Set **Current phase** and **Active task** from [TASKS.md](./TASKS.md).
3. Move finished task IDs to **Completed since last push**; clear or trim that section on the next session if you prefer.
4. Fill **Blockers** if anything stops the next task.
5. Fill **Next up** (1–3 concrete steps).

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — handshake pushed (`6f27619`) |
| **Branch** | `master` |
| **Current phase** | Phase 0 — spikes & setup (nearly complete) |
| **Active task** | T0.5 — role templates in `seed/roles.seed.json` |
| **MVP target** | Blueprint §21 (P0 + most P1) |

## Completed since last push

- [x] **T0.3** — `initialize` → `authenticate` → `session/new` → `session/set_mode` (`acp/connection.rs`, `acp/handshake.rs`)
- [x] Dev UI: **Full handshake** probe button
- [x] Live handshake test on Windows (logged in CLI)

## Blockers

_None._

## Next up

1. **T0.5** — JT’s five role templates → `seed/roles.seed.json`
2. **Phase 1** — `Store` trait + template engine (T1.4, T1.5) + ACP client hardening (T1.3)
3. **T0.2** / **T0.4** — RAM metrics + `agent-client-protocol` crate evaluation (optional before Phase 1)

## Environment notes

- **Primary OS:** Windows
- **Rust:** 1.99.0 — add `%USERPROFILE%\.cargo\bin` to PATH in new shells
- **Cursor CLI:** `2026.10.01-e373342`

## Quick commands

```bash
npm run build
npm run tauri dev

cd src-tauri
cargo test
cargo test live_handshake_probe -- --ignored --nocapture
```
