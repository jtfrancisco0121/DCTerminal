# DCTerminal — progress log

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). Update this file before pushing.

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — session stream polish (tools, status bar) |
| **Branch** | `master` |
| **Current phase** | Finish MVP vertical slice (see [MVP-FINISH.md](./MVP-FINISH.md)) |
| **Active task** | P1: transcript persist, scratch pad |

## Product-ready today

- Role **startup form** → **Start role session** → **follow-up** in session pane (same agent until Stop)
- **Multi-tab** drafts; **+ New tab** during live session (draft queued until Stop)
- **Session UI** — full-height terminal-style pane, Markdown + tables; tool rows coalesce; activity + permission banners
- **Release UI** — dev probes / duplicate dev session hidden (`import.meta.env.DEV` only)

## P0 landed (2026-10-06)

- **Permission card** — `acp/permission-request` + `respond_permission_request`
- **Cancel turn** — `dev_session_cancel`, Esc, toolbar button
- **Auth** — `AUTH_ERROR` from handshake → `_auth` form error
- **Product shell** — release UI without dev probes

## Not MVP-done yet
- Transcript persist across Stop / relaunch
- `session/load` resume (P2)
- Installers / §21 acceptance on three OSes

## Next up (strict order)

See **[MVP-FINISH.md](./MVP-FINISH.md)** — P0 items 1–4, then P1.

## Quick commands

```bash
npm run dev:ui    # terminal 1
npm run dev:app   # terminal 2
cd src-tauri && cargo test
```
