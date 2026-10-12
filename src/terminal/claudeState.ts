/**
 * One state per Claude Code role terminal, shared by the tab chip, status
 * bar, grid, chain overview lane, hand-off message and notifications.
 *
 * Order: exited, then needs you, then working, then idle. "Needs you" comes
 * only from the session log's open tool: ExitPlanMode and AskUserQuestion
 * right away, any other tool only while the PTY shows Claude Code's
 * permission dialog. Quiet time alone never means "needs you".
 */

import type { TerminalSessionLog } from "../bridge";

export type TerminalNeeds = "plan" | "question" | "permission";

export type TerminalState =
  | { kind: "exited"; code: number }
  | { kind: "needs"; needs: TerminalNeeds; toolId: string; toolTitle: string }
  | { kind: "working" }
  | { kind: "idle" };

export type TerminalStateInput = {
  log: Pick<TerminalSessionLog, "turnDone" | "openTool"> | null | undefined;
  /** The permission dialog detector currently sees the dialog. */
  dialogVisible: boolean;
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
  if (open) {
    const needs: TerminalNeeds | null =
      open.name === "ExitPlanMode"
        ? "plan"
        : open.name === "AskUserQuestion"
          ? "question"
          : input.dialogVisible
            ? "permission"
            : null;
    if (needs) return { kind: "needs", needs, toolId: open.id, toolTitle: open.title };
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

/**
 * The permission dialog on screen: when the detector last saw it drawn, and
 * the open tool it asks about. `fresh` means drawn since the last read that
 * named its tool, so the next read decides the tool again (after an answer
 * the next dialog may be for a different tool).
 */
export type DialogOwner = { since: number; toolId: string | null; fresh: boolean };

/** A dialog that was just drawn (again), keeping the tool it showed for. */
export function dialogDrawn(owner: DialogOwner | undefined, now: number): DialogOwner {
  return { since: now, toolId: owner?.toolId ?? null, fresh: true };
}

/**
 * After a session-log read that started at `readAt`: which tool the visible
 * dialog belongs to, and whether to hide it. It is hidden only once its own
 * tool leaves the log (answered or rejected) or the turn ends; never because
 * an earlier tool finished, and never on a failed or stale read.
 */
export function dialogAfterRead(
  owner: DialogOwner | undefined,
  log: Pick<TerminalSessionLog, "turnDone" | "openTool"> | null,
  readAt: number,
): { owner: DialogOwner | undefined; clear: boolean } {
  if (!owner || !log || readAt < owner.since) return { owner, clear: false };
  if (log.turnDone) return { owner: undefined, clear: true };
  const openId = log.openTool?.id ?? null;
  if (owner.fresh || owner.toolId === null) {
    // Not flushed to the log yet: keep waiting for its tool.
    if (!openId) return { owner, clear: false };
    return { owner: { since: owner.since, toolId: openId, fresh: false }, clear: false };
  }
  return openId === owner.toolId ? { owner, clear: false } : { owner: undefined, clear: true };
}

/** The dialog counts for the log's open tool only once it is known to ask about it. */
export function dialogShownFor(
  owner: DialogOwner | undefined,
  log: Pick<TerminalSessionLog, "turnDone" | "openTool"> | null | undefined,
): boolean {
  const openId = log && !log.turnDone ? log.openTool?.id : undefined;
  return !!owner && !!openId && owner.toolId === openId;
}
