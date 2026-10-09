# Role prompt templates (source of truth)

Markdown files here are the **authoritative** persona prompts. DCTerminal converts them into `seed/roles.seed.json` with `{{key}}` tokens and confirmed field schemas.

## Files

| File | Role id |
|------|---------|
| `role-planner.md` | `role_planner` |
| `role-plan-reviewer.md` | `role_plan_reviewer` |
| `role-implementer.md` | `role_implementer` |
| `role-pr-reviewer.md` | `role_pr_reviewer` |
| `role-developer.md` | `role_developer` |
| `role-general.md` | `role_general` |
| `role-recommendation.md` | `role_recommendation` |
| `role-codebase-audit.md` | `role_codebase_audit` |

## After editing a template

From the repo root:

```bash
cd src-tauri
cargo run --bin build_roles_seed
```

This rewrites `seed/roles.seed.json`. Field definitions and placeholder mappings live in `src-tauri/src/template/seed_defs.rs` — update that file if you add or rename placeholders.

Then rebuild/run the app so the app-data `roles.json` is refreshed. If you already ran the app once, delete app-data `roles.json` (e.g. `%APPDATA%\com.jtfrancisco.dcterminal\roles.json` on Windows, `~/Library/Application Support/com.jtfrancisco.dcterminal/roles.json` on macOS) and restart, or reinstall — built-in roles are only copied from seed on first run.
