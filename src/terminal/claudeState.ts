/**
 * One state per Claude Code role terminal, shared by the tab chip, status
 * bar, grid, chain overview lane, hand-off message and notifications.
 *
 * Order: exited, then needs you, then working, then idle. "Needs you" comes
 * only from the session log's unanswered tools: ExitPlanMode and
 * AskUserQuestion right away, any other tool only while the PTY shows Claude
 * Code's permission dialog for it. On a bridged pipeline stage (ADR-015,
 * D22) the PermissionRequest hook says so first, at once; the screen stays
 * the fallback. Quiet time alone never means "needs you".
 * A turn with no known end and no unanswered tool that stayed quiet for
 * TURN_QUIET_MS is still working, flagged `unknown` (Claude Code may have
 * changed its log format): the pill says to check the terminal, nothing
 * treats the turn as done.
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
  | { kind: "working"; unknown?: true }
  | { kind: "idle" };

type LogView = Pick<TerminalSessionLog, "turnDone" | "openTool" | "pendingTools">;
export type PendingTool = { id: string; name: string; title: string; hint?: string };
/** The tool a permission dialog on screen asks about, and which prompt it is. */
export type DialogTool = PendingTool & { promptKey: string };

/**
 * A bridged stage's Needs you (D22): its PermissionRequest hook (or the
 * `permission_prompt` Notification backup, with no tool) said a permission
 * dialog is up. `at`: when the app heard it; `key`: which prompt.
 */
/**
 * The bridge's Needs you for a tab: the hooked tool (`null` from the
 * Notification backup), when it came, its dedupe key, and `shown` once the
 * screen drew a permission dialog after it.
 */
export type BridgeNeedsMark = { tool: string | null; at: number; key: string; shown?: boolean };

/** Time a log read gets to catch up with the hook before it can clear it. */
export const BRIDGE_NEEDS_GRACE_MS = 1000;

export type TerminalStateInput = {
  log: LogView | null | undefined;
  /** The bridge's Needs you for this tab, until you answer it or a log read clears it (`bridgeNeedsAfterAnswer`, `bridgeNeedsAfterDialog`, `bridgeNeedsAfterRead`). */
  bridgeNeeds?: BridgeNeedsMark | null;
  /** The unanswered tool whose permission dialog is on screen (`dialogToolFor`). */
  dialogTool: DialogTool | null;
  /** Output arrived recently (the fallback when there is no log yet). */
  ptyBusy: boolean;
  /** null while the process runs. */
  exitCode: number | null | undefined;
  /** No output and no new log record for TURN_QUIET_MS (`quietTurn`). */
  quiet?: boolean;
};

/** Quiet time after which a turn with no end marker shows as unknown. */
export const TURN_QUIET_MS = 60_000;

/** No PTY output since `outputAt` and no new log record since `logAt` for TURN_QUIET_MS. */
export function quietTurn(input: { outputAt: number | undefined; logAt: number; now: number }): boolean {
  return input.now - Math.max(input.outputAt ?? 0, input.logAt) >= TURN_QUIET_MS;
}

/**
 * The watched tabs whose turn has no known end and saw no output or new
 * records for TURN_QUIET_MS (since they were first watched, before any read).
 */
export function quietTurnIds(
  watched: Iterable<[string, { since: number; records?: LogRecordsSeen }]>,
  logs: Record<string, { turnDone: boolean } | null | undefined>,
  outputAt: (id: string) => number | undefined,
  now: number,
): string[] {
  const ids: string[] = [];
  for (const [id, entry] of watched) {
    if (logs[id]?.turnDone !== false) continue;
    if (quietTurn({ outputAt: outputAt(id), logAt: entry.records?.at ?? entry.since, now })) ids.push(id);
  }
  return ids.sort();
}

/** What the last read found, and when those records first appeared (`quietTurn`'s `logAt`). */
export type LogRecordsSeen = { key: string; at: number };

type RecordsView = Pick<TerminalSessionLog, "turnDone" | "lastPromptAt" | "lastReply" | "pendingTools"> & {
  toolCalls: { id: string; status: string }[];
};

/** Compared with the previous read, so a call that came and went between reads still counts once. */
export function logRecordsSeen(
  prev: LogRecordsSeen | undefined,
  log: RecordsView | null,
  now: number,
): LogRecordsSeen | undefined {
  if (!log) return prev;
  const last = log.toolCalls[log.toolCalls.length - 1];
  const key = JSON.stringify([
    log.turnDone,
    log.lastPromptAt,
    log.lastReply,
    (log.pendingTools ?? []).map((tool) => tool.id),
    log.toolCalls.length,
    last?.id,
    last?.status,
  ]);
  return prev?.key === key ? prev : { key, at: now };
}

export function deriveTerminalState(input: TerminalStateInput): TerminalState {
  if (input.exitCode !== null && input.exitCode !== undefined) {
    return { kind: "exited", code: input.exitCode };
  }
  const log = input.log;
  // The bridge heard the permission prompt from Claude Code itself: it
  // names the prompt before the screen is read, and keeps naming it.
  const hooked = input.bridgeNeeds;
  if (hooked) {
    const waiting = pendingToolsOf(log).filter((tool) => !OWN_PROMPT.has(tool.name));
    const tool = hooked.tool ? waiting.find((item) => item.name === hooked.tool) : waiting[0];
    return {
      kind: "needs",
      needs: "permission",
      toolId: tool?.id ?? `bridge:${hooked.key}`,
      toolTitle: tool?.title ?? hooked.tool ?? "",
      promptKey: `bridge:${hooked.key}`,
    };
  }
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
  if (log && !log.turnDone && input.quiet && pendingToolsOf(log).length === 0) {
    return { kind: "working", unknown: true };
  }
  const working = log ? !log.turnDone : input.ptyBusy;
  return working ? { kind: "working" } : { kind: "idle" };
}

export function sameTerminalState(a: TerminalState | undefined, b: TerminalState | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "exited" && b.kind === "exited") return a.code === b.code;
  if (a.kind === "working" && b.kind === "working") return !!a.unknown === !!b.unknown;
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
 * After a session-log read that started at `readAt`: the bridge's Needs you
 * stays until a read made at least BRIDGE_NEEDS_GRACE_MS after it shows the
 * turn over, or no tool waiting on a dialog (none of the hooked tool's
 * name, when it named one). An older read, or a failed one, keeps it.
 */
export function bridgeNeedsAfterRead(
  mark: BridgeNeedsMark | undefined,
  log: LogView | null,
  readAt: number,
): BridgeNeedsMark | undefined {
  if (!mark || !log || readAt < mark.at + BRIDGE_NEEDS_GRACE_MS) return mark;
  if (log.turnDone) return undefined;
  const waiting = pendingToolsOf(log).filter((tool) => !OWN_PROMPT.has(tool.name));
  const asking = mark.tool ? waiting.some((tool) => tool.name === mark.tool) : waiting.length > 0;
  return asking ? mark : undefined;
}

/**
 * A key that may answer a dialog (Enter, Esc, a digit) was sent to the tab
 * at `answeredAt`. Approving writes nothing to the session log, and the
 * tool_result lands only when the tool finishes, so the answer itself is
 * what clears the hook's Needs you. A key sent before the hook named the
 * prompt answered something else.
 */
export function bridgeNeedsAfterAnswer(
  mark: BridgeNeedsMark | undefined,
  answeredAt: number,
): BridgeNeedsMark | undefined {
  return mark && answeredAt >= mark.at ? undefined : mark;
}

/**
 * The screen's permission dialog was drawn (`visible`) or went away. A
 * dialog drawn after the hook and then gone was answered. One the detector
 * never saw going "away" keeps the mark (the hook is the better witness).
 */
export function bridgeNeedsAfterDialog(
  mark: BridgeNeedsMark | undefined,
  visible: boolean,
): BridgeNeedsMark | undefined {
  if (!mark) return undefined;
  if (visible) return mark.shown ? mark : { ...mark, shown: true };
  return mark.shown ? undefined : mark;
}

/**
 * The permission dialog on screen.
 * - `since`, `context`: when it was last drawn in full, and its text then
 *   (the question and the lines above, which may include transcript lines).
 * - `drawNew`: that draw showed a different dialog body than the one before.
 * - `afterAnswer`: that draw followed an answer key or click, so it may be
 *   the next call's dialog rather than the same one drawn again.
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
  afterAnswer: boolean;
  toolId: string | null;
  fresh: boolean;
  promptKey: number | null;
};

/** Lines kept as the dialog's body: the question and the lines just above it. */
const BODY_LINES = 4;
const dialogBody = (context: string) => context.split("\n").slice(-BODY_LINES).join("\n");

/** A dialog that was just drawn (again), keeping what it showed until the next read. */
export function dialogDrawn(
  owner: DialogOwner | undefined,
  now: number,
  context: string,
  afterAnswer = false,
): DialogOwner {
  const changed = !owner || dialogBody(owner.context) !== dialogBody(context);
  const unread = !!owner?.fresh;
  return {
    since: now,
    context,
    // What a read has not seen yet still counts.
    drawNew: changed || (unread && !!owner?.drawNew),
    afterAnswer: afterAnswer || (unread && !!owner?.afterAnswer),
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
 * the next of two identical calls); else the oldest, or the twin of
 * `answered`. Claude Code asks about parallel calls
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
  // Nothing named: the oldest, or after an answer the twin of the call just
  // answered (identical parallel calls), never an unrelated call.
  const done = candidates.find((tool) => tool.id === answered);
  const twin = done
    ? candidates.find((tool) => tool.id !== done.id && tool.name === done.name && tool.title === done.title)
    : undefined;
  return twin ?? candidates[0];
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
  // The same body drawn again right after an answer is the next of two
  // identical parallel calls; a new body names its own call, and a redraw
  // after an arrow key or a resize is the same call.
  const answered = owner.fresh && owner.afterAnswer && !owner.drawNew ? owner.toolId : null;
  const next = toolForPrompt(log, owner.context, answered);
  if (!next && settled) return { owner: undefined, clear: true };
  // Not written to the log yet: keep waiting for its call.
  if (!next) return { owner: { ...owner, toolId: stillOpen ? owner.toolId : null }, clear: false };
  // A new prompt: the first one, a different dialog body, a dialog drawn
  // after an answer key or click (which dismisses the one before), or the
  // same body drawn again for another call.
  const isNew =
    owner.fresh &&
    (owner.promptKey === null ||
      owner.drawNew ||
      owner.afterAnswer ||
      (owner.toolId !== null && next.id !== owner.toolId));
  return {
    owner: {
      ...owner,
      toolId: next.id,
      fresh: false,
      drawNew: false,
      afterAnswer: false,
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
