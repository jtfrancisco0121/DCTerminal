# MVP finish — what “done” means

**Spec:** [DCTerminal-Project-Blueprint.md](./DCTerminal-Project-Blueprint.md) §21  
**Checklist:** [TASKS.md](./TASKS.md)  
**Status:** [PROGRESS.md](./PROGRESS.md)

## You can use today (product path)

1. **Cursor CLI** installed and `agent login`
2. **Tab** → fill role form → **Start role session**
3. **Follow-up** in the `›` box while the session runs (same agent thread)
4. **Stop session** → edit form → **Start** again (new agent; startup prompt re-sent)
5. **+ New tab** for another task (during a live session: draft only until Stop)

Dev-only panels (ACP probes, duplicate dev session) are hidden in release builds.

## MVP acceptance (§21) — not done yet

| # | Criterion | Status |
|---|-----------|--------|
| A | Multi-tab: Planner + Implementer + Reviewer + General, each injects once | [~] tabs yes; one live agent at a time |
| B | Validation + schema guard on start | [~] merge/validate yes; schema confirm UI no |
| C | Kill one agent → only that tab; restart works | [~] stop/kill yes; no “resume” |
| D | Drafts restored after force-kill | [x] forms.json + state.json |
| E | Auth error + retry | [ ] |
| F | Relaunch → tabs `awaitingInput`, no auto re-inject | [x] |

## Finish order (do in this sequence)

### P0 — Makes real work possible

1. **Permission card** — UI Allow / Reject for `session/request_permission` ([x] MVP slice).
2. **Cancel turn** — `session/cancel` + button/Esc ([x]).
3. **One product shell** — role sessions only; dev tools in DEV build ([x]).
4. **Auth errors** — `AUTH_ERROR` on connect + form error `_auth` ([x] slice; Retry = Start again).

### P1 — Feels complete

5. **Transcript persist** per tab (read-only after Stop; optional restore on relaunch).
6. **Continue vs restart** copy — “Follow-up” while live; “Start” = new session (documented in README).
7. **Scratch pad + Transfer** (FR-050–053).
8. **Keymap** defaults (Mod+Enter send, Mod+T new tab) (FR-061).

### P2 — Blueprint “future” (after MVP tag)

- `session/load` resume (true continue after quit)
- Plan / question / todo cards (FR-010)
- Installers + CI matrix (T5.x)

## Out of scope for first MVP tag

- PTY / xterm shell
- Custom roles editor
- Transcript export, notifications, auto-update

## Definition of “finished” for v0.1

- JT can run a **Developer** or **Implementer** session on a repo, approve permissions, send follow-ups, cancel a turn, stop without orphan `agent` processes, and use **multiple tabs** for different forms.
- `npm run build` + `cargo test` pass; README explains daily use (not just dev setup).
