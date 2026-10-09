import type { ReactNode } from "react";
import { ROLE_RULES_OFF_TITLE } from "../TabBar";

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
  roleRulesOff?: boolean;
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
 * carries the active tab's status, model, folder, and the Run Everything
 * warning, plus short notices that used to be banners.
 */
export function StatusBar({
  status,
  model = null,
  provider = null,
  folder = null,
  branch = null,
  roleRulesOff = false,
  messages = [],
  trailing = null,
}: Props) {
  return (
    <footer className="status-bar" aria-label="Status bar">
      <span className={`status-bar-item status-bar-status status-tone-${status.tone}`}>
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
      {roleRulesOff && (
        <span
          className="status-bar-item status-bar-warn"
          role="img"
          aria-label={ROLE_RULES_OFF_TITLE}
          title={ROLE_RULES_OFF_TITLE}
        >
          ⚠ Run Everything
        </span>
      )}
      {messages.map((message) => (
        <span
          key={message.id}
          className={`status-bar-message status-bar-message-${message.tone}`}
          title={message.text}
        >
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
      <span className="status-bar-spacer" />
      {trailing}
    </footer>
  );
}
