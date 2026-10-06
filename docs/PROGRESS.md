# DCTerminal — progress log

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). Update this file before pushing.

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — Job 1: live split view, file panel, and model picker (draft PR, not merged). Verified on Linux with `npm run check`; the Mac checks are listed under "Not MVP-done yet". |
| **Branch** | `feat/live-split-file-model` |
| **Current phase** | Finish MVP vertical slice (see [MVP-FINISH.md](./MVP-FINISH.md)) |
| **Active task** | Windows acceptance of the terminal, resume, and history list. See [cursor-cli-history.md](./cursor-cli-history.md). |

## Product-ready today

- Blank tab: pick a role and folder, then the startup fields and **Start**. A running session fills the tab, with the scratch pad under the transcript. Role details, diagnostics, shortcuts, and data paths are on **Settings** (gear, command palette, or Ctrl+,)
- **Planner hand-off** — when a Planner turn has finished, **Send to Implementer** (plan card, last assistant message, or command palette) opens an Implementer tab in the same folder. The form is filled from the latest plan plus its to-dos, or from the message, the plan card, or a selection. JT edits it and presses Start. **Send to Developer** uses the same path and puts the plan in the scratch pad. Each hand-off is saved in app data (`handoffs.json`). The new tab links back with **From Planner: title**. The same dialog can open the target as a **Terminal** tab, which launches `agent` with that role's flags and the mapped plan as the initial prompt. A terminal-mode Planner has **Send to Implementer** and **Send to Developer** on its toolbar and right-click menu. The content can be the selection, the last 200 lines (ANSI stripped), or the newest plan file under `%USERPROFILE%\.cursor\plans` (read-only, modified after that terminal started). The plan file is the default when one exists
- **Terminal** — a blank tab can start a shell or interactive `agent` (no extra flags). After a role is picked, **Chat** or **Terminal** is remembered per role. A role terminal uses the same startup form, then launches `agent` in that folder. Every terminal tab (shell, role, Cursor CLI) has the same scratch pad under the terminal, stored per tab. **Send** (Mod+Shift+.) writes the selection or the whole pad as one prompt: bracketed paste when the program asked for it, then one Enter. **Paste to terminal** does the same without Enter. Mod+J focuses the pad; Esc returns to the terminal. Chat-only actions (transfer, chain) stay on chat tabs. Ctrl+Shift+` toggles a shell pane on a chat tab. The xterm buffer stays alive while the tab is hidden. Closing the tab kills the process tree. **Open in Cursor CLI** opens a saved chat in that terminal with `agent --resume`
- **Resume and history** — Continue uses `session/load` for an ACP session. The blank-tab card lists sessions for the folder. A CLI chat opens in the terminal. An ACP session resumes in the app. See [cursor-cli-history.md](./cursor-cli-history.md)
- **Local install** — `./install.sh` (macOS and Linux), `install.ps1` (Windows PowerShell 5.1 and 7), or `npm run install-app`. Windows install succeeded. `install.sh` tests skip themselves when bash is not a POSIX shell (the WSL stub).
- **Multi-tab live sessions** — each tab has its own `agent acp` process, transcript, and permission queue
- **Role policy** — Implementer/Developer auto-allow; Reviewer allows shell + MCP and denies writes; Planner/General block write and shell; MCP allowed for every role. Auto-decisions show in the transcript
- **Session UI** — full-height terminal-style pane, Markdown + tables; tool rows coalesce; activity + permission banners
- **Live split view** — Mod+\\ (split right) or Mod+Alt+\\ (split down) opens a tab picker. The second pane shows that tab live: a terminal tab is the same xterm on the same PTY (no second process), and a chat tab is the live chat with its own composer and permission cards. Mod+Alt+S swaps the panes, Mod+Alt+O moves focus, Mod+Alt+W closes the split. Keys go only to the focused pane (blue ring). The divider is resizable. Split mode, the second tab, and the size are saved in `state.json` (`layout`) and come back after a restart. Selecting the second pane's tab in the tab bar swaps the panes, so one tab is never shown twice. Cmd on macOS, Ctrl elsewhere. The chords are listed in Settings > Keyboard shortcuts
- **File panel** — Mod+B (or the command palette) shows a tree of the active tab's folder. Folders load when opened. `.gitignore` is respected; `.git`, `node_modules`, and `target` are hidden. A folder shows at most 1000 entries. Preview is read-only with syntax highlighting (highlight.js core, 24 languages) and image preview; text over 1 MB and images over 8 MB are not loaded. **Edit** then Mod+S (or Save) writes the file. The Rust side canonicalizes every path, rejects `..`, refuses symlinks that leave the folder, writes only existing files inside the tab's folder, and refuses a save when the file's mtime changed since it was opened (Overwrite or Reload). **Reveal in Finder** (Show in folder elsewhere), **Copy path**, and **Insert @file** (adds `@path` to the tab's scratch pad)
- **Model picker** — a global default model and per-role defaults (including Cursor CLI tabs) in Settings > Models, and a per-tab override from the tab header, the terminal toolbar, the second pane, or next to Start on a blank tab. The default is `composer-2.5`. The list comes from `agent --list-models` (cached 24 h in `models-cache.json`, with a built-in fallback list) and is searchable; Fast variants have a badge. Terminal tabs pass `--model <id>`. A live chat switches with `session/set_config_option` (model category) or `session/set_model` when the agent advertises them; otherwise the agent restarts with `--model` and the same session is reopened with `session/load`. The per-tab choice is saved in `state.json`
- **Release UI** — dev probes / duplicate dev session hidden (`import.meta.env.DEV` only)

## Locked product decisions (2026-10-06)

See blueprint §31. ACP chat stays primary. No token tracking. No writes to `~/.cursor`. The app writes into the user's folder only when JT edits a file in the file panel and saves it (Job 1 request): existing files inside the tab's folder, never outside it. The app only reads `%USERPROFILE%\.cursor\plans` (or `$HOME/.cursor/plans`) when a terminal Planner sends a hand-off. Plain Ctrl stays with chat. Ctrl+Shift is the terminal (E6 has landed). Global `approvalMode` is left at `allowlist`.

## Not MVP-done yet

- §21 acceptance on three OSes is still manual. Windows install succeeded. Linux install was run on the installer branch. macOS was not
- Mac manual test of Job 1 (split, file panel, models): Cmd chords (Cmd+\\, Cmd+Alt+\\/S/O/W, Cmd+B, Cmd+S in the editor) on a real keyboard, Option/AltGr text not being swallowed, Reveal in Finder, `agent --list-models` output on the logged-in CLI, `agent --model <id> acp` being accepted, and whether the live CLI advertises a model config option or `session/set_model` (otherwise switching restarts the agent and reloads the session)
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
