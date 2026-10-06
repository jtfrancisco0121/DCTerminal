# DCTerminal

Local desktop app: **role-aware, multi-tab UI** on top of the Cursor CLI via **ACP** (`agent acp`). See the full spec in [docs/DCTerminal-Project-Blueprint.md](docs/DCTerminal-Project-Blueprint.md).

## Status

Early scaffold — track progress in:

- **[docs/PROGRESS.md](docs/PROGRESS.md)** — update before each commit/push (where we left off)
- **[docs/TASKS.md](docs/TASKS.md)** — phased checklist
- **[docs/plans/2026-10-06-mvp-implementation-plan.md](docs/plans/2026-10-06-mvp-implementation-plan.md)** — build order

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) + [Tauri prerequisites](https://tauri.app/start/prerequisites/) (for `tauri dev` / `tauri build`)
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

**Windows:** If `tauri dev` says `cargo metadata` / `program not found`, Rust is not on your PATH. Either open a new terminal after installing Rust, or for this session:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
npm run tauri dev
```

Permanent fix: add `%USERPROFILE%\.cargo\bin` to your user **Path** environment variable (Settings → System → About → Advanced system settings → Environment Variables).

## Project layout

| Path | Purpose |
|------|---------|
| `src/` | React UI, `bridge.ts` IPC |
| `src-tauri/` | Rust core (ACP, store, template engine — in progress) |
| `docs/roles/` | Source-of-truth role prompts (Markdown) |
| `seed/roles.seed.json` | Generated via `npm run build:roles` |
| `fixtures/` | Golden merges + ACP recordings |
| `tools/fake-acp-agent/` | Test harness (planned) |
| `docs/` | Blueprint, progress, tasks, ADRs |

## License

Private / personal tool (see repository owner).
