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
5. **The run engine lives in Rust.** Run state and the advance/loop/stop decision move out of `StartupForm.tsx` into the backend, so a run keeps going when its tab is not on screen. The UI shows and controls runs; it no longer drives them.
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

## Consequences

- Docs that say hand-offs are always user-triggered now point here.
- New pipelines need no code change once Phase 1 lands.
- The run ledger becomes the record of what happened in a run, replacing the reading of `handoffs.json`, `state.json` and transcripts side by side.
- The role prompts for Plan Reviewer and PR Reviewer change in Phase 1 (the JSON block). Their template hashes go into `SHIPPED_TEMPLATE_HASHES` so unedited saved roles upgrade.
- Proposal page with diagrams: https://claude.ai/artifact/DVZPr5r15TbXsRMau7nMTh (private to JT).
