/**
 * What the terminal header's state pill says (R16): Working · 12s, Needs you,
 * Done · <verdict>, Exited · code N, State unknown · check the terminal. One place, so the active tab, the second
 * pane and every grid cell read alike.
 */
import { NEEDS_YOU_TEXT, type TabStatus } from "../tabStatus";
import type { TerminalState } from "./claudeState";

export type HeaderTone = "working" | "unknown" | "needs" | "done" | "exited" | "idle";

export type HeaderState = {
  tone: HeaderTone;
  /** Pill text without the elapsed time. */
  text: string;
  /** Whether "Working · 12s" counts up. */
  timed: boolean;
};

/** 12s, 1m 05s, 1h 02m. */
export function formatElapsed(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/**
 * `state` is the role terminal's derived state; `status` is the tab chip's
 * status, which covers other terminals by output activity. `turnEnded` is
 * set once the session log shows the turn finished.
 */
export function headerStateOf(input: {
  state?: TerminalState;
  status?: TabStatus;
  turnEnded: boolean;
  /** A reviewer's verdict, when it has one. */
  verdict?: string | null;
}): HeaderState {
  const { state, status, turnEnded, verdict } = input;
  if (state?.kind === "exited") {
    return { tone: "exited", text: `Exited · code ${state.code}`, timed: false };
  }
  if (!state && typeof status?.exitCode === "number") {
    return { tone: "exited", text: `Exited · code ${status.exitCode}`, timed: false };
  }
  const needs = state?.kind === "needs" ? state.needs : !state ? status?.needsYou : null;
  if (needs) {
    // Which kind of prompt, worded as the tab chip's tooltip words it.
    return { tone: "needs", text: `Needs you: ${NEEDS_YOU_TEXT[needs]}`, timed: false };
  }
  if (state?.kind === "working" && state.unknown) {
    return { tone: "unknown", text: "State unknown · check the terminal", timed: false };
  }
  if (state?.kind === "working" || (!state && status?.busy)) {
    return { tone: "working", text: "Working", timed: true };
  }
  if (turnEnded) {
    return { tone: "done", text: verdict ? `Done · ${verdict}` : "Done", timed: false };
  }
  return { tone: "idle", text: "Idle", timed: false };
}

/** The pill's full text with the elapsed time when it is working. */
export function headerPillText(state: HeaderState, elapsedSeconds: number): string {
  return state.timed ? `${state.text} · ${formatElapsed(elapsedSeconds)}` : state.text;
}

/**
 * When each working tab's turn started, in ms. Kept per tab (not per header
 * instance) so "Working · 12s" stays right across tab switches and remounts.
 * `turnStartedAt` is the session log's prompt time when there is one;
 * otherwise the first time the tab was seen working. Tabs that stopped
 * working drop out. Returns `prev` when nothing changed.
 */
export function trackWorkingSince(
  prev: Record<string, number>,
  tabs: { tabId: string; working: boolean; turnStartedAt?: number | null }[],
  now: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  let changed = false;
  for (const { tabId, working, turnStartedAt } of tabs) {
    if (!working) continue;
    const fromLog =
      typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt)
        ? Math.min(turnStartedAt, now)
        : null;
    next[tabId] = fromLog ?? prev[tabId] ?? now;
    if (next[tabId] !== prev[tabId]) changed = true;
  }
  if (!changed && Object.keys(prev).length === Object.keys(next).length) return prev;
  return next;
}
