# DCTerminal — progress log

## Git workflow

**Commit and push at the end of each phase** (or when a task group is complete and tests pass). Update this file before pushing.

## Snapshot

| Field | Value |
|--------|--------|
| **Last updated** | 2026-10-06 — Phase 1a (pending push) |
| **Branch** | `master` |
| **Current phase** | Phase 1 — core plumbing |
| **Active task** | T1.3 — ACP client hardening (per-tab session) |

## Completed since last push

- [x] **T0.5** — Roles built from `docs/roles/*.md` → `seed/roles.seed.json` (`build_roles_seed`)
- [x] **T1.5 (core)** — Template merge, validate, confirmed schemas in `seed_defs.rs` + tests
- [x] **T1.4 (roles)** — JSON atomic I/O, `roles.json` seed on first run, `list_roles` / `get_role` / `validate_and_preview`

## Next up

1. T1.3 — Persistent ACP client per tab (reuse `connection.rs`)
2. T2.8 — Startup form UI wired to `validate_and_preview`
3. T1.2 — Process supervisor

## Quick commands

```bash
npm run build:roles    # after editing docs/roles
npm run build
npm run tauri dev
cd src-tauri && cargo test
```
