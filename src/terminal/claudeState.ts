/**
 * One state per Claude Code role terminal, shared by the tab chip, status
 * bar, grid, chain overview lane, hand-off message and notifications.
 *
 * Order: exited, then needs you, then working, then idle. "Needs you" comes
 * only from the session log's unanswered tools: ExitPlanMode and
 * AskUserQuestion right away, any other tool only while the PTY shows Claude
 * Code's permission dialog for it. Quiet time alone never means "needs you".
 */

import type { TerminalSessionLog } from "../bridge";

export type TerminalNeeds = "plan" | "question" | "permission";

export type TerminalState =
  | { kind: "exited"; code: number }
  | { kind: "needs"; needs: TerminalNeeds; toolId: string; toolTitle: string }
  | { kind: "working" }
  | { kind: "idle" };

type LogView = Pick<TerminalSessionLog, "turnDone" | "openTool" | "pendingTools">;
export type PendingTool = { id: string; name: string; title: string };

export type TerminalStateInput = {
  log: LogView | null | undefined;
  /** The unanswered tool whose permission dialog is on screen (`dialogToolFor`). */
  dialogTool: PendingTool | null;
  /** Output arrived recently (the fallback when there is no log yet). */
  ptyBusy: boolean;
  /** null while the process runs. */
  exitCode: number | null | undefined;
};

export function deriveTerminalState(input: TerminalStateInput): TerminalState {
  if (input.exitCode !== null && input.exitCode !== undefined) {
    return { kind: "exited", code: input.exitCode };
  }
  const log = input.log;
  const open = log && !log.turnDone ? log.openTool : null;
  if (open?.name === "ExitPlanMode") {
    return { kind: "needs", needs: "plan", toolId: open.id, toolTitle: open.title };
  }
  if (open?.name === "AskUserQuestion") {
    return { kind: "needs", needs: "question", toolId: open.id, toolTitle: open.title };
  }
  const dialog = input.dialogTool;
  if (dialog && log && !log.turnDone) {
    return { kind: "needs", needs: "permission", toolId: dialog.id, toolTitle: dialog.title };
  }
  const working = log ? !log.turnDone : input.ptyBusy;
  return working ? { kind: "working" } : { kind: "idle" };
}

export function sameTerminalState(a: TerminalState | undefined, b: TerminalState | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "exited" && b.kind === "exited") return a.code === b.code;
  if (a.kind === "needs" && b.kind === "needs") {
    return a.needs === b.needs && a.toolId === b.toolId && a.toolTitle === b.toolTitle;
  }
  return true;
}

const NEEDS_WAITING: Record<TerminalNeeds, string> = {
  plan: "a plan to review",
  question: "a question",
  permission: "a permission request",
};

/** "waiting for you on a plan to review", for the hand-off block message. */
export function terminalWaitingText(needs: TerminalNeeds): string {
  return `waiting for you on ${NEEDS_WAITING[needs]}`;
}

/** Toast / OS notification body for a new "needs you". */
export function terminalNeedsMessage(state: Extract<TerminalState, { kind: "needs" }>): string {
  if (state.needs === "plan") return "Claude Code needs your approval for the plan";
  if (state.needs === "question") return "Claude Code has a question for you";
  return state.toolTitle
    ? `Claude Code needs your permission: ${state.toolTitle}`
    : "Claude Code needs your permission";
}

/** The current turn's unanswered tools, oldest first (older backends: the open tool). */
export function pendingToolsOf(log: LogView | null | undefined): PendingTool[] {
  if (!log || log.turnDone) return [];
  return log.pendingTools ?? (log.openTool ? [log.openTool] : []);
}

/** Tools that show their own prompt, never the permission dialog. */
const OWN_PROMPT = new Set(["ExitPlanMode", "AskUserQuestion"]);

/**
 * The permission dialog on screen: when the detector last saw it drawn, and
 * the unanswered tool it asks about. `fresh` means drawn since the last read
 * that named its tool, so the next read decides the tool again (after an
 * answer the next dialog is for another tool).
 */
export type DialogOwner = { since: number; toolId: string | null; fresh: boolean };

/** A dialog that was just drawn (again), keeping the tool it showed for. */
export function dialogDrawn(owner: DialogOwner | undefined, now: number): DialogOwner {
  return { since: now, toolId: owner?.toolId ?? null, fresh: true };
}

/**
 * After a session-log read that started at `readAt`: which tool the visible
 * dialog belongs to, and whether to hide it. Claude Code asks about parallel
 * calls oldest first, so a new dialog is for the oldest unanswered tool. It
 * is hidden only once its own tool is answered or rejected, or the turn
 * ends; never because another tool finished or appeared, and never on a
 * failed or stale read.
 */
export function dialogAfterRead(
  owner: DialogOwner | undefined,
  log: LogView | null,
  readAt: number,
): { owner: DialogOwner | undefined; clear: boolean } {
  if (!owner || !log || readAt < owner.since) return { owner, clear: false };
  if (log.turnDone) return { owner: undefined, clear: true };
  const pending = pendingToolsOf(log);
  if (owner.fresh || owner.toolId === null) {
    const next = pending.find((tool) => !OWN_PROMPT.has(tool.name));
    // Not written to the log yet: keep waiting for its tool.
    if (!next) return { owner, clear: false };
    return { owner: { since: owner.since, toolId: next.id, fresh: false }, clear: false };
  }
  return pending.some((tool) => tool.id === owner.toolId)
    ? { owner, clear: false }
    : { owner: undefined, clear: true };
}

/** The unanswered tool the on-screen dialog asks about, once a read tied them. */
export function dialogToolFor(
  owner: DialogOwner | undefined,
  log: LogView | null | undefined,
): PendingTool | null {
  if (!owner?.toolId) return null;
  return pendingToolsOf(log).find((tool) => tool.id === owner.toolId) ?? null;
}
