# DCTerminal — progress log

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). Update this file before pushing.

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — per-tab live sessions and role permission policy |
| **Branch** | `cursor/per-tab-sessions-afe9` |
| **Current phase** | Finish MVP vertical slice (see [MVP-FINISH.md](./MVP-FINISH.md)) |
| **Active task** | P1: transcript persist, scratch pad (ADE roadmap E2+) |

## Product-ready today

- Role **startup form** → **Start role session** → **follow-up** in session pane
- **Multi-tab live sessions** — each tab has its own `agent acp` process, transcript, and permission queue
- **Role policy** — Implementer/Developer auto-allow; Reviewer allows shell + MCP and denies writes; Planner/General block write and shell; MCP allowed for every role. Auto-decisions show in the transcript
- **Session UI** — full-height terminal-style pane, Markdown + tables; tool rows coalesce; activity + permission banners
- **Release UI** — dev probes / duplicate dev session hidden (`import.meta.env.DEV` only)

## Locked product decisions (2026-10-06)

See blueprint §31. ACP chat stays primary. No token tracking. No writes to `~/.cursor` or the user's repo. Plain Ctrl in chat; Ctrl+Shift reserved for a future terminal pane.

## Not MVP-done yet

- Transcript persist across Stop / relaunch (saved scrollback on Stop only)
- Scratch pad, keymap overlay (ADE roadmap E2–E3)
- `session/load` resume (P2)
- Installers / §21 acceptance on three OSes

## Next up (strict order)

See **[MVP-FINISH.md](./MVP-FINISH.md)** — remaining P1 items, then ADE roadmap E2+.

## Quick commands

```bash
npm run dev:ui    # terminal 1
npm run dev:app   # terminal 2
cd src-tauri && cargo test
npm test
```
