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
      /** A permission dialog's text: tells two prompts for one tool apart. */
      prompt?: string;
    }
  | { kind: "working" }
  | { kind: "idle" };

type LogView = Pick<TerminalSessionLog, "turnDone" | "openTool" | "pendingTools">;
export type PendingTool = { id: string; name: string; title: string; hint?: string };
/** The tool a permission dialog on screen asks about, and that dialog's text. */
export type DialogTool = PendingTool & { prompt: string };

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
      prompt: dialog.prompt,
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
      (a.prompt ?? "") === (b.prompt ?? "")
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
 * The permission dialog on screen. `since`: when it was last drawn in full;
 * `prompt`: its text then. `toolId` and `shownPrompt` are what is shown, set
 * by a log read after the draw. `fresh` means drawn since that read, so the
 * next read decides the tool again (after an answer the next dialog is for
 * another call, or another prompt from the same subagent).
 */
export type DialogOwner = {
  since: number;
  prompt: string;
  toolId: string | null;
  shownPrompt: string;
  fresh: boolean;
};

/** A dialog that was just drawn (again), keeping what it showed until the next read. */
export function dialogDrawn(owner: DialogOwner | undefined, now: number, prompt: string): DialogOwner {
  return {
    since: now,
    prompt,
    toolId: owner?.toolId ?? null,
    shownPrompt: owner?.shownPrompt ?? prompt,
    fresh: true,
  };
}

const squash = (text: string) => text.replace(/\s+/g, "");

/**
 * Which unanswered call the dialog text names: the one whose hint (file
 * name, host, command) it shows, else the oldest. Claude Code asks about
 * parallel calls oldest first, but calls that need no permission (reads,
 * fetches to allowed hosts, subagents) may still be running ahead of it.
 */
function toolForPrompt(log: LogView, prompt: string): PendingTool | undefined {
  const candidates = pendingToolsOf(log).filter((tool) => !OWN_PROMPT.has(tool.name));
  const screen = squash(prompt);
  return (
    candidates.find((tool) => {
      const hint = squash(tool.hint ?? "");
      return hint.length > 0 && screen.includes(hint);
    }) ?? candidates[0]
  );
}

/**
 * After a session-log read that started at `readAt`: which call the visible
 * dialog asks about, and whether to hide it. It is hidden when the turn
 * ends, or when its call left the log after the user typed (`answering`).
 * Another call finishing or appearing, a failed read or a read older than
 * the draw never hide it. If its call left the log without typing here (a
 * parallel call that needed no permission was taken for it), it moves to
 * another unanswered call; with none left, nothing can be asking.
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
  const next = toolForPrompt(log, owner.prompt);
  if (!next && settled) return { owner: undefined, clear: true };
  // Not written to the log yet: keep waiting for its call.
  if (!next) return { owner: { ...owner, toolId: stillOpen ? owner.toolId : null }, clear: false };
  return {
    owner: { since: owner.since, prompt: owner.prompt, toolId: next.id, shownPrompt: owner.prompt, fresh: false },
    clear: false,
  };
}

/** The unanswered call the on-screen dialog asks about, once a read tied them. */
export function dialogToolFor(
  owner: DialogOwner | undefined,
  log: LogView | null | undefined,
): DialogTool | null {
  if (!owner?.toolId) return null;
  const tool = pendingToolsOf(log).find((item) => item.id === owner.toolId);
  return tool ? { ...tool, prompt: owner.shownPrompt } : null;
}
