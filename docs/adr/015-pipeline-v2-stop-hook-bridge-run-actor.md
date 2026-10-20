# ADR-015: Pipeline v2: hook and MCP bridge, structured results, one Rust run actor

- **Status:** Proposed (JT approves on merge)
- **Date:** 2026-10-19
- **Supersedes:** [ADR-014](014-pipeline-engine-opt-in-autopilot.md) §4 (turn end from the session log), §5 (the frontend carries decisions out) and §7 (results as a fenced JSON block). For engine-2 runs only until V6; engine-1 runs keep ADR-014 as written until then (D19). From V6 on, engine-1 runs are manual only, so ADR-014's autopilot carry-out applies to no run.
- **Keeps:** every other part of ADR-014: §1 opt-in autopilot per run, §2 guardrails, §3 the default policy, the terminal-first half of §4, §6 pipelines as data, §8 gates, and both 2026-10-16 amendments. Also ADR-010 (no auto-approve of permissions beyond `allow_once`), the read-only rule for Claude and Cursor config folders, and "merge only after JT approves".
- **Plan:** [docs/plans/2026-10-18-pipeline-v2-plan.md](../plans/2026-10-18-pipeline-v2-plan.md) (run folder layout, result schemas, Track H and Track V tables). Live evidence: [docs/claude-hooks-observed.md](../claude-hooks-observed.md) (V0, Claude Code 2.1.287).

## Context

ADR-014's autopilot guesses at every step. Most fixes since it shipped (claims, stale and interrupted turns, re-asks) patch a symptom of one of these guesses.

| Today (ADR-014) | Where | Effect |
|---|---|---|
| Turn end is read from the session log (`turnDone`) | §4, `claude_log` watcher | Interrupted, stale and coalesced turns need special cases; a log-format change leaves tabs stuck running |
| Verdicts and findings come from a fenced JSON block, with regexes as the fallback | §7, `contract.ts`, `verdict.ts` | A reply that forgets or mangles the block needs a re-ask, and the parser decides what the reviewer meant |
| "Needs you" comes from screen bytes | `permissionDialog.ts` | Pinned to Claude Code 2.1.287's screen; a new version can hide Needs you |
| Decisions are carried out in React by pasting keystrokes | §5, `useAutopilot.ts` over `executor.ts` | Two drivers (JT and autopilot) race; claims exist only to order them; a run only advances while the window is mounted |
| A loop-back pastes a follow-up into the running terminal | `executor.ts` | Depends on the input box state; an Esc leaves the old prompt in the box |

V0 (2026-10-18, live on Claude Code 2.1.287) showed that hooks from inline `--settings` fire in the interactive TUI, that Stop carries the turn id and the last reply, that a Stop hook can block once, that an inline stdio MCP server loads, and that SIGTERM plus `--resume` keeps the session. So the app can be told these things instead of guessing them.

## Decision

1. **A file-based bridge, no HTTP server (D8, D37, D38).** Rust launches each bridged stage's `claude` with three additions: hooks through `--settings` (inline JSON, merged with the H5 usage status line into the launch's one `--settings`), a one-tool MCP server through `--mcp-config` (inline JSON, stdio), and `--allowedTools mcp__dcterminal__submit_result`. A Planner stage gets `--settings` only, because it reports through ExitPlanMode (D11) and has no tool to allow or serve. Both the hooks and the MCP server are the `dcterminal` binary run as `dcterminal bridge` (the path comes from the running executable; hooks use the `args` array, so there is no shell quoting). The bridge writes only atomic JSON files inside the run folder named on its command line (`<app data>/runs/<runId>/`), checks the run id and stage name, and makes no network calls. Rust watches the folder with `notify`. There is no port, token, firewall prompt or async runtime.
   - Bridged stages are chosen by H4 stage kind (D33): `planner`, `implementer` and `reviewer`, so copied roles count like their originals. A reviewer stage with parallel reviewers (`alsoReviewers`) and a `generic` stage are not bridged. A new run gets engine 2 only when every stage of its pipeline is bridged (`engine_for`), so the run actor only drives runs it can follow end to end; any other pipeline's runs get engine 1, which after V6 means manual only.
   - Every stage of an engine-2 run launches this way, autopilot or not (D13), including a Planner JT starts from the form. Autopilot only decides whether Rust acts; enforcement (the block in 3) applies only on autopilot and not while a stage is taken over. Each stage folder holds a `mode` file (`autopilot`, `manual` or `takeover`) that the bridge reads.
   - JT's own MCP servers stay available (no `--strict-mcp-config`, D14). JT's own Stop hooks still run, because inline settings merge with user settings (D15). If one of them blocks stages, the fix is to document how to scope it, not to drop it.
   - Tabs outside a pipeline, and stages of engine-1 runs, launch exactly as today, with no hooks and no MCP.
   - The run folder, as shipped (`bridge/mod.rs`, `bridge/folder.rs`). The app writes `run.json`, `stage.json` and `mode` at launch, and the run actor writes each `findings-<stage>-r<N>.json`; the bridge writes the rest. The JSON files are written atomically (temp file, then rename); `bridge.log` is appended in place and `plan.md` is markdown. Nothing is written outside the run folder.

     ```text
     run.json                      the run id, checked by the bridge (D37)
     plan.md, tasks.json           the Planner's plan and tasks (ExitPlanMode hook)
     prs.json, prs-<lane>.json     what each Implementer reported (submit_result)
     findings-<stage>-r<N>.json    a review round the actor sent back (V4)
     inbox/                        finished turns (Stop) and Needs you (PermissionRequest, Notification)
     bridge.log                    what went wrong, unknown payload fields (D24)
     stages/<stage>[@lane]/
       stage.json                  stage, role, lane, owning tab, result schema
       mode                        autopilot | manual | takeover
       turn.json                   current turn: prompt_id, start, blocked, end
       results/<turn>.json         what submit_result accepted, already checked
       payloads/<Event>.json       newest raw hook payload per event
       needs.json                  the last Needs you posted (Notification dedupe)
     ```
   - Every `claude` launch removes inherited `CLAUDE*` env vars except `CLAUDE_CONFIG_DIR`; otherwise Claude writes no session log (D39).
2. **Turn end comes from the Stop hook (replaces ADR-014 §4's "turn end comes from the session log").** UserPromptSubmit writes `stages/<stage>/turn.json` with Claude's `prompt_id` as the turn id; Stop carries the same `prompt_id` and `last_assistant_message`, so nothing is parsed from the log at turn end (D9). Stop does not fire on Esc or on a rejected permission: a UserPromptSubmit with no Stop is an abandoned turn, and autopilot never acts on it. A later UserPromptSubmit, an `idle_prompt` Notification or the stall watchdog closes it out (D9a; the `idle_prompt` close-out is built in #98, follow-up fixes). After an Esc the input box is cleared before the next prompt, because Claude puts the interrupted prompt back (D40). Needs you comes from the PermissionRequest hook, which fires at once: it drops a Needs-you event in `inbox/` and answers nothing, so the dialog stays for JT. The `permission_prompt` Notification (about 6 s late) is the backup, posted only when that turn had no PermissionRequest, and screen scraping stays as the last fallback (D22). Needs you does not end the turn, so autopilot decides nothing until the turn ends; while it lasts, the stage's view takes keystrokes (D27). PermissionRequest for ExitPlanMode or AskUserQuestion sets no permission mark, so the plan or question prompt shows instead. The terminal-first half of §4 is unchanged: the Planner runs in `plan`, every other role in `auto`, and chat (ACP) autopilot stays out of scope (D23). A role on Haiku silently runs in `default`, because auto mode is unavailable there; it asks before risky actions more often, and the overview says so (D12a; built in #98, follow-up fixes).
3. **Stages report through tools, not prose (replaces ADR-014 §7).** Reviewer and Implementer stages (by stage kind) call `submit_result` (`schema: 1`; schemas in the plan's "Result schemas"). The bridge checks every field and returns a tool error naming each problem, so Claude fixes it in the same turn. An accepted Implementer result is also copied to the run's `prs.json` (`prs-<lane>.json` in a lane). A BLOCKED Implementer reports through the same tool with `blocked` (why) and `prs` empty or left out; no checks run and the run waits with `checkpoint` and that reason. If no UserPromptSubmit opened the turn (V0 did not verify that the positional startup prompt sends one), the PreToolUse hook for `submit_result` or ExitPlanMode opens it from its `prompt_id`, and if no hook ran at all the tool opens a `tool-<uuid>` turn that the next Stop ends. The tool is allowed up front with `--allowedTools`, and a PreToolUse hook also answers `allow` for that one tool, because plan mode still prompts despite the allowlist (D12). The Planner reports through its ExitPlanMode call: a PreToolUse hook saves `plan.md` and `tasks.json` (from a fenced `tasks[]` block in the plan) and answers `deny` with "Plan received", which ends the turn with no approval dialog (D11). On autopilot, a Stop with no result this turn is blocked once, only while `stop_hook_active` is false, with a reason that names the exact tool and arguments; a second stop with no result ends the turn and stops the run with `no_result`, never an endless loop (D10). The `## HANDOFF:` prose stays in the role templates for JT and for manual hand-offs; a `{{result_instructions}}` token adds the tool instructions only on bridged stages, and a bridged role without the token gets them appended to its prompt (D21). The regex parsers stay for manual hand-offs and to display old runs; old verdict words ("REQUEST CHANGES", "REQUIRES REVISION") are rejected by `submit_result` with a tool error that names `CHANGES_REQUIRED`, so Claude resubmits in the same turn.
4. **One Rust run actor carries decisions out (replaces ADR-014 §5).** One thread per active run is the only thing that acts on it (D18). It handles one message at a time: bridge events, JT's buttons, gate results, process exits and timers. That ordering, plus turn-id dedupe, replaces claims; the guarantee of ADR-014's "each hand-off once" amendment stays, only its mechanism changes. The actor spawns stage terminals, builds launch prompts in Rust from the role template and the run files, runs gates after the Stop hook (never inside it, D16), decides with `pipelines::autopilot::decide`, and advances. Manual buttons on engine-2 runs (Send, Send back, Approve, Continue, and Take over / Hand back from 5) become messages to the actor; React only renders and sends user actions. A loop-back or gate failure sends SIGTERM, waits for exit (SIGKILL after 10 s), then relaunches `claude --resume S` with the same flags and a short prompt; the view stays and is pointed at the new process (D17).
   - A review round first goes to `findings-<stage>-r<N>.json`, and the prompt names that file and repeats the findings. A failed check's output goes inline in the prompt (there is no gate output file). A Send back JT presses is resumed with JT's text as written, and no findings file is written for it.
   - For a round sent back, the target is resumed when its tab still exists and has a saved Claude session, whether its process is running and idle or has exited. A target that is still mid-turn is not killed: the run stops with `carry_out_failed`, because an abandoned turn looks the same as a working one (D9a). A failed check is stricter: the stage's terminal must be running and idle, and otherwise (exited, or still working) the run stops with `carry_out_failed`.
   - One paste remains (D40): a stage that still runs but has no saved Claude session gets the round or the check output pasted, after Ctrl+U clears its input box. Every stage the actor opens and every role terminal saves its session, so this is a fallback. For a round sent back, a tab that is gone, or exited with no session, gets a new terminal; a failed check never opens one. The v1 re-ask is gone since V6.
   - The D24 gate in 6 runs again before every resume. If it now refuses the bridge, the run becomes manual for good (as in 6), nothing is resumed and no terminal opens, and the one Timeline note names the round's findings file so JT can send it back by hand. This is not a `carry_out_failed` stop.

   Next-stage prompts point at `plan.md`, `tasks.json` and `prs.json` (only the ones that exist), and their fields are still filled from those files, because role templates require them. A manual Send on an engine-2 run opens the form prefilled from those files, still editable (the actor's read-only `prefill` action, D20). If the actor thread panics, the run goes to `stopped` with `carry_out_failed`, the stages' `mode` files go to `manual` (except taken-over stages) so no result is enforced, and the stages keep running.
5. **Hidden stages with Watch and Take over (D25 to D28).** Stages start hidden at 120×40 with a 2 MB output ring buffer each. Watch is any view of the stage (its tab, Watch in split, a grid cell); it replays the buffer, goes live and resizes once to force a clean redraw. On autopilot, a stage's view is read-only, and the backend refuses keystrokes too, except while the stage needs JT or is taken over (D27). With autopilot off every stage takes keystrokes, since nothing else drives it. Closing a Watch view never stops a stage; closing the stage's tab still closes its terminal.
   - **Take over** writes `mode = takeover`, so the bridge no longer blocks a stop with no result. The stage's turns are recorded but not decided, gate results for it are not acted on, its exit does not stop the run, and the stall watchdog skips it. The run waits with `taken_over` when every current stage tab is taken over; in a fanned-out run other lanes keep going. A decision that would act on a taken-over tab (a loop-back into it, a retry) is not applied, and the run stops with `taken_over` naming the stage.
   - **Hand back** writes `mode` back (`autopilot`, or `manual` when autopilot is off). The actor first re-decides the other current stages' held turns; a held round aimed at the handed-back stage that JT's own newer turn has already answered is recorded as dealt with, with a Timeline note, and nothing is sent. Then it decides at once the stage's current turn if it has a result and was not decided before Take over. A turn with no result waits for the next turn.
6. **Engine versions (D19, D24).** New runs of a pipeline the bridge covers end to end carry `engine: 2` (see 1). Engine-1 runs kept the ADR-014 path until V6; since V6 they are manual only: autopilot cannot be turned on for them, restart recovery and the stall watchdog skip them, and the overview disables the toggle and says why. Old runs saved with autopilot on keep the flag, inert; nothing is migrated.
   - **The gate** (`bridge/gate.rs`) runs at every bridged start and at every relaunch of a bridged tab (Restart, resume), on the launch's thread with no store lock held. It reads `claude --version` (cached per executable, keyed on its size and modification time, so an in-place update is seen) and the settings files Claude Code reads (the run's config folder, the project's `.claude/settings.json` and `.claude/settings.local.json`, the managed settings file), each time.
   - Claude Code 2.1.287 (what V0 verified) or newer is required. Older, or a version that cannot be read, gives the run engine 1 with a notice on the overview and the Timeline. Newer is allowed: the bridge logs unknown payload fields in `bridge.log` and the overview says "Claude Code version not yet verified".
   - Hooks off also gives engine 1 with a notice naming the file and the setting: `disableAllHooks: true` in any of those settings files, or `allowManagedHooksOnly: true` in the managed file (which drops `--settings` hooks too).
   - **A mid-run switch.** When a Restart, resume or actor launch finds the gate refusing on a run that was already running bridged, the run becomes manual for good: `manualOnly`, autopilot off, status `stopped` with no stop reason, every stage's `mode` file set to `manual` (except stages JT has taken over), and one Timeline note ("manual from now on"). Turning autopilot back on is refused with that reason. A refused resume resumes nothing and the note names the round's findings file (see 4). A first launch that picks engine 1 for a new run just starts it as an engine-1 (manual-only) run.

## ADR-014 guardrails kept

Every guardrail from ADR-014 §2 and its amendments still applies to engine-2 runs. What changes is how the app learns about each event.

| Guardrail (ADR-014) | How v2 enforces it |
|---|---|
| Autopilot is opt-in per run; manual is the default (§1) | Unchanged. Hooks and MCP run on every stage of an engine-2 run, but the actor acts only on autopilot runs (D13). Engine-1 runs, and runs a mid-run switch made `manualOnly`, cannot turn autopilot on (D19, D24) |
| Checkpoint before the first Implementer stage, on by default, can be turned off per pipeline | The actor stops with `checkpoint` before spawning the stage. A BLOCKED Implementer (`submit_result` with `blocked`) also waits with `checkpoint` and its reason |
| The run stops on Needs you (permission, question or plan card) | The stage waits for JT: its turn does not end, so nothing is decided. PermissionRequest hook first, Notification and screen scraping as fallbacks (D22); the view takes keystrokes while it lasts (D27) |
| Round caps: none by default since 2026-10-16; an optional `maxRounds` (1 to 20) stops the run with `round_cap` | Unchanged; checked by `decide` |
| Pause when Claude usage is near the limit | statusLine `rate_limits` gives terminal usage when present. When usage is known and at or above the pipeline's `autopilot.pauseAtUsagePercent`, the run stops with `usage_limit` before the next hand-off. Unknown usage is shown as unknown, never 0%, and the run continues. A rate-limit error in a stage's log also stops the run with `usage_limit` (D32, H5) |
| A missing verdict, or missing HANDOFF sections after one re-ask, stops the run | Becomes: no `submit_result` after one block stops with `no_result`. The re-ask and `missing_sections` are gone since V6. The reviewer schema requires a verdict, so `no_verdict` stays only as a guard in `decide` |
| Repeated check failures stop the run | Unchanged; gates run in the actor and stop with `gate_failed` |
| Autopilot never merges a pull request | Unchanged. Nothing in the bridge or the actor runs a merge |
| Each hand-off once per run, stage, round and lane, or per source turn (2026-10-16) | The actor's one-message-at-a-time loop plus turn-id dedupe (D18) |
| A turn whose round ended while its checks ran is skipped (2026-10-16) | The actor drops a turn result or gate result whose round is no longer the run's current round, with a Timeline line, as `decide` does today ("the run is on round N now") |
| A manual Send warns once when autopilot made the hand-off already (2026-10-16) | A manual Send on an engine-2 run is a message to the actor. The actor refuses it with the same warning when it made that hand-off already |
| Autopilot skips a turn JT interrupted | An abandoned turn (UserPromptSubmit with no Stop) is never acted on (D9a) |
| Default policy: advance when no finding is MEDIUM or above and no regression; LOWs go to the run report (§3) | Unchanged; findings now carry `severity` and `regression` from the schema |
| Chat (ACP) autopilot stays out of scope; terminal roles run in `auto` (§4) | Unchanged (D23) |
| Permissions: no auto-approve beyond `allow_once` (ADR-010) | Unchanged. Stages never get `--dangerously-skip-permissions` or `bypassPermissions`; the only pre-approval is the one DCTerminal tool, `mcp__dcterminal__submit_result` (D12) |
| Claude and Cursor config folders are read-only | Unchanged. All flags are inline; the bridge writes only inside the run folder (D37) |

Every stop carries one reason code, shown on the overview, in the notification and in the ledger: `checkpoint`, `gate_failed`, `no_check_found`, `no_result` (replaces v1's `missing_sections`), `no_verdict`, `blocking_findings`, `round_cap`, `usage_limit`, `stalled`, `app_restarted`, `carry_out_failed`, `taken_over`, `paused_by_you`.

## Decision log

The final decisions from the plan, with the V0 amendments of 2026-10-18 applied. "Reverse if" is the evidence that would change a row.

### Order and quality

| # | Decision | Reverse if |
|---|---|---|
| D1 | Track S (stability), then Track H (hardening), then Track V (v2). V0 can run at any time | Never; the order is the point |
| D2 | No new features during Track S: only bug fixes, tests and the S2 structural fixes | A bug can only be fixed by a feature (then it counts as a fix) |
| D3 | "Pitch perfect" is the Track S exit bar, ending with 5 working days of JT's normal use with no new MEDIUM+ bug | — |
| D4 | No StartupForm rewrite. Each fix extracts only the code it touches into a tested module | Bugs keep clustering in StartupForm's wiring after S1 |
| D5 | The full Playwright suite runs on every Track S PR (decided 2026-10-18; overrides "no Playwright unless asked" for Track S only) | JT would rather run it himself at the exit bar |
| D6 | JT runs a 20-minute smoke checklist once, at the exit bar; a Playwright project on the built app under the production CSP covers the rest. Agents do not drive the live app | — |

### v2 design

| # | Decision | Reverse if |
|---|---|---|
| D7 | Build v2 by layer (signals, one owner, resume, hidden), not by stage | — |
| D8 | Files, not HTTP: `command` hooks and a stdio MCP server, both `dcterminal bridge`, writing into the run folder; Rust watches it with `notify` | T10 fails: a small sidecar binary. Command hooks prove unreliable: `http` hooks |
| D9 | The turn id is Claude's `prompt_id`, the same in UserPromptSubmit and Stop; Stop's `last_assistant_message` means nothing is parsed from the log at turn end (confirmed by V0 T2) | — |
| D9a | Stop does not fire on Esc or a rejected permission. A UserPromptSubmit with no Stop is an abandoned turn; autopilot never acts on it. A later UserPromptSubmit, an `idle_prompt` Notification or the stall watchdog closes it out (new in V0, T4) | — |
| D10 | Block at most once per turn, only when `stop_hook_active` is false, with a reason naming the exact tool and arguments. A second stop with no result stops the run with `no_result` (confirmed by V0 T3, with the wording rule) | — |
| D11 | The Planner reports through ExitPlanMode: a PreToolUse hook saves the plan and tasks, then answers `deny` with "Plan received", ending the turn with no dialog (confirmed by V0 T7) | ExitPlanMode capture breaks: the Planner calls `submit_result` after its plan |
| D12 | Reviewers and the Implementer use `submit_result`. Always pass `--allowedTools mcp__dcterminal__submit_result` **and** a PreToolUse hook answering `allow` for that tool, because plan mode prompts despite the allowlist (changed by V0 T5, T6) | — |
| D12a | Auto mode is unavailable on Haiku; such a session silently runs in `default`. The overview says so (new in V0, T5) | — |
| D13 | Hooks and MCP on every stage of an engine-2 run (stages chosen by H4 kind; a pipeline with any other stage gives its runs engine 1). Autopilot only decides whether Rust acts; the block applies only on autopilot and not while taken over | — |
| D14 | No `--strict-mcp-config`; JT's own MCP servers stay available to stages | JT's servers interfere with stages |
| D15 | JT's own Stop hooks still run (settings merge) | One of them blocks stages: document how to scope it |
| D16 | Gates run in the actor after the Stop hook, never inside it; a failure resumes the session with the output | — |
| D17 | Loop-back: SIGTERM, wait for exit, SIGKILL after 10 s, then `claude --resume S` with the same flags and a short prompt pointing at the findings file (a failed check: its output inline). No keystrokes when the stage has a saved session (confirmed by V0 T11: exit in 0.6 s, log complete); a running stage with no saved session gets one paste after Ctrl+U (D40) | SIGTERM damages the log: send `/exit` as the one allowed keystroke and wait |
| D18 | One Rust run actor per active run carries decisions out, one message at a time; this replaces claims. Manual buttons on engine-2 runs go through it | — |
| D19 | New runs of a pipeline the bridge covers end to end carry `engine: 2`. Engine-1 runs keep the v1 path until V6, then become manual-only (shipped in V6: autopilot refused, recovery and the watchdog skip them, no data migration) | — |
| D20 | Next-stage prompts point at run files. A manual Send on an engine-2 run opens the form prefilled from those files, still editable. Tabs outside a pipeline are unchanged | — |
| D21 | `## HANDOFF:` prose stays in role templates; `{{result_instructions}}` adds the tool instructions only on bridged stages; a bridged role without the token gets them appended | — |
| D22 | The PermissionRequest hook is the Needs-you signal; the `permission_prompt` Notification (about 6 s late) and screen scraping are backups (changed by V0 T8) | — |
| D23 | Permission modes unchanged: `plan` for the Planner, `auto` for every other role. Chat (ACP) autopilot stays out of scope | — |
| D24 | Engine 2 needs Claude Code 2.1.287 (V0-verified) or newer. Older or unreadable gives the run engine 1 with a notice; newer is allowed, with unknown payload fields logged and "Claude Code version not yet verified" on the overview. Hooks off (`disableAllHooks` in any settings file Claude Code reads, or a managed `allowManagedHooksOnly`) also gives engine 1. Checked at every bridged start and relaunch; a switch on a run already running bridged makes it manual for good (`manualOnly`, one Timeline note) | A newer version breaks the bridge: pin a maximum too |

### Hidden stages

| # | Decision | Reverse if |
|---|---|---|
| D25 | Watch replays a 2 MB output ring buffer per stage, then resizes once to force a clean redraw | Replay looks broken: keep a headless terminal (`vt100` crate) and send its screen |
| D26 | A hidden terminal is 120×40, resized to the view on attach | — |
| D27 | On autopilot, typing in a Watch view (and through the backend) only while the stage needs JT or is taken over. With autopilot off, every stage takes keystrokes | — |
| D28 | Hand back turns enforcement and decisions back on; if the current turn already has a result and was not decided before Take over, the actor decides at once. A held round JT's own newer turn already answered is recorded, not sent | — |

### Hardening

| # | Decision | Reverse if |
|---|---|---|
| D29 | After a restart, never act on a finished turn by itself: the run waits with `app_restarted` and a Continue button | — |
| D30 | Stall limit: 30 minutes with no output and no log growth, per pipeline (`autopilot.stallMinutes`) | Long quiet test suites trip it: raise the default |
| D31 | An `auto` gate with nothing to run stops with `no_check_found`, unless the gate is marked `optional` | — |
| D32 | Unknown usage is shown as unknown, never 0%; autopilot continues. When usage is known and at or above `autopilot.pauseAtUsagePercent`, the run stops with `usage_limit` before the next hand-off, and so does a rate-limit error in a stage's log. The statusLine input carries `rate_limits.five_hour` and `seven_day` when present, so terminals can report usage; it is optional, missing on the first render (changed by V0 T9 and pulled forward into H5) | — |
| D33 | A `kind` on each stage (`planner`, `reviewer`, `implementer`, `generic`) replaces every role-id check, so copied roles behave like their originals | — |

### Process

| # | Decision | Reverse if |
|---|---|---|
| D34 | v2 is tested on the `fake_claude` Rust binary. Live runs on `~/.claude-account1` only for V0 and the final acceptance run | — |
| D35 | The plan's repository copy is `docs/plans/2026-10-18-pipeline-v2-plan.md`; with this ADR and `docs/claude-hooks-observed.md` it lands with V0 and V1 | — |
| D36 | One draft PR per plan row, branched from `master`. The review loop runs until no MEDIUM+ finding and no regression. Merged only when JT approves | — |
| D37 | The bridge writes only inside the run folder named on its command line, checks the run id and stage name, and makes no network calls. The folder lives in app data | — |
| D38 | Hooks use the `args` array (no shell quoting); the bridge path comes from the running executable | — |
| D39 | Every `claude` launch removes inherited `CLAUDE*` env vars except `CLAUDE_CONFIG_DIR`, or Claude writes no session log (new in V0; fixed under Track S) | — |
| D40 | After an Esc, clear the input box before the next prompt: Claude puts the interrupted prompt back (new in V0). Every actor paste (only a running stage with no saved session since V4) sends Ctrl+U first | — |

## Order of work

Track S exits first (D1). H1 (`fake_claude`) is merged; H2 to H5 follow. V code starts only after Track S exits and H1 to H3 are merged. Each V phase is one draft PR.

| Phase | Work |
|---|---|
| V0 | Verify T1 to T11 live; results in `docs/claude-hooks-observed.md` (done 2026-10-18; T1 passed, so v2 is a go) |
| V1 | This ADR and the plan copy |
| V2a | `dcterminal bridge` (hook and MCP modes), the run folder, UserPromptSubmit and Stop hooks, `submit_result` for Plan Reviewer and PR Reviewer, block once, `{{result_instructions}}`; today's executor reads turn end and result from Rust |
| V2b | Planner through ExitPlanMode, Implementer `submit_result` with `prs[]`, fan-out from `tasks.json`, PermissionRequest as the Needs-you signal |
| V3 | The run actor; `useAutopilot` stops carrying anything out for engine-2 runs |
| V4 | Resume on loop-back and gate failure; hand-offs through run files |
| V5 | Hidden stages, Watch, Take over, Hand back |
| V6 | Remove the v1 autopilot carry-out, claims and executor autopilot code; engine-1 runs become manual-only; update README, `docs/pipelines/README.md` and `PIPELINE-REPLY-GUIDE.md` |

## Alternatives considered

| Option | Why not |
|---|---|
| An `http` hook to a localhost endpoint (the original spec) | Adds a server, port, token and async runtime; `notify` is already in use. Kept as the fallback if command hooks prove unreliable (D8) |
| Keep reading turn ends from the session log | Every interrupted, stale and coalesced turn needs its own case, and a log-format change breaks status. Stop carries the turn id and the last reply |
| Keep the fenced JSON block | The reply can forget or mangle it, and nothing checks it while Claude can still fix it. The tool error does |
| The Planner calls `submit_result` with `tasks[]` | It runs in plan mode, where the tool prompts; ExitPlanMode is its natural end (D11) |
| Block whenever there is no result | One stubborn turn would loop forever (D10) |
| Gates inside the Stop hook | A hook that waits minutes freezes the terminal (D16) |
| Resume "in the same PTY" | A PTY ends with its process; the view is what stays (D17) |
| Delete claims outright | JT's manual buttons can still race autopilot; the actor's message order replaces them (D18) |
| Delete the hand-off mapping code | Manual hand-offs still use the form path; only the autopilot executor and claims go (V6) |
| Build v2 stage by stage, starting with the PR Reviewer | Each layer ships value on its own; the PR Reviewer is still the first stage to get signals (D7, V2a) |

## Consequences

- ADR-014 §4 (its turn-end part), §5 and §7 carry a "superseded" note pointing here. Docs that describe autopilot carry-out (`docs/pipelines/README.md`, `PIPELINE-REPLY-GUIDE.md`, the README) are updated in V6, when the v1 path is removed.
- Pipeline stages depend on Claude Code hook payloads. The bridge keeps raw payloads in the run folder and logs unknown fields. When the D24 gate refuses, the fallback is engine 1, which since V6 is manual only: a refused CLI or hooks-off setting costs autopilot, not the run.
- The role templates for Plan Reviewer, PR Reviewer, Planner and Implementer gain `{{result_instructions}}` in V2a and V2b. Their template hashes go into `SHIPPED_TEMPLATE_HASHES` so unedited saved roles upgrade.
- Kill and resume costs a few seconds per loop-back; the conversation and usually the prompt cache survive.
- The plan is done when one Eagle-Eye 1 run on autopilot, live on `~/.claude-account1` against a scratch repo, goes plan → plan review → checkpoint → implement → checks → PR review with every turn end from the Stop hook and every verdict from the bridge, resumes the same Implementer session on a loop-back, pastes no keystrokes (every stage the actor opens has a saved session, so D40's paste fallback is not used), recovers from a quit with `app_restarted` and Continue, writes nothing to `~/.claude*` and merges no pull request (plan, "Done when").
