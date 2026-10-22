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
| `role-analyst.md` | `role_analyst` (F2: writes `brief.md`) |
| `role-pm.md` | `role_pm` (F2: writes `prd.md`) |
| `role-architect.md` | `role_architect` (F2: writes `architecture.md`) |
| `role-triage.md` | `role_triage` (R1: a QA round's Triage stage) |

The Analyst, PM and Architect are DCTerminal's own templates, written for Eagle-Eye L (Track F). They run as `artifact` stages: each writes its document into the run folder and reports it through `submit_result` (`{{result_instructions}}`). No wording is taken from other projects' templates; if any is added later, credit it in that role's file.

## After editing a template

From the repo root:

```bash
cd src-tauri
cargo run --bin build_roles_seed
```

This rewrites `seed/roles.seed.json`. Field definitions and placeholder mappings live in `src-tauri/src/template/seed_defs.rs` — update that file if you add or rename placeholders.

Then rebuild and run the app. Missing built-in roles are added, and unedited built-ins move to the new template (see "Changing a built-in template" below). A built-in you edited keeps your version until you press "Reset built-in" in Settings › Roles.

## Changing a built-in template

1. Edit the role's markdown here, then run `cargo run --bin build_roles_seed` in `src-tauri`.
2. Add the role's previous `templateHash` (from the old `seed/roles.seed.json`) to `SHIPPED_TEMPLATE_HASHES` in `src-tauri/src/store/roles_store.rs`. Saved roles that still have that hash were never edited, so they move to the new template on the next start. Edited roles stay as they are; "Reset built-in" in Settings › Roles updates them.
3. Keep the `## HANDOFF: …` sections at the end of the pipeline roles' output. `src/handoff/contract.ts` reads them to fill the next role's form.
