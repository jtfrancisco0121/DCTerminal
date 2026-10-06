# DCTerminal — progress log

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). Update this file before pushing.

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — `install.ps1` calls `npm.cmd` / `.exe` shims so Windows PowerShell 5.1 does not enter `npm.ps1` |
| **Branch** | `cursor/local-install-scripts-28f8` |
| **Current phase** | Finish MVP vertical slice (see [MVP-FINISH.md](./MVP-FINISH.md)) |
| **Active task** | Local install scripts. `install.ps1` targets Windows PowerShell 5.1 and 7. Live three-OS acceptance is still manual. |

## Product-ready today

- Blank tab: pick a role and folder, then the startup fields and **Start**. A running session fills the tab, with the scratch pad under the transcript. Role details, diagnostics, shortcuts, and data paths are on **Settings** (gear, command palette, or Ctrl+,)
- **Planner hand-off** — when a Planner turn has finished, **Send to Implementer** (plan card, last assistant message, or command palette) opens an Implementer tab in the same folder. The form is filled from the latest plan plus its to-dos, or from the message, the plan card, or a selection. JT edits it and presses Start. **Send to Developer** uses the same path and puts the plan in the scratch pad. Each hand-off is saved in app data (`handoffs.json`). The new tab links back with **From Planner: title**
- **Multi-tab live sessions** — each tab has its own `agent acp` process, transcript, and permission queue
- **Role policy** — Implementer/Developer auto-allow; Reviewer allows shell + MCP and denies writes; Planner/General block write and shell; MCP allowed for every role. Auto-decisions show in the transcript
- **Session UI** — full-height terminal-style pane, Markdown + tables; tool rows coalesce; activity + permission banners
- **Release UI** — dev probes / duplicate dev session hidden (`import.meta.env.DEV` only)

## Locked product decisions (2026-10-06)

See blueprint §31. ACP chat stays primary. No token tracking. No writes to `~/.cursor` or the user's repo. Plain Ctrl in chat; Ctrl+Shift reserved for a future terminal pane.

## Not MVP-done yet

- `session/load` resume (P2) — restored transcripts are read-only history, not a resumed ACP thread
- §21 acceptance on three OSes (Linux install was run here; macOS was not. Windows PowerShell 5.1 failed on `npm.ps1` at `2cb3f48` and the shim fix has not been re-run on that PC)
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
