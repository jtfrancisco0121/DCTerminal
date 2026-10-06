# Capturing `session/request_permission` payloads

Use this when checking that DCTerminal's role classifier matches real Cursor ACP traffic. The toggle is **off by default**. Nothing is sent off the machine.

## Turn it on

1. Open DCTerminal.
2. Open **Settings** (gear in the tab bar, command palette, or Ctrl+,) and check **Record permission payloads**.
3. Start a role session and let the agent hit a tool that asks for permission (or is auto-answered by the role policy).
4. Each `session/request_permission` JSON-RPC request is appended as one line to:

```text
<app data>/logs/permission-payloads.jsonl
```

| OS | App data directory |
|---|---|
| Windows | `%APPDATA%\com.jtfrancisco.dcterminal\` |
| macOS | `~/Library/Application Support/com.jtfrancisco.dcterminal/` |
| Linux | `~/.local/share/com.jtfrancisco.dcterminal/` |

The checkbox state is stored in `settings.json` in that same directory (`diagnostics.capturePermissionPayloads`). Turn it off again when you are done. If a write fails (disk full or a locked file), the permission is still answered and the error is shown under the checkbox.

## What is stored

Each line looks like:

```json
{
  "capturedAt": "2026-10-06T00:00:00Z",
  "tabId": "tab_…",
  "roleId": "role_reviewer",
  "method": "session/request_permission",
  "payload": {}
}
```

`payload` is the raw request after redaction:

- File bodies and diffs are removed (`content`, `text`, `diff`, `old_string`, `new_string`, and the same names with different casing).
- Secret-shaped fields are removed (`apiKey`, `token`, `password`, `authorization`, …).
- Values that look like `sk-…`, `ghp_…`, `Bearer …`, or a private key are replaced with `[redacted]`.
- Other very long strings are truncated. `command`, `path`, `title`, and `cwd` are kept so the classifier can be checked.

## How to compare with the classifier

The decision code is `src-tauri/src/permissions/policy.rs` (`evaluate_permission`). For each captured line:

1. Note `roleId` and the tool fields that survived redaction (`toolCall.kind`, `title`, `rawInput.command`, `rawInput.path`).
2. Replay that `params` object through `evaluate_permission` (a unit test is the easiest place).
3. Confirm the outcome:
   - Implementer / Developer → `allow-once` for write, shell, and MCP.
   - PR Reviewer → allow shell and MCP, reject writes. Ambiguous requests stay on the card.
   - Planner / General → reject write and shell. MCP is allowed.
4. `allow-always` is never chosen. DCTerminal does not write `~/.cursor` or the project.

Auto-decisions also show up in the transcript as a system line. The log still records those requests so you can see the payload even when no card was shown.

## Live Cursor CLI notes (2026.10.01)

Captured on JT's Mac with `approvalMode: allowlist` and an empty shell allowlist:

- Permission request params do **not** include `rawInput`. The command, path, or URL is on the preceding (or following) `tool_call` / `tool_call_update` with the same `toolCallId`, or only in the title.
- Delete arrives as `kind: "edit"` with title `Delete \`path\``. DCTerminal displays it as delete; classification remains Write.
- Fetch uses `toolCallId: "web_fetch_0"` (does not match the real tool call) and can arrive **before** any `tool_call`. Title parsing supplies the URL.
- File create/edit under allowlist never send `request_permission`.
- With `approvalMode: unrestricted` (Run Everything), the agent never sends `request_permission`, so role rules never apply. DCTerminal only reads `cli-config.json` and warns; it never writes or overrides that setting.

### MCP

MCP permission payloads are still **unverified** on a live CLI. The classifier keeps `mcp_signal` (server fields, `kind: mcp`, titles like `mcp:…`) as a best-effort signal. Do not treat MCP auto-allow as proven until a capture lands in `fixtures/acp/permissions/`.
