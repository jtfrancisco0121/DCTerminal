# DCTerminal

Local desktop app: **role-aware, multi-tab UI** on top of the Cursor CLI via **ACP** (`agent acp`). See the full spec in [docs/DCTerminal-Project-Blueprint.md](docs/DCTerminal-Project-Blueprint.md).

## Quick start

One command builds DCTerminal for this computer and installs it. There is no code signing and no GitHub Actions release.

```bash
./install.sh          # macOS or Linux
npm run install-app   # same thing, including Windows
```

Windows PowerShell 5.1 or PowerShell 7:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The script checks Node 20+, Rust (rustup), and the platform libraries, prints the exact install command, and asks before installing anything that is missing. `--yes` answers yes. `--skip-checks` skips `npm run check`. On a Mac the `.app` matches that Mac (Apple Silicon or Intel); `--universal` builds both. `--uninstall` removes the app and leaves your data.

| OS | App | Your data (kept on uninstall) |
|----|-----|-------------------------------|
| macOS | `/Applications/DCTerminal.app`, or `~/Applications` if that folder is not writable | `~/Library/Application Support/com.jtfrancisco.dcterminal/` |
| Linux (apt) | `/usr/bin/dcterminal` | `~/.local/share/com.jtfrancisco.dcterminal/` |
| Linux (no apt) | `~/.local/bin/DCTerminal.AppImage` | `~/.local/share/com.jtfrancisco.dcterminal/` |
| Windows | `%LOCALAPPDATA%\DCTerminal\dcterminal.exe` | `%APPDATA%\com.jtfrancisco.dcterminal\` |

Launch it with `open -a DCTerminal`, `dcterminal`, the AppImage path, or the Start menu shortcut. Sessions also need the Cursor CLI (`agent login`). The installer warns if `agent` is not on PATH. Details: **[docs/RELEASE.md](docs/RELEASE.md)**.

## Status

**Pre-MVP** — each tab can run its own `agent acp` session, with role permission policy, a scratch pad, and local transcripts. A local install is `./install.sh` / `install.ps1`. Track:

- **[docs/MVP-FINISH.md](docs/MVP-FINISH.md)** — what “done” means and finish order
- **[docs/PROGRESS.md](docs/PROGRESS.md)** — snapshot before each push
- **[docs/TASKS.md](docs/TASKS.md)** — full checklist

## Using the app (daily)

1. Install Cursor CLI and run `agent login`.
2. Run `npm run dev:ui` + `npm run dev:app` (or a release build when available).
3. The window opens on a tab bar and one blank tab. Pick a **role** and **Choose folder…**. That tab then shows the role’s startup fields and **Start**.
4. **Continue the same agent** with the `›` follow-up box (Ctrl+Enter) — do not press Stop.
5. Draft long prompts in the **scratch pad** under the session. Ctrl+. copies the selection (or the whole pad) into the input. A line that is only `---` splits the pad into steps; Send waits for each reply to finish before the next step.
6. **Choose folder…** opens the system folder dialog. The form shows the folder name and path, and does not start the session. Recent and favorites are in the menu on that control. A new tab asks you to choose a folder. A restored tab keeps the folder it already had.
7. **Stop session** when done — the transcript is saved on the tab and in the app data folder. After a restart it comes back as read-only history. **Start new session** begins a fresh agent. A missing folder does not hide that history, but Start stays blocked until the folder exists.
8. On a restored tab, **Continue session** loads the same ACP session and does not re-inject the startup prompt. **Start new session** opens the startup fields and starts a new session. **Cursor CLI history** lists sessions for the folder. **Resume** continues one in the app. **Open in Cursor CLI** is only for a saved chat, and it opens a terminal tab running `agent --resume`.
9. **+ New tab** for another task. The tab you left keeps its agent running. Close (×) stops only that tab. Ctrl+K opens the command palette; Ctrl+/ lists shortcuts. Ctrl+\\ splits the view so two tabs can be read side by side.
10. The gear in the tab bar, **Settings** in the command palette, and Ctrl+, open **Settings**: role details, the diagnostics toggle, shortcuts, data locations, and version. **Record permission payloads** lives there (off by default) and writes redacted `session/request_permission` lines for classifier checks. See [docs/permission-payload-capture.md](docs/permission-payload-capture.md).

**Continue session** resumes the same thread when the CLI allows it, using the session id stored on the tab. See [docs/cursor-cli-history.md](docs/cursor-cli-history.md). Ctrl+Shift+` toggles the terminal pane. Ctrl+Shift+. sends the scratch pad to the terminal.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) 1.90+ (the locked Tauri 2.12 crates require it) + [Tauri prerequisites](https://tauri.app/start/prerequisites/) (for `tauri dev` / `tauri build`)
- [Cursor CLI](https://cursor.com/docs/cli) with `agent login` (for real agent sessions later)
- Windows: WebView2 (usually preinstalled on Windows 10/11)

## Development

```bash
npm install
npm run build          # frontend TypeScript + Vite (no Rust)
npm run dev:full       # desktop app (starts Vite if needed)
```

### Hot reload (recommended daily workflow)

Keep the UI dev server running in one terminal; restart only the Rust shell when you change `src-tauri/`.

**Terminal 1 — leave running**

```bash
npm run dev:ui
```

**Terminal 2 — desktop app**

```bash
npm run dev:app
```

- **React / CSS (`src/`)** — Vite HMR updates the open window (no restart).
- **Rust (`src-tauri/`)** — `tauri dev` recompiles and relaunches the app (Vite keeps running).
- **Single terminal** — `npm run dev:full` still works; if Vite is already on port `1420`, Tauri reuses it instead of failing.

IPC-only checks (roles list, etc.) need the Tauri window — `npm run dev:ui` alone is browser-only and cannot call Rust commands.

### Checks and installers

Automatic GitHub Actions is **disabled** (no Actions subscription). Before merging, run:

```bash
npm run check
```

That runs Rust tests, Clippy (`-D warnings`), `npm test`, and `npm run build`. `./install.sh` runs the same check, then builds and installs for this OS only. To produce installers without installing them:

```bash
npm run release:win      # NSIS + MSI, on Windows
npm run release:mac      # .app + .dmg, on macOS
npm run release:linux    # .deb + .AppImage, on Linux
```

Unsigned Windows installers trip SmartScreen until they are code-signed. Cut a release, output paths, and how to add signing later: **[docs/RELEASE.md](docs/RELEASE.md)**.

**Windows:** If `tauri dev` says `cargo metadata` / `program not found`, Rust is not on your PATH. Either open a new terminal after installing Rust, or for this session:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
npm run tauri dev
```

Permanent fix: add `%USERPROFILE%\.cargo\bin` to your user **Path** environment variable (Settings → System → About → Advanced system settings → Environment Variables).

### Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Blank window / UI not loading | Use **two terminals** (`dev:ui` + `dev:app`), or run **`npm run dev:stable`** (bundled UI, no Vite). |
| Port 1420 in use | Stop other `vite`/`tauri` processes, or keep one `npm run dev:ui` running and only restart `dev:app`. |
| `Chrome_WidgetWin_0` on exit | Harmless WebView2 message when closing the window or pressing Ctrl+C. |
| Agent stuck / no output | Yellow **status bar** = waiting for permission or tools still running. Scroll up for the **permission** card; use **Cancel turn** if a tool hangs. |
| Long list of `pending` tools | Tool rows **update in place** when the agent reports completion; reasoning stays in collapsed **Reasoning**. |
| “Not authenticated” | Run `agent login` in a terminal, then **Start** again. |

`devUrl` is **`http://127.0.0.1:1420`** (must match Vite’s host).

## Project layout

| Path | Purpose |
|------|---------|
| `src/` | React UI, `bridge.ts` IPC |
| `src-tauri/` | Rust core (ACP, store, template engine — in progress) |
| `docs/roles/` | Source-of-truth role prompts (Markdown) |
| `seed/roles.seed.json` | Generated via `npm run build:roles` |
| `fixtures/` | Golden merges + ACP recordings |
| `tools/fake-acp-agent/` | Test harness (planned) |
| `docs/` | Blueprint, progress, tasks, ADRs, [release steps](docs/RELEASE.md) |

## License

Private / personal tool (see repository owner).
