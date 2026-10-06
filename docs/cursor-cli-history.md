# Cursor CLI history and ACP resume

DCTerminal talks to Cursor CLI only through `agent acp`. On JT's machine (Cursor CLI `2026.10.01-e373342`) those sessions are stored under `%USERPROFILE%\.cursor\acp-sessions\<sessionId>\`, while `agent ls`, `agent resume`, and `/resume` read a different tree: `%USERPROFILE%\.cursor\chats\<project-hash>\<chatId>\store.db`.

This note separates what the docs and the captured `initialize` response already say from what still has to be observed on a logged-in CLI. The live probe was **not** run in the environment that wrote this file (no logged-in Cursor CLI here). Do not treat the probe's verdict lines as filled in until JT runs it.

## What the docs and the captured handshake say

Sources:

- [Cursor CLI ACP](https://cursor.com/docs/cli/acp) — session flow is `initialize`, `authenticate`, then `session/new` **or** `session/load`, then `session/prompt`.
- [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters) — `--resume [chatId]` resumes a chat; `create-chat` creates an empty chat and prints its id; `ls` and `resume` are chat commands. `agent acp` is a hidden command and the ACP page gives it no flags of its own.
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup) — call `session/load` only when `agentCapabilities.loadSession` is true. The agent must replay the conversation as `session/update` notifications, then answer the `session/load` request. `session/resume` is a **different** method and requires `sessionCapabilities.resume`.
- [ACP session list](https://agentclientprotocol.com/protocol/v1/session-list) — call `session/list` only when `sessionCapabilities.list` is present. Listing does not resume a session.
- ACP `_meta` — clients must not assume meaning for values under `_meta`.
- Fixture [`fixtures/acp/initialize-response-2026-10-06.ndjson`](../fixtures/acp/initialize-response-2026-10-06.ndjson), from CLI `2026.10.01-e373342`:

```json
"agentCapabilities": {
  "loadSession": true,
  "sessionCapabilities": { "list": {} }
}
```

`loadSession` is true. `sessionCapabilities.list` is present. `sessionCapabilities.resume` and `sessionCapabilities.close` are absent. DCTerminal therefore sends `session/load` and does not send `session/resume`.

A Cursor forum thread records that `session/load` replay of `user_message_chunk` / `agent_message_chunk` was missing on CLI builds through `2026.05.16` and landed in `2026.06.04-5fd875e`. JT's build is later than that. Replay still has to be checked with the probe; a changelog is not a substitute for this machine.

## The three options

### (a) Bind an ACP session to `agent create-chat`

**Not supported by the public docs.** `session/new` is documented as `{ cwd, mcpServers }`. Nothing in the Cursor ACP page or the ACP schema says a `create-chat` id can be passed as `sessionId`, `chatId`, or `_meta.chatId`. Assuming `_meta` would violate the ACP rule that clients must not invent meaning for those keys.

DCTerminal does **not** call `create-chat` and does **not** send those extra fields. The probe tries them and prints whether the returned `sessionId` equals the chat id, and whether a directory appears under `chats/` or only under `acp-sessions/`.

### (b) `agent --resume <acpSessionId>`

**Not documented for ACP ids.** `--resume` takes a chat id. JT already observed that ACP sessions are absent from the store `/resume` reads. The probe runs:

```text
agent --resume <acpSessionId> -p "What code word did I give you? Reply with that word only."
```

after an ACP turn that was told the code word `ORCHID`. Exit 0 without that word is inconclusive (some session may have opened; it is not proof this ACP thread resumed). A not-found error is a no.

**Open in Cursor CLI** still launches that command, because it is the only interactive CLI entry point the task can call, and because CLI chats listed from `chats/` *are* the ids `--resume` is documented to take. For an ACP id, treat the window as unverified until the probe summary says `(b)` is `Yes`.

On Windows the app tries `wt.exe -d <folder> powershell.exe -NoExit -Command "& '<agent>' --resume <id>"`, then a new PowerShell console. The id is restricted to ASCII letters, digits, `_`, and `-`. There is no in-app ConPTY tab on this branch.

### (c) ACP `session/load`

**This is the supported path, and it is what Continue uses.**

Cursor's ACP docs say to resume with `session/load`. The captured `initialize` advertises `loadSession: true`. The client checks that flag on the live `initialize` response and does not send `session/load` when it is missing.

Continue session:

1. The tab keeps `session.acpSessionId` across Stop, app relaunch (a `running` tab becomes `awaitingInput`), and close/reopen.
2. Continue spawns `agent acp` and sends `session/load` with that id, the tab folder, and `mcpServers: []`.
3. `session/update` notifications from the load are applied to the transcript. The old local scrollback is not pasted into a new `session/new`.
4. If the CLI returns success but no message chunks, the local scrollback stays on screen and is labeled as a local copy. The live process is still the loaded ACP session.
5. If `session/load` fails, the form shows the error. DCTerminal does not silently start a new ACP session.

`session/list` is advertised, but the history list does not call it. Spawning an agent just to list sessions would be a write-capable process. The list reads files instead.

## History list

On the blank-tab card (and on a restored tab's card), **Cursor CLI history** shows sessions for the chosen folder:

- `%USERPROFILE%\.cursor\acp-sessions\<id>\meta.json` (or `~/.cursor/...` off Windows), matched on `cwd`
- `%USERPROFILE%\.cursor\chats\<hash>\<id>\meta.json`, matched the same way

`store.db` is not opened. Opening SQLite can create `-wal` / `-shm` files, and DCTerminal does not write under `~/.cursor`. Chats that have no `meta.json` are omitted rather than guessed. **Resume** opens a new tab and `session/load`s that id. **Open in Cursor CLI** runs `agent --resume` as in (b).

## Probe JT runs

From the repo root, in PowerShell, with `agent login` already done:

```powershell
powershell -File scripts/probe-cursor-cli-history.ps1
```

Equivalent:

```powershell
cd src-tauri
cargo test live_cli_history_probe -- --ignored --nocapture --test-threads=1
```

The probe is ignored by a normal `cargo test`. It prints help text, `create-chat`, one real ACP session (a short prompt containing `ORCHID`), three undocumented `session/new` shapes, `agent --resume` of the ACP id, `agent ls` (killed after 8 seconds if it is interactive), and `session/load` plus a follow-up prompt. The last lines are:

```text
=== summary ===
(a) create-chat bind: Yes|No|Inconclusive — ...
(b) agent --resume <acpSessionId>: Yes|No|Inconclusive — ...
(c) session/load: Yes|No|Inconclusive — ...
```

`agent` itself writes session files while the probe runs. That is the CLI, not DCTerminal.
