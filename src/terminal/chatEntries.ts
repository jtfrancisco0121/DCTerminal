/**
 * The chat view of a Claude terminal tab: its session log as ordered entries
 * (src-tauri/src/claude_session_log/chat.rs), merged from the backend's
 * updates. Pure; the shared subscription is in ./chatEntriesStore.ts.
 */
import type { ChatEntriesUpdate, ChatEntry, ChatEntryStatus } from "../bridge";

export type ChatEntriesState = {
  sessionId: string | null;
  /** The newest revision seen; sent back as `since`. */
  revision: number | null;
  /** Ascending `seq`. */
  entries: ChatEntry[];
};

export const EMPTY_CHAT: ChatEntriesState = { sessionId: null, revision: null, entries: [] };

/**
 * Applies one update. A reset (or another session) replaces the list;
 * otherwise entries are merged by `seq`, and those the backend dropped
 * (below `firstSeq`) go too. Returns `state` when nothing changed.
 */
export function applyChatUpdate(state: ChatEntriesState, update: ChatEntriesUpdate): ChatEntriesState {
  if (update.reset || update.sessionId !== state.sessionId) {
    return { sessionId: update.sessionId, revision: update.revision, entries: [...update.entries] };
  }
  const first = state.entries[0]?.seq;
  if (update.entries.length === 0 && (first === undefined || first >= update.firstSeq)) {
    return update.revision === state.revision ? state : { ...state, revision: update.revision };
  }
  const bySeq = new Map<number, ChatEntry>();
  for (const entry of state.entries) bySeq.set(entry.seq, entry);
  for (const entry of update.entries) bySeq.set(entry.seq, entry);
  const entries = [...bySeq.values()]
    .filter((entry) => entry.seq >= update.firstSeq)
    .sort((a, b) => a.seq - b.seq);
  return { sessionId: state.sessionId, revision: update.revision, entries };
}

export type SubAgentEntry = Extract<ChatEntry, { kind: "subAgent" }>;

/**
 * The entry came from the Claude Code process started at `ptyStart` (ms), or
 * later: an entry left "running" by an earlier process (it crashed, then
 * `--continue` reopened the same log) never gets its result. Null
 * `ptyStart` (no start known) and an entry without a time both count.
 */
export function fromCurrentRun(entry: ChatEntry, ptyStart: number | null): boolean {
  if (ptyStart === null || !entry.at) return true;
  const at = Date.parse(entry.at);
  return Number.isNaN(at) || at >= ptyStart;
}

/** Sub-agents with no result yet from the current run (see `fromCurrentRun`), oldest first. */
export function runningSubAgents(entries: readonly ChatEntry[], ptyStart: number | null = null): SubAgentEntry[] {
  return entries.filter(
    (entry): entry is SubAgentEntry =>
      entry.kind === "subAgent" && entry.status === "running" && fromCurrentRun(entry, ptyStart),
  );
}

export type DecisionEntry = Extract<ChatEntry, { kind: "plan" | "question" }>;

/**
 * The plan or question Claude Code waits on: the newest one with no result,
 * after the latest prompt and asked by the current run (see
 * `fromCurrentRun`). Null when none is open.
 */
export function openDecision(entries: readonly ChatEntry[], ptyStart: number | null): DecisionEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    // A prompt came after it: Claude Code is no longer asking.
    if (entry.kind === "user") return null;
    if (entry.kind !== "plan" && entry.kind !== "question") continue;
    if (entry.status === "running" && fromCurrentRun(entry, ptyStart)) return entry;
  }
  return null;
}

/** "1 sub-agent running", "2 sub-agents running"; null for none. */
export function subAgentText(count: number): string | null {
  if (count <= 0) return null;
  return `${count} sub-agent${count === 1 ? "" : "s"} running`;
}

export const STATUS_TEXT: Record<ChatEntryStatus, string> = {
  running: "Running",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
};

/** Plan and question entries read as the user's decision, not a tool result. */
export function decisionText(kind: "plan" | "question", status: ChatEntryStatus): string {
  if (status === "running") return "Waiting for you in the terminal";
  if (kind === "plan") return status === "done" ? "Approved" : status === "error" ? "Not approved" : "Stopped";
  return status === "done" ? "Answered" : status === "error" ? "Declined" : "Stopped";
}

/** Milliseconds between two ISO stamps, or null when either is missing or bad. */
export function durationMs(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** 1.25 s → "1.3s", 42 s → "42s", 125 s → "2m 05s". */
export function formatDuration(ms: number): string {
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  const whole = Math.round(secs);
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

export type ToolEntry = Extract<ChatEntry, { kind: "tool" }>;

/** What the chat view draws: one entry, or a run of tool calls folded into one row. */
export type ChatRow =
  | { kind: "entry"; key: string; entry: ChatEntry }
  | { kind: "tools"; key: string; tools: ToolEntry[] };

/** Runs of this many tool calls or more fold into one collapsed row. */
export const TOOL_GROUP_MIN = 3;

export function chatRows(entries: readonly ChatEntry[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let run: ToolEntry[] = [];
  const flush = () => {
    if (run.length >= TOOL_GROUP_MIN) {
      rows.push({ kind: "tools", key: `tools-${run[0].seq}`, tools: run });
    } else {
      for (const tool of run) rows.push({ kind: "entry", key: `e-${tool.seq}`, entry: tool });
    }
    run = [];
  };
  for (const entry of entries) {
    if (entry.kind === "tool") {
      run.push(entry);
      continue;
    }
    flush();
    rows.push({ kind: "entry", key: `e-${entry.seq}`, entry });
  }
  flush();
  return rows;
}

/** "5 tool calls", plus how many are running or failed. */
export function toolGroupText(tools: readonly ToolEntry[]): string {
  const running = tools.filter((tool) => tool.status === "running").length;
  const failed = tools.filter((tool) => tool.status === "error").length;
  const parts = [`${tools.length} tool calls`];
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/** The view a Claude terminal tab shows (kept across restarts: ./terminalViews.ts). */
export type TerminalViewMode = "terminal" | "chat";

export function terminalViewOf(
  views: Readonly<Record<string, TerminalViewMode>>,
  tabId: string | null | undefined,
): TerminalViewMode {
  return (tabId && views[tabId]) || "terminal";
}
