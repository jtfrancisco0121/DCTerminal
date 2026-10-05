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
| **Last updated** | 2026-10-06 — Phase 0 pushed (`c3a2bb6`) |
| **Branch** | `master` |
| **Current phase** | Phase 0 — spikes & setup |
| **Active task** | T0.3 — extend protocol probe (auth, session/new, permissions) |
| **MVP target** | Blueprint §21 (P0 + most P1) |

## Completed since last push

- [x] T0.0 — Tauri 2 + React + TypeScript scaffold
- [x] Tracking docs + `seed/` / `fixtures/` layout
- [x] Rust toolchain verified; `main.rs` crate name fix (`dcterminal_lib`)
- [x] **T1.1** — `detect_cli` (PATH, PATHEXT, `%LOCALAPPDATA%\cursor-agent\agent.cmd`, `DCT_AGENT_PATH`)
- [x] **T0.1** — spawn `agent acp` + piped stdio (see `acp/probe.rs`)
- [x] **T0.3 (partial)** — `initialize` response recorded in `fixtures/acp/` + `docs/acp-observed.md`
- [x] Dev UI: CLI status + **Probe ACP initialize** button

## Blockers

_None._

## Next up

1. Commit current work; push (consider `develop` branch).
2. Extend probe or scripted capture for `authenticate` → `session/new` → `set_mode` (finish T0.3).
3. **T0.5** — JT’s five templates into `seed/roles.seed.json`.
4. **T1.5** — template engine + golden tests.

## Environment notes

- **Primary OS:** Windows
- **Node:** v22+
- **Rust:** 1.99.0 (`%USERPROFILE%\.cargo\bin` — ensure on PATH in new terminals / IDE)
- **Cursor CLI:** `2026.10.01-e373342`

## Quick commands

```bash
npm install
npm run build
npm run tauri dev

cd src-tauri
cargo test
cargo test live_acp_probe -- --ignored --nocapture
```
