/**
 * F1: background-tab notifications. Pure decisions so the UI wiring stays
 * thin. ACP gives exact signals (prompt finished, request_permission,
 * cursor/create_plan), so no output-silence heuristics are needed.
 */
import type { PromptFinishedEvent } from "../bridge";

export type NotificationSettings = {
  /** Master switch for agent notifications. */
  enabled: boolean;
  /** OS notification while DCTerminal is not the focused window. */
  system: boolean;
  /** In-app toast for a background tab while DCTerminal is focused. */
  toastWhenFocused: boolean;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  system: true,
  toastWhenFocused: true,
};

export type AgentEventKind = "finished" | "question" | "permission" | "plan" | "failed";

export type AgentEvent = {
  kind: AgentEventKind;
  /** Short context: last agent line, permission title, or error. */
  detail: string;
};

export type NotifyDecision = { toast: boolean; system: boolean };

/**
 * Who hears about an event. A visible tab in a focused window is silent.
 * A background tab in a focused window gets a toast. An unfocused window
 * gets a system notification plus a toast waiting for the user's return.
 */
export function decideNotification(input: {
  tabId: string;
  visibleTabIds: readonly (string | null | undefined)[];
  windowFocused: boolean;
  settings: NotificationSettings;
}): NotifyDecision {
  const { settings } = input;
  if (!settings.enabled) return { toast: false, system: false };
  if (!input.windowFocused) return { toast: true, system: settings.system };
  const visible = input.visibleTabIds.includes(input.tabId);
  if (visible) return { toast: false, system: false };
  return { toast: settings.toastWhenFocused, system: false };
}

function lastNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function looksLikeQuestion(line: string): boolean {
  // Strip trailing Markdown emphasis or code ticks: "**Which one?**".
  return /\?\s*$/.test(line.replace(/[*_`)\]]+$/, ""));
}

/** Map a finished prompt to a notification, or null when the user cancelled. */
export function classifyPromptFinished(evt: PromptFinishedEvent): AgentEvent | null {
  if (!evt.tabId) return null;
  if (!evt.success) {
    return { kind: "failed", detail: evt.error ?? "" };
  }
  if (evt.result?.stopReason === "cancelled") return null;
  const text = evt.result?.agentText ?? "";
  const last = lastNonEmptyLine(text);
  if (last && looksLikeQuestion(last)) return { kind: "question", detail: last };
  return { kind: "finished", detail: text.trim() };
}

const BODY_LIMIT = 140;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= BODY_LIMIT) return flat;
  return `${flat.slice(0, BODY_LIMIT - 1).trimEnd()}…`;
}

const FALLBACK_BODY: Record<AgentEventKind, string> = {
  finished: "The agent finished its turn.",
  question: "The agent is waiting for your answer.",
  permission: "The agent is waiting for your approval.",
  plan: "Open the tab to accept or reject the plan.",
  failed: "The turn ended with an error.",
};

const TITLE_SUFFIX: Record<AgentEventKind, string> = {
  finished: "finished",
  question: "has a question",
  permission: "needs permission",
  plan: "has a plan to review",
  failed: "stopped with an error",
};

export function notificationMessage(
  event: AgentEvent,
  tabLabel: string,
): { title: string; body: string } {
  const name = tabLabel.trim() || "Agent";
  const detail = event.kind === "plan" ? "" : oneLine(event.detail);
  return {
    title: `${name} ${TITLE_SUFFIX[event.kind]}`,
    body: detail || FALLBACK_BODY[event.kind],
  };
}

export type AgentToast = {
  id: string;
  tabId: string;
  kind: AgentEventKind;
  title: string;
  body: string;
};

/** Newest first. A tab keeps only its latest toast. */
export function pushToast(list: AgentToast[], toast: AgentToast, max = 4): AgentToast[] {
  return [toast, ...list.filter((t) => t.tabId !== toast.tabId)].slice(0, max);
}

export function dismissToast(list: AgentToast[], id: string): AgentToast[] {
  const next = list.filter((t) => t.id !== id);
  return next.length === list.length ? list : next;
}

export function dismissToastsForTab(list: AgentToast[], tabId: string): AgentToast[] {
  const next = list.filter((t) => t.tabId !== tabId);
  return next.length === list.length ? list : next;
}

/** Needs-you toasts linger; plain completions fade sooner. */
export function toastLifetimeMs(kind: AgentEventKind): number {
  return kind === "finished" ? 6000 : 15000;
}
