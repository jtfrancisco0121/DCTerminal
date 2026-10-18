# Claude Code hooks, MCP and resume: observed behavior (v2.1.287)

- **Date:** 2026-10-18
- **CLI:** `/opt/homebrew/bin/claude`, 2.1.287 (Claude Code)
- **Account:** `CLAUDE_CONFIG_DIR=$HOME/.claude-account1` on every run (Claude Max)
- **Model:** `--model haiku` (Haiku 4.5) for all tests except T5a, which used `--model sonnet` because auto mode is not available on Haiku (see T5).
- **Method:** flags only. Hooks and statusLine came from inline `--settings '<json>'`, the MCP server from inline `--mcp-config '<json>'`, plus `--allowedTools`, `--permission-mode`, `--session-id` and `--resume`. No settings file was edited and no `claude mcp add` / `claude config` was run. `--dangerously-skip-permissions` and `bypassPermissions` were never used.
- **Driver:** the interactive TUI, driven from Python through a stdlib `pty` at 120x40 (`driver.py`). The tests never used `-p`.
- **Environment:** the child process had all inherited `CLAUDE*` / `ANTHROPIC*` env vars removed except `CLAUDE_CONFIG_DIR` (see "Gotchas").
- **Sessions:** 13 short sessions in total. No rate-limit or usage errors occurred.
- **Scratch dir:** `tools/claude-hooks-probe`
  - Scripts: `driver.py`, `hook.py`, `mcp_server.py`, `statusline.py`, `t1.py`, `t3.py`, `t4.py`, `t4b.py`, `t5.py`, `t7.py`, `t11.py`
  - Raw logs: `logs/*.hooks.jsonl`, `logs/*.screen.txt`, `logs/mcp.jsonl`, `logs/statusline.jsonl`

## Summary

| Test | Result | Observed | Implication for the plan |
|---|---|---|---|
| T1 hooks fire in interactive mode | **PASS** | Inline `--settings` hooks fire. UserPromptSubmit and Stop each fire exactly once per turn, and every payload carries `session_id`. SessionStart and SessionEnd fire too. | **D8 (files bridge) is GO.** The core v2 assumption holds. |
| T2 payload fields | **PASS** | The Stop payload has `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`, `scratchpad_dir` and `hook_event_name`. UserPromptSubmit has the same `prompt_id` as that turn's Stop. | **D9 (turn id) is GO:** use `prompt_id` to join UserPromptSubmit to Stop. `last_assistant_message` means there is no need to parse the transcript at Stop. |
| T3 Stop block | **PASS** | Two forms work: JSON `{"decision":"block","reason":...}` on stdout with exit 0, and exit code 2 with the reason on stderr. Either way the turn continues, the model sees the reason, and the next Stop has `stop_hook_active: true`. The TUI shows the reason as "Stop hook error: ...", and the exit-2 form prefixes it with `[<hook command>]:`. | **D10 (block once) is GO:** block only when `stop_hook_active == false`. The reason must name the exact action and arguments. With a vague reason, Haiku asked the user which verdict to use instead of calling the tool. |
| T4 Stop on Esc | **Stop does NOT fire** | Esc during thinking and Esc mid-stream both end the turn with no Stop (and no StopFailure). Rejecting a permission prompt also ends the turn with no Stop. | **D9/D10 need a fallback:** a UserPromptSubmit with no matching Stop means the turn was interrupted or abandoned. Detect it from the next UserPromptSubmit, from the `idle_prompt` Notification, or from the transcript. |
| T5 MCP + allowedTools | **PASS, with caveat** | The inline stdio MCP server loads, and its tools are deferred (reached through ToolSearch first). In `default` mode, `--allowedTools mcp__dcterminal__submit_result` gives no prompt; without it the user is prompted. **On Haiku, `--permission-mode auto` is ignored** ("auto mode unavailable for this model") and the session runs in `default`. On Sonnet in auto mode the call ran with no prompt even without `--allowedTools`. | **D12 is GO for default and auto mode.** Always pass `--allowedTools`, and do not rely on auto mode for Haiku roles. |
| T6 MCP in plan mode | **CONTRADICTS D12** | In `plan` mode the MCP tool prompts **even with `--allowedTools`**. A PreToolUse hook returning `permissionDecision:"allow"` for `mcp__dcterminal__submit_result` makes it run without a prompt (verified in T7). | A plan-mode role needs a PreToolUse allow hook for the DCTerminal tool. `--allowedTools` is not enough. |
| T7 ExitPlanMode capture | **PASS** | The PreToolUse(`ExitPlanMode`) payload has `tool_input.plan` (the full markdown) and `tool_input.planFilePath`. A deny ends the turn cleanly: there is no approval dialog, the model writes a short wrap-up, and Stop fires (`stop_hook_active:false`). | **D11 (Planner via ExitPlanMode) is GO.** Note that Claude writes the plan file under `$CLAUDE_CONFIG_DIR/plans/`. |
| T8 Notification | **PASS** | Notification fires for `permission_prompt` ("Claude needs your permission") about 6 s *after* the dialog appears, and for `idle_prompt` ("Claude is waiting for your input") 60 s after Stop. The fields are `message`, `notification_type`, `session_id` and `prompt_id`. The PermissionRequest hook fires immediately (about 40 ms after PreToolUse) with `tool_name`, `tool_input` and `permission_suggestions`. | **D22:** Notification works, but use **PermissionRequest** for real-time "needs approval". Notification is about 6 s late. |
| T9 statusLine usage | **PASS** | The statusLine stdin includes `rate_limits.five_hour.{used_percentage,resets_at}` and `rate_limits.seven_day.{used_percentage,resets_at}`, plus `cost.*`, `context_window.*` and `prompt_cache.*`. `rate_limits` is missing on the first render, before any API response; it appeared in 7 of 8 calls. | **D32 is GO** via statusLine. Treat `rate_limits` as optional. |
| T10 hook latency | **Approximate** | Spawning a trivial hook took 7 ms for `/usr/bin/true`, 25 ms for `sh -c 'cat'` and 85 ms for a Python hook (median; p90 120 ms). The in-session PreToolUse-to-PostToolUse gap was 27–48 ms in default and plan mode. One auto-mode gap was 429 ms, probably the auto-mode classifier. | A compiled `dcterminal bridge` should add well under 50 ms per event. **T10 proper is deferred** because the binary does not exist yet. |
| T11 SIGTERM + resume | **PASS** | SIGTERM exits in 0.57 s (code 143), and the `.jsonl` is complete (both turns plus `stop_hook_summary`/`turn_duration`). **SessionEnd fires on SIGTERM** with `reason:"other"`. `--resume <uuid> "prompt"` starts the turn at once (Stop about 2.5 s after launch), keeps the same `session_id`, appends to the same `.jsonl`, and fires SessionStart with `source:"resume"`. | **D17 is GO.** |

### Contradictions with the plan

1. **T6 / D12:** `--allowedTools` does **not** pre-approve the MCP tool in `--permission-mode plan`; it still prompts. Fix: add a PreToolUse hook (matcher `mcp__dcterminal__submit_result`) that returns `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`. This was verified to work in plan mode. A PermissionRequest hook is a possible alternative, but it was not tested.
2. **T5 / D12:** `--permission-mode auto` is **unavailable on Haiku**. The CLI silently runs `default` (payload `permission_mode:"default"`, banner "auto mode unavailable for this model"). Any role run on Haiku must rely on `--allowedTools`/hooks, not auto mode.
3. **T4 / D9-D10:** **Stop does not fire on Esc interrupt or on a rejected permission prompt.** The plan must not assume that every UserPromptSubmit gets a matching Stop.
4. **T8 / D22 (minor):** the `permission_prompt` Notification arrives about 6 s late. Use PermissionRequest for immediacy.

T1 holds: hooks fire in interactive mode, so v2 is **not** no-go.

### Gotchas found

- **Inherited env vars:** if `CLAUDE_CODE_CHILD_SESSION` (and the other `CLAUDE_CODE_*` vars of a parent Claude session) leak into the child, the TUI shows "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker" and **no .jsonl is written**. DCTerminal must scrub `CLAUDE*` env vars, except `CLAUDE_CONFIG_DIR`, when it spawns `claude`.
- **First-run trust dialog:** a new folder shows "Quick safety check: Is this a project you created or one you trust?" with **"No, exit" pre-selected**. Pressing Enter exits. Choosing "Yes" needs Down then Enter, sent as one write; sending `ESC [ B` byte by byte reads as Esc and cancels. Once trusted, the folder is remembered (the resume run showed no dialog). No auto-mode opt-in dialog appeared on Sonnet.
- **Esc during thinking:** if Esc lands before any output, the TUI **restores the interrupted prompt into the input box**. The next typed prompt is then appended to it. In T4 the second UserPromptSubmit had `prompt` = "Count from 1 to 200 ...No tools.Create a file named hello.txt ...". A driver must clear the input (Ctrl+U) after an interrupt.
- **MCP tools are deferred:** the model first calls `ToolSearch` with `select:mcp__dcterminal__submit_result`, then the tool. This adds one extra tool round-trip per session.
- **MCP handshake:** Claude Code first sends `server/discover` (MCP 2026-07-28 draft); a "method not found" reply is fine. Then it sends `initialize` with `protocolVersion:"2025-11-25"`, `notifications/initialized` and `tools/list`. Echoing the protocol version worked.
- **Policy:** `disableAllHooks` and managed policy blocked nothing, and `/Library/Application Support/ClaudeCode/` does not exist. Every hook configured through inline `--settings` ran.
- **Update banner:** the TUI shows an "Update available! Run: brew upgrade claude-code" banner. It is harmless.

## Per-test details

### T1: Stop and UserPromptSubmit fire (t1.py)
Two turns ("Reply with exactly: OK", then "OK2") produced exactly SessionStart, UPS, Stop, UPS, Stop, SessionEnd. The hooks were configured only via `--settings`. Hook command: `python3`-shebang script `hook.py <label>` appending stdin to JSONL.

SessionStart:
```json
{
  "session_id": "f6a8c401-6791-4e84-9c46-c9e641b3ba46",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/f6a8c401-6791-4e84-9c46-c9e641b3ba46.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-haiku-4-5-20251001"
}
```
UserPromptSubmit:
```json
{
  "session_id": "f6a8c401-6791-4e84-9c46-c9e641b3ba46",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/f6a8c401-6791-4e84-9c46-c9e641b3ba46.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "4bb9dfae-c4ce-43d9-ae3f-6c886459b204",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Reply with exactly: OK"
}
```
Stop:
```json
{
  "session_id": "f6a8c401-6791-4e84-9c46-c9e641b3ba46",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/f6a8c401-6791-4e84-9c46-c9e641b3ba46.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "4bb9dfae-c4ce-43d9-ae3f-6c886459b204",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "OK",
  "background_tasks": [],
  "session_crons": []
}
```
SessionEnd (after `/exit`):
```json
{
  "session_id": "f6a8c401-6791-4e84-9c46-c9e641b3ba46",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/f6a8c401-6791-4e84-9c46-c9e641b3ba46.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "440d877e-4048-45ab-a08d-edf96b219757",
  "hook_event_name": "SessionEnd",
  "reason": "prompt_input_exit"
}
```

### T2: payload fields
- **Stop:** `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `hook_event_name`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. On Sonnet there is also `effort: {"level":"medium"}`.
- **UserPromptSubmit:** `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `hook_event_name`, `prompt`.
- `prompt_id` is a fresh UUID per user turn and is identical in that turn's UPS, PreToolUse, PostToolUse and Stop. SessionStart has no `prompt_id`. SessionEnd carries a new `prompt_id` after `/exit`, and the last turn's `prompt_id` after SIGTERM.

### T3: Stop block (t3.py)
**Turn 1:** the control file made the Stop hook print `{"decision":"block","reason":"Call submit_result with your result before finishing."}` once (exit 0). Claude continued, ran ToolSearch for the tool and then asked the user which verdict to submit, because the reason did not say. The second Stop:
```json
{
  "session_id": "685dd464-eabf-4e4c-9f6f-ac02c63aad27",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/685dd464-eabf-4e4c-9f6f-ac02c63aad27.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "c6bd398e-3fd7-4c52-b8dc-2335cec4b293",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": true,
  "last_assistant_message": "I need to submit a result to complete the stop hook. What verdict would you like me to submit: `APPROVED` or `CHANGES_REQUIRED`?",
  "background_tasks": [],
  "session_crons": []
}
```
**Turn 2:** the hook exited with code 2 and wrote "Call submit_result with verdict CHANGES_REQUIRED before finishing." to stderr. Claude called the tool (no prompt, because `--allowedTools` was set) and replied. The TUI showed `Stop hook error: [<hook path> Stop]: Call submit_result ...`. The PreToolUse for the MCP call:
```json
{
  "session_id": "685dd464-eabf-4e4c-9f6f-ac02c63aad27",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/685dd464-eabf-4e4c-9f6f-ac02c63aad27.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "b2bfdedd-2616-42a2-afaa-afbada43b0ad",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "mcp__dcterminal__submit_result",
  "tool_input": {
    "verdict": "CHANGES_REQUIRED"
  },
  "tool_use_id": "toolu_01BDgA5BAwkoupE6bBMpchLT",
  "mcp_server": {
    "name": "dcterminal",
    "source": "dynamic"
  }
}
```
The following Stop:
```json
{
  "session_id": "685dd464-eabf-4e4c-9f6f-ac02c63aad27",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/685dd464-eabf-4e4c-9f6f-ac02c63aad27.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "b2bfdedd-2616-42a2-afaa-afbada43b0ad",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": true,
  "last_assistant_message": "Done. Submitted verdict CHANGES_REQUIRED to the stop hook.",
  "background_tasks": [],
  "session_crons": []
}
```
Both forms block. Both set `stop_hook_active:true` on the next Stop, and neither loops when the hook does not block again.

### T4: Esc interrupt (t4.py, t4b.py)
- t4: Esc 2.5 s after "Count from 1 to 200..." landed while the model was still thinking. The UPS fired but **no Stop** fired, and the prompt text went back into the input box.
- t4b: the driver waited until "1 2 3 4 5" was streaming and then sent Esc. The TUI showed "Interrupted · What should Claude do instead?". **No Stop or StopFailure** fired within 10 s or later.
- t4: rejecting a Write permission dialog with Esc showed "User rejected write to hello.txt". **No Stop** fired.

### T5: inline MCP and permission (t5.py, args `name model mode allowed`)
- **t5a** (`--model sonnet --permission-mode auto`, no `--allowedTools`): ToolSearch ran, then `submit_result {"verdict":"APPROVED"}` ran with **no prompt** and the model replied "DONE". The payload had `permission_mode:"auto"`.
- **t3** (`--model haiku --permission-mode auto --allowedTools mcp__dcterminal__submit_result`): no prompt. But the banner said "auto mode unavailable for this model" and the payloads show `permission_mode:"default"`, so the allowlist is what avoided the prompt.
- **t5b** (`--model haiku --permission-mode default`, no allowedTools): the dialog "Tool use dcterminal — Submit Result Tool: (MCP) ... Do you want to proceed? 1. Yes 2. Yes, and don't ask again ... 3. No" appeared. The PermissionRequest payload:
```json
{
  "session_id": "405b1593-efaf-4fbe-b9bb-16e8cae9c9a7",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/405b1593-efaf-4fbe-b9bb-16e8cae9c9a7.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "39e1c9cc-e8f0-4066-ae8b-de8ae6a05802",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "mcp__dcterminal__submit_result",
  "tool_input": {
    "verdict": "APPROVED"
  },
  "permission_suggestions": [
    {
      "type": "addRules",
      "rules": [
        {
          "toolName": "mcp__dcterminal__submit_result"
        }
      ],
      "behavior": "allow",
      "destination": "localSettings"
    }
  ],
  "mcp_server": {
    "name": "dcterminal",
    "source": "dynamic"
  }
}
```
MCP `initialize` params from Claude Code:
```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": {
    "roots": {
      "listChanged": true
    },
    "elicitation": {
      "form": {},
      "url": {}
    }
  },
  "clientInfo": {
    "name": "claude-code",
    "title": "Claude Code",
    "version": "2.1.287",
    "description": "Anthropic's agentic coding tool",
    "websiteUrl": "https://claude.com/claude-code"
  }
}
```
The MCP `tools/call` params:
```json
{
  "name": "submit_result",
  "arguments": {
    "verdict": "APPROVED"
  },
  "_meta": {
    "claudecode/toolUseId": "toolu_01NYZPbvjzSx4KVUwS79vuz4",
    "progressToken": 2
  }
}
```

### T6: MCP in plan mode (t5.py t6a/t6b)
- **t6a** (`--permission-mode plan`, no allowedTools): prompted.
- **t6b** (`--permission-mode plan --allowedTools mcp__dcterminal__submit_result`): **still prompted** (the same dialog). PermissionRequest (no `permission_suggestions` in plan mode):
```json
{
  "session_id": "a355b7b7-ec04-4055-a0f9-a13ac5e7ad35",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/a355b7b7-ec04-4055-a0f9-a13ac5e7ad35.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "d25d8292-6b7d-4a4d-be2f-00786ef8ba13",
  "permission_mode": "plan",
  "hook_event_name": "PermissionRequest",
  "tool_name": "mcp__dcterminal__submit_result",
  "tool_input": {
    "verdict": "APPROVED"
  },
  "mcp_server": {
    "name": "dcterminal",
    "source": "dynamic"
  }
}
```
- **t7** (plan mode plus a PreToolUse hook matcher `mcp__dcterminal__submit_result` returning `permissionDecision:"allow"`): the tool ran with no prompt, followed by "DONE" and Stop.

### T7: ExitPlanMode capture (t7.py)
`--permission-mode plan`, with a PreToolUse hook (matcher `ExitPlanMode`) returning `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Plan received by DCTerminal. Stop here."}}`. Sequence:
1. Write (plan file under `~/.claude-account1/plans/`, allowed in plan mode)
2. ToolSearch `select:ExitPlanMode`
3. PreToolUse(ExitPlanMode), which was denied. The TUI showed "Error: PreToolUse:ExitPlanMode hook error: Plan received by DCTerminal. Stop here."
4. The model wrote a short summary of the plan.
5. Stop

There was no approval dialog, and the repo was unchanged (no CHANGELOG.md). Hook payload:
```json
{
  "session_id": "b81c0b86-03a5-41cd-b447-b537777694a0",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/b81c0b86-03a5-41cd-b447-b537777694a0.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "849af5b3-40c4-4f3d-983b-501e57d851fe",
  "permission_mode": "plan",
  "hook_event_name": "PreToolUse",
  "tool_name": "ExitPlanMode",
  "tool_input": {
    "plan": "# Plan: Add CHANGELOG.md\n\n## Context\nThe repo has a single commit (`8ce4933 init`) and no changelog. Add one at the repo root so future changes have a home.\n\n- Create `CHANGELOG.md` at the repo root in Keep a Changelog format: a short header, an `## [Unreleased]` section, and an `## [Initial]` entry (dated from commit `8ce4933`) summarizing the init contents.\n- Seed the entries by reading `git log` and the top-level files, so the initial entry reflects what is actually in the repo.\n- Verify by viewing the rendered file and `git status` (only `CHANGELOG.md` is new), then commit it only if the user asks.\n",
    "planFilePath": "~/.claude-account1/plans/call-the-submit-result-tool-tidy-aho.md"
  },
  "tool_use_id": "toolu_011FHMuWrDADYhZomjN1rZk4"
}
```
Stop after the deny:
```json
{
  "session_id": "b81c0b86-03a5-41cd-b447-b537777694a0",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/b81c0b86-03a5-41cd-b447-b537777694a0.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "849af5b3-40c4-4f3d-983b-501e57d851fe",
  "permission_mode": "plan",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "The plan is written, and DCTerminal received it. I haven't created `CHANGELOG.md` yet.\n\n- Create `CHANGELOG.md` at the repo root in Keep a Changelog format. It gets a short header, an `## [Unreleased]` section, and an initial entry dated from commit `8ce4933`.\n- Fill the initial entry from `git log` and the top-level files, so it matches what's in the repo.\n- Check that only `CHANGELOG.md` is new in `git status`. I'll commit it only if you ask.",
  "background_tasks": [],
  "session_crons": []
}
```
Note: `ExitPlanMode` is also a deferred tool here (reached through ToolSearch).

### T8: Notification (t4.py, t4b.py)
permission_prompt (about 6 s after the dialog appeared; PermissionRequest had fired at dialog time):
```json
{
  "session_id": "367d391a-7bcb-4aa0-b707-3007b5205ec2",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/367d391a-7bcb-4aa0-b707-3007b5205ec2.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "2ef48a32-1b88-4b3f-9f20-2f27c7abee52",
  "hook_event_name": "Notification",
  "message": "Claude needs your permission",
  "notification_type": "permission_prompt"
}
```
The matching PermissionRequest (Write tool):
```json
{
  "session_id": "367d391a-7bcb-4aa0-b707-3007b5205ec2",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/367d391a-7bcb-4aa0-b707-3007b5205ec2.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "2ef48a32-1b88-4b3f-9f20-2f27c7abee52",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "tools/claude-hooks-probe/repo/hello.txt",
    "content": "hi"
  },
  "permission_suggestions": [
    {
      "type": "setMode",
      "mode": "acceptEdits",
      "destination": "session"
    }
  ]
}
```
idle_prompt (60.4 s after Stop):
```json
{
  "session_id": "9ba37b29-e20d-4fd5-99ab-9f9948b5fa0e",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/9ba37b29-e20d-4fd5-99ab-9f9948b5fa0e.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "164d19a5-bdce-4068-b8d3-7219a843fa23",
  "hook_event_name": "Notification",
  "message": "Claude is waiting for your input",
  "notification_type": "idle_prompt"
}
```
No idle notification fired while the input box held text after an interrupt (t4, 75 s wait). The idle timer seems to start only after a completed turn.

### T9: statusLine (`statusline.py`, used in t3)
`"statusLine":{"type":"command","command":"<abs>/statusline.py"}` in inline `--settings` works: the script's output "V0-STATUS ok" was rendered. Field names: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `session_name`, `model{id,display_name}`, `workspace{current_dir,project_dir,added_dirs}`, `version`, `output_style`, `cost{total_cost_usd,total_duration_ms,total_api_duration_ms,total_lines_added,total_lines_removed}`, `context_window{total_input_tokens,total_output_tokens,context_window_size,current_usage{...},used_percentage,remaining_percentage}`, `exceeds_200k_tokens`, `prompt_cache{...}`, `fast_mode`, `thinking`, **`rate_limits{five_hour{used_percentage,resets_at},seven_day{used_percentage,resets_at}}`** (`resets_at` = unix seconds). The first render, before any API call, had no `prompt_id`, `session_name`, `prompt_cache` or `rate_limits`. Last capture:
```json
{
  "session_id": "685dd464-eabf-4e4c-9f6f-ac02c63aad27",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/685dd464-eabf-4e4c-9f6f-ac02c63aad27.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "b2bfdedd-2616-42a2-afaa-afbada43b0ad",
  "session_name": "OK confirmation",
  "model": {
    "id": "claude-haiku-4-5-20251001",
    "display_name": "Haiku 4.5"
  },
  "workspace": {
    "current_dir": "tools/claude-hooks-probe/repo",
    "project_dir": "tools/claude-hooks-probe/repo",
    "added_dirs": []
  },
  "version": "2.1.287",
  "output_style": {
    "name": "default"
  },
  "cost": {
    "total_cost_usd": 0.052054,
    "total_duration_ms": 28536,
    "total_api_duration_ms": 23297,
    "total_lines_added": 0,
    "total_lines_removed": 0
  },
  "context_window": {
    "total_input_tokens": 37037,
    "total_output_tokens": 79,
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 8,
      "output_tokens": 79,
      "cache_creation_input_tokens": 155,
      "cache_read_input_tokens": 36874
    },
    "used_percentage": 19,
    "remaining_percentage": 81
  },
  "exceeds_200k_tokens": false,
  "prompt_cache": {
    "warm": true,
    "caching_observed": true,
    "ttl": "1h",
    "expires_at": 1792266004,
    "requests": 6,
    "misses": 0,
    "expected_rebuilds": 0,
    "hit_ratio": 0.9695050916217809,
    "cache_write_tokens": 6617,
    "miss_recache_tokens": 0,
    "last_miss_at": null,
    "last_miss_cause": null,
    "miss_causes": {},
    "recache_tokens_if_cold": 37037
  },
  "fast_mode": false,
  "thinking": {
    "enabled": true
  },
  "rate_limits": {
    "five_hour": {
      "used_percentage": 19,
      "resets_at": 1792264200
    },
    "seven_day": {
      "used_percentage": 17,
      "resets_at": 1792580400
    }
  }
}
```

### T10: hook latency
These are local spawn costs (20 runs each, a Stop-sized payload on stdin):

| Command | Median | p90 |
|---|---|---|
| `python3 hook.py` | 84 ms | 120 ms |
| `sh -c 'cat >/dev/null'` | 25 ms | 33 ms |
| `/usr/bin/true` | 7 ms | 11 ms |

In a session, the PreToolUse-hook to PostToolUse-hook wall gap for fast tools was 27–48 ms (this includes the tool itself, 0–13 ms). The TUI shows "running Stop hook" for under 1 s. The cost of the real `dcterminal bridge` is deferred until the binary exists.

### T11: SIGTERM and resume (t11.py)
1. `--session-id 8842c7f4-246a-4549-93e1-600d7730599b`, one turn ("OK"), then SIGTERM. The process exited in 0.57 s with code 143.
2. The `.jsonl` at `~/.claude-account1/projects/-private-tmp-claude-501--Users-...-scratchpad-v0-repo/<uuid>.jsonl` had 35 lines, including the user message, the assistant "OK", `system/stop_hook_summary`, `system/turn_duration` and `cost-state`, so it was complete.
3. SessionEnd fired on SIGTERM:
```json
{
  "session_id": "8842c7f4-246a-4549-93e1-600d7730599b",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/8842c7f4-246a-4549-93e1-600d7730599b.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "prompt_id": "52ba43f2-8d75-4062-83c0-334acf095779",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```
4. `claude --model haiku --resume <uuid> --settings ... "Reply with exactly: RESUMED"`. The turn auto-started with no dialog, and Stop came 2.5 s after launch with `last_assistant_message:"RESUMED"`. The session id was unchanged, and 14 lines were appended to the **same** `.jsonl` (`sessionId` = same uuid). No new jsonl was created for this session. SessionStart on resume:
```json
{
  "session_id": "8842c7f4-246a-4549-93e1-600d7730599b",
  "transcript_path": "~/.claude-account1/projects/<project-slug>/8842c7f4-246a-4549-93e1-600d7730599b.jsonl",
  "cwd": "tools/claude-hooks-probe/repo",
  "scratchpad_dir": "<scratch>",
  "hook_event_name": "SessionStart",
  "source": "resume",
  "seconds_since_last_response": 8,
  "context_tokens": 35855,
  "prompt_cache_likely_expired": false,
  "estimated_cache_write_usd": 0.0717
}
```
