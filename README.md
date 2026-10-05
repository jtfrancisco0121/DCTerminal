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
npm run tauri dev      # full desktop app
```

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
