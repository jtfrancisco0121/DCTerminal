# DCTerminal MVP — implementation plan

> **For:** Engineers and agents continuing this repo  
> **Spec:** [DCTerminal-Project-Blueprint.md](../DCTerminal-Project-Blueprint.md)  
> **Checklist:** [TASKS.md](../TASKS.md)  
> **Status:** [PROGRESS.md](../PROGRESS.md)

## Goal

Ship the blueprint MVP (§21): multi-tab desktop app over `agent acp`, role startup forms, once-per-session prompt injection, scratch pad + hotkeys, structured transcript, permission handling — on Windows, macOS, and Linux.

## Repository layout (target)

```text
DCTerminal/
├── docs/                    # blueprint, PROGRESS, TASKS, adr/, acp-observed.md
├── docs/plans/              # this file
├── seed/roles.seed.json     # built-in roles (JT templates)
├── fixtures/acp/            # recorded protocol (T0.3)
├── fixtures/templates/      # golden merge outputs (T1.5)
├── tools/fake-acp-agent/    # test harness (§24)
├── src/                     # React UI + bridge.ts
└── src-tauri/src/           # Rust: acp, supervisor, orchestrator, template, store, commands
```

## Build order (do not skip)

1. **Phase 0** — Prove spawn + protocol on real CLI; lock schemas in seed data.
2. **Phase 1** — Template engine + store + ACP client + supervisor (test-heavy, minimal UI).
3. **Phase 2** — One tab end-to-end: form → inject → stream → permission.
4. **Phase 3+** — Multi-tab and polish per TASKS.md.

## Architecture rules (from ADRs)

- UI never spawns processes; only Tauri commands/events.
- Merge and placeholder guard live only in Rust (`template` module).
- One `agent acp` process per tab (ADR-003).
- JSON persistence behind `Store` trait (ADR-006).

## Definition of done per task

- Code merged with tests where TASKS.md marks P0 for that area.
- [TASKS.md](../TASKS.md) checkbox updated.
- [PROGRESS.md](../PROGRESS.md) snapshot updated before push.

## First vertical slice acceptance (preview)

Single tab: pick role → valid form → merged prompt → `session/prompt` matches golden text → render streaming updates → approve one permission → cancel one turn → close tab with no orphan `agent` process (§21 criteria, single-tab subset).
