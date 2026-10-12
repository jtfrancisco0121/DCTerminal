import type { ReactNode } from "react";
import type { LimitLine } from "../usage/limits";

export type StatusTone = "idle" | "ok" | "busy" | "needs" | "error";

export type StatusMessage = {
  id: string;
  text: string;
  tone: "info" | "warn" | "error";
  onDismiss?: () => void;
};

type Props = {
  status: { tone: StatusTone; text: string };
  model?: string | null;
  /** Provider indicator, e.g. "Claude · ~/.claude-account2 · jt@…" + full tooltip. */
  provider?: { text: string; title: string } | null;
  folder?: string | null;
  branch?: string | null;
  /**
   * Set on agent tabs. `fallback` is why Claude could not take the role mode.
   * `mode` is the `--permission-mode` a Claude role terminal launched with
   * (`auto` | `plan`); when set it replaces "Full permissions".
   */
  permissions?: { fallback?: string | null; mode?: string | null } | null;
  /** Claude 5h/7d line. Null hides it. */
  usage?: LimitLine | null;
  messages?: StatusMessage[];
  /** U7: the optional shortcut hints sit at the right end of the same strip. */
  trailing?: ReactNode;
};

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * U3: one status strip under the workspace instead of stacked banners. It
 * carries the active tab's status, model, folder, and the full-permissions
 * indicator, plus short notices that used to be banners.
 */
export const FULL_PERMISSIONS_TITLE =
  "Chat tabs run with full permissions (Claude chat: bypass / auto / plan per role; Cursor: unrestricted). Claude role terminals use auto or plan mode and ask before risky actions. Answers are allow-once; nothing is written to your repo's settings.";

/** Tooltip for a Claude role terminal's permission mode. */
export function permissionModeTitle(mode: string): string {
  const base = `Claude Code launched this role terminal with --permission-mode ${mode}`;
  return mode === "plan"
    ? `${base}: it plans without editing files and asks before acting.`
    : `${base}: it asks you before risky actions.`;
}

export function StatusBar({
  status,
  model = null,
  provider = null,
  folder = null,
  branch = null,
  permissions = null,
  usage = null,
  messages = [],
  trailing = null,
}: Props) {
  const mode = permissions?.mode?.trim() || null;
  const permissionText = mode
    ? `Mode: ${mode}`
    : permissions?.fallback
      ? `Full permissions unavailable for Claude — ${permissions.fallback}`
      : "Full permissions";
  const permissionWarn = !mode && Boolean(permissions?.fallback);
  const permissionTitle = mode
    ? permissionModeTitle(mode)
    : permissionWarn
      ? permissionText
      : FULL_PERMISSIONS_TITLE;
  return (
    <footer className="status-bar" aria-label="Status bar">
      <span
        className={`status-bar-item status-bar-status status-tone-${status.tone}`}
        role="status"
        aria-live="polite"
      >
        <span className="status-bar-dot" aria-hidden />
        {status.text}
      </span>
      {provider && (
        <span
          className="status-bar-item status-provider"
          title={provider.title}
          data-testid="status-provider"
        >
          {provider.text}
        </span>
      )}
      {model && (
        <span className="status-bar-item" title="Model for this tab">
          <span className="status-bar-label" aria-hidden>
            ◇
          </span>
          {model}
        </span>
      )}
      {folder && (
        <span
          className="status-bar-item status-bar-folder"
          title={[folder, ...(branch ? [`Branch: ${branch}`] : [])].join("\n")}
        >
          <span>{folderName(folder)}</span>
          {branch && <span className="status-bar-branch">⎇ {branch}</span>}
        </span>
      )}
      {permissions && (
        <span
          className={`status-bar-item${permissionWarn ? " status-bar-warn" : ""}`}
          title={permissionTitle}
          data-testid="status-permissions"
        >
          {permissionText}
        </span>
      )}
      {usage && (
        <span
          className={`status-bar-item status-usage status-usage-${usage.tone}`}
          title={usage.title}
          data-testid="status-usage"
        >
          {usage.text}
        </span>
      )}
      <span className="status-bar-messages" role="status" aria-live="polite">
      {messages.map((message) => (
        <span
          key={message.id}
          className={`status-bar-message status-bar-message-${message.tone}`}
          title={message.text}
        >
          {message.tone !== "info" && (
            <span className="sr-only">{message.tone === "error" ? "Error: " : "Warning: "}</span>
          )}
          <span className="status-bar-message-text">{message.text}</span>
          {message.onDismiss && (
            <button
              type="button"
              className="status-bar-dismiss"
              aria-label={`Dismiss: ${message.text}`}
              onClick={message.onDismiss}
            >
              ×
            </button>
          )}
        </span>
      ))}
      </span>
      <span className="status-bar-spacer" />
      {trailing}
    </footer>
  );
}
