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
  | {
      kind: "needs";
      needs: TerminalNeeds;
      toolId: string;
      toolTitle: string;
      /** Which permission prompt this is: stays the same while one dialog is up. */
      promptKey?: string;
    }
  | { kind: "working" }
  | { kind: "idle" };

type LogView = Pick<TerminalSessionLog, "turnDone" | "openTool" | "pendingTools">;
export type PendingTool = { id: string; name: string; title: string; hint?: string };
/** The tool a permission dialog on screen asks about, and which prompt it is. */
export type DialogTool = PendingTool & { promptKey: string };

export type TerminalStateInput = {
  log: LogView | null | undefined;
  /** The unanswered tool whose permission dialog is on screen (`dialogToolFor`). */
  dialogTool: DialogTool | null;
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
  // A permission dialog on screen is what Claude Code is asking now, even
  // with a plan or question queued behind it.
  const dialog = input.dialogTool;
  if (dialog && log && !log.turnDone) {
    return {
      kind: "needs",
      needs: "permission",
      toolId: dialog.id,
      toolTitle: dialog.title,
      promptKey: dialog.promptKey,
    };
  }
  const open = log && !log.turnDone ? log.openTool : null;
  if (open?.name === "ExitPlanMode") {
    return { kind: "needs", needs: "plan", toolId: open.id, toolTitle: open.title };
  }
  if (open?.name === "AskUserQuestion") {
    return { kind: "needs", needs: "question", toolId: open.id, toolTitle: open.title };
  }
  const working = log ? !log.turnDone : input.ptyBusy;
  return working ? { kind: "working" } : { kind: "idle" };
}

export function sameTerminalState(a: TerminalState | undefined, b: TerminalState | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "exited" && b.kind === "exited") return a.code === b.code;
  if (a.kind === "needs" && b.kind === "needs") {
    return (
      a.needs === b.needs &&
      a.toolId === b.toolId &&
      a.toolTitle === b.toolTitle &&
      (a.promptKey ?? "") === (b.promptKey ?? "")
    );
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
 * The permission dialog on screen.
 * - `since`, `context`: when it was last drawn in full, and its text then
 *   (the question and the lines above, which may include transcript lines).
 * - `drawNew`: that draw showed a different dialog body than the one before.
 * - `toolId`: the unanswered call it asks about, set by a log read after the
 *   draw. `fresh`: drawn since that read, so the next read decides again.
 * - `promptKey`: which prompt is shown; it changes only for a new prompt, so
 *   a redraw of the same dialog, or moving it to another call, does not
 *   notify again.
 */
export type DialogOwner = {
  since: number;
  context: string;
  drawNew: boolean;
  toolId: string | null;
  fresh: boolean;
  promptKey: number | null;
};

/** Lines kept as the dialog's body: the question and the lines just above it. */
const BODY_LINES = 4;
const dialogBody = (context: string) => context.split("\n").slice(-BODY_LINES).join("\n");

/** A dialog that was just drawn (again), keeping what it showed until the next read. */
export function dialogDrawn(owner: DialogOwner | undefined, now: number, context: string): DialogOwner {
  const changed = !owner || dialogBody(owner.context) !== dialogBody(context);
  return {
    since: now,
    context,
    // A change not yet seen by a read still counts.
    drawNew: changed || (!!owner?.fresh && owner.drawNew),
    toolId: owner?.toolId ?? null,
    fresh: true,
    promptKey: owner?.promptKey ?? null,
  };
}

const squash = (text: string) => text.replace(/\s+/g, "");

/**
 * Which unanswered call the dialog asks about: the one whose hint (file
 * name, host, command) ends closest to the question, since lines higher up
 * can be transcript lines for other calls; on a tie the longer hint, then a
 * call other than `answered` (a dialog drawn again after an answer is for
 * the next call); else the oldest. Claude Code asks about parallel calls
 * oldest first, but calls that need no permission (reads, fetches to allowed
 * hosts, subagents) may still be running ahead.
 */
function toolForPrompt(
  log: LogView,
  context: string,
  answered: string | null,
): PendingTool | undefined {
  const candidates = pendingToolsOf(log).filter((tool) => !OWN_PROMPT.has(tool.name));
  const screen = squash(context);
  const score = (tool: PendingTool): [number, number, number] => {
    const hint = squash(tool.hint ?? "");
    const at = hint ? screen.lastIndexOf(hint) : -1;
    return [at < 0 ? -1 : at + hint.length, at < 0 ? 0 : hint.length, tool.id === answered ? 0 : 1];
  };
  let best: PendingTool | undefined;
  let bestScore: [number, number, number] = [-1, 0, 0];
  for (const tool of candidates) {
    const next = score(tool);
    if (next[0] < 0) continue;
    const better = next.findIndex((value, i) => value !== bestScore[i]);
    if (better >= 0 && next[better] > bestScore[better]) {
      best = tool;
      bestScore = next;
    }
  }
  if (best) return best;
  // Nothing named: the oldest, but not the call just answered.
  return candidates.find((tool) => tool.id !== answered) ?? candidates[0];
}

/**
 * After a session-log read that started at `readAt`: which call the visible
 * dialog asks about, and whether to hide it. It is hidden when the turn
 * ends, or when its call left the log after the user typed (`answering`).
 * Another call finishing or appearing, a failed read or a read older than
 * the draw never hide it. If its call left the log without typing here (a
 * parallel call that needed no permission was taken for it), it moves to
 * another unanswered call, as the same prompt; with none left, nothing can
 * be asking.
 */
export function dialogAfterRead(
  owner: DialogOwner | undefined,
  log: LogView | null,
  readAt: number,
  answering: boolean,
): { owner: DialogOwner | undefined; clear: boolean } {
  if (!owner || !log || readAt < owner.since) return { owner, clear: false };
  if (log.turnDone) return { owner: undefined, clear: true };
  const stillOpen = pendingToolsOf(log).some((tool) => tool.id === owner.toolId);
  const settled = !owner.fresh && owner.toolId !== null;
  if (settled && stillOpen) return { owner, clear: false };
  if (settled && answering) return { owner: undefined, clear: true };
  // A fresh draw with a call already tied is a redraw after the user typed.
  const next = toolForPrompt(log, owner.context, owner.fresh ? owner.toolId : null);
  if (!next && settled) return { owner: undefined, clear: true };
  // Not written to the log yet: keep waiting for its call.
  if (!next) return { owner: { ...owner, toolId: stillOpen ? owner.toolId : null }, clear: false };
  // A new prompt: first one, a different dialog body, or the same body drawn
  // again for another call (the same command asked twice).
  const isNew =
    owner.fresh &&
    (owner.promptKey === null || owner.drawNew || (owner.toolId !== null && next.id !== owner.toolId));
  return {
    owner: {
      ...owner,
      toolId: next.id,
      fresh: false,
      drawNew: false,
      promptKey: isNew || owner.promptKey === null ? owner.since : owner.promptKey,
    },
    clear: false,
  };
}

/** The unanswered call the on-screen dialog asks about, once a read tied them. */
export function dialogToolFor(
  owner: DialogOwner | undefined,
  log: LogView | null | undefined,
): DialogTool | null {
  if (!owner?.toolId || owner.promptKey === null) return null;
  const tool = pendingToolsOf(log).find((item) => item.id === owner.toolId);
  return tool ? { ...tool, promptKey: String(owner.promptKey) } : null;
}
