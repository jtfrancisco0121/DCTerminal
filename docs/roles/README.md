# Role prompt templates (source of truth)

Markdown files here are the **authoritative** persona prompts. DCTerminal converts them into `seed/roles.seed.json` with `{{key}}` tokens and confirmed field schemas.

## Files

| File | Role id |
|------|---------|
| `role-planner.md` | `role_planner` |
| `role-implementer.md` | `role_implementer` |
| `role-pr-reviewer.md` | `role_pr_reviewer` |
| `role-developer.md` | `role_developer` |
| `role-general.md` | `role_general` |

## After editing a template

From the repo root:

```bash
cd src-tauri
cargo run --bin build_roles_seed
```

This rewrites `seed/roles.seed.json`. Field definitions and placeholder mappings live in `src-tauri/src/template/seed_defs.rs` — update that file if you add or rename placeholders.

Then rebuild/run the app so the app-data `roles.json` is refreshed (delete `%APPDATA%\com.jtfrancisco.dcterminal\roles.json` to re-seed from disk, or edit in app later).
