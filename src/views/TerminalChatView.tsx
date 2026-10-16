import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import type { ChatEntry, ChatEntryStatus } from "../bridge";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { detectPlatform, type Platform } from "../keymap";
import {
  chatRows,
  decisionText,
  durationMs,
  formatDuration,
  openDecision,
  runningSubAgents,
  STATUS_TEXT,
  subAgentText,
  toolGroupText,
  type TerminalViewMode,
  type ToolEntry,
} from "../terminal/chatEntries";
import { useChatEntries } from "../terminal/chatEntriesStore";
import { useLivePty, useLivePtyStart } from "../terminal/useLivePty";
import {
  PermissionCard,
  TerminalComposer,
  usePermissionDialog,
  type TerminalComposerHandle,
} from "./TerminalChatControls";

/** Status classes shared with the chat tab's tool rows (App.css). */
const STATUS_CLASS: Record<ChatEntryStatus, string> = {
  running: "running",
  done: "completed",
  error: "failed",
  stopped: "stopped",
};

function StatusPill({ status, text }: { status: ChatEntryStatus; text?: string }) {
  return (
    <span className={`session-tool-status session-tool-status-${STATUS_CLASS[status]}`}>
      {text ?? STATUS_TEXT[status]}
    </span>
  );
}

function ToolRow({ tool }: { tool: ToolEntry }) {
  const took = durationMs(tool.at, tool.endedAt);
  return (
    <div className={`session-stream-tool session-stream-tool-${STATUS_CLASS[tool.status]}`}>
      <span className="session-tool-marker" aria-hidden>
        ▸
      </span>
      <span className="session-tool-label" title={tool.title}>
        {tool.title}
      </span>
      {took !== null && <span className="terminal-chat-took">{formatDuration(took)}</span>}
      <StatusPill status={tool.status} />
    </div>
  );
}

/**
 * A plan or question still open. Claude Code asks it as a terminal dialog
 * whose keys the app cannot read reliably, so it is answered there.
 */
function AnswerInTerminal({ onShowTerminal }: { onShowTerminal: () => void }) {
  return (
    <div className="terminal-chat-answer-here">
      <span>Answer in the terminal.</span>
      <button type="button" className="secondary-button" onClick={onShowTerminal}>
        Show terminal
      </button>
    </div>
  );
}

function EntryView({
  entry,
  open,
  onShowTerminal,
}: {
  entry: ChatEntry;
  /** The plan or question Claude Code waits on (see `openDecision`). */
  open: boolean;
  onShowTerminal: () => void;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="session-stream session-stream-user">
          <div className="session-user-turn">
            <div className="session-user-label" aria-hidden>
              You ›
            </div>
            <div className="session-user-body terminal-chat-prompt">{entry.text}</div>
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="session-stream session-stream-agent">
          <div className="session-agent-body">
            <ChatMarkdown>{entry.text}</ChatMarkdown>
          </div>
        </div>
      );
    case "tool":
      return <ToolRow tool={entry} />;
    case "subAgent": {
      const took = durationMs(entry.at, entry.endedAt);
      return (
        <div
          className={`terminal-chat-subagent terminal-chat-subagent-${STATUS_CLASS[entry.status]}`}
          data-testid="terminal-chat-subagent"
        >
          <span className="terminal-chat-subagent-label">Sub-agent</span>
          <span className="terminal-chat-subagent-text" title={entry.description}>
            {entry.description}
            {entry.agentType && <span className="terminal-chat-subagent-type"> · {entry.agentType}</span>}
          </span>
          {took !== null && <span className="terminal-chat-took">{formatDuration(took)}</span>}
          <StatusPill
            status={entry.status}
            text={entry.background && entry.status === "done" ? "Started in background" : undefined}
          />
        </div>
      );
    }
    case "plan":
      return (
        <section className="session-card terminal-chat-card" aria-label="Plan">
          <header className="terminal-chat-card-head">
            <h3>Plan</h3>
            <StatusPill status={entry.status} text={decisionText("plan", entry.status)} />
          </header>
          <div className="session-stream-agent terminal-chat-plan">
            <ChatMarkdown>{entry.plan || "_The plan is empty._"}</ChatMarkdown>
          </div>
          {open && <AnswerInTerminal onShowTerminal={onShowTerminal} />}
        </section>
      );
    case "question":
      return (
        <section className="session-card terminal-chat-card" aria-label="Question">
          <header className="terminal-chat-card-head">
            <h3>Question</h3>
            <StatusPill status={entry.status} text={decisionText("question", entry.status)} />
          </header>
          {entry.questions.map((question, index) => (
            <div key={index} className="terminal-chat-question">
              <p className="terminal-chat-question-text">
                {question.header && <strong>{question.header}: </strong>}
                {question.question}
              </p>
              {question.options.length > 0 && (
                <ul className="session-card-list">
                  {question.options.map((option, at) => (
                    <li key={at}>{option}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {open && <AnswerInTerminal onShowTerminal={onShowTerminal} />}
        </section>
      );
  }
}

export type TerminalChatViewProps = {
  tabId: string;
  /** The tab's state is Needs you. */
  needsYou: boolean;
  onShowTerminal: () => void;
  /** The tab's state is Working: the composer queues and offers Stop. */
  working?: boolean;
  /** Claude Code exited. */
  exited?: boolean;
  platform?: Platform;
  /** Earlier sends of this tab, newest first. */
  history?: string[];
  beforeSend?: (tabId: string) => Promise<void>;
  onSent?: (text: string) => void;
  composerRef?: Ref<TerminalComposerHandle>;
};

/**
 * Chat view of a Claude terminal tab: its session log as a conversation, a
 * composer that types into the same PTY, and the permission dialog as
 * buttons. The PTY keeps running underneath; the terminal is one switch away.
 */
export function TerminalChatView({
  tabId,
  needsYou,
  onShowTerminal,
  working = false,
  exited = false,
  platform = detectPlatform(typeof navigator === "undefined" ? "" : navigator.platform),
  history,
  beforeSend,
  onSent,
  composerRef,
}: TerminalChatViewProps) {
  const { entries } = useChatEntries(tabId);
  const dialog = usePermissionDialog(tabId);
  // Only what this tab's current Claude Code asked: one an earlier process
  // left open (it crashed, `--continue` reopened the log) gets no result.
  const ptyStart = useLivePty(tabId)?.startedAt ?? null;
  const decision = useMemo(() => openDecision(entries, ptyStart), [entries, ptyStart]);
  // Claude Code waits on a dialog: Enter there picks an option, so the composer holds.
  const blocked = needsYou || !!dialog || !!decision;
  // A permission answer whose dialog went only by the detector's timer.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const rows = useMemo(() => chatRows(entries), [entries]);
  const screenRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (screen && pinned.current) screen.scrollTop = screen.scrollHeight;
  }, [rows]);

  useEffect(() => {
    pinned.current = true;
    setUnconfirmed(false);
  }, [tabId]);

  // A new dialog replaces the note.
  useEffect(() => {
    if (dialog) setUnconfirmed(false);
  }, [dialog]);

  const showTerminal = () => {
    setUnconfirmed(false);
    onShowTerminal();
  };

  return (
    <div className="terminal-chat" data-testid="terminal-chat-view">
      {needsYou && !dialog && (
        <div className="terminal-chat-banner" role="alert">
          <span>Claude is waiting for you in the terminal.</span>
          <button type="button" className="primary-button" onClick={onShowTerminal}>
            Show terminal
          </button>
        </div>
      )}
      <div
        ref={screenRef}
        className="session-terminal-screen terminal-chat-screen"
        role="log"
        aria-label="Conversation"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {rows.length === 0 && (
          <p className="session-terminal-placeholder">
            No conversation yet. Messages show here once Claude writes them to the session log.
          </p>
        )}
        {rows.map((row) =>
          row.kind === "tools" ? (
            <details
              key={row.key}
              className="terminal-chat-tools"
              open={row.tools.some((tool) => tool.status === "running") || undefined}
            >
              <summary>{toolGroupText(row.tools)}</summary>
              {row.tools.map((tool) => (
                <ToolRow key={tool.seq} tool={tool} />
              ))}
            </details>
          ) : (
            <EntryView
              key={row.key}
              entry={row.entry}
              open={row.entry.seq === decision?.seq}
              onShowTerminal={onShowTerminal}
            />
          ),
        )}
      </div>
      {dialog && (
        <PermissionCard
          tabId={tabId}
          dialog={dialog}
          onShowTerminal={onShowTerminal}
          onUnconfirmed={() => setUnconfirmed(true)}
        />
      )}
      {!dialog && unconfirmed && (
        <div className="terminal-chat-answer-failed" role="alert">
          <span>Couldn't confirm — check the terminal.</span>
          <button type="button" className="secondary-button" onClick={showTerminal}>
            Show terminal
          </button>
        </div>
      )}
      <TerminalComposer
        ref={composerRef}
        tabId={tabId}
        platform={platform}
        working={working}
        exited={exited}
        blocked={blocked}
        history={history}
        beforeSend={beforeSend}
        onSent={(text) => {
          setUnconfirmed(false);
          onSent?.(text);
        }}
        onShowTerminal={onShowTerminal}
      />
    </div>
  );
}

/** "Terminal · Chat" in a Claude terminal tab's header. */
export function TerminalViewSwitch({
  tabId,
  view,
  onChange,
}: {
  tabId: string;
  view: TerminalViewMode;
  onChange: (view: TerminalViewMode) => void;
}) {
  return (
    <div className="segmented terminal-view-switch" role="radiogroup" aria-label="Show as">
      {(["terminal", "chat"] as const).map((value) => (
        <label key={value} className="segmented-option">
          <input
            type="radio"
            name={`terminal-view-${tabId}`}
            checked={view === value}
            onChange={() => onChange(value)}
          />
          {value === "terminal" ? "Terminal" : "Chat"}
        </label>
      ))}
    </div>
  );
}

/**
 * "2 sub-agents running" in a Claude terminal tab's header; nothing when none
 * are. None once the PTY exited (a sub-agent dies with Claude Code) or for
 * one an earlier process left running.
 */
export function SubAgentIndicator({ tabId }: { tabId: string }) {
  const { entries } = useChatEntries(tabId);
  const ptyStart = useLivePtyStart(tabId);
  const running = ptyStart === null ? [] : runningSubAgents(entries, ptyStart);
  const text = subAgentText(running.length);
  if (!text) return null;
  return (
    <span
      className="terminal-header-subagents"
      title={running.map((agent) => agent.description).join("\n")}
    >
      {text}
    </span>
  );
}
