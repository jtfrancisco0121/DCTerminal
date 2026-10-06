# MVP finish — what “done” means

**Spec:** [DCTerminal-Project-Blueprint.md](./DCTerminal-Project-Blueprint.md) §21  
**Checklist:** [TASKS.md](./TASKS.md)  
**Status:** [PROGRESS.md](./PROGRESS.md)

## You can use today (product path)

1. **Cursor CLI** installed and `agent login`
2. Blank tab → pick a role and folder → fill the fields → **Start**
3. **Follow-up** in the `›` box while the session runs (same agent thread)
4. **Stop session** → edit form → **Start** again (new agent; startup prompt re-sent)
5. **+ New tab** starts another task **without** stopping the one that's running. Each tab has its own agent. Switching tabs does not kill the others.
6. **Restart** on a tab whose agent crashed returns to the form. Close (×) on a running tab stops only that agent.

Dev-only panels (ACP probes, duplicate dev session) are hidden in release builds.

## MVP acceptance (§21) — not done yet

| # | Criterion | Status |
|---|-----------|--------|
| A | Multi-tab: Planner + Implementer + Reviewer + General, each injects once | [~] each tab can run its own agent; role policy auto-answers permissions. Not yet verified live on Windows with four concurrent CLIs |
| B | Validation + schema guard on start | [~] merge/validate yes (whitespace required, emptyBehavior); schema confirm UI no |
| C | Kill one agent → only that tab; restart works | [~] close/stop kills that process tree; Restart returns to the form. Continue uses `session/load` when the tab has an ACP session id |
| D | Drafts restored after force-kill | [x] forms.json + state.json |
| E | Auth error + retry | [~] form shows `_auth` / `_cli` with `agent login` guidance; not exercised against a live logged-out CLI on this machine |
| F | Relaunch → tabs `awaitingInput`, no auto re-inject | [x] |

## Finish order (do in this sequence)

### P0 — Makes real work possible

1. **Permission card** — UI Allow / Reject for `session/request_permission` ([x] MVP slice).
2. **Cancel turn** — `session/cancel` + button/Esc ([x]).
3. **One product shell** — role sessions only; dev tools in DEV build ([x]).
4. **Auth errors** — `AUTH_ERROR` on connect + form error `_auth` ([x] slice; Retry = Start again).

### P1 — Feels complete

5. **Transcript persist** per tab (read-only after Stop; restore on relaunch). [x] app-data JSON, rotation, corrupt-file handling. Not `session/load`.
6. **Continue vs restart** copy — “Follow-up” while live; “Start” = new session (documented in README). [x]
7. **Scratch pad + Transfer** (FR-050–053). [x] per-tab pad, debounce + flush, `---` chaining. No global pad (P1 in the blueprint).
8. **Keymap** defaults (Ctrl+Enter send, Ctrl+T new tab, Ctrl+. transfer) (FR-061). [x] overlay. Ctrl+Shift is reserved and not bound.

### P2 — Blueprint “future” (after MVP tag)

- Live Windows probe of `session/load` replay ([cursor-cli-history.md](./cursor-cli-history.md))
- Plan / question / todo cards (FR-010) — plan accept/reject, todos, and task cards are in the session view; `cursor/ask_question` is still auto-cancelled
- Installers + CI matrix (T5.x)

## Out of scope for first MVP tag

- PTY / xterm shell
- Custom roles editor
- Transcript export, notifications, auto-update

## Definition of “finished” for v0.1

- JT can run a **Developer** or **Implementer** session on a repo, approve (or auto-allow) permissions, send follow-ups, cancel a turn, stop without orphan `agent` processes, and run **more than one tab's agent at the same time**.
- `npm run build` + `cargo test` pass; README explains daily use (not just dev setup).
