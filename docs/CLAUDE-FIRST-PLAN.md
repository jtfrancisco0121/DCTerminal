# Claude-First Provider Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax. Tick items after each commit/push. Anything marked **(unverified)** must be confirmed by the capture/probe step named next to it before code depends on it.

**Goal:** Make DCTerminal Claude-first. Claude Code becomes the default provider for chat tabs (over ACP, through the Claude Code ACP adapter) and terminal tabs (interactive `claude`), on JT's Claude subscription login. Cursor CLI stays as a second provider, picked per tab, with a default in Settings. Also fix the missing Planner → Plan Reviewer hand-off and turn the Eagle-Eye hand-off chains into a first-class, user-triggered flow for both providers.

**Architecture:** Add a `provider` layer in Rust (`src-tauri/src/provider/`) and TS (`src/provider/`). Everything that is Cursor-specific today (executable lookup, ACP spawn args, `authenticate` method, `cursor/*` extension methods, terminal flags, model list, history store, plan files, CLI permission config) moves behind a `Provider` trait / descriptor. A second implementation, `ClaudeProvider`, spawns `claude-agent-acp` for chat and `claude` for terminals, always with `CLAUDE_CONFIG_DIR` set to the configured Claude config dir so the right Claude account is used (see Claude account / config dir below). The existing ACP client, resume, plan cards, scratch pads, and hand-off code stay shared. Per-role permission rules are retired: every role on both providers runs with full permissions and any permission request is auto-approved with `allow_once` (see Decisions). The Eagle-Eye fix (new Plan Reviewer role + generic hand-off transitions) does not depend on the provider work and lands first.

**Size:** 11 phases, 32 tasks.

**Tech Stack:** Tauri 2 + React/TS, Rust (`serde_json`, existing `acp/` JSON-RPC client, `portable-pty`), xterm.js, Vitest, `cargo test`. External: Claude Code CLI (`claude`, Homebrew cask on JT's Mac, 2.1.236), `@agentclientprotocol/claude-agent-acp` 0.88.0 (installed globally by JT, not a DCTerminal npm dependency), Cursor CLI `agent` (unchanged).

## Global Constraints

- Base: current `master` (`79b11e7`, merge of PR #14 `feat/feature-roadmap-implementation`).
- No CI / GitHub Actions.
- **Never write to the Claude config dir (`providers.claude.configDir`, e.g. `~/.claude-account2`), `~/.claude`, or `~/.cursor`** (all read-only), or into user project repos. DCTerminal never creates the config dir either. This includes never answering a Claude permission request with an `allow_always` option for a tool (the adapter turns that into a rule in the project's `.claude/settings.local.json`; see Research §A).
- Keep `npm audit` at 0; tests pass on Node 22/24/26; run `npm run check` before every push.
- Main device is JT's Mac; Mac `npm run check` + install before asking him to smoke (`PATH=/opt/homebrew/bin:$PATH`).
- No cloud agents (Cursor or Claude `--cloud` / `--bg`). DCTerminal never launches `claude --cloud`, `--bg`, or `ultrareview`.
- Merge only after JT approves.
- Hand-offs are always user-triggered. Nothing auto-starts the next step.
- DCTerminal never runs `claude auth login`, `/login`, or any login flow for JT, and never reads or stores Claude credentials. It only reads `claude auth status --json` output (run with `CLAUDE_CONFIG_DIR=<configDir>`) to show "logged in / not logged in" and which account.
- **Every Claude process gets `CLAUDE_CONFIG_DIR=<configDir>`** (adapter spawn, every terminal `claude`, `claude auth status`, `claude --version`). A GUI app does not see JT's `claude2` shell alias, so without this it would use the default `~/.claude` login — the wrong account.
- Personal-use only (see Risks: subscription login through the Agent SDK).
- **Full permissions for every role** (Decision 4). Auto-answers only ever pick `allow_once`. The one request DCTerminal does not auto-answer is `ExitPlanMode` from a **Planner** tab (it becomes the plan card).

## Approved discovery (JT, 2026-10-09)

1. **Claude-first.** Cursor stays as a second provider: per-tab provider choice + default provider in Settings (default **Claude**).
2. **Claude chat tabs** use an ACP adapter for Claude Code so the existing ACP chat code (sessions, permission cards, resume, plan cards) is reused. **Terminal tabs** run `claude` the same way they run `agent`. Both use JT's Claude subscription login via Claude Code.
3. Claude versions of:
   - (a) history/resume from Claude Code sessions in the Claude config dir (`<configDir>/projects`; JT: `~/.claude-account2`), read-only;
   - (b) a model picker with Claude models (Opus, Sonnet, Haiku);
   - (c) ~~role permission rules on Claude's permission requests, plus a warning when Claude runs with permissions skipped~~ — **superseded by Decision 4 (2026-10-09):** no role rules; all roles allow everything; one full-permissions indicator instead of warnings;
   - (d) Planner → Implementer hand-off using Claude's plan mode;
   - (e) a usage/limits view for the Claude subscription, only if Claude Code exposes that data (it does, partially — see Research §C).
4. **Eagle-Eye chains**, both providers, user-triggered:
   - Eagle-Eye 1: Planner → Plan Reviewer → Implementer → PR Reviewer
   - Eagle-Eye 2: Implementer → PR Reviewer
   - Each hand-off carries the previous step's output into the next tab's form or scratch pad; the UI shows the chain position ("Eagle-Eye 1 · step 2 of 4").
   - Fix first: after the Planner finishes there is no hand-off to a Plan Reviewer (root cause below).
5. Rules: no CI; never write to the Claude config dir / `~/.claude` / `~/.cursor`; `npm audit` 0; Node 22/24/26; `npm run check` before every push; Mac is main; no cloud agents; merge only with JT's approval.

## Claude account / config dir (JT requirement, 2026-10-09)

JT runs Claude Code as `claude2`, a zsh alias for `CLAUDE_CONFIG_DIR=$HOME/.claude-account2 claude` (his second Claude account). DCTerminal is a GUI app and does not see shell aliases, so spawning plain `claude` / `claude-agent-acp` would use the default `~/.claude` login (wrong account) and history would be read from `~/.claude/projects` (wrong folder). Rules:

- **Setting:** `providers.claude.configDir` (string path, `~` expanded). JT's value: `~/.claude-account2`. When unset, fall back to `~/.claude`.
- **Env override:** `DCT_CLAUDE_CONFIG_DIR` wins over the setting (Settings shows "set by DCT_CLAUDE_CONFIG_DIR" and greys out the field). An inherited `CLAUDE_CONFIG_DIR` in DCTerminal's own env is ignored and overwritten, so the resolved value is the only one used. Precedence: `DCT_CLAUDE_CONFIG_DIR` → `providers.claude.configDir` → `~/.claude`.
- **Spawns:** pass `CLAUDE_CONFIG_DIR=<configDir>` in the env of the adapter spawn (the adapter's SDK passes it to the `claude` it runs) and of every terminal `claude` spawn (role terminals, plain Claude Code tile, `claude --resume`).
- **History / plans:** read sessions, plans, and history from `<configDir>/projects` (and `<configDir>/plans` if it ever exists). Read-only; never write there.
- **Auth status:** `claude auth status --json` runs with the same env, so "signed in as …" is the account DCTerminal will actually use.
- **Indicator:** Settings > Providers and the status bar / tab tooltip show the config folder plus the logged-in account (e.g. "Claude · ~/.claude-account2 · jt@…"), so JT can tell at a glance he is on the right Claude account.
- **Missing folder:** if the resolved dir does not exist, show "Claude config folder not found: <path>" in Settings and on Start; never create it.
- The resolved config dir is captured when a Claude session starts and saved with the tab's `sessions.claude` id; if it later differs (JT switched accounts), the tab starts a fresh Claude session instead of resuming an id from the other account.

## Decisions (resolved 2026-10-09)

JT resolved the four open decisions on 2026-10-09:

1. **General role under Claude → `auto` mode** (not `plan`, not Manual/`default`). Permission requests that still reach DCTerminal in `auto` are auto-approved with `allow_once`.
2. **Plan Reviewer can run everything** (full shell, edits, MCP, web — not read-only). Its role prompt still says "review, don't implement", but permissions are not restricted. On Cursor it uses the full-access flags (`--yolo`).
3. **Existing / restored tabs migrate to Claude.** Tabs and saved workspaces without a saved provider become `claude` in a one-time migration (Task 6.3). A Cursor session id cannot resume under Claude, so a migrated tab starts a **fresh Claude session**; its old Cursor session id is kept per provider, so switching that tab back to Cursor resumes / shows the old Cursor history. Cursor stays a selectable provider per tab and in Settings.
4. **No per-role permission rules.** All roles allow everything on both providers. Claude: `bypassPermissions` mode where the role has no natural mode, otherwise the role's mode with every `session/request_permission` auto-approved. Auto-answers pick the `allow_once` option, **never `allow_always`** (that writes a rule to the user's project `.claude/settings.local.json`) and never `reject_*`. The role rule engine and the "role rules are off" / bypass warnings are removed (Phase 7 rewritten); a single indicator shows that tabs run with full permissions. Cursor side is already consistent: JT's global Cursor `approvalMode` is `"unrestricted"`.

### Per-role modes (both providers)

| Role | Claude chat (`session/set_mode`) | Claude terminal | Permission requests (chat) | Cursor chat / terminal |
|------|----------------------------------|-----------------|----------------------------|------------------------|
| General | `auto` | `--permission-mode auto` | auto-approve `allow_once` | `agent` / `--yolo` |
| Planner | `plan` (plan hand-off needs it) | `--permission-mode plan` | auto-approve `allow_once`, **except `ExitPlanMode` → plan card** (never auto-answered) | `plan` / `--plan` |
| Plan Reviewer | `bypassPermissions` | `--permission-mode bypassPermissions` | auto-approve `allow_once` | `agent` / `--yolo` |
| Implementer | `bypassPermissions` | `--permission-mode bypassPermissions` | auto-approve `allow_once` | `agent` / `--yolo` |
| Developer | `bypassPermissions` | `--permission-mode bypassPermissions` | auto-approve `allow_once` | `agent` / `--yolo` |
| PR Reviewer | `bypassPermissions` | `--permission-mode bypassPermissions` | auto-approve `allow_once` | `agent` / `--yolo` |
| Codebase Audit | `bypassPermissions` | `--permission-mode bypassPermissions` | auto-approve `allow_once` | `agent` / `--yolo` |
| Recommendation | `bypassPermissions` | `--permission-mode bypassPermissions` | auto-approve `allow_once` | `agent` / `--yolo` |
| Custom roles | `bypassPermissions` | `--permission-mode bypassPermissions` | auto-approve `allow_once` | `agent` / `--yolo` |

Rules that go with the table:

- `ExitPlanMode` outside a Planner tab (Claude entered plan mode on its own via `EnterPlanMode`, which is auto-approved): auto-answer the `allow_once` option ("Yes, manually approve edits"), then re-send `session/set_mode <role mode>` so the tab returns to its mode from the table.
- **Fallbacks.** If the adapter does not advertise `bypassPermissions` (process runs as root, or `permissions.disableBypassPermissionsMode: "disable"` in managed / user settings) or does not advertise `auto` for JT's account **(unverified — Task 4.2)**: chat uses `default` with every request auto-approved `allow_once` (same outcome); terminal uses `--permission-mode acceptEdits` and the indicator says "full permissions unavailable — Claude may prompt in the terminal".
- Claude `auto` mode may still refuse an action on its own (its classifier). That is Claude's behavior, accepted for General.
- Deny rules in JT's own `<configDir>/settings.json` (JT: `~/.claude-account2/settings.json`) still apply in every mode; DCTerminal never edits them.
- The Settings Run-mode override (Run Everything / Plan / Ask / Auto-review) no longer changes Claude flags; it stays for Cursor terminals only (Phase 3/7).

## Eagle-Eye root cause (Planner → Plan Reviewer)

There is no Plan Reviewer anywhere in the app, so the Planner can only hand off to Implementer, Developer, or **PR Reviewer**:

| # | Finding | Location |
|---|---------|----------|
| 1 | No Plan Reviewer role is seeded. The seed list is exactly Planner, Implementer, PR Reviewer, Developer, General, Recommendation, Codebase Audit. There is no `docs/roles/role-plan-reviewer.md` either. | `src-tauri/src/template/seed_defs.rs:14-24` (`all_role_specs`), specs at `:48`, `:118`, `:179`, `:221`, `:233`, `:245`, `:257`; `docs/roles/` |
| 2 | Hand-off targets are a hard-coded tuple of three role ids; the type `HandoffTargetId` cannot name any other role. | `src/handoff/map.ts:19-20` (`HANDOFF_TARGETS = ["role_implementer", "role_developer", "role_pr_reviewer"]`) |
| 3 | The dialog's target list and the "Send to …" buttons are hard-coded to the same three. | `src/components/HandoffDialog.tsx:16-20` (`TARGETS`), `:166-182` (`ACTION_BUTTONS`) |
| 4 | The Planner's offer is hard-coded to those three; the Implementer's to PR Reviewer only. | `src/StartupForm.tsx:2540-2559` (`handoffOffer`) |
| 5 | A **terminal** Planner's right-click menu only has Implementer and Developer. | `src/StartupForm.tsx:3830-3848` (`menuActions`) |
| 6 | The palette command named `sendPlanReviewer` is "Hand off plan to **PR** Reviewer…", i.e. the Planner's plan goes straight to code review of a PR that does not exist yet. | `src/tabChrome.ts:424-427`, handler `src/StartupForm.tsx:2703-2704` |
| 7 | Only Planner and Implementer can be a hand-off source; any other role gets "Send a plan from a Planner tab." So even a hand-made "Plan Reviewer" custom role could not hand forward to Implementer. | `src/handoff/map.ts:151-163` (`handoffBlockReason`), `:137-143` (`handoffFromRole`) |
| 8 | Implementer → PR Reviewer carries only the Implementer's own form (title, description, approved plan, context) — no implementation summary, diff, or PR link. | `src/handoff/map.ts:372-407` (`mapImplementerToReviewer`) |
| 9 | The "pipeline workspace" preset opens Planner / Implementer / PR Reviewer only. | `src-tauri/src/commands/app_state.rs:145-149` (`PIPELINE_ROLE_IDS`), notice at `src/StartupForm.tsx:2749` |

**Summary:** the hand-off graph was built as "Planner → {Implementer, Developer, PR Reviewer}" plus "Implementer → PR Reviewer", with the targets hard-coded in four places and no Plan Reviewer role seeded, so step 2 of Eagle-Eye 1 has nothing to hand to. Fix = seed a Plan Reviewer role and replace the hard-coded lists with one transition table (Phase 1).

## Research findings

### A. Claude Code ACP adapter

| Item | Finding | Source |
|------|---------|--------|
| Package | **`@agentclientprotocol/claude-agent-acp`**, bin `claude-agent-acp`. The old names `@zed-industries/claude-code-acp` (last 0.16.2) and `@zed-industries/claude-agent-acp` (last 0.23.1) are deprecated on npm: "renamed to @agentclientprotocol/claude-agent-acp". GitHub `zed-industries/claude-code-acp` redirects to `agentclientprotocol/claude-agent-acp`. | `npm view` (2026-10-09); https://github.com/agentclientprotocol/claude-agent-acp |
| Version | **0.88.0** (published 2026-10-08 20:19 PHT); `0.88.1-preview.1` exists. Releases near-daily (0.86.x → 0.88.0 in 3 days). Pin an exact version. | https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp |
| License | Apache-2.0 | npm / repo |
| Maintenance | Active: last push 2026-10-09 03:43 PHT, 2.6k stars, 132 open issues, not archived. | `gh api repos/agentclientprotocol/claude-agent-acp` |
| Engine / size | `node >= 22`. Deps: `@agentclientprotocol/sdk` 1.7.0, `@anthropic-ai/claude-agent-sdk` 0.3.293, `zod`, `diff`. A default install is **~540 MB** because the SDK pulls a platform `claude` binary as an optional dep (~240 MB per platform). | scratch install `/tmp/cacp` |
| npm audit | **0 vulnerabilities** (108 packages, 0.88.0, scratch dir on the box, 2026-10-09). Not a DCTerminal dependency, so DCTerminal's own audit is unaffected. | `npm audit` |
| Which `claude` it runs | `CLAUDE_CODE_EXECUTABLE` env if set, otherwise the SDK's bundled binary; the error text says to "set CLAUDE_CODE_EXECUTABLE" when the optional binary is missing. Plan: install with `--omit=optional` and set `CLAUDE_CODE_EXECUTABLE` to the detected `claude` **(unverified that 0.88.0 + JT's CLI 2.1.236 work together — capture step 4.2)**. | `dist/acp-agent.js:645-679` |
| Auth | Uses Claude Code's own login (claude.ai subscription or Console) through the spawned `claude`. **No `ANTHROPIC_API_KEY` needed.** `authMethods` are terminal-login methods (`claude-ai-login` → `claude auth login --claudeai`, `console-login`, or `claude-login` when remote) and are only advertised when the client declares terminal-auth support. It pushes `_auth/status_update` (`kind`, `label`) on its own. DCTerminal must **not** call `authenticate` with Cursor's `cursor_login` for this provider. | `dist/acp-agent.js:1290-1356`, `dist/auth-status.js` |
| ACP methods | `initialize`, `authenticate`, `logout`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/fork`, `session/close`, `session/delete`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_config_option`, `providers/*`. `agentCapabilities.loadSession: true`. **No `session/set_model` handler** — the model is a config option (`set_config_option`), which DCTerminal already tries first (`acp/session_connect.rs:116-122`). | `dist/acp-agent.js:1358-1400`, `:8971+` |
| Modes | `default` ("Manual"), `acceptEdits`, `plan`, `auto`, plus `bypassPermissions` only when allowed. Bypass is offered unless the process is root, `permissions.disableBypassPermissionsMode` is `"disable"`, or the client sends `_meta.claudeCode.options.allowDangerouslySkipPermissions: false` on `session/new`. Initial mode comes from settings `permissions.defaultMode` (accepts `manual` as alias of `default`). | `dist/session-mode.js:200-275`, `dist/permissions/modes.js`, `dist/acp-agent.js:7110-7120` |
| Permission requests | Standard `session/request_permission` with option `kind`s `allow_once` / `allow_always` / `reject_once` / `reject_always`. Tool-specific option builders for Bash, Read, Edit, Write, WebFetch, MCP (`mcp__*`), Skill, Enter/ExitPlanMode. "Always" options for tools write a rule to `localSettings` (the project's `.claude/settings.local.json`). DCTerminal's policy already picks `kind == "allow_once"` (`permissions/policy.rs:193-212`) — keep that picker (it becomes the whole policy, Task 7.1) and never pick `allow_always` for tools. | `dist/permissions/options.js`, `dist/permissions/effects.js:40` |
| Plan mode | Leaving plan mode is an `ExitPlanMode` permission request titled **"Ready to code?"**. Options: "Yes, manually approve edits" (`allow_once`), "Yes, auto-accept edits", "Yes, and use auto mode", "Yes, and bypass permissions" (if allowed), "Yes, clear context and …" variants (all `allow_always` → session mode change, not a file write), and reject = "No, keep planning" (turn ends cancelled). Plan steps also arrive as standard `session/update` `sessionUpdate: "plan"` entries. Where the plan markdown sits inside the request (`rawInput.plan`?) is **(unverified — capture step 4.2)**. | `dist/permissions/options/tools.js:40-110`, `dist/permissions/presentation.js:49`, `dist/exit-plan.js`, `dist/acp-agent.js:2240` |
| Usage | `session/update` `usage_update` (context `used` / `size`) and, on each SDK `rate_limit_event`, a `usage_update` carrying `_meta["_claude/rateLimit"]` = `{status, resetsAt, rateLimitType (five_hour / seven_day / seven_day_opus / seven_day_sonnet / overage…), utilization, …}`. A `/usage` prompt is rendered from an SDK method literally named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. | `dist/acp-agent.js:5202-5214`, `:135-165`; `claude-agent-sdk/sdk.d.ts:5664-5700` |
| Extras to ignore | `_auth/status_update`, `_session/steering`, AIR/JetBrains `_meta` extensions, `available_commands_update`. DCTerminal must ignore unknown notifications (it already cancels unknown `cursor/*` requests; generalize to "unknown extension → ignore / cancel"). | README |

### B. Claude Code CLI facts (JT's Mac, read-only checks)

- **Installed:** yes. `which claude` → `/opt/homebrew/bin/claude` → `/opt/homebrew/Caskroom/claude-code/2.1.236/claude`. `claude --version` → `2.1.236 (Claude Code)`. Node on the Mac: v26.3.1. Cursor `agent` 2026.10.01 is also present (`~/.local/bin/agent`). The ACP adapter is **not** installed (`claude-agent-acp` not on PATH, not in `npm ls -g`).
- **Config dir note:** the `~/.claude` observations below are from the default folder. JT's working account is `~/.claude-account2` (via `CLAUDE_CONFIG_DIR`); its layout is assumed to match **(unverified — check read-only in Task 2.3)**.
- `~/.claude` contains: `backups cache daemon history.jsonl ide jobs plugins policy-limits.json projects remote-settings.json sessions settings.json settings.local.json skills`. `~/.claude/settings.json` keys: `permissions`, `model`, `effortLevel`, `theme`; `permissions` has **no `defaultMode`** and no `disableBypassPermissionsMode` (so sessions start in Manual). `~/.claude/plans` does not exist.
- **Flags (from `claude --help`, 2.1.236):** `--model <model>` (alias like `fable`, `opus`, `sonnet` or a full name like `claude-fable-5`); `--permission-mode <mode>` with choices `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`; `--dangerously-skip-permissions`; `--allow-dangerously-skip-permissions` (makes bypass available without enabling it); `-c, --continue`; `-r, --resume [id]`; `--fork-session`; `--session-id <uuid>`; `-n, --name <name>`; `--settings <file-or-json>`; `--setting-sources`; `--allowedTools` / `--disallowedTools`; `--effort low|medium|high|xhigh|max`; `--add-dir`; positional `[prompt]` starts an interactive session with that prompt. Subcommands include `auth status [--json|--text]`, `doctor`, `agents`, `mcp`, `update`, `ultrareview` (cloud — never used).
- **Permission mode precedence** (docs): `--permission-mode` / `--dangerously-skip-permissions` first, then `permissions.defaultMode` in a settings file. `"auto"` or `"bypassPermissions"` in a project's `.claude/settings.json` / `.claude/settings.local.json` do not take effect; in `~/.claude/settings.json` (or managed settings) they do. Deny rules apply in every mode. https://code.claude.com/docs/en/permission-modes, https://code.claude.com/docs/en/settings
- **Session storage (observed):** `~/.claude/projects/<encoded cwd>/<session uuid>.jsonl`, where the folder name is the absolute path with `/` replaced by `-` (e.g. `-Users-jtfrancisco-Documents-Projects-better-agentic-ide`). How other characters (`.`, `_`, spaces) are encoded is **(unverified)** — match on the `cwd` field inside records instead of decoding folder names. Record `type`s seen: `user`, `assistant`, `attachment`, `system`, `queue-operation`, `custom-title` (`customTitle`), `ai-title` (`aiTitle`), `last-prompt`. `user`/`assistant` records carry `cwd`, `gitBranch`, `sessionId`, `timestamp`, `uuid`, `parentUuid`, `version`, `entrypoint`, `isSidechain`, `permissionMode` (user). `assistant.message.usage` has `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `service_tier`, etc.; `message.model` seen: `claude-opus-4-8`. `~/.claude/sessions` is empty on the Mac. `~/.claude/history.jsonl` is prompt history (not needed).
- **Models** (docs, https://code.claude.com/docs/en/model-config): aliases `default`, `best`, `fable`, `opus`, `sonnet`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`. On the Anthropic API they currently resolve to Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.1, but **Opus 5.5 needs CLI ≥ 2.1.280, Sonnet 5.5 ≥ 2.1.284, Haiku 5.5 ≥ 2.1.293** — JT's 2.1.236 is older, so aliases resolve to older models there. Fable usage may bill to usage credits (consent prompt in interactive CLI; in SDK apps that don't show the prompt it bills without asking). `/model` in the CLI writes `model` to `~/.claude/settings.json` — DCTerminal must use `--model` / `set_config_option` (session-only), never `/model`.
- Sessions resumed with `--resume` keep the model saved in the transcript unless `--model` is given.

### C. Usage / limits

- **Claude Code exposes it.** `/usage` (interactive) shows plan usage; the status line JSON has `rate_limits.five_hour` / `seven_day` with `used_percentage` and `resets_at` for Pro/Max after the first API response (https://code.claude.com/docs/en/statusline, https://code.claude.com/docs/en/costs). The Agent SDK emits `rate_limit_event` with `utilization`, `resetsAt`, `rateLimitType`, `status`, and the adapter forwards it as `usage_update._meta["_claude/rateLimit"]` (Research §A).
- **Feasible read-only view:** passive. Every Claude chat tab already receives these notifications; DCTerminal keeps the **last known** value per window (5-hour, 7-day, per-model weekly when sent) with its reset time, plus per-tab context usage (`used`/`size`). Shown in the status bar and a small Settings > Usage panel. Optional: per-session token totals from the jsonl `message.usage` fields in the history list.
- **What it can't show:** nothing before a Claude chat tab has made its first request in this app run (it is pushed, not polled); terminal tabs (the interactive `claude` keeps it in-process; the status-line route needs a `statusLine` setting — writing `~/.claude/settings.json` is forbidden, and `--settings '{"statusLine":…}'` per launch is **(unverified)** and would override JT's own status line, so it is out of scope); exact plan limits in tokens or messages (only percentages); spend in dollars on a subscription. The `/usage` structured API is explicitly experimental, so DCTerminal does not call it.
- **Conflict to confirm:** PROGRESS.md "Locked product decisions (2026-10-06)" says "No token tracking." JT's 2026-10-09 approval of (e) is read here as "limits view yes, no token accounting." Phase 10 therefore ships only the limits + context bar; the optional jsonl token totals stay off unless JT says yes.

### D. Policy note on subscription login through the Agent SDK

Anthropic's docs say third-party developers may not offer claude.ai login or route requests through Free/Pro/Max credentials **for their users** in Agent SDK products; individual use of your own subscription and signing in to the unmodified `claude` binary is allowed (https://code.claude.com/docs/en/legal-and-compliance, https://code.claude.com/docs/en/agent-sdk/overview). DCTerminal is JT's private tool: it never handles credentials, never offers a login, and the adapter drives JT's own `claude` login. Keep it that way; this plan does not distribute the app. Terminal tabs (plain `claude`) are clearly fine. Listed under Risks.

## Provider abstraction design

### Where provider-specific code lives today

| Concern | Today (Cursor-only) | Becomes |
|---------|---------------------|---------|
| Executable lookup, version, login status | `src-tauri/src/cli_detect.rs` (`resolve_agent_executable` :15, `agent_login_status` :324 via `agent status --format json`) | `Provider::detect()` / `login_status()`; Cursor impl keeps this code, Claude impl resolves the config dir, `claude` + `claude-agent-acp`, runs `claude --version` and `claude auth status --json` with `CLAUDE_CONFIG_DIR=<configDir>` (read-only) |
| ACP spawn args | `acp/ndjson.rs:115` (`acp_launch_args` = `["acp"]`), `acp/client.rs:29` (`--model` spawn flag) | `Provider::acp_command(model) -> ProgramArgs + env` (Claude: `claude-agent-acp`, env `CLAUDE_CODE_EXECUTABLE` + `CLAUDE_CONFIG_DIR`) |
| Handshake | `acp/session_connect.rs:137-230` (always `authenticate {methodId:"cursor_login"}`, then `session/set_mode`) | `Provider::auth_step()` (Cursor: `cursor_login`; Claude: none — only report `_auth/status_update` / errors) and `Provider::session_new_meta()` (Claude: `_meta.claudeCode.options.allowDangerouslySkipPermissions=true`, so `bypassPermissions` is offered — Decision 4) |
| Mode ids | `mode_id` "agent"/"plan"/"ask" in role snapshots (`store/state_store.rs`, `commands/dev_session.rs:202`) | `Provider::mode_for_role(role, available_modes)` per the per-role mode table (Claude: `auto` / `plan` / `bypassPermissions`, fallback `default`; Cursor: `agent` / `plan`) |
| Extension methods | `cursor/create_plan`, `cursor/ask_question`, `cursor/update_todos`, `cursor/task` (`acp/connection.rs:241-252`, `acp/request_handler.rs:13-25`, `acp/session_update.rs:24`, `commands/prompt_worker.rs:93-103`) | `Provider::classify_request(method)` → `Permission | Plan | Question | Unknown`; Claude: `session/request_permission` with `ExitPlanMode` = Plan |
| Terminal command line | `pty/launch.rs` (`role_terminal_flags` :63, `with_model` :82, `plain_agent_args`, `deliver_prompt`), `pty/mod.rs:248,378,468,497` (`resolve_agent_executable`) | `Provider::terminal_command(role, mode, model, prompt, resume)` → argv **+ env** (Claude: `CLAUDE_CONFIG_DIR`) |
| Resume args | `cli_launch.rs:12-25` (`agent --resume <id>`) | `Provider::resume_terminal_args(id)` (Claude: `--resume <id>`) |
| Model list / default | `models.rs` (`DEFAULT_MODEL_ID = "composer-2.5"` :20, `agent --list-models` :285, `static_fallback` :172), `store/settings_store.rs` `ModelSettings` | per-provider `ModelSettings { default, per_role }`; Claude list from `session/new` config options, fallback static aliases |
| History store | `cursor_history.rs` (`~/.cursor` chats + ACP meta), `src/cursorHistory.ts`, `src/components/CursorHistoryList.tsx` | `Provider::list_history(folder)`; new `claude_history.rs` reading `<configDir>/projects` |
| Plan files (terminal Planner) | `pty/plans.rs:19` (`~/.cursor/plans`) | `Provider::plans_dir()` (Claude: none known; fall back to selection / tail) |
| CLI permission config | `permissions/cli_config.rs` (`~/.cursor/cli-config.json` `approvalMode`, `role_rules_off`), role rule engine `permissions/policy.rs` | Retired (Decision 4): `role_rules_off` and its warning go away; `policy.rs` shrinks to "pick `allow_once`" (Task 7.1). No Claude settings parser. |
| Error text | `commands/role_session.rs:156` ("Run `agent login`"), `:389` | provider-specific messages |
| Setup | `commands/setup.rs`, `src/components/FirstRunSetup.tsx` | step per provider (Claude first) |

### Rust

```text
src-tauri/src/provider/
  mod.rs        // ProviderId { Claude, Cursor } (serde "claude" | "cursor"), trait Provider, registry
  cursor.rs     // wraps existing cli_detect / launch / cursor_history / cli_config (no behavior change)
  claude.rs     // claude + claude-agent-acp
  claude_detect.rs
```

```rust
pub trait Provider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn detect(&self) -> ProviderStatus;              // found, version, path, adapter found
    fn login_status(&self) -> LoginStatus;           // read-only CLI call
    fn acp_command(&self, model: Option<&str>) -> Result<ProgramArgs, String>; // includes env
    fn auth_step(&self) -> Option<(String, Value)>;  // Some(("authenticate", {...})) for Cursor
    fn session_new_meta(&self, opts: &SessionOpts) -> Option<Value>;
    fn mode_for_role(&self, role_id: &str, available: &[String]) -> String; // per-role mode table + fallback
    fn classify_request(&self, method: &str, params: &Value) -> AgentRequestKind;
    fn terminal_command(&self, req: &TerminalLaunch) -> Result<ProgramArgs, String>;
    fn list_history(&self, folder: &str) -> Vec<HistoryEntry>;
    fn plans_dir(&self) -> Option<PathBuf>;
    fn config_dir(&self) -> Option<ConfigDirInfo>; // Claude: resolved dir + source (env / setting / default); Cursor: None
}
```

- `TabState` / role snapshot gain `provider: Option<ProviderId>` (missing on old tabs; treated as `cursor` until the one-time migration in Task 6.3 flips them to `claude`, Decision 3) and per-provider session ids `sessions: { cursor?: String, claude?: String }` (the old single session id moves to `sessions.cursor`). New tabs take Settings default `claude`.
- `settings.json` (app data) gains `providers: { default: "claude", claude: { adapterPath?, claudePath?, configDir? }, cursor: {} }` (`configDir` unset → `~/.claude`; JT sets `~/.claude-account2`; `DCT_CLAUDE_CONFIG_DIR` overrides) (no bypass toggle: full permissions always, Decision 4) and `models` becomes per-provider (migrate old `models` into `models.cursor`).
- `AcpClient::connect*` takes `&dyn Provider`. `LiveSession` remembers the provider.

### TypeScript

```text
src/provider/
  types.ts      // ProviderId, ProviderStatus, labels ("Claude", "Cursor")
  descriptor.ts // per-provider UI facts: model default, terminal tile label, history title, warnings copy
  useProviders.ts
```

- Start card: provider chip next to the model chip (Claude / Cursor), remembered per role like Chat/Terminal; the model picker list follows the provider.
- Settings: new **Providers** section (default provider, detected paths/versions, Claude config folder + signed-in account, login status, adapter install hint, read-only line "All tabs run with full permissions"). Models section split per provider.
- `CursorHistoryList` → `HistoryList` with provider-specific loaders.
- Tab chips / header tooltip show the provider; for Claude also the config folder and account.

---

## Phase 1: Eagle-Eye fix — Plan Reviewer hand-off (provider-independent, lands first)

### Task 1.1: Seed a Plan Reviewer role

**Files:** `docs/roles/role-plan-reviewer.md` (new), `docs/roles/README.md`, `src-tauri/src/template/seed_defs.rs`, regenerated roles seed (`cargo run --bin build_roles_seed`), `src-tauri/src/permissions/policy.rs` (`canonical_role`), `src-tauri/src/pty/launch.rs` (`role_family`), `src/workspaceView.ts` (`BUILT_IN_PERMISSION_SUMMARY`), `src-tauri/src/template/merge_tests.rs`

- [x] Write `role-plan-reviewer.md`: review the proposed plan against the codebase (it may run commands, tests, and tools — Decision 2 — but does not implement), list blocking issues / risks / missing tests, and end with a **Reviewed plan** section (the approved or revised plan) plus **Review notes**. Placeholders: `[PASTE THE ORIGINAL FEATURE / BUG REQUEST HERE]`, `[PASTE THE PROPOSED IMPLEMENTATION PLAN HERE]`, `[OPTIONAL: …]`.
- [x] `plan_reviewer_spec()`: id `role_plan_reviewer`, name "Plan Reviewer", color distinct from PR Reviewer, fields `originalTask` (required), `plan` (required, multiline — matches `PLAN_FIELD_KEYS`), `additionalContext` (optional). Add to `all_role_specs()` after Planner.
- [x] Policy: Plan Reviewer = full-access family (Decision 2: allow everything). Terminal flags: Cursor `--yolo` (same as Implementer); Claude `bypassPermissions` later in Phase 3. `BUILT_IN_PERMISSION_SUMMARY`: "Full access".
- [x] Existing user role files: template merge adds the new built-in without touching edited roles (check `template/merge.rs` behavior; add a merge test).
- [x] Tests: seed has 8 roles; `evaluate_permission("role_plan_reviewer", edit)` allows (`allow_once`); Cursor terminal flags for Plan Reviewer = `--yolo --approve-mcps --trust`; merge keeps a user-edited Planner.
- [x] Commit: `feat: seed Plan Reviewer role`

### Task 1.2: One hand-off transition table

**Files:** `src/handoff/map.ts`, `src/handoff/transitions.ts` (new) + test, `src/handoff/map.test.ts`

- [x] Replace `HANDOFF_TARGETS` with `HANDOFF_TRANSITIONS: Record<sourceRoleId, targetRoleId[]>`:
  - `role_planner` → `role_plan_reviewer`, `role_implementer`, `role_developer`
  - `role_plan_reviewer` → `role_implementer`, `role_developer`, `role_planner` (send back for revision)
  - `role_implementer` → `role_pr_reviewer`
  - `role_developer` → `role_pr_reviewer`
  - `role_pr_reviewer` → `role_implementer` (fix-ups; optional, behind the same dialog)
- [x] `HandoffTargetId` becomes `string` validated against the table; `handoffFromRole` reads role names from the loaded roles, not a switch.
- [x] `handoffBlockReason` generalizes: source must have transitions; Planner / Plan Reviewer need content; Implementer / Developer need a finished turn.
- [x] Mapping: Planner → Plan Reviewer puts the plan in `plan`, the Planner's request in `originalTask`. Plan Reviewer → Implementer puts the **Reviewed plan** section (fallback: whole last message) in `approvedPlan` and the review notes in `additionalContext`.
- [x] Keep "Planner → PR Reviewer" out of the default list (it was the mislabelled path); the palette id `sendPlanReviewer` is renamed (Task 1.3).
- [x] Tests: every transition maps to the target's real field keys; Plan Reviewer is a valid source; Implementer → PR Reviewer unchanged.
- [x] Commit: `fix: hand-off transitions include Planner → Plan Reviewer`

### Task 1.3: Buttons, dialog, palette, terminal menu

**Files:** `src/components/HandoffDialog.tsx` (+ test), `src/StartupForm.tsx` (`handoffOffer` ~2540, palette cases ~2697-2707, terminal `menuActions` ~3830), `src/tabChrome.ts` (+ test), `src/components/CommandPalette.tsx`, `src/SessionTerminal.tsx` (~456), `src/components/SessionCards.tsx`

- [x] `TARGETS` / `ACTION_BUTTONS` built from the transition table and role names ("Send to Plan Reviewer").
- [x] `handoffOffer` uses `HANDOFF_TRANSITIONS[roleId]` instead of the two hard-coded branches.
- [x] Terminal Planner menu: add **Send to Plan Reviewer**; terminal Plan Reviewer gets **Send to Implementer**.
- [x] Palette: `sendPlanPlanReviewer` "Hand off plan to Plan Reviewer…"; keep `sendImplementerToReviewer`; `canSendPlan` true for Planner and Plan Reviewer.
- [x] Tests: Planner chat shows Plan Reviewer button first; terminal menu lists it; palette titles.
- [x] Commit: `feat: Send to Plan Reviewer from Planner chat, terminal, and palette`

### Task 1.4: Pipeline preset + docs

**Files:** `src-tauri/src/commands/app_state.rs` (`PIPELINE_ROLE_IDS`), `src/StartupForm.tsx` (~2749 notice), `docs/PROGRESS.md`

- [x] Pipeline workspace opens Planner, Plan Reviewer, Implementer, PR Reviewer.
- [x] PROGRESS: note the fix.
- [ ] `npm run check` (done on box and Mac); Mac smoke of Planner → Plan Reviewer → Implementer (JT, manual).
- [x] Commit: `feat: pipeline preset adds Plan Reviewer`

## Phase 2: Provider abstraction + Settings

### Task 2.1: `ProviderId` in state and settings (no behavior change)

**Files:** `src-tauri/src/provider/mod.rs` (new), `src-tauri/src/store/state_types.rs`, `src-tauri/src/store/settings_store.rs`, `src-tauri/src/store/workspace_store.rs`, `src-tauri/src/lib.rs`

- [x] `ProviderId` enum, serde lowercase. The tab / workspace field is optional; missing = legacy, resolved as `cursor` until Task 6.3 migrates it (so nothing breaks before Claude chat exists). Move the existing session id into `sessions.cursor` on load.
- [x] Settings: `providers.default` = `claude` for new and existing profiles (Decision 3), per-provider `models` (migrate old `models` → `models.cursor`).
- [x] Tests: old `state.json` / `settings.json` / `workspaces.json` fixtures load with provider missing (resolves to `cursor`) and the old id in `sessions.cursor`; new tab gets the default; round-trip.
- [x] Commit: `feat: provider id on tabs, workspaces, and settings`

### Task 2.2: Move Cursor code behind `Provider`

**Files:** `src-tauri/src/provider/cursor.rs` (new), `acp/session_connect.rs`, `acp/client.rs`, `acp/ndjson.rs`, `acp/connection.rs`, `acp/request_handler.rs`, `pty/mod.rs`, `pty/launch.rs`, `cli_launch.rs`, `commands/role_session.rs`, `commands/prompt_worker.rs`, `commands/model_session.rs`

- [x] Implement the trait for Cursor by delegating to existing functions; thread `&dyn Provider` through `AcpClient::connect*`, `handshake`, `handshake_load`, PTY launch.
- [x] `cursor/*` handling moves to `CursorProvider::classify_request`; unknown extension requests from any provider are cancelled (as today), unknown notifications ignored.
- [x] All existing Rust and Vitest tests pass unchanged (this is a refactor).
- [x] Commit: `refactor: Cursor CLI behind a Provider trait`

### Task 2.3: Claude config dir (which Claude account)

**Files:** `src-tauri/src/provider/claude_config.rs` (new), `src-tauri/src/store/settings_store.rs`, `src-tauri/src/provider/claude.rs`, `src-tauri/src/lib.rs`

- [x] Setting `providers.claude.configDir` (optional string). Resolver `resolve_claude_config_dir()` → `{ path, source: env | setting | default }`: `DCT_CLAUDE_CONFIG_DIR` → setting → `~/.claude`; expand `~`, canonicalize, report `exists`. Never create the folder.
- [x] One helper `claude_env(&ConfigDirInfo) -> Vec<(String, String)>` that sets `CLAUDE_CONFIG_DIR=<path>` (overwriting any inherited value); every Claude spawn (adapter, terminals, `claude auth status`) goes through it — no Claude `Command` is built without it.
- [ ] JT's Mac: set `configDir` to `~/.claude-account2`; confirm read-only (`ls`) that `~/.claude-account2/projects` exists and matches the `~/.claude` layout (Research §B).
- [x] Tests: precedence env > setting > default; `~` expansion; missing dir reported, not created; old `settings.json` without the key loads (resolves to `~/.claude`); `claude_env` overrides an inherited `CLAUDE_CONFIG_DIR`.
- [x] Commit: `feat: Claude config dir setting (CLAUDE_CONFIG_DIR)`

### Task 2.4: Claude detection and login status

**Files:** `src-tauri/src/provider/claude_detect.rs` (new), `src-tauri/src/provider/claude.rs`, `src-tauri/src/commands/setup.rs`, `src-tauri/src/lib.rs`

- [x] Resolve `claude`: `DCT_CLAUDE_PATH`, PATH, then known locations (`/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.local/bin/claude`, `~/.claude/local/claude`, Windows `%USERPROFILE%\.local\bin\claude.exe` — **(unverified on Windows)**). GUI apps on macOS do not inherit the shell PATH, so the known-location list matters.
- [x] Resolve `claude-agent-acp`: `DCT_CLAUDE_ACP_PATH`, PATH, npm global bin (`npm prefix -g`/bin), Homebrew `/opt/homebrew/bin`.
- [x] `claude --version`; `claude auth status --json` run with `claude_env` (`CLAUDE_CONFIG_DIR=<configDir>`, Task 2.3) and parsed for logged-in / kind / account label (email or org, display only — never stored beyond display). **(unverified JSON shape — capture it on the Mac in this task with `CLAUDE_CONFIG_DIR=~/.claude-account2` and add a fixture.)**
- [x] Tests: path resolution with fake dirs; parse fixtures for logged in / logged out; the auth-status command carries `CLAUDE_CONFIG_DIR` from the resolver.
- [x] Commit: `feat: detect Claude Code and the Claude ACP adapter`

### Task 2.5: Provider UI — Settings, Start card, first-run

**Files:** `src/provider/*` (new), `src/components/SettingsPage.tsx` (+ test), `src/StartupForm.tsx`, `src/components/RoleTiles.tsx`, `src/components/FirstRunSetup.tsx` (+ test), `src/tabChrome.ts`, `src/components/StatusBar.tsx`

- [x] Settings > **Providers**: default provider (Claude / Cursor), detected paths + versions, **Claude config folder** field (text + Browse; placeholder `~/.claude`; shows the source, and "set by DCT_CLAUDE_CONFIG_DIR" read-only when the env override is set; "folder not found" if missing), the **signed-in account for that folder**, login status with the hint "run `CLAUDE_CONFIG_DIR=<configDir> claude` (your `claude2`) and use `/login`" (nothing is run for JT), adapter install hint `npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.88.0`.
- [ ] Start card: provider chip beside the model chip; remembered per role; terminal tiles read "Claude Code" / "Cursor CLI". **(chip + per-role memory done; the "Claude Code" terminal tile lands with Task 3.2, since Claude terminals do not run before Phase 3)**
- [x] First-run setup checks Claude first, Cursor optional.
- [x] Status bar / tab tooltip show provider; for Claude tabs also the config folder and account ("Claude · ~/.claude-account2 · <account>"; status bar shows the short form, tooltip the full path). This is how JT tells he is on the right Claude account.
- [x] First-run: Claude step shows the config folder it will use and the account, with a link to change the folder.
- [x] Tests: default provider persists; chip switches model list; first-run passes with Claude only; Settings saves `configDir` and shows the env-override state; status bar / tab tooltip render folder + account; "not signed in" for that folder shows the hint.
- [x] Commit: `feat: provider choice in Settings and on the Start card`

## Phase 3: Claude terminal tabs

### Task 3.1: `claude` command lines for role terminals

**Files:** `src-tauri/src/provider/claude.rs`, `src-tauri/src/pty/launch.rs` (split shared prompt delivery from Cursor flags), `src-tauri/src/pty/mod.rs`

- [x] Role → flags from the per-role mode table (Decisions). The Settings run-mode override does not apply to Claude:
  - General: `--permission-mode auto`
  - Planner: `--permission-mode plan`
  - Every other role (Plan Reviewer, Implementer, Developer, PR Reviewer, Codebase Audit, Recommendation, custom): `--permission-mode bypassPermissions`
  - No `--disallowedTools` / `--allowedTools` for any role.
- [ ] Check on the Mac whether `--permission-mode bypassPermissions` alone is enough or also needs `--allow-dangerously-skip-permissions`, and whether the TUI shows a one-time bypass confirmation that JT accepts himself **(unverified)**. If bypass is disabled, fall back to `--permission-mode acceptEdits` (Decisions → Fallbacks). **Checked 2026-10-09 (`claude --help`, 2.1.236): `--permission-mode` accepts `bypassPermissions`; `--allow-dangerously-skip-permissions` only makes bypass *available* without enabling it, so it is not passed. A first-run bypass confirmation in the TUI is still unverified (a launch would write to `~/.claude-account2`, so JT checks it himself).**
- [x] `--model <id>` first when set (reuse `valid_model_id`); prompt as the positional argument via `deliver_prompt` (same 24,000-byte rule and prompt-file fallback).
- [x] PTY env gets `CLAUDE_CONFIG_DIR=<configDir>` via `claude_env` (Task 2.3) for every Claude terminal; Cursor terminals unchanged.
- [x] Never pass `--dangerously-skip-permissions` (use `--permission-mode bypassPermissions`), `--cloud`, `--bg`, `--settings`, `--continue`.
- [x] Tests: argv per role matches the table; Run-mode override ignored for Claude; long prompt uses the file; invalid model dropped; env contains `CLAUDE_CONFIG_DIR` = resolved dir (setting, env override, and default cases).
- [x] Commit: `feat: Claude Code role terminals`

### Task 3.2: Plain "Claude Code" terminal tile + scratch pad

**Files:** `src-tauri/src/pty/mod.rs` (launch `"claude-cli"`), `src/StartupForm.tsx`, `src/components/RoleTiles.tsx`, `src/components/TerminalView.tsx`

- [x] New launch choice `claude-cli` (plain `claude`, no flags, env `CLAUDE_CONFIG_DIR=<configDir>` — the GUI equivalent of JT's `claude2`) next to `cursor-cli`. Test: plain tile env carries the config dir.
- [ ] Scratch-pad Send: confirm `claude`'s TUI enables bracketed paste and accepts one Enter as submit **(unverified — check on the Mac)**; if not, fall back to typed text + Enter. **Scratch-pad Send already follows the live xterm mode (`modes.bracketedPasteMode`), so it falls back to typed text + Enter by itself when `claude` does not enable bracketed paste. Whether one Enter submits in the `claude` TUI is still unverified (needs a live run on the Mac).**
- [x] Closing the tab kills the process tree (existing).
- [x] Commit: `feat: Claude Code terminal tile`

### Task 3.3: Terminal Planner hand-off source for Claude

**Files:** `src-tauri/src/provider/claude.rs` (`plans_dir`), `src/StartupForm.tsx` (`openTerminalHandoff`)

- [x] Claude has no confirmed plan-file folder (`~/.claude/plans` absent on the Mac; check `<configDir>/plans` read-only too). `plans_dir` is always relative to the resolved config dir, never hard-coded `~/.claude`. Default scope = selection, then last 200 lines. If a plans dir is confirmed later, read it read-only like `pty/plans.rs`. **Checked 2026-10-09 (read-only `ls`): `~/.claude-account2/plans` exists on the Mac and holds Claude plan-mode `.md` files (`~/.claude/plans` does not exist). `terminal_plan_file` now takes the tab id and reads the newest plan written since the terminal started from the tab provider `plans_dir` (`<configDir>/plans` for Claude, `~/.cursor/plans` for Cursor), read-only. With no new plan file the dialog defaults to the selection, then the terminal tail.**
- [x] Commit: `feat: Claude terminal Planner hand-off uses selection or tail`

## Phase 4: Claude chat via the ACP adapter

### Task 4.1: Spawn and handshake

**Files:** `src-tauri/src/provider/claude.rs`, `src-tauri/src/acp/session_connect.rs`, `src-tauri/src/acp/client.rs`, `src-tauri/src/commands/role_session.rs`

- [ ] Spawn `claude-agent-acp` with env `CLAUDE_CODE_EXECUTABLE=<detected claude>` and `CLAUDE_CONFIG_DIR=<configDir>` (via `claude_env`, Task 2.3); inherit the user env otherwise (do not set `ANTHROPIC_API_KEY`; if one is set in JT's env, show a notice that Claude Code may bill the API key instead of the subscription — **(unverified precedence)**).
- [ ] Handshake: `initialize` (no terminal-auth client capability, so no login methods are offered) → no `authenticate` → `session/new { cwd, mcpServers: [], _meta: { claudeCode: { options: { allowDangerouslySkipPermissions: true } } } }` → `session/set_mode` from `mode_for_role` (per-role mode table; if the wanted mode is not in the advertised modes, use `default` + auto-approve and flag the indicator).
- [ ] Map "not logged in" errors / `_auth/status_update { kind: "none" }` to "Claude Code is not signed in for <configDir>. Open a terminal, run `CLAUDE_CONFIG_DIR=<configDir> claude` (your `claude2`), and use `/login`. Then Retry."
- [ ] Test: the adapter `ProgramArgs` env has both `CLAUDE_CODE_EXECUTABLE` and `CLAUDE_CONFIG_DIR`.
- [ ] Commit: `feat: Claude chat tabs over claude-agent-acp`

### Task 4.2: Real payload capture (like the Cursor one)

**Files:** `docs/claude-acp-observed.md` (new), `fixtures/acp/claude/*.json` (new), `docs/permission-payload-capture.md`, `src-tauri/src/commands/agent_requests.rs` (capture covers all ACP traffic types for this provider)

- [ ] JT installs the adapter on the Mac (`npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.88.0`); turn on **Record permission payloads**; run one General (`auto`), one Planner (`plan`), one Plan Reviewer and one Implementer (`bypassPermissions`) session in a scratch repo.
- [ ] Capture and redact: `initialize` response, `session/new` response (modes, configOptions incl. model list), `session/request_permission` for Bash, Edit, Write, WebFetch, an MCP tool, `ExitPlanMode` (force these in `default` mode, since `bypassPermissions` sends few or none); `session/update` kinds seen (`plan`, `tool_call`, `tool_call_update`, `current_mode_update`, `usage_update` with `_claude/rateLimit`, `available_commands_update`); `session/load` replay; `_auth/status_update`.
- [ ] Record answers to: whether `session/new` advertises `auto` and `bypassPermissions` for JT's account; which requests still arrive in `auto` / `bypassPermissions` / `plan`; where the plan markdown is in `ExitPlanMode`; whether `session/new` `sessionId` equals the `~/.claude/projects/**/<id>.jsonl` name; whether adapter 0.88.0 works with CLI 2.1.236 via `CLAUDE_CODE_EXECUTABLE` (else JT updates `claude`, his call); whether `session/load` replays the transcript; that with `CLAUDE_CONFIG_DIR=~/.claude-account2` the adapter's sessions land in `~/.claude-account2/projects` (not `~/.claude/projects`) and `_auth/status_update` names the account-2 login; whether the adapter reads `permissions.*` from `<configDir>/settings.json`.
- [ ] Commit: `docs: captured Claude ACP payloads`

### Task 4.3: Session updates, plan cards, questions

**Files:** `src-tauri/src/acp/session_update.rs`, `src-tauri/src/acp/text_extract.rs`, `src/sessionCards.ts` (+ test), `src/SessionTerminal.tsx`, `src/components/PermissionCard.tsx`

- [ ] Standard `plan` updates → plan card (already partly handled by `sessionCards.ts:121-123`); `current_mode_update` → header mode badge; `usage_update` → Phase 10 store; ignore AIR / steering / auth extensions.
- [ ] `ExitPlanMode` request in a Planner tab → plan card (Phase 8); everywhere else it is auto-answered per Task 7.1. No generic permission cards are shown (all other requests auto-approve).
- [ ] Claude has no `cursor/ask_question`; questions come as plain assistant text → existing "turn ended on a question" detection.
- [ ] Tests from Task 4.2 fixtures.
- [ ] Commit: `feat: Claude session updates and plan cards`

### Task 4.4: Errors, cancel, restart

**Files:** `src-tauri/src/acp/connection.rs`, `src-tauri/src/commands/role_session.rs`, `src-tauri/src/supervisor/*`

- [ ] `session/cancel` on Stop; adapter crash → same restart + `session/load` path as Cursor.
- [ ] Missing adapter → message with the install command; missing `claude` → install link.
- [ ] Commit: `feat: Claude chat error handling`

## Phase 5: Model picker

### Task 5.1: Claude model list

**Files:** `src-tauri/src/models.rs`, `src-tauri/src/provider/claude.rs`, `src/models.ts` (+ test), `src/components/ModelPicker.tsx` (+ test)

- [ ] List source order: config options from the latest Claude `session/new` (cached 24 h in app data `models-cache.json` under `claude`), else static fallback: `default` (account default), `opus`, `sonnet`, `haiku`; optional extras `fable` (badge "may use usage credits"), `opusplan`, `sonnet[1m]`, `opus[1m]` — show only if the adapter's list includes them.
- [ ] Default Claude model: `default` (JT can pick `opus`). Cursor default stays `composer-2.5`.
- [ ] `valid_model_id` accepts `[1m]` suffix.
- [ ] Tests: fallback list; cache per provider; id validation.
- [ ] Commit: `feat: Claude models in the picker`

### Task 5.2: Switching

**Files:** `src-tauri/src/commands/model_session.rs`, `src-tauri/src/acp/client.rs`, `src-tauri/src/pty/launch.rs`

- [ ] Live chat: `session/set_config_option` (model) — adapter has no `session/set_model`; restart + `session/load` fallback stays.
- [ ] Terminal: `--model`. Never send `/model` (it writes `<configDir>/settings.json`).
- [ ] Commit: `feat: switch Claude model per tab`

## Phase 6: History and resume

### Task 6.1: Read-only Claude history index

**Files:** `src-tauri/src/claude_history.rs` (new), `src-tauri/src/commands/cursor_cli.rs` → `history.rs`, `src/cursorHistory.ts` → `src/history.ts`, `src/components/CursorHistoryList.tsx` → `HistoryList.tsx`

- [ ] Scan `<configDir>/projects/*/*.jsonl` using the resolved config dir (Task 2.3; JT: `~/.claude-account2/projects`), never a hard-coded `~/.claude`; keep files whose records' `cwd` equals the folder (canonicalized). Stream lines; stop after the first `user` record + title records; cap file size read per entry.
- [ ] Entry: id (file stem / `sessionId`), title (`customTitle` > `aiTitle` > first user text, trimmed), last modified, `gitBranch`, `entrypoint` (to label sessions created by DCTerminal's adapter vs CLI — **(unverified values)**). Skip `isSidechain` sessions.
- [ ] Open read-only (no lock, no write). Test with fixture jsonl (copied structure, fake content); test that a non-default config dir is scanned and `~/.claude/projects` is not; history panel header shows the folder it read.
- [ ] Commit: `feat: Claude Code history for a folder (read-only)`

### Task 6.2: Resume

**Files:** `src-tauri/src/provider/claude.rs`, `src-tauri/src/acp/client.rs`, `src/StartupForm.tsx`, `src/components/HistoryList.tsx`

- [ ] **Resume in app** (chat): `session/load { sessionId }` (or `session/resume` if load replay is too heavy — decide from Task 4.2).
- [ ] **Open in Claude Code** (terminal): `claude --resume <id>` in that folder, env `CLAUDE_CONFIG_DIR=<configDir>`.
- [ ] Tab saves the config dir with `sessions.claude`; if the current resolved dir differs, do not resume — start fresh with a one-line notice ("Claude config folder changed; starting a new session"). Test both cases.
- [ ] History panel title follows the tab's provider; both lists available via a toggle.
- [ ] Commit: `feat: resume Claude sessions in chat or terminal`

### Task 6.3: Migrate existing / restored tabs to Claude

**Files:** `src-tauri/src/store/state_store.rs`, `src-tauri/src/store/workspace_store.rs`, `src-tauri/src/store/state_types.rs`, `src/StartupForm.tsx`, `src/components/HistoryList.tsx`, tests

- [ ] One-time migration (state flag `migrations.claudeFirst`, run on load after Claude chat + history exist): every tab and saved-workspace tab with no saved provider gets `provider: claude` (Decision 3). Tabs explicitly set to Cursor after the migration stay Cursor.
- [ ] Session ids: a migrated tab keeps its Cursor id in `sessions.cursor`; `sessions.claude` is empty, so restore / Start opens a **fresh Claude session** (chat: `session/new`; terminal: `claude` with the role flags, no `--resume`). Never pass a Cursor id to Claude.
- [ ] Switching a migrated tab back to Cursor resumes `sessions.cursor` (chat `session/load`, terminal `agent --resume <id>`); the Cursor history list stays available via the History toggle. Cursor stays selectable everywhere.
- [ ] One-line notice on a migrated tab's first restore: "Now using Claude. Your earlier Cursor session is kept — switch this tab to Cursor to reopen it."
- [ ] Backup: copy `state.json` / `workspaces.json` to `*.pre-claude-first.json` in app data before migrating (never `~/.claude` / `~/.cursor`).
- [ ] Tests: fixtures with chat + terminal Cursor tabs migrate to Claude with empty Claude session; migration runs once; switch-back resumes the Cursor id; workspaces migrate the same way.
- [ ] Commit: `feat: migrate existing tabs to Claude with fresh sessions`

## Phase 7: Full permissions (allow everything) + indicator

Replaces the old "role permission rules + skip-permissions warning" phase (Decision 4). No role rule engine, no Claude settings-file parser, no rules-off / bypass warnings.

### Task 7.1: Auto-approve every request (both providers); retire role rules

**Files:** `src-tauri/src/permissions/policy.rs` (+ tests), `src-tauri/src/permissions/tool_cache.rs`, `src-tauri/src/permissions/cli_config.rs`, `src-tauri/src/pty/launch.rs` (`role_family` / `effective_mode`), `src/workspaceView.ts` (`BUILT_IN_PERMISSION_SUMMARY`), `src/components/PermissionCard.tsx`, `fixtures/acp/claude/permissions/*`

- [ ] `policy.rs` becomes one rule for every role and provider: answer `session/request_permission` with the `allow_once` option. If a request has no `allow_once` option, show the card (no auto-pick of `allow_always` / `reject_*`). Remove per-role evaluation, role families for permissions, and per-role tool classification (keep classification only if the tool cache / UI labels still need it).
- [ ] Exception: Claude `ExitPlanMode` in a **Planner** tab is never auto-answered (→ plan card, Phase 8). In any other tab, auto-answer its `allow_once` option and re-send `session/set_mode <role mode>` (Decisions). `EnterPlanMode` is auto-approved like everything else.
- [ ] Cursor terminal flags follow the table: Planner `--plan`; every other role `--yolo` (General loses `--mode ask`; PR Reviewer / Codebase Audit / Recommendation / custom get `--yolo`). Cursor chat modes: Planner `plan`, others `agent`. The Run-mode override stays for Cursor terminals.
- [ ] Remove `role_rules_off` and its notice from `cli_config.rs` (still read `approvalMode` read-only for the indicator text if useful). `BUILT_IN_PERMISSION_SUMMARY`: "Full access" for all roles.
- [ ] Tests: for every role × provider, captured Claude fixtures (Bash, Edit, Write, WebFetch, MCP) and Cursor fixtures pick `allow_once`; `allow_always` never picked; Planner `ExitPlanMode` not auto-answered; non-Planner `ExitPlanMode` auto-answered + mode restored; Cursor flags per role.
- [ ] Commit: `feat: all roles allow everything; retire role permission rules`

### Task 7.2: Single full-permissions indicator

**Files:** `src/components/StatusBar.tsx` (+ test), `src/TabBar.tsx` (+ test), `src/components/SettingsPage.tsx`, chat header

- [ ] Replace the "⚠ Run Everything" / "Role permission rules are off" warnings (status bar, tab icon, Settings) with one neutral indicator: "Full permissions" in the status bar, tooltip "All tabs run with full permissions (Claude: bypass / auto / plan per role; Cursor: unrestricted). Answers are allow-once; nothing is written to your repo's settings."
- [ ] Fallback state (Decisions → Fallbacks): indicator reads "Full permissions unavailable for Claude — <reason>" when the adapter did not offer the wanted mode or a terminal fell back to `acceptEdits`.
- [ ] Tests: indicator shows for Claude and Cursor tabs; old warning strings gone; fallback text.
- [ ] Commit: `feat: full-permissions indicator replaces rules-off warnings`

## Phase 8: Plan mode hand-off (Claude)

### Task 8.1: Planner runs in plan mode

**Files:** `src-tauri/src/provider/claude.rs`, `src/SessionTerminal.tsx`, `src/components/SessionCards.tsx`

- [ ] Claude Planner chat starts with `session/set_mode plan` (Plan Reviewer runs `bypassPermissions` per Decision 2 and hands off its reviewed plan from its last message). Other requests in plan mode auto-approve `allow_once` (Task 7.1).
- [ ] `ExitPlanMode` ("Ready to code?") → plan card with the plan markdown, **Hand off…** buttons (from the transition table), and **Keep planning** (answers the reject option). DCTerminal never picks "Yes, …" for a Planner: implementation happens in the Implementer tab.
- [ ] Commit: `feat: Claude plan mode plan card`

### Task 8.2: Hand-off content from the plan

**Files:** `src/handoff/map.ts` (`HandoffSource.planMarkdown`), `src/StartupForm.tsx`

- [ ] New scope `plan_mode` = the `ExitPlanMode` plan text (default when present), then latest message / plan card / selection.
- [ ] Tests: plan text lands in Plan Reviewer `plan` and Implementer `approvedPlan`.
- [ ] Commit: `feat: hand off Claude plan-mode plans`

## Phase 9: Eagle-Eye chains (both providers)

### Task 9.1: Chain model

**Files:** `src-tauri/src/store/handoff_store.rs`, `src-tauri/src/commands/handoff.rs`, `src-tauri/src/store/state_types.rs`, `src/handoff/chains.ts` (new) + test

- [ ] `ChainRef { chainId, kind: "eagle1" | "eagle2", step, total }` on `HandoffRecord` and on the tab. Steps: eagle1 = Planner(1) → Plan Reviewer(2) → Implementer(3) → PR Reviewer(4); eagle2 = Implementer(1) → PR Reviewer(2).
- [ ] A hand-off along the chain's next edge carries `step + 1`; any other hand-off ends the chain link (no chain label).
- [ ] Tests: step math; old `handoffs.json` without chain loads.
- [ ] Commit: `feat: Eagle-Eye chain records`

### Task 9.2: Chain UI

**Files:** `src/StartupForm.tsx`, `src/components/HandoffDialog.tsx`, `src/components/RoleTiles.tsx`, `src/tabChrome.ts`, `src/components/StatusBar.tsx`, `src/App.css`

- [ ] Start a chain: palette **Start Eagle-Eye 1…** / **Start Eagle-Eye 2…** (opens a Planner or Implementer draft tagged step 1), and a chain toggle on Start card for Planner / Implementer.
- [ ] Label "Eagle-Eye 1 · step 2 of 4" in the chat header, terminal toolbar, and tab tooltip; **Next: Send to Plan Reviewer** button highlighted as the primary hand-off action. User-triggered only.
- [ ] Commit: `feat: Eagle-Eye chain position and next-step button`

### Task 9.3: Carry each step's output

**Files:** `src/handoff/map.ts`, `src/changes/diffModel.ts`, `src-tauri/src/turn_changes.rs` (read-only summary), `src/StartupForm.tsx`

- [ ] Planner → Plan Reviewer: plan → `plan`; request → `originalTask`.
- [ ] Plan Reviewer → Implementer: reviewed plan → `approvedPlan`; review notes → `additionalContext`.
- [ ] Implementer → PR Reviewer: `approvedPlan` + `originalTask` as today, plus `additionalContext` gets: implementation summary (last assistant message), changed files with +/− counts from the Whole-tab snapshot, current branch, and the first GitHub PR URL found in the transcript (if any). Large diffs are not pasted; the reviewer runs `git diff` itself.
- [ ] Terminal sources: selection / tail, as today.
- [ ] Tests for each edge, both providers' source shapes.
- [ ] Commit: `feat: Eagle-Eye hand-offs carry plan, review notes, and implementation summary`

### Task 9.4: Both providers

**Files:** tests only (`src/handoff/*.test.ts`, `src-tauri/src/store/handoff_store.rs` tests)

- [ ] A chain can mix providers (e.g. Claude Planner → Cursor Implementer); the next tab defaults to the source tab's provider.
- [ ] Commit: `test: Eagle-Eye chains across providers`

## Phase 10: Claude usage / limits view

### Task 10.1: Collect last-known limits

**Files:** `src-tauri/src/acp/session_update.rs`, `src-tauri/src/commands/usage.rs` (new), `src/usage/usageStore.ts` (new) + test

- [ ] From `usage_update._meta["_claude/rateLimit"]`: keep per `rateLimitType` the latest `utilization`, `resetsAt`, `status`, and when it was seen. From `usage_update.used/size`: per-tab context fill. In memory only (or app data, never `~/.claude` / the config dir). Key the values by config dir so another account's limits are never shown.
- [ ] Shape is from the adapter source; confirm with Task 4.2 fixtures.
- [ ] Commit: `feat: collect Claude limit updates`

### Task 10.2: Show it

**Files:** `src/components/StatusBar.tsx`, `src/components/SettingsPage.tsx` (Usage section), tests

- [ ] Status bar: "Claude 5h 42% · resets 3:10 PM" (local time), yellow at ≥80% / `allowed_warning`, red on `rejected`; "not reported yet" before the first update. Tab header shows context fill for Claude chats.
- [ ] Settings > Usage: each window with bar, reset time, last-updated time, and the text "Updated by Claude chat tabs; terminal tabs don't report usage."
- [ ] No token accounting, no jsonl scan (PROGRESS "No token tracking"), unless JT approves it separately.
- [ ] Commit: `feat: Claude usage and limits in the status bar`

## Phase 11: Docs + verify

### Task 11.1: Docs and smoke

**Files:** `docs/PROGRESS.md`, `README.md`, `docs/cursor-cli-history.md` (link to Claude history), `docs/claude-acp-observed.md`, this plan

- [ ] PROGRESS snapshot + update "Locked product decisions" (Claude config dir `providers.claude.configDir` / `DCT_CLAUDE_CONFIG_DIR` → `CLAUDE_CONFIG_DIR` on every Claude spawn; config dir and `~/.claude` read-only, Claude default provider, existing tabs migrated to Claude, all roles full permissions / no role rules, per-role mode table).
- [ ] README: Claude Code + adapter install steps; how to point DCTerminal at a non-default Claude account (Settings > Providers > Claude config folder, or `DCT_CLAUDE_CONFIG_DIR`).
- [ ] Tick all boxes after push; `npm run check` and `npm audit` = 0 on the box and on the Mac; Node 22/24/26.
- [ ] Message JT with PR link and the smoke list below.
- [ ] Commit: `docs: Claude-first provider progress`

## Risks and remaining questions

- **Subscription login via the Agent SDK (policy).** Allowed for personal use of your own subscription; not for offering login to others. DCTerminal stays private, never handles credentials. If Anthropic tightens this, chat tabs could fall back to Claude terminal tabs only (which run the unmodified `claude`).
- **Adapter churn.** Releases almost daily, protocol extensions under `_meta`. Pin `0.88.0`, record captures, upgrade deliberately.
- **CLI/SDK version skew.** JT's CLI 2.1.236 vs. adapter's SDK 0.3.293. If `CLAUDE_CODE_EXECUTABLE` mode fails, options: JT updates Claude Code (`brew upgrade --cask claude-code`, his call) or the adapter uses its bundled binary (bigger install; credential sharing with the Homebrew binary via macOS Keychain is **(unverified)**).
- **Fable / usage credits.** In SDK apps without the consent prompt, a Fable request bills credits without asking. Hide Fable unless JT turns it on in Settings.
- **ExitPlanMode plan location** and **sessionId ↔ jsonl name** are unverified until Task 4.2.
- **Full permissions everywhere (accepted by JT, Decision 4).** Every role can edit files and run any command in the tab's folder without asking. Mitigation is git + JT's own `~/.claude` deny rules; DCTerminal never picks `allow_always`, so nothing is written to project `.claude/settings.local.json` (resolves the old "project rules files" question). Auto-answer pick logic is covered by tests on captured fixtures.
- **`auto` / `bypassPermissions` availability** for JT's account / CLI 2.1.236 is unverified until Task 4.2; fallback is `default` + auto-approve (chat) / `acceptEdits` (terminal).
- **Migration (Decision 3).** Migrated tabs lose in-app continuity of their Cursor conversation under Claude (fresh session); the Cursor session stays resumable by switching back. State is backed up before migrating.
- **Usage view vs. "No token tracking":** confirm limits-only is OK.
- **Wrong Claude account.** A missed spawn path without `CLAUDE_CONFIG_DIR` would silently use `~/.claude`. Mitigation: one `claude_env` helper, tests on every spawn path, and the folder + account indicator. Whether the adapter's SDK honors `CLAUDE_CONFIG_DIR` end-to-end is **(unverified until Task 4.2)**.
- **Windows paths** for `claude` / adapter are unverified; Mac is the target.
- **Status line usage for terminal tabs** via `--settings` is unverified and out of scope.

## Out of scope

- Writing any Claude or Cursor config (the Claude config dir e.g. `~/.claude-account2/*`, `~/.claude/*`, `~/.cursor/*`, project `.claude/*`)
- Claude cloud / background agents, `ultrareview`, remote control
- Bundling the adapter or `claude` inside the DCTerminal app
- Token/cost accounting
- Per-role permission rules, permission rule editing, or bypass warnings (retired by Decision 4)
- Signed distribution

## Smoke checklist (JT)

- [ ] Settings > Providers shows Claude Code 2.1.x found, signed in, adapter found; default provider = Claude
- [ ] Settings > Providers: Claude config folder = `~/.claude-account2`, account shown is the `claude2` account (same as `claude2 auth status` in a terminal); status bar / tab tooltip show the same folder + account
- [ ] `ps eww` (or `ps -E`) on the adapter and a Claude terminal shows `CLAUDE_CONFIG_DIR=/Users/…/.claude-account2`; launching DCTerminal with `DCT_CLAUDE_CONFIG_DIR=~/.claude` switches the indicator to `~/.claude` (then remove it)
- [ ] New tab → Implementer → Claude → Chat → Start: mode badge `bypassPermissions`; edits and shell run without cards; no `allow_always` picked; no `.claude/settings.local.json` appears in the repo
- [ ] General (Claude chat): mode badge `auto`; any permission request auto-approved
- [ ] Plan Reviewer (Claude chat): can run shell and tests (and write if asked); PR Reviewer likewise
- [ ] Planner (Claude chat): plan mode; "Ready to code?" shows as a plan card with **Send to Plan Reviewer** and **Keep planning**
- [ ] Eagle-Eye 1: Planner → Plan Reviewer → Implementer → PR Reviewer, each tab labelled "step n of 4", each form pre-filled; nothing starts until Start
- [ ] Eagle-Eye 2: Implementer → PR Reviewer carries summary + changed files (+ PR link if present)
- [ ] Same chains with Cursor tabs still work; Cursor Planner → Plan Reviewer works (Phase 1)
- [ ] Claude terminal tabs: role flags match the per-role mode table (`ps`), scratch-pad Send submits once; plain Claude Code tile works
- [ ] Model picker: Claude list (default / opus / sonnet / haiku); switching mid-chat works; Cursor list unchanged
- [ ] History: Claude sessions for the folder listed from `~/.claude-account2/projects` (a session started with `claude2` appears; one only in `~/.claude` does not); Resume in app and Open in Claude Code both work; `~/.claude-account2` and `~/.claude` mtimes unchanged by DCTerminal (only by Claude itself)
- [ ] Status bar shows the single "Full permissions" indicator; no "role rules are off" / Run Everything warnings anywhere
- [ ] Restart with tabs from before the update: they reopen as Claude with fresh sessions and the migration notice; switching one back to Cursor reopens its old Cursor session
- [ ] Status bar shows Claude 5h / 7d usage after the first Claude chat reply
- [ ] Themes, split view, file panel, diff panel unaffected

## Agent handoff fields (copy/paste)

**Task Type:** Feature

**Title:** Make DCTerminal Claude-first (Claude Code provider) and fix the Eagle-Eye hand-off chains

**Description:** Add Claude Code as the default provider. Chat tabs talk ACP to `claude-agent-acp` (the Claude Code ACP adapter, `@agentclientprotocol/claude-agent-acp` 0.88.0), so sessions, resume, and plan cards reuse the existing ACP code. Terminal tabs run `claude` the way they run `agent` today. Both use JT's Claude subscription login through Claude Code; DCTerminal never handles credentials. Cursor CLI stays as a second provider: per-tab choice plus a default in Settings (default Claude). JT runs Claude as `claude2` (`CLAUDE_CONFIG_DIR=$HOME/.claude-account2 claude`); a GUI app does not see that alias, so add a Claude config dir setting `providers.claude.configDir` (JT: `~/.claude-account2`; unset → `~/.claude`; env override `DCT_CLAUDE_CONFIG_DIR`) and pass `CLAUDE_CONFIG_DIR=<configDir>` to the adapter, every terminal `claude`, and `claude auth status --json`; show the config folder + signed-in account in Settings > Providers and the status bar / tab. Add Claude versions of history/resume (read-only from `<configDir>/projects`), the model picker (default/opus/sonnet/haiku), Planner hand-off from Claude plan mode, and a limits view (5-hour / 7-day utilization pushed by the adapter). Per JT's decisions (2026-10-09): no per-role permission rules — every role on both providers allows everything (Claude modes: General `auto`, Planner `plan`, all other roles incl. Plan Reviewer `bypassPermissions`; any permission request auto-approved with `allow_once`, never `allow_always`; Planner `ExitPlanMode` becomes the plan card) with one "Full permissions" indicator replacing the rules-off warnings; existing/restored tabs migrate to Claude with fresh Claude sessions while their Cursor session stays resumable by switching back. First fix the bug that the Planner cannot hand off to a Plan Reviewer (no such role is seeded and hand-off targets are hard-coded), then build user-triggered Eagle-Eye chains (EE1: Planner → Plan Reviewer → Implementer → PR Reviewer; EE2: Implementer → PR Reviewer) that carry each step's output and show "Eagle-Eye 1 · step 2 of 4".

**Approved Implementation Plan:** Follow `docs/CLAUDE-FIRST-PLAN.md` phases 1–11 (32 tasks) in order (Phase 1, the Plan Reviewer fix, can ship as its own PR first). Tick checkboxes after each push. Do the Task 4.2 payload capture on JT's Mac before relying on anything marked (unverified). Draft PRs to master.

**Additional Context:** Base `master` at `79b11e7`. Root cause of the missing Plan Reviewer hand-off: `seed_defs.rs:14-24` has no Plan Reviewer; `src/handoff/map.ts:19` hard-codes targets to Implementer/Developer/PR Reviewer; same lists in `HandoffDialog.tsx:16-20,166-182`, `StartupForm.tsx:2540-2559` and the terminal menu at `StartupForm.tsx:3830-3848`; `handoffBlockReason` (`map.ts:151-163`) only accepts Planner/Implementer as sources. Claude Code 2.1.236 is installed on JT's Mac at `/opt/homebrew/bin/claude` (Homebrew cask); the adapter is not installed yet (JT: `npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.88.0`, run with `CLAUDE_CODE_EXECUTABLE`). Decisions resolved 2026-10-09 (see the plan's Decisions section and per-role mode table): General = Claude `auto`; Plan Reviewer runs everything; existing tabs migrate to Claude (Task 6.3); all roles allow everything, Phase 7 = auto-approve + indicator (JT's global Cursor `approvalMode` is already `unrestricted`). Claude config dir (Task 2.3): `DCT_CLAUDE_CONFIG_DIR` → `providers.claude.configDir` (JT `~/.claude-account2`) → `~/.claude`, set as `CLAUDE_CONFIG_DIR` on every Claude spawn, history from `<configDir>/projects`. Never write to the Claude config dir, `~/.claude`, or `~/.cursor`; never auto-pick `allow_always`; never send `/model`. No CI, `npm audit` 0, Node 22/24/26, `npm run check` before every push, Mac is main, no cloud agents, merge only with JT's approval.
