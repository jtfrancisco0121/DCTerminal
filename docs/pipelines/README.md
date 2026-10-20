# Pipelines

Built-in pipeline definitions ([ADR-014](../adr/014-pipeline-engine-opt-in-autopilot.md)). The app bundles these files: Rust reads them with `include_str!` (`src-tauri/src/pipelines/`) and the UI imports them (`src/pipeline/defs.ts`). Your own pipelines live in `pipelines.json` in the app data folder and are edited under **Settings › Pipelines**.

## Format

| Field | Meaning |
|---|---|
| `id` | Unique id, also the chain kind on tabs (`eagle1`). Letters, digits, `_` and `-`. |
| `name` | Shown on chain labels ("Eagle-Eye 1 · step 2 of 4"). |
| `runKind` | Optional. The run kind stored on the chain's run; defaults to `id`. Built-ins keep `full` / `execute` so older runs still load. |
| `stages[]` | In order. Each has `id`, `roleId`, `title`. |
| `stages[].loopBack` | A reviewer stage can send its round back to an earlier stage: `to` (stage id), `maxRounds` (1 to 20; leave it out for no limit, the default: rounds go back until the reviewer approves), `minSeverity` (default `MEDIUM`; findings below it go to follow-ups instead of another round). |
| `stages[].gates[]` | Checks the app runs after the stage's turn, before handing on: `{ "kind": "command", "run": "npm run check" }` (`"auto"` picks `npm run check`, `cargo test`, or `npm test` from the folder), `{ "kind": "pullRequest" }` (every pull request the stage reported exists on GitHub). The HANDOFF contract is always checked. |
| `stages[].checkpoint` | Autopilot stops before starting this stage and waits for you. |
| `stages[].alsoReviewers` | Specialist reviewers (role ids, for example a custom Security Reviewer) that review the same work in parallel with the stage's role. Needs a `loopBack`. Autopilot opens them together, waits for all of them, and decides on the merged reviews: the worst verdict, every reviewer's findings. |
| `autopilot.pauseAtUsagePercent` | Autopilot pauses when the Claude 5-hour or 7-day usage reaches this percent (default 90). |
| `autopilot.stallMinutes` | While a stage is Working, this many minutes with no terminal output and no growth of its session log stops the run with `stalled` (default 30, 1 to 1440). Raise it for a pipeline whose checks run quietly for long. |

A pipeline with a `role_implementer` stage can **fan out** at that stage: the stage before it (its plan) lists several pull requests, and each gets its own lane of the remaining stages in its own git worktree. See `docs/PIPELINE-REPLY-GUIDE.md`.
