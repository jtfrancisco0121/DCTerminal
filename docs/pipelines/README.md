# Pipelines

Built-in pipeline definitions ([ADR-014](../adr/014-pipeline-engine-opt-in-autopilot.md)). The app bundles these files: Rust reads them with `include_str!` (`src-tauri/src/pipelines/`) and the UI imports them (`src/pipeline/defs.ts`). Your own pipelines live in `pipelines.json` in the app data folder and are edited under **Settings › Pipelines**.

## Format

| Field | Meaning |
|---|---|
| `id` | Unique id, also the chain kind on tabs (`eagle1`). Letters, digits, `_` and `-`. |
| `name` | Shown on chain labels ("Eagle-Eye 1 · step 2 of 4"). |
| `runKind` | Optional. The run kind stored on the chain's run; defaults to `id`. Built-ins keep `full` / `execute` so older runs still load. |
| `stages[]` | In order. Each has `id`, `roleId`, `title`. |
| `stages[].kind` | What the stage does: `planner`, `reviewer`, `implementer` or `generic`. Every rule that depends on the role (which HANDOFF sections its reply owes, the plan-mode plan, the send-back ask, fan-out) reads the kind, so a copy of a built-in role (Settings › Roles › Duplicate) works like the original. Left out: from the built-in role id, else `reviewer` for a stage with a `loopBack`, else `generic`. A reviewer whose round goes back to a planner reviews the plan; any other reviews the work. A kind you write must agree with the `loopBack`: a stage with a `loopBack` is a `reviewer`, and a `reviewer` needs a `loopBack`. Otherwise the pipeline is shown disabled with the reason. |
| `stages[].loopBack` | A reviewer stage can send its round back to an earlier stage: `to` (stage id), `maxRounds` (1 to 20; leave it out for no limit, the default: rounds go back until the reviewer approves), `minSeverity` (default `MEDIUM`; findings below it go to follow-ups instead of another round). |
| `stages[].gates[]` | Checks the app runs after the stage's turn, before handing on: `{ "kind": "command", "run": "npm run check" }` (`"auto"` picks `npm run check`, `cargo test`, or `npm test` from the folder), `{ "kind": "pullRequest" }` (every pull request the stage reported exists on GitHub). An `auto` command that finds nothing to run stops the run with `no_check_found`; add `"optional": true` to the gate to skip it instead. The HANDOFF contract is always checked. |
| `stages[].checkpoint` | Autopilot stops before starting this stage and waits for you. |
| `stages[].alsoReviewers` | Specialist reviewers (role ids, for example a custom Security Reviewer) that review the same work in parallel with the stage's role. Needs a `loopBack`. Autopilot opens them together, waits for all of them, and decides on the merged reviews: the worst verdict, every reviewer's findings. |
| `autopilot.pauseAtUsagePercent` | Autopilot pauses when the Claude 5-hour or 7-day usage reaches this percent (default 90). |
| `autopilot.stallMinutes` | While a stage is Working, this many minutes with no terminal output and no growth of its session log stops the run with `stalled` (default 30, 1 to 1440). Raise it for a pipeline whose checks run quietly for long. |

Every role id must exist. When the app loads your pipelines (and whenever a role is added or deleted), one that does not validate stays listed under Settings › Pipelines, **disabled**, with the reason; it is never dropped, and an entry that is not a pipeline at all is kept exactly as written. A disabled pipeline cannot be started, and autopilot stops a run whose pipeline became disabled or unknown instead of guessing one.

## Engine 2 and the run actor

A new run gets engine 2 when every stage of its pipeline reports through the pipeline bridge, told apart by the stage's kind (so a copied role counts like its original): a `planner` stage, a `reviewer` stage with no `alsoReviewers`, and an `implementer` stage. Eagle-Eye 1 and 2 qualify. Any other pipeline (a stage with `alsoReviewers`, or a `generic` stage) runs on engine 1, the path described in ADR-014.

On an engine-2 run, one Rust **run actor** per run is the only thing that acts on it (`src-tauri/src/run_actor/`). It hears each stage's finished turn from the bridge, runs the stage's gates on a thread of its own, decides, and carries the decision out: it opens the next stage's terminal with a prompt built from the role template and the run folder (`plan.md`, `prs.json`, `tasks.json`; the prompt also points at those files), sends a round back or a failed check's output to the stage that must act, and starts lanes that were waiting. Sending back stops that stage's `claude` (SIGTERM, then SIGKILL after 10 s) and resumes its session in the same terminal (`claude --resume`, same flags) with a short prompt: a review round's points at `findings-<stage>-r<N>.json` in the run folder, a failed check's carries its output. The tab you watch stays and shows the resumed session. Your Send on such a run fills the next stage's form from the run folder's files, and you can still edit it. Your **Send**, **Send back**, **Approve** and **Continue** on such a run are messages to the same actor, handled one at a time with autopilot's own steps, so the two never make the same hand-off twice. If the actor fails, the run stops (`stopped`, reason `carry_out_failed`) and the stage terminals keep running for you to finish by hand.

A pipeline with an `implementer` stage can **fan out** at that stage: the stage before it (its plan) lists several pull requests, and each gets its own lane of the remaining stages in its own git worktree. See `docs/PIPELINE-REPLY-GUIDE.md`. On an engine-2 run whose Planner launched with the bridge, fan-out reads the Planner's tasks from the run folder's `tasks.json` instead of the reply's list.
