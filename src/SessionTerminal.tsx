import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { HandoffActions } from "./components/HandoffDialog";
import type { HandoffTargetId } from "./handoff/map";
import { historyNavigate } from "./scratch/pad";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PermissionRequestEvent, QuestionRequestEvent } from "./bridge";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./components/QuestionCard";
import { summarizeSessionActivity } from "./sessionActivity";
import type { StreamSegment, ToolStatus } from "./transcript";
import { ChatFindBar } from "./components/ChatFindBar";
import { findAll, searchSegments } from "./search/textSearch";

/** F5: open the find bar, optionally landing on one message's n-th hit. */
export type ChatFindRequest = {
  query: string;
  segmentId?: string | null;
  occurrence?: number;
  nonce: number;
};

const HIGHLIGHT_ALL = "dct-find";
const HIGHLIGHT_CURRENT = "dct-find-current";

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function clearFindHighlights() {
  if (!highlightsSupported()) return;
  CSS.highlights.delete(HIGHLIGHT_ALL);
  CSS.highlights.delete(HIGHLIGHT_CURRENT);
}

/** Paint matches in the rendered chat (WebKit / Chromium Custom Highlight API). */
function paintFindHighlights(root: HTMLElement, query: string, current: HTMLElement | null, nth: number) {
  if (!highlightsSupported()) return;
  const all: Range[] = [];
  const inCurrent: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    for (const hit of findAll(text.data, query)) {
      const range = document.createRange();
      range.setStart(text, hit.start);
      range.setEnd(text, hit.end);
      all.push(range);
      if (current?.contains(text)) inCurrent.push(range);
    }
  }
  CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...all));
  const active = inCurrent[nth] ?? inCurrent[0];
  if (active) CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(active));
  else CSS.highlights.delete(HIGHLIGHT_CURRENT);
}

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
  questionRequest?: QuestionRequestEvent | null;
  onQuestionAnswer?: (choiceId: string) => void;
  onQuestionSkip?: () => void;
  onQuestionCancel?: () => void;
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
    targets?: HandoffTargetId[];
    primaryTarget?: string | null;
    onSend: (target: HandoffTargetId) => void;
  } | null;
  /** "Eagle-Eye 1 · step 2 of 4" */
  chainLabel?: string | null;
  /** Claude chat context fill, e.g. "Context 3%". */
  contextFill?: string | null;
  /** Extra header controls, for example the model picker or pane buttons. */
  headerExtra?: ReactNode;
  /** F3: branch of a worktree tab. */
  branch?: string | null;
  /** F5: a new nonce opens the find bar (Mod+F or a Search all chats jump). */
  findRequest?: ChatFindRequest | null;
  onSearchAllChats?: (query: string) => void;
  /** U1: extra hover lines for the header (role, model). */
  details?: string;
  /** U3: the workspace status bar shows activity and folder warnings. */
  statusInBar?: boolean;
};

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

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
  questionRequest = null,
  onQuestionAnswer,
  onQuestionSkip,
  onQuestionCancel,
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
  chainLabel = null,
  contextFill = null,
  headerExtra,
  branch = null,
  findRequest = null,
  onSearchAllChats,
  details,
  statusInBar = false,
}: Props) {
  const screenRef = useRef<HTMLDivElement>(null);
  const permissionRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findFocusKey, setFindFocusKey] = useState(0);
  const findTarget = useRef<{ segmentId: string; occurrence: number } | null>(null);
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;

  useEffect(() => {
    // Reading search results must not be yanked back to the bottom.
    if (findOpenRef.current) return;
    const el = screenRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [segments, promptInFlight]);

  const requestNonce = findRequest?.nonce;
  useEffect(() => {
    if (!findRequest) return;
    findTarget.current = findRequest.segmentId
      ? { segmentId: findRequest.segmentId, occurrence: findRequest.occurrence ?? 0 }
      : null;
    setFindOpen(true);
    if (findRequest.query) setFindQuery(findRequest.query);
    setFindIndex(0);
    setFindFocusKey((key) => key + 1);
    // Only a new request (nonce) reopens; the object itself may be rebuilt.
  }, [requestNonce]);

  const findHits = useMemo(
    () => (findOpen ? searchSegments(segments, findQuery) : []),
    [findOpen, findQuery, segments],
  );

  useEffect(() => {
    const target = findTarget.current;
    if (!target || findHits.length === 0) return;
    findTarget.current = null;
    let at = findHits.findIndex(
      (hit) => hit.segmentId === target.segmentId && hit.occurrence === target.occurrence,
    );
    if (at < 0) at = findHits.findIndex((hit) => hit.segmentId === target.segmentId);
    if (at >= 0) setFindIndex(at);
  }, [findHits, requestNonce]);

  const currentHit =
    findHits.length > 0 ? findHits[Math.min(findIndex, findHits.length - 1)] : null;
  const currentSegmentId = currentHit?.segmentId ?? null;
  const currentOccurrence = currentHit?.occurrence ?? 0;

  useEffect(() => {
    const root = screenRef.current;
    if (!findOpen || !root) {
      clearFindHighlights();
      return;
    }
    const element = currentSegmentId
      ? Array.from(root.querySelectorAll<HTMLElement>("[data-segment-id]")).find(
          (el) => el.dataset.segmentId === currentSegmentId,
        ) ?? null
      : null;
    if (element) {
      const details = element.querySelector("details");
      if (details && !details.open) details.open = true;
      element.scrollIntoView?.({ block: "center" });
    }
    paintFindHighlights(root, findQuery, element, currentOccurrence);
  }, [findOpen, findQuery, currentSegmentId, currentOccurrence, segments]);

  useEffect(() => clearFindHighlights, []);

  const closeFind = () => {
    setFindOpen(false);
    clearFindHighlights();
    inputRef?.current?.focus();
  };

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
        <div
          className="session-terminal-chrome-titles"
          title={[
            title,
            `Folder: ${cwd}`,
            ...(branch ? [`Branch: ${branch}`] : []),
            `Session: ${sessionId}`,
            ...(details ? [details] : []),
          ].join("\n")}
        >
          <h2 className="session-terminal-title">{title}</h2>
          <span className="session-terminal-subtitle">
            {branch && (
              <span className="session-branch" aria-label="Git branch">
                ⎇ {branch}
              </span>
            )}
            {folderName(cwd)}
            {chainLabel && <span className="chain-label">{chainLabel}</span>}
            {contextFill && <span className="chain-label">{contextFill}</span>}
          </span>
        </div>
        <div className="session-terminal-chrome-actions">
          {headerExtra}
          <button
            type="button"
            className="secondary-button"
            onClick={onCancelTurn}
            disabled={busy || !promptInFlight}
            aria-label="Cancel turn"
            title="Cancel in-flight turn (Esc)"
          >
            Cancel
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
            aria-label="Stop session"
            title="Stop this session"
          >
            Stop
          </button>
        </div>
      </header>

      {folderWarning && !statusInBar && (
        <p className="folder-warning" role="status">
          {folderWarning}
        </p>
      )}

      {activity && !statusInBar && (
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

      {questionRequest && onQuestionAnswer && onQuestionSkip && onQuestionCancel && (
        <div className="session-permission-sticky">
          <QuestionCard
            request={questionRequest}
            busy={busy}
            onAnswer={onQuestionAnswer}
            onSkip={onQuestionSkip}
            onCancel={onQuestionCancel}
          />
        </div>
      )}

      {findOpen && (
        <ChatFindBar
          query={findQuery}
          index={currentHit ? Math.min(findIndex, findHits.length - 1) : -1}
          count={findHits.length}
          focusKey={findFocusKey}
          onQuery={(query) => {
            setFindQuery(query);
            setFindIndex(0);
          }}
          onStep={(delta) => {
            if (findHits.length === 0) return;
            setFindIndex((index) => {
              const at = Math.min(index, findHits.length - 1);
              return (at + delta + findHits.length) % findHits.length;
            });
          }}
          onClose={closeFind}
          onSearchAll={onSearchAllChats}
        />
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
              data-segment-id={seg.id}
              className={`session-stream session-stream-${seg.kind}${
                findOpen && seg.id === currentSegmentId ? " session-find-current" : ""
              }`}
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
                      targets={handoff.targets ?? []}
                      primaryTarget={handoff.primaryTarget}
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
          aria-label={canSendFollowUp ? "Follow-up message" : "Message"}
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
