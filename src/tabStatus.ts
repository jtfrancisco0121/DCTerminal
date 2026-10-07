/**
 * F2: per-tab status for the tab chips. Busy, finished-but-unseen, and
 * needs-you come from exact ACP signals on chat tabs (prompt in flight,
 * request_permission, cursor/create_plan, prompt finished) and from an
 * output-activity heuristic on terminal tabs.
 */
import type { AgentEventKind } from "./notify/agentNotify";
import type { TabRuntime } from "./liveTabs";

export type NeedsYou = "permission" | "plan" | "question" | "error";

export type TabStatus = {
  busy: boolean;
  /** A turn finished while the user was not looking at this tab. */
  unseen: boolean;
  needsYou: NeedsYou | null;
};

/** What a finished turn left behind until the user looks at the tab. */
export type TabMark = "finished" | "question" | "error";

export const IDLE_STATUS: TabStatus = { busy: false, unseen: false, needsYou: null };

function markFor(kind: AgentEventKind): TabMark | null {
  if (kind === "finished") return "finished";
  if (kind === "question") return "question";
  if (kind === "failed") return "error";
  return null;
}

/**
 * Record a finished turn. `watching` means the tab is on screen in a focused
 * window, so nothing is left unseen. `kind` null is a cancelled turn.
 */
export function markAfterTurn(
  marks: Record<string, TabMark>,
  tabId: string,
  kind: AgentEventKind | null,
  watching: boolean,
): Record<string, TabMark> {
  if (kind === null) return marks;
  if (watching) return clearMarks(marks, [tabId]);
  const mark = markFor(kind);
  if (!mark || marks[tabId] === mark) return marks;
  return { ...marks, [tabId]: mark };
}

/** Drop marks for tabs the user is now looking at. */
export function clearMarks(
  marks: Record<string, TabMark>,
  tabIds: readonly (string | null | undefined)[],
): Record<string, TabMark> {
  const hit = tabIds.filter((id): id is string => !!id && id in marks);
  if (hit.length === 0) return marks;
  const next = { ...marks };
  for (const id of hit) delete next[id];
  return next;
}

export function computeTabStatus(input: {
  runtime?: TabRuntime;
  mark?: TabMark;
  planPending: boolean;
  questionPending?: boolean;
  terminalBusy?: boolean;
}): TabStatus {
  const rt = input.runtime;
  let needsYou: NeedsYou | null = null;
  if (rt?.permission) needsYou = "permission";
  else if (input.planPending) needsYou = "plan";
  else if (input.questionPending) needsYou = "question";
  else if (input.mark === "question") needsYou = "question";
  else if (input.mark === "error" || rt?.agentExited) needsYou = "error";
  return {
    busy: !!rt?.promptInFlight || !!input.terminalBusy,
    unseen: input.mark === "finished",
    needsYou,
  };
}

const NEEDS_YOU_TEXT: Record<NeedsYou, string> = {
  permission: "permission request",
  plan: "plan to review",
  question: "agent asked a question",
  error: "stopped with an error",
};

/** One line for tooltips and screen readers. Empty when idle. */
export function tabStatusLabel(status: TabStatus): string {
  if (status.needsYou) return `Needs you: ${NEEDS_YOU_TEXT[status.needsYou]}`;
  if (status.busy) return "Working";
  if (status.unseen) return "Finished, not viewed yet";
  return "";
}
