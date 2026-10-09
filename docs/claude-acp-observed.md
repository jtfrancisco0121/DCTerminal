# Claude ACP adapter: observed behaviour

This is a live capture of `@agentclientprotocol/claude-agent-acp`. It is the Claude counterpart of `docs/acp-observed.md`. Plan: Task 4.2 in `docs/CLAUDE-FIRST-PLAN.md`.

## Setup

| | |
|---|---|
| When | 2026-10-09, 14:52–14:53 (Asia/Manila) |
| Machine | JT's Mac |
| Adapter | `@agentclientprotocol/claude-agent-acp@0.88.0`, installed globally with `npm install -g --omit=optional …` and run from `/opt/homebrew/bin/claude-agent-acp` |
| Claude Code | 2.1.236, at `/opt/homebrew/bin/claude` and passed as `CLAUDE_CODE_EXECUTABLE` |
| Config | `CLAUDE_CONFIG_DIR=$HOME/.claude-account2` (JT's `claude2` account) |
| Working directory | Scratch dir `/tmp/dct-acp-capture/scratch`, not a repo |

The session was one minimal run, driven by a small Node script that speaks NDJSON over stdio:

1. `initialize`
2. `session/new`, with `_meta.claudeCode.options.allowDangerouslySkipPermissions: true`
3. `session/set_mode bypassPermissions`
4. `session/prompt "Reply with just the word OK."`
5. Close the adapter.
6. Start a second adapter process and send `session/load` for the same session id.

**Redactions:** the account email, organization name and home path are replaced with placeholders. The 63 user skills/commands in `available_commands_update` are replaced with one placeholder entry.

## Fixtures (`fixtures/acp/claude/`)

| File | What |
|------|------|
| `initialize-response.json` | `initialize` result |
| `session-new.json` | `session/new` request and result: modes and configOptions, including the model list |
| `set-mode-bypass.json` | `session/set_mode` request and result, plus the `config_option_update` that follows |
| `auth-status-update.json` | `_auth/status_update` notifications |
| `prompt-turn.json` | Everything the adapter sent during one prompt turn, ending with the prompt result |
| `session-load.json` | `session/load` request and everything the adapter sent back, ending with the result |

Tests that read these fixtures:
- `src-tauri/src/acp/claude_fixture_tests.rs`
- `src/sessionCards.test.ts`

## Answers

**Login methods and login state**
- `initialize` returns `authMethods: []`, `agentCapabilities.loadSession: true`, and `sessionCapabilities` close/delete/fork/list/resume/subagents. `agentInfo.version` is `0.88.0`.
- No `authenticate` call is needed.
- The adapter sends `_auth/status_update` as a notification (no id), not inside `session/update`. Its payload is `{ authStatus: { kind: "account", label: "Claude Team", account: { plan, email, organization } } }`. It names the account-2 login.
- DCTerminal ignores this notification for now.

**Modes (`session/new`)**
- Advertised modes:
  - `default` ("Manual")
  - `acceptEdits`
  - `plan`
  - `auto`
  - `bypassPermissions`
- So both `auto` and `bypassPermissions` are available on JT's account.
- `currentModeId` before `set_mode` is `default`.
- `session/set_mode` returns `{}` and then a `config_option_update` with the mode option's `currentValue`. There is no `current_mode_update`.

**Models (`session/new` configOptions)**
- The config options are `mode`, `model`, `effort` and `fast`.
- The `model` option has `currentValue: "opus[1m]"`.
- Model values: `default`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet`, `haiku`.
- The model ids carry `[1m]`. DCTerminal's Claude model check (`is_claude_model_id`) accepts them. The Cursor check (`valid_model_id`) does not, and it is never used for Claude.

**Does 0.88.0 work with CLI 2.1.236 via `CLAUDE_CODE_EXECUTABLE`?** Yes. The turn ended with `stopReason: end_turn`, and the text was "OK".

**Prompt-turn updates seen**
- `available_commands_update`
- `usage_update` (three times):
  - `used`/`size` and `_meta._claude/model`
  - `_meta._claude/rateLimit` = `{ status, resetsAt, rateLimitType: "five_hour", overageStatus, … }`
  - `cost` = `{ amount, currency }`
- `agent_message_chunk`, with `messageId`
- `session_info_update`, with `title` and `updatedAt`

The prompt result carries `usage` (input, output, cache read, cache write and total tokens) and `_meta.quota`.

**Does `session/load` replay the transcript?** Yes. It replays `user_message_chunk` and `agent_message_chunk` updates, then returns modes with `currentModeId: "bypassPermissions"`, so the mode survives the restart.

**Does the `session/new` `sessionId` match the transcript file name?** Yes. It equals the `<id>.jsonl` file name under `~/.claude-account2/projects/-private-tmp-dct-acp-capture-scratch/`.

**Where do the sessions land?** In `~/.claude-account2/projects` and nowhere under `~/.claude/projects`, so the adapter honours `CLAUDE_CONFIG_DIR`.

**stderr:** the adapter logs `[session/create] … phase=…` timing lines. In `bypassPermissions` it warns that `canUseTool` will not be invoked. DCTerminal's exit-error wording does not treat these lines as login failures (see the tests in `acp/connection.rs`).

## Files Claude wrote in `~/.claude-account2` during the capture

The capture was allowed to let Claude write its own files there. DCTerminal and our scripts wrote nothing to that folder. The list below comes from comparing listings before and after, and attributing each change by its time.

**Certainly from the capture**
- `projects/-private-tmp-dct-acp-capture-scratch/0c7f1846-3eb2-4a23-80f2-78d5138a78f5.jsonl` (new; the transcript)
- `projects/-private-tmp-dct-acp-capture-scratch/memory/` (new, empty)
- `session-env/0c7f1846-3eb2-4a23-80f2-78d5138a78f5/` (new, empty)

**Very likely from the capture (matching times, 14:52:57–14:53:05)**
- `backups/.claude.json.backup.<timestamp>` (new)
- `shell-snapshots/snapshot-zsh-<timestamp>-<id>.sh` (new)
- `.claude.json`, `policy-limits.json` and `remote-settings.json` (modified)
- `plugins/known_marketplaces.json` (modified)

**Not from the capture:** JT's own Claude session was running at the same time in another project. It changed `history.jsonl`, `paste-cache/…`, `sessions/*.json`, `plugins/.in_use/…` and its own project files. `history.jsonl` does not contain the capture prompt.

## Not captured yet (still to verify)

This run was deliberately minimal: one trivial prompt and no tool use. Still open:

- `session/request_permission` payloads for Bash, Edit, Write, WebFetch, an MCP tool and `ExitPlanMode`. That includes where the plan markdown sits in `ExitPlanMode`. DCTerminal currently looks for `toolCall.kind: "switch_mode"`, a title containing "Ready to code"/"ExitPlanMode", or `rawInput.plan`. **Unverified on a live Mac run** (this VM cannot log in). The plan card reads `rawInput.plan` (string or JSON), then the tool content, then the title, and answers the reject option.
- `usage_update._meta["_claude/rateLimit"]` utilization. The captured `prompt-turn.json` has `five_hour` status and `resetsAt` but no utilization, so the status bar omits the percent until the adapter sends one.
- Which requests still arrive in `auto`, `plan` and `bypassPermissions`. In `bypassPermissions` the adapter says `canUseTool` is never called, so expect none.
- `plan`, `tool_call`, `tool_call_update` and `current_mode_update` updates during a real turn.
- Whether the adapter reads `permissions.*` from `<configDir>/settings.json`.
- The logged-out path: what `_auth/status_update` with `kind: "none"` looks like, and the error text from `session/new`.
- Whether `ANTHROPIC_API_KEY` takes precedence over the subscription login.

To capture these, follow `docs/permission-payload-capture.md`: turn on **Record permission payloads**, then run Claude chat tabs in a scratch repo. DCTerminal records the payloads of auto-answered Claude requests too.
