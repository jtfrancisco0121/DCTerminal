# DCTerminal — progress log

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). Update this file before pushing.

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — scratch pad, keymap, tab chrome, transcripts, session cards |
| **Branch** | `cursor/scratch-keymap-chrome-75c2` |
| **Current phase** | Finish MVP vertical slice (see [MVP-FINISH.md](./MVP-FINISH.md)) |
| **Active task** | Installers / live Windows acceptance. E2–E5 controls are in this branch. |

## Product-ready today

- Role **startup form** → **Start role session** → **follow-up** in session pane
- **Multi-tab live sessions** — each tab has its own `agent acp` process, transcript, and permission queue
- **Role policy** — Implementer/Developer auto-allow; Reviewer allows shell + MCP and denies writes; Planner/General block write and shell; MCP allowed for every role. Auto-decisions show in the transcript
- **Session UI** — full-height terminal-style pane, Markdown + tables; tool rows coalesce; activity + permission banners
- **Release UI** — dev probes / duplicate dev session hidden (`import.meta.env.DEV` only)

## Locked product decisions (2026-10-06)

See blueprint §31. ACP chat stays primary. No token tracking. No writes to `~/.cursor` or the user's repo. Plain Ctrl in chat; Ctrl+Shift reserved for a future terminal pane.

## Not MVP-done yet

- `session/load` resume (P2) — restored transcripts are read-only history, not a resumed ACP thread
- Installers / §21 acceptance on three OSes
- Optional xterm pane (E6). Ctrl+Shift stays unbound until that pane exists
- Live Windows check of folder browse, chaining, and permission-payload capture against a logged-in Cursor CLI

## Next up (strict order)

See **[MVP-FINISH.md](./MVP-FINISH.md)** — remaining acceptance, then ADE roadmap E6+.

## Quick commands

```bash
npm run dev:ui    # terminal 1
npm run dev:app   # terminal 2
cd src-tauri && cargo test
npm test
```
