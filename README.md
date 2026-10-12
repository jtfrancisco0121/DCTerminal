# DCTerminal

**A desktop workspace for running Claude Code (and Cursor CLI) agents side by side, one role per tab.**

Plan, review, implement and review the PR in a chain of tabs, with hand-offs that carry each role's result into the next one. Built with Tauri 2, React and Rust. Runs on macOS, Linux and Windows.

> **Status:** pre-MVP, personal tool, version 0.1.0. See [docs/MVP-FINISH.md](docs/MVP-FINISH.md) for what "done" means.

---

## Contents

- [Features](#features)
- [Install](#install)
- [Set up Claude Code](#set-up-claude-code)
- [The role pipeline](#the-role-pipeline)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Docs](#docs)

---

## Features

| | |
|---|---|
| **Tabs per task** | Each tab runs its own agent in its own folder. Leaving a tab keeps its agent running. |
| **Chat or Terminal** | Chat tabs talk to Claude over ACP. Terminal tabs run the real `claude` CLI. |
| **Roles** | Planner, Plan Reviewer, Implementer, PR Reviewer, and more. Each one has its own prompt, color, model and permission mode. You can edit roles or add your own. |
| **Hand-offs** | **Send to …** passes a finished role's result to the next role's form. Nothing starts until you press Start. |
| **Truthful status** | Every tab shows **Working**, **Needs you**, **Done** or **Exited**. It also sends a notification when Claude waits on you or finishes. |
| **Scratch pad** | Draft long prompts under any session. A `---` line splits the pad into steps that send one after another. |
| **Split and grid** | Show a second tab live beside the current one, or watch up to six tabs in a grid. |
| **File panel, Changes, Activity** | Browse and edit files, review the git diff, and see every command and file write an agent made. |
| **Your data stays local** | Transcripts, roles and settings live in the app data folder. DCTerminal never handles your credentials. |

## Install

One command builds DCTerminal for this computer and installs it. It needs Node 20+ and Rust. The script checks both and asks before installing anything.

```bash
./install.sh            # macOS or Linux
npm run install-app     # any OS, including Windows
```

```powershell
# Windows (PowerShell 5.1 or 7)
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

<details>
<summary>Installer options, and where things go</summary>

| Flag | Effect |
|---|---|
| `--yes` | Answer yes to every prompt |
| `--skip-checks` | Skip `npm run check` before building |
| `--universal` | macOS: build for Apple Silicon and Intel |
| `--uninstall` | Remove the app, keep your data |

| OS | App | Your data (kept on uninstall) |
|---|---|---|
| macOS | `/Applications/DCTerminal.app` (or `~/Applications`) | `~/Library/Application Support/com.jtfrancisco.dcterminal/` |
| Linux (apt) | `/usr/bin/dcterminal` | `~/.local/share/com.jtfrancisco.dcterminal/` |
| Linux (no apt) | `~/.local/bin/DCTerminal.AppImage` | `~/.local/share/com.jtfrancisco.dcterminal/` |
| Windows | `%LOCALAPPDATA%\DCTerminal\dcterminal.exe` | `%APPDATA%\com.jtfrancisco.dcterminal\` |

The build has no code signing and no CI release. See [docs/RELEASE.md](docs/RELEASE.md).
</details>

## Set up Claude Code

Claude is the default provider. Chat tabs use the ACP adapter, and terminal tabs run `claude`.

```bash
# 1. Install Claude Code: https://code.claude.com  (macOS: brew install --cask claude-code)
# 2. Install the ACP adapter
npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.88.0
# 3. Sign in with your own subscription
claude      # then /login
```

- **Second account:** point **Settings › Providers › Claude config folder** at it (for example `~/.claude-account2`), or set `DCT_CLAUDE_CONFIG_DIR` before launch. DCTerminal only reads that folder.
- **Cursor CLI (optional):** install it and run `agent login`.

## The role pipeline

```
Planner  →  Plan Reviewer  →  Implementer  →  PR Reviewer
 (plan)       (verdict)        (draft PRs)     (verdict per PR)
```

1. Start a **Planner** tab: pick a folder, the role, Chat or Terminal, and describe the task.
2. When its turn ends, press **Send to Plan Reviewer**. The plan fills the next role's fields. Check the preview and press Start.
3. Repeat down the chain. When a reviewer asks for changes, **Send back to …** returns the findings to the earlier tab as a new round.
4. Use **Open chain overview…** to see every stage, its status and its verdict in one place.

Terminal roles launch Claude Code in `plan` mode (Planner) or `auto` mode (the others), so Claude still asks before risky actions. Those questions show up as **Needs you**.

**How to reply to each role:** see [docs/PIPELINE-REPLY-GUIDE.md](docs/PIPELINE-REPLY-GUIDE.md).

## Keyboard shortcuts

Use ⌘ in place of Ctrl on macOS. **Ctrl+/** shows the full list for your platform, and **Ctrl+K** runs any action by name.

| Keys | Action | Keys | Action |
|---|---|---|---|
| `Ctrl+K` | Command palette | `Ctrl+P` | Go to tab |
| `Ctrl+T` / `Ctrl+W` | New / close tab | `F6` | Reopen closed tab |
| `Ctrl+1…9` | Go to tab | `F2` | Rename tab |
| `Ctrl+Enter` | Send | `Ctrl+.` | Scratch pad → input |
| `Ctrl+J` / `Ctrl+L` | Focus pad / input | `Ctrl+F` | Find in tab |
| `Ctrl+\` / `Ctrl+Alt+\` | Split right / down | `Ctrl+Alt+G` | Grid view |
| `Ctrl+B` | File panel | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Terminal text size |
| `Ctrl+,` | Settings | `Esc` | Back to terminal / close dialog |

In terminal tabs, Option works as Meta for Claude Code's Option shortcuts, and Shift+Enter adds a new line. You can turn Option as Meta off under **Settings › Terminal**.

## Development

```bash
npm install
npm run dev:ui      # terminal 1: Vite, leave running (React/CSS hot-reload)
npm run dev:app     # terminal 2: the desktop app (restarts on Rust changes)
```

`npm run dev:full` does both in one terminal. `npm run dev:ui` alone is browser-only and can't call Rust commands.

**Before merging, run:**

```bash
npm run check       # cargo test, clippy -D warnings, vitest, build
```

| Command | What it does |
|---|---|
| `npm test` | Unit tests (vitest) |
| `npm run e2e:ui` | Playwright UI tests against a fake backend (slow) |
| `npm run build:roles` | Rebuild `seed/roles.seed.json` from `docs/roles/*.md` |
| `npm run release:mac` / `:linux` / `:win` | Build installers without installing |

**Requirements:** Node 20+, Rust 1.90+, the [Tauri prerequisites](https://tauri.app/start/prerequisites/), and WebView2 on Windows (usually preinstalled). GitHub Actions is off, so `npm run check` is the gate.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Blank window | Use two terminals (`dev:ui` + `dev:app`), or `npm run dev:stable` |
| Port 1420 in use | Stop other `vite`/`tauri` processes, or keep one `dev:ui` and restart only `dev:app` |
| Windows: `cargo metadata` / `program not found` | Rust isn't on PATH. Open a new terminal, or add `%USERPROFILE%\.cargo\bin` to Path |
| Tab shows **Needs you** | Claude is waiting on a permission prompt, question or plan. Answer it in the tab |
| "Not authenticated" | `claude` then `/login` (or `agent login` for Cursor), then Start again |
| `Chrome_WidgetWin_0` on exit | Harmless WebView2 message |

## Project layout

| Path | What's there |
|---|---|
| `src/` | React UI (`views/`, `components/`, `terminal/`, `handoff/`, `pipeline/`), IPC in `bridge.ts` |
| `src-tauri/` | Rust core: PTY, ACP, providers, session logs, stores |
| `docs/roles/` | Role prompts (source of truth) |
| `seed/` | Generated built-in roles |
| `e2e/` | Playwright UI tests and the fake-agent harness |
| `fixtures/` | Recorded ACP sessions and terminal captures |
| `docs/` | Plans, guides, ADRs |

## Docs

| Doc | For |
|---|---|
| [PIPELINE-REPLY-GUIDE.md](docs/PIPELINE-REPLY-GUIDE.md) | Getting clean hand-offs from each role |
| [RELEASE.md](docs/RELEASE.md) | Building and releasing installers |
| [TESTING.md](docs/TESTING.md) | Test layers and how to run them |
| [DCTerminal-Project-Blueprint.md](docs/DCTerminal-Project-Blueprint.md) | Full product spec |
| [MVP-FINISH.md](docs/MVP-FINISH.md) · [PROGRESS.md](docs/PROGRESS.md) · [TASKS.md](docs/TASKS.md) | Status and checklists |
| [permission-payload-capture.md](docs/permission-payload-capture.md) | Recording permission payloads |
| [cursor-cli-history.md](docs/cursor-cli-history.md) | Cursor CLI session history and resume |

---

Private, personal tool.
