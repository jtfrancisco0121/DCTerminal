# Pipelines

Built-in pipeline definitions ([ADR-014](../adr/014-pipeline-engine-opt-in-autopilot.md)). The app bundles these files: Rust reads them with `include_str!` (`src-tauri/src/pipelines/`) and the UI imports them (`src/pipeline/defs.ts`). Your own pipelines live in `pipelines.json` in the app data folder and are edited under **Settings › Pipelines**.

## Format

| Field | Meaning |
|---|---|
| `id` | Unique id, also the chain kind on tabs (`eagle1`). Letters, digits, `_` and `-`. |
| `name` | Shown on chain labels ("Eagle-Eye 1 · step 2 of 4"). |
| `runKind` | Optional. The run kind stored on the chain's run; defaults to `id`. Built-ins keep `full` / `execute` so older runs still load. |
| `stages[]` | In order. Each has `id`, `roleId`, `title`. |
| `stages[].kind` | What the stage does: `planner`, `reviewer`, `implementer` or `generic`. Every rule that depends on the role (which HANDOFF sections its reply owes, the plan-mode plan, the send-back ask, fan-out) reads the kind, so a copy of a built-in role (Settings › Roles › Duplicate) works like the original. Left out: from the built-in role id, else `reviewer` for a stage with a `loopBack`, else `generic`. A reviewer whose round goes back to a planner reviews the plan; any other reviews the work. |
| `stages[].loopBack` | A reviewer stage can send its round back to an earlier stage: `to` (stage id), `maxRounds` (1 to 20; leave it out for no limit, the default: rounds go back until the reviewer approves), `minSeverity` (default `MEDIUM`; findings below it go to follow-ups instead of another round). |
| `stages[].gates[]` | Checks the app runs after the stage's turn, before handing on: `{ "kind": "command", "run": "npm run check" }` (`"auto"` picks `npm run check`, `cargo test`, or `npm test` from the folder), `{ "kind": "pullRequest" }` (every pull request the stage reported exists on GitHub). An `auto` command that finds nothing to run stops the run with `no_check_found`; add `"optional": true` to the gate to skip it instead. The HANDOFF contract is always checked. |
| `stages[].checkpoint` | Autopilot stops before starting this stage and waits for you. |
| `stages[].alsoReviewers` | Specialist reviewers (role ids, for example a custom Security Reviewer) that review the same work in parallel with the stage's role. Needs a `loopBack`. Autopilot opens them together, waits for all of them, and decides on the merged reviews: the worst verdict, every reviewer's findings. |
| `autopilot.pauseAtUsagePercent` | Autopilot pauses when the Claude 5-hour or 7-day usage reaches this percent (default 90). |

Every role id must exist. When the app loads your pipelines (and whenever a role is added or deleted), one that does not validate stays listed under Settings › Pipelines, **disabled**, with the reason; it is never dropped, and an entry that is not a pipeline at all is kept exactly as written. A disabled pipeline cannot be started, and autopilot stops a run whose pipeline became disabled or unknown instead of guessing one.

A pipeline with an `implementer` stage can **fan out** at that stage: the stage before it (its plan) lists several pull requests, and each gets its own lane of the remaining stages in its own git worktree. See `docs/PIPELINE-REPLY-GUIDE.md`.
