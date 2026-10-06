import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PermissionRequestEvent } from "./bridge";
import { PermissionCard } from "./PermissionCard";
import { summarizeSessionActivity } from "./sessionActivity";
import type { StreamSegment, ToolStatus } from "./transcript";

const markdownComponents: Components = {
  table: ({ children }) => (
    <div className="session-markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

type Props = {
  title: string;
  cwd: string;
  sessionId: string;
  segments: StreamSegment[];
  promptInFlight: boolean;
  followUp: string;
  busy: boolean;
  canSendFollowUp: boolean;
  promptError: string | null;
  permissionRequest: PermissionRequestEvent | null;
  onPermissionSelect: (optionId: string) => void;
  onPermissionCancel: () => void;
  onCancelTurn: () => void;
  onFollowUpChange: (value: string) => void;
  onSendFollowUp: () => void;
  onStop: () => void;
  folderWarning?: string | null;
  agentExited?: boolean;
  onRestart?: () => void;
};

export function SessionTerminal({
  title,
  cwd,
  sessionId,
  segments,
  promptInFlight,
  followUp,
  busy,
  canSendFollowUp,
  promptError,
  permissionRequest,
  onPermissionSelect,
  onPermissionCancel,
  onCancelTurn,
  onFollowUpChange,
  onSendFollowUp,
  onStop,
  folderWarning,
  agentExited = false,
  onRestart,
}: Props) {
  const screenRef = useRef<HTMLDivElement>(null);
  const permissionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [segments, promptInFlight]);

  useEffect(() => {
    if (!permissionRequest) return;
    permissionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [permissionRequest]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!busy && followUp.trim()) onSendFollowUp();
    }
  };

  const hasContent = segments.some((s) => s.text.length > 0);
  const remarkPlugins = useMemo(() => [remarkGfm], []);
  const activity = summarizeSessionActivity(segments, {
    promptInFlight,
    waitingPermission: !!permissionRequest,
  });

  const toolStatusLabel = (status?: ToolStatus): string => {
    switch (status) {
      case "pending":
        return "pending";
      case "in_progress":
      case "running":
        return "running";
      case "completed":
        return "done";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      default:
        return "active";
    }
  };

  return (
    <div className="session-terminal">
      <header className="session-terminal-chrome">
        <div className="session-terminal-chrome-titles">
          <h2 className="session-terminal-title">{title}</h2>
          <p className="session-terminal-subtitle" title={sessionId}>
            {cwd}
          </p>
        </div>
        <div className="session-terminal-chrome-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onCancelTurn}
            disabled={busy || !promptInFlight}
            title="Cancel in-flight turn (Esc)"
          >
            Cancel turn
          </button>
          {agentExited && onRestart && (
            <button
              type="button"
              className="primary-button"
              onClick={onRestart}
              disabled={busy}
              title="Stop this agent and return to the form so you can start it again"
            >
              Restart
            </button>
          )}
          <button
            type="button"
            className="secondary-button session-stop"
            onClick={onStop}
            disabled={busy}
          >
            Stop session
          </button>
        </div>
      </header>

      {folderWarning && (
        <p className="folder-warning" role="status">
          {folderWarning}
        </p>
      )}

      {activity && (
        <p
          className={`session-activity${permissionRequest ? " session-activity-urgent" : ""}`}
          role="status"
        >
          {activity}
        </p>
      )}

      {permissionRequest && (
        <div ref={permissionRef} className="session-permission-sticky">
          <PermissionCard
            request={permissionRequest}
            busy={busy}
            onSelect={onPermissionSelect}
            onCancel={onPermissionCancel}
          />
        </div>
      )}

      <div className="session-terminal-screen-wrap">
        <div ref={screenRef} className="session-terminal-screen" role="log">
          {!hasContent && promptInFlight && (
            <p className="session-terminal-placeholder">Agent is thinking…</p>
          )}
          {segments.map((seg) => {
            if (seg.kind === "thought" && !seg.text.trim()) return null;
            return (
            <div
              key={seg.id}
              className={`session-stream session-stream-${seg.kind}`}
            >
              {seg.kind === "user" ? (
                <div className="session-user-turn">
                  <div className="session-user-label" aria-hidden>You ›</div>
                  <div className="session-user-body">
                    <ReactMarkdown
                      remarkPlugins={remarkPlugins}
                      components={markdownComponents}
                    >
                      {seg.text}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : seg.kind === "agent" ? (
                <div className="session-agent-turn">
                  <div className="session-agent-label" aria-hidden>Agent</div>
                  <div className="session-agent-body">
                    <ReactMarkdown
                      remarkPlugins={remarkPlugins}
                      components={markdownComponents}
                    >
                      {seg.text}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : seg.kind === "tool" ? (
                <div
                  className={`session-stream-tool session-stream-tool-${seg.toolStatus ?? "unknown"}`}
                >
                  <span className="session-tool-marker" aria-hidden>▸</span>
                  <span className="session-tool-label">{seg.text}</span>
                  <span
                    className={`session-tool-status session-tool-status-${seg.toolStatus ?? "unknown"}`}
                  >
                    {toolStatusLabel(seg.toolStatus)}
                  </span>
                </div>
              ) : seg.kind === "thought" ? (
                <details className="session-stream-thought">
                  <summary>Reasoning (collapsed)</summary>
                  <pre>{seg.text}</pre>
                </details>
              ) : (
                <div className="session-stream-system"># {seg.text}</div>
              )}
            </div>
            );
          })}
          {promptInFlight && hasContent && (
            <span className="session-terminal-cursor" aria-hidden>▌</span>
          )}
        </div>
      </div>

      {promptError && (
        <p className="error session-terminal-error">{promptError}</p>
      )}

      <div className="session-terminal-composer">
        <span className="session-terminal-prompt" aria-hidden>›</span>
        <textarea
          className="session-terminal-input"
          rows={3}
          placeholder={
            canSendFollowUp
              ? "Follow-up message (Ctrl+Enter to send)"
              : "Message"
          }
          value={followUp}
          onChange={(e) => onFollowUpChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
        />
        <button
          type="button"
          className="primary-button session-terminal-send"
          onClick={onSendFollowUp}
          disabled={busy || agentExited || !followUp.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
