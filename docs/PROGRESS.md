# DCTerminal — progress log

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). Update this file before pushing.

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — Terminal, session/load resume, and in-app `agent --resume` for CLI chats. Windows install succeeded (`start` quoting fixed). `install.sh` tests skip when bash is not a POSIX shell. |
| **Branch** | `cursor/integrate-terminal-history-0dcf` |
| **Current phase** | Finish MVP vertical slice (see [MVP-FINISH.md](./MVP-FINISH.md)) |
| **Active task** | Windows acceptance of the terminal, resume, and history list. See [cursor-cli-history.md](./cursor-cli-history.md). |

## Product-ready today

- Blank tab: pick a role and folder, then the startup fields and **Start**. A running session fills the tab, with the scratch pad under the transcript. Role details, diagnostics, shortcuts, and data paths are on **Settings** (gear, command palette, or Ctrl+,)
- **Planner hand-off** — when a Planner turn has finished, **Send to Implementer** (plan card, last assistant message, or command palette) opens an Implementer tab in the same folder. The form is filled from the latest plan plus its to-dos, or from the message, the plan card, or a selection. JT edits it and presses Start. **Send to Developer** uses the same path and puts the plan in the scratch pad. Each hand-off is saved in app data (`handoffs.json`). The new tab links back with **From Planner: title**. The same dialog can open the target as a **Terminal** tab, which launches `agent` with that role's flags and the mapped plan as the initial prompt. A terminal-mode Planner has **Send to Implementer** and **Send to Developer** on its toolbar and right-click menu. The content can be the selection, the last 200 lines (ANSI stripped), or the newest plan file under `%USERPROFILE%\.cursor\plans` (read-only, modified after that terminal started). The plan file is the default when one exists
- **Terminal** — a blank tab can start a shell or interactive `agent` (no extra flags). After a role is picked, **Chat** or **Terminal** is remembered per role. A role terminal uses the same startup form, then launches `agent` in that folder. Ctrl+Shift+` toggles a shell pane on a chat tab. Ctrl+Shift+. sends the scratch pad to the terminal. The xterm buffer stays alive while the tab is hidden. Closing the tab kills the process tree. **Open in Cursor CLI** opens a saved chat in that terminal with `agent --resume`
- **Resume and history** — Continue uses `session/load` for an ACP session. The blank-tab card lists sessions for the folder. A CLI chat opens in the terminal. An ACP session resumes in the app. See [cursor-cli-history.md](./cursor-cli-history.md)
- **Local install** — `./install.sh` (macOS and Linux), `install.ps1` (Windows PowerShell 5.1 and 7), or `npm run install-app`. Windows install succeeded. `install.sh` tests skip themselves when bash is not a POSIX shell (the WSL stub).
- **Multi-tab live sessions** — each tab has its own `agent acp` process, transcript, and permission queue
- **Role policy** — Implementer/Developer auto-allow; Reviewer allows shell + MCP and denies writes; Planner/General block write and shell; MCP allowed for every role. Auto-decisions show in the transcript
- **Session UI** — full-height terminal-style pane, Markdown + tables; tool rows coalesce; activity + permission banners
- **Release UI** — dev probes / duplicate dev session hidden (`import.meta.env.DEV` only)

## Locked product decisions (2026-10-06)

See blueprint §31. ACP chat stays primary. No token tracking. No writes to `~/.cursor` or the user's repo. The app only reads `%USERPROFILE%\.cursor\plans` (or `$HOME/.cursor/plans`) when a terminal Planner sends a hand-off. Plain Ctrl stays with chat. Ctrl+Shift is the terminal (E6 has landed). Global `approvalMode` is left at `allowlist`.

## Not MVP-done yet

- §21 acceptance on three OSes is still manual. Windows install succeeded. Linux install was run on the installer branch. macOS was not
- Live Windows check of the embedded terminal, folder browse, chaining, and permission-payload capture against a logged-in Cursor CLI

## Next up (strict order)

See **[MVP-FINISH.md](./MVP-FINISH.md)** — remaining acceptance. E6 (embedded terminal) is in this branch.

## Quick commands

```bash
npm run dev:ui    # terminal 1
npm run dev:app   # terminal 2
cd src-tauri && cargo test
npm test
```
