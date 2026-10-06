import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { HandoffActions } from "./components/HandoffDialog";
import type { HandoffTargetId } from "./handoff/map";
import { historyNavigate } from "./scratch/pad";
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
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  history?: string[];
  historyCursor?: number;
  onHistoryCursor?: (cursor: number) => void;
  handoff?: {
    enabled: boolean;
    reason: string | null;
    onSend: (target: HandoffTargetId) => void;
  } | null;
  onOpenInCursorCli?: () => void;
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
  inputRef,
  history = [],
  historyCursor = -1,
  onHistoryCursor,
  handoff,
  onOpenInCursorCli,
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
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && onHistoryCursor) {
      const navigated = historyNavigate({
        history,
        cursor: historyCursor,
        direction: e.key === "ArrowUp" ? "older" : "newer",
        draft: followUp,
        caretAtStart: e.currentTarget.selectionStart === 0,
      });
      if (navigated.handled) {
        e.preventDefault();
        onHistoryCursor(navigated.cursor);
        onFollowUpChange(navigated.text);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
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
  const lastAgentId = useMemo(() => {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i].kind === "agent" && segments[i].text.trim()) return segments[i].id;
    }
    return null;
  }, [segments]);

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
          {onOpenInCursorCli && (
            <button
              type="button"
              className="secondary-button"
              onClick={onOpenInCursorCli}
              disabled={busy}
              title="Open Windows Terminal or PowerShell running agent --resume for this ACP session"
            >
              Open in Cursor CLI
            </button>
          )}
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
        <div ref={screenRef} className="session-terminal-screen" data-session-screen role="log">
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
                  {handoff && seg.id === lastAgentId && (
                    <HandoffActions
                      enabled={handoff.enabled}
                      reason={handoff.reason}
                      busy={busy}
                      onSend={handoff.onSend}
                    />
                  )}
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
          ref={inputRef}
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
