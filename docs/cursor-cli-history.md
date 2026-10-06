# Cursor CLI history and ACP resume

DCTerminal talks to Cursor CLI only through `agent acp`. On JT's machine (Cursor CLI `2026.10.01-e373342`) those sessions are stored under `%USERPROFILE%\.cursor\acp-sessions\<sessionId>\`, while `agent ls`, `agent resume`, and `/resume` read a different tree: `%USERPROFILE%\.cursor\chats\<project-hash>\<chatId>\store.db`.

JT ran the live probe on 2026-10-06 against Cursor CLI `2026.10.01` with a logged-in CLI. Results:

```text
(a) create-chat bind: No — session/new did not return the create-chat id and did not land under chats/
(b) agent --resume <acpSessionId>: No — exit 1, and agent ls does not contain the ACP id
(c) session/load: Yes — the replay contained the code word, and a follow-up prompt worked
```

DCTerminal therefore resumes ACP sessions with `session/load`. It does not call `create-chat`, and it does not offer `agent --resume` for an ACP id.

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

A Cursor forum thread records that `session/load` replay of `user_message_chunk` / `agent_message_chunk` was missing on CLI builds through `2026.05.16` and landed in `2026.06.04-5fd875e`. The 2026-10-06 probe confirmed replay on `2026.10.01`: the loaded thread contained the code word, and a follow-up prompt on that same session worked.

## The three options

### (a) Bind an ACP session to `agent create-chat`

**Not supported by the public docs.** `session/new` is documented as `{ cwd, mcpServers }`. Nothing in the Cursor ACP page or the ACP schema says a `create-chat` id can be passed as `sessionId`, `chatId`, or `_meta.chatId`. Assuming `_meta` would violate the ACP rule that clients must not invent meaning for those keys.

DCTerminal does **not** call `create-chat` and does **not** send those extra fields. The 2026-10-06 probe tried them: `session/new` did not return the `create-chat` id, and the session did not appear under `chats/`.

### (b) `agent --resume <acpSessionId>`

**Not documented for ACP ids.** `--resume` takes a chat id. JT already observed that ACP sessions are absent from the store `/resume` reads. The probe runs:

```text
agent --resume <acpSessionId> -p "What code word did I give you? Reply with that word only."
```

after an ACP turn that was told the code word `ORCHID`. On 2026-10-06 this exited 1, and `agent ls` did not contain the ACP id.

**Open in Cursor CLI** is offered only for a real CLI chat (`chats/<hash>/<id>/meta.json` for the chosen folder). The button is hidden on ACP rows. The backend refuses an id that is not a CLI chat for that folder, so `agent --resume` is never started for an ACP session. ACP rows use **Resume**, which is `session/load` in a new tab.

A CLI chat opens in an in-app Terminal tab that runs `agent --resume <chatId>` in that folder. The id is passed as an argument, not through a shell string, and it is restricted to ASCII letters, digits, `_`, and `-`. DCTerminal does not open Windows Terminal or a separate PowerShell window for this.

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

`store.db` is not opened. Opening SQLite can create `-wal` / `-shm` files, and DCTerminal does not write under `~/.cursor`. Chats that have no `meta.json` are omitted rather than guessed.

- **Resume** is shown for ACP sessions. It opens a new tab and continues that session. The on-screen hint is “Saved sessions for this folder.” The heading tooltip says Resume continues a session here, and Open in Cursor CLI opens a chat in the terminal.
- **Open in Cursor CLI** is shown for CLI chats only. It opens an in-app terminal running `agent --resume`. ACP sessions use **Resume** instead.

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

The probe is ignored by a normal `cargo test`. It prints help text, `create-chat`, one real ACP session (a short prompt containing `ORCHID`), three undocumented `session/new` shapes, `agent --resume` of the ACP id, `agent ls` (killed after 8 seconds if it is interactive), and `session/load` plus a follow-up prompt. Cleanup skips `taskkill` when that process has already exited, and discards `taskkill` console output, so an already-gone pid does not print `ERROR: The process "…" not found.` The last lines are:

```text
=== summary ===
(a) create-chat bind: Yes|No|Inconclusive — ...
(b) agent --resume <acpSessionId>: Yes|No|Inconclusive — ...
(c) session/load: Yes|No|Inconclusive — ...
```

`agent` itself writes session files while the probe runs. That is the CLI, not DCTerminal.
