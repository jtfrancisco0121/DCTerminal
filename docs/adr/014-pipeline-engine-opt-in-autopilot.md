# ADR-014: Pipeline engine with opt-in autopilot, terminal-first

- **Status:** Accepted (JT, 2026-10-13)
- **Supersedes:** "Hand-offs are always user-triggered. Nothing auto-starts the next step." (`CLAUDE-FIRST-PLAN.md` global constraints, `orchestrator-design.md`, `OPPORTUNITY-MAP.md`). Manual stays the default; it is no longer the only mode.
- **Does not change:** ADR-010 (no auto-approve of permissions beyond `allow_once`), the read-only rule for Claude and Cursor config folders, and "merge only after JT approves".

## Context

The pipeline today is two hard-coded chains: Eagle-Eye 1 (Planner → Plan Reviewer → Implementer → PR Reviewer) and Eagle-Eye 2 (Implementer → PR Reviewer).

| Today | Where | Effect |
|---|---|---|
| Stage lists are written three times | `src/handoff/chains.ts`, `src/pipeline/stages.ts`, `src-tauri/src/store/state_types.rs` | No other pipeline shape is possible; the copies can drift |
| Every hand-off waits for a click | `routing.ts` picks only the button label | Runs stall when JT is away, even after an APPROVED verdict |
| Verdicts and findings are prose read by regexes | `contract.ts`, `verdict.ts` | Findings have no severity, so no rule can act on them |
| Nothing checks the build between stages | Tests run only if the agent decides to | "Implemented" can arrive with a failing `npm run check` |
| Review rounds have no limit | `chain_loop_back` adds 1 to `round` | Loops have no stopping rule |
| The hand-off executor lives in the UI | `StartupForm.tsx` `confirmHandoffNow` | Run state only advances while the window is open; hard to test alone |

## Decision

1. **Autopilot is opt-in, per run.** Manual is the default for every run. When JT turns autopilot on for a run, the engine applies that run's policy after each turn: advance, loop back, or stop for JT.
2. **Guardrails that always apply:**
   - A checkpoint before the first Implementer stage, on by default. JT can turn it off per pipeline.
   - The run stops on **Needs you** (permission, question, or plan card).
   - At most 3 rounds per loop-back edge. Reaching the cap stops the run.
   - The run pauses when the Claude 5-hour or 7-day limit is near (`usage.json`).
   - A missing verdict, or missing HANDOFF sections after one re-ask, stops the run.
   - Autopilot never merges a pull request.
3. **Default policy follows JT's review rule:** advance when there is no finding at MEDIUM or above and no regression. LOW findings go to the run report as follow-ups instead of starting another round.
4. **Terminal tabs first.** Autopilot targets Claude role terminals: turn end comes from the session log (`turnDone`), and terminal roles run in `--permission-mode auto`, so Claude still asks before risky actions and the run stops as Needs you. Chat (ACP) runs stay manual. Chat roles run in `bypassPermissions` with every request auto-answered `allow_once`, so nothing would ever stop them. Chat autopilot needs its own decision later, and would move those roles to `auto`.
5. **Run state and the decision live in Rust; the frontend carries decisions out.** The run, its ledger, gate results, autopilot state and the advance/loop/stop decision (`pipelines::autopilot::decide`) are in the backend and unit-tested there. Carrying a decision out (mapping a reply onto the next role's form, opening its terminal, pasting a follow-up) stays in the frontend (`src/pipeline/useAutopilot.ts` over `src/handoff/executor.ts`), because hand-off mapping (`map.ts`) and terminal start live there. The app window is always mounted, so a run moves on when its tab is not on screen; it pauses while the app is closed.
6. **Pipelines are data.** A pipeline definition lists stages (role and surface), gates, loop-back edges with round caps and severity thresholds, and checkpoints. Eagle-Eye 1 and 2 ship as built-in definitions that behave exactly as today. Built-ins are seeded from `docs/pipelines/*.json`, the way `docs/roles` seeds roles. User pipelines live in the app data folder and are edited in Settings.
7. **Stages exchange structured results.** Reviewer roles add a fenced JSON block (verdict, findings with severity and file, pull requests) after their `## HANDOFF:` sections. The existing regex parsers stay as the fallback for older replies.
8. **Gates are checks the app runs itself** between stages: required sections present, a command such as `npm run check` in the stage's folder, and the pull request exists (`gh pr view`). A failed gate loops back with its output as the findings.

## Order of work

Each phase ships on its own. Autopilot does not start before Phase 1 is merged.

| Phase | Work |
|---|---|
| 0. Foundation | (A) Fix the lock-order deadlock between `session_agent_logs` and a running turn. (B) Skip thought and tool text in `agentText` for Claude's `sessionUpdate` field. (C) Make `role_session_start` and `acp_set_model` async. (D) Move the hand-off executor out of `StartupForm.tsx`, with no change in behavior. (E) Save a hand-off and its chain step in one backend call. |
| 1. Still manual | Pipelines as data; structured verdicts with severity; contract, check and pull-request gates; round caps; a run ledger and timeline. |
| 2. Autopilot | Per-run policy, checkpoints, stop conditions, notifications, usage-aware pause. Terminal roles only. |
| 3. Scale | One Implementer per pull request in its own worktree (`worktree.rs`); dependent pull requests wait; specialist reviewers merged into one verdict. |

## Alternatives considered

| Option | Why not |
|---|---|
| Keep every hand-off manual | Leaves runs stalled on clicks that add no review. Gates and severities remove most of the reason for them. |
| Global autopilot switch | Too coarse: JT trusts a bug fix run more than a new feature. |
| Autopilot for chat first | Chat roles run with full permissions and never stop for JT. Terminal `auto` mode keeps a person in the loop for risky actions. |
| Keep the engine in the UI | Runs would stop when the window closes or reloads, and the logic stays inside a 5,700-line component. |
| Parallel Implementers first | Running more agents at once multiplies every reliability bug, including the Phase 0 ones. |

## Amendments

- **2026-10-16: no round cap by default.** Guardrail 2's "at most 3 rounds per loop-back edge" no longer applies to the built-in pipelines. A loop-back's `maxRounds` is optional: left out, autopilot sends rounds back until the reviewer approves, or only findings below the threshold remain. A pipeline may still set a cap (1 to 20) in Settings › Pipelines, and reaching it stops the run as before. Every other stop stays: Needs you, the checkpoint, usage near the limit, missing HANDOFF sections after one re-ask, a missing verdict, repeated check failures, and never merging.
- **2026-10-16: each hand-off once.** A hand-off on (or a send-back) is made at most once per run, stage, round and lane, or per source turn, whether you or autopilot makes it. The run keeps these claims; `decide` takes one atomically and skips (with a Timeline line) when one exists. A manual Send warns once when autopilot made it already. Autopilot also skips a turn you interrupted, and a turn whose round ended while its checks ran.
- **2026-10-19: explicit run status (Track H2).** A run carries `status` (`running`, `waiting`, `complete`, `stopped`) and, when waiting, one `stopReason` code (`checkpoint`, `gate_failed`, `no_check_found`, `no_result`, `no_verdict`, `blocking_findings`, `round_cap`, `usage_limit`, `stalled`, `app_restarted`, `carry_out_failed`, `taken_over`, `paused_by_you`). `decide` acts only while `running`: after a stop, finished turns are left alone (with a Timeline line) until you hand on, send back, approve, or turn autopilot off and on. `complete` is final for autopilot, so late turns after completion are ignored; only a hand-off or send-back you make reopens the run (`running` with autopilot on, else `stopped`), as the load-time migration also reads that history. Turning autopilot off makes the run `stopped` (`paused_by_you`). Runs saved before this get a status from their old fields on load. A failed gate's retries reset once the gate passes. A round going back to a live terminal is recorded before the findings are pasted; when the record fails, the run stops with `carry_out_failed`.
- **2026-10-19: restart recovery and the stall watchdog (Track H3).** At startup each `running` autopilot run is checked against its current stage's session logs. A finished turn no decision covers puts the run in `waiting` with `app_restarted`; autopilot never acts on it by itself, and the overview's **Continue** runs the run again and decides that turn. A turn the quit cut off is noted, and the run keeps running. While a current stage is Working (a prompt with no finished turn), no terminal output and no log growth for the pipeline's `autopilot.stallMinutes` (default 30) puts the run in `waiting` with `stalled`. Both run on one background thread, never the main thread, and read logs with no store lock held.
- **2026-10-19: stage kinds and loud failures (Track H4).** Each stage has a `kind` (`planner`, `reviewer`, `implementer`, `generic`; left out: from the built-in role id, else `reviewer` for a stage with a loop-back, else `generic`). Every rule that keyed on `role_planner` and friends (required HANDOFF sections, the plan-mode turn end, the send-back ask, verdict reading, fan-out, plan lookups) reads the kind instead, so a copied role behaves like its original; a reviewer whose loop-back goes to a planner reviews the plan. Your pipelines are validated on load and whenever roles change: an invalid one is kept, disabled with the reason, never dropped (an entry that is not a pipeline is kept as written). Role ids must exist. An unknown run kind is an error, never a silent Eagle-Eye 1. An `auto` command gate with nothing to run stops the run with `no_check_found` unless the gate is `optional`. Permission modes (D23 read with D33): on a pipeline the stage kind decides, so a `planner` stage, a copied Planner included, starts in `plan` mode (terminal, restart, chat and its plan card). Every other stage gets its role's usual non-plan mode: `auto` in a Claude terminal, the D23 chat table in a Claude chat (`bypassPermissions`, or `auto` for General), and `--yolo` in a Cursor terminal unless Settings overrides the run mode. A hand-off start carries the chain the new tab joins, since the tab is tagged after it starts. Off a pipeline, the built-in Planner role plans as before.
- **2026-10-19: honest usage and stop reasons (Track H5).** Usage that is missing or stale (the window reset since the reading, or a reading with no reset time older than its window) reads as **unknown**, never 0%. Autopilot carries on when usage is unknown, but a rate-limit error in a stage's session log (Claude's synthetic `isApiErrorMessage` reply) stops the run with `usage_limit`, before any check runs. Claude terminal tabs now report usage: each one DCTerminal starts gets `--settings` with a `statusLine` that runs the app's own executable (`--dct-status-line <file>`), which records `rate_limits.five_hour` / `seven_day` from Claude Code's input and prints nothing; `rate_limits` is optional (missing on the first render). A status line you set yourself (account or folder settings) wins, and that tab's usage stays unknown. Every stop carries its reason code to the overview, the stop notification and the Timeline (the stop line's `outcome`; "Autopilot off" carries `paused_by_you`), each shown with one plain-English line (`src/pipeline/stopReasons.ts`).
- **2026-10-19: one owner for engine-2 runs (pipeline v2 V3).** On a run whose every stage reports through the pipeline bridge (engine 2), a Rust run actor, one thread per active run, replaces the frontend executor: it hears each finished turn from the run's inbox, runs the gates on a thread of its own, decides with the same `decide`, and opens the next stage's terminal with a prompt built in Rust from the role template and the run folder. Your Send, Send back, Approve and Continue on such a run are messages to that actor; handling one message at a time, plus the decided-turn list, replaces claims there (the hand-off records stay, so a Send after autopilot's warns once). A panic in the actor stops the run (`stopped`, `carry_out_failed`) and leaves the stage terminals running. A pipeline the bridge does not cover whole (a stage with parallel reviewers, or a `generic` stage; stages are told apart by their H4 kind) keeps engine 1 and this ADR's frontend executor.

## Consequences

- Docs that say hand-offs are always user-triggered now point here.
- New pipelines need no code change once Phase 1 lands.
- The run ledger becomes the record of what happened in a run, replacing the reading of `handoffs.json`, `state.json` and transcripts side by side.
- The role prompts for Plan Reviewer and PR Reviewer change in Phase 1 (the JSON block). Their template hashes go into `SHIPPED_TEMPLATE_HASHES` so unedited saved roles upgrade.
- Proposal page with diagrams: https://claude.ai/artifact/DVZPr5r15TbXsRMau7nMTh (private to JT).
