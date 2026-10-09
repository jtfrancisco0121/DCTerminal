/**
 * Planner → other-role hand-off.
 *
 * The plan text is mapped onto the target role's own form fields
 * (Implementer `approvedPlan`, PR Reviewer `originalTask`, and so on).
 * Roles with no plan field (Developer) keep the text for the scratch pad.
 * This module only maps text. The UI decides whether the target opens as
 * a chat tab or a terminal tab.
 *
 * Character limits match `handoff_store.rs`.
 */

import { TERMINAL_TAIL_LINES } from "../terminal/text";

export const INLINE_PLAN_CHARS = 100_000;
export const JSON_PLAN_CHARS = 1_000_000;
export const FILE_PLAN_CHARS = 8_000_000;

export const HANDOFF_TARGETS = ["role_implementer", "role_developer", "role_pr_reviewer"] as const;
export type HandoffTargetId = (typeof HANDOFF_TARGETS)[number];

export type HandoffScope =
  | "plan_and_todos"
  | "message"
  | "card"
  | "selection"
  | "plan_file"
  | "terminal_tail";

export type HandoffSurface = "chat" | "terminal";

export type HandoffPlanEntry = {
  content: string;
  status: string;
  priority?: string;
};

export type HandoffTodo = {
  content: string;
  status: string;
};

export type HandoffField = {
  key: string;
  options?: string[];
};

export type HandoffSource = {
  sourceRoleId: string;
  sourceTabId: string;
  sourceLabel: string;
  cwd: string;
  answers: Record<string, string>;
  latestMessage: string;
  plan: HandoffPlanEntry[];
  todos: HandoffTodo[];
  selection: string;
  turnInFlight: boolean;
  /** Set when the source is a terminal-mode Planner tab. */
  fromTerminal?: boolean;
  /** Body of the newest plan file written after the terminal started. */
  planFileText?: string;
  planFileName?: string;
  /** Last lines of the terminal buffer, already stripped of ANSI codes. */
  terminalTail?: string;
};

export type HandoffLimits = {
  inline: number;
  json: number;
  file: number;
};

export const DEFAULT_HANDOFF_LIMITS: HandoffLimits = {
  inline: INLINE_PLAN_CHARS,
  json: JSON_PLAN_CHARS,
  file: FILE_PLAN_CHARS,
};

export type MappedHandoff = {
  title: string;
  /** Form values for the new tab, including `cwd`. Does not start the agent. */
  answers: Record<string, string>;
  /** Text persisted with the hand-off (may be shorter than the original). */
  planText: string;
  /** Text placed in the plan field or scratch pad. */
  inlinePlan: string;
  planField: string | null;
  /** True when the plan has no schema field and should seed the scratch pad. */
  usesScratchPad: boolean;
  truncated: boolean;
  warning: string | null;
};

const PLAN_FIELD_KEYS = ["approvedPlan", "plan", "implementationPlan"];
const DESCRIPTION_FIELD_KEYS = ["description", "request", "originalTask", "task"];
const CONTEXT_FIELD_KEYS = ["additionalContext", "context", "notes"];

const TASK_TYPE_TO_IMPLEMENTER: Record<string, string> = {
  Feature: "Feature",
  Bug: "Bug Fix",
  Refactor: "Refactor",
  Chore: "Other",
  "Bug Fix": "Bug Fix",
  Improvement: "Improvement",
  Other: "Other",
};

export function charCount(text: string): number {
  return Array.from(text).length;
}

export function takeChars(text: string, max: number): string {
  if (max <= 0) return "";
  return Array.from(text).slice(0, max).join("");
}

export function latestAgentMessage(
  segments: { kind: string; text: string }[],
): string {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment.kind === "agent" && segment.text.trim()) return segment.text.trim();
  }
  return "";
}

export function selectionInside(root: HTMLElement | null): string {
  if (!root || typeof window === "undefined") return "";
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return "";
  return selection.toString().trim();
}

export function handoffFromRole(sourceRoleId: string): string {
  if (sourceRoleId === "role_planner") return "Planner";
  if (sourceRoleId === "role_plan_reviewer") return "Plan Reviewer";
  if (sourceRoleId === "role_implementer") return "Implementer";
  if (sourceRoleId === "role_developer") return "Developer";
  if (sourceRoleId === "role_pr_reviewer") return "PR Reviewer";
  return "role";
}

function implementerAnswersReady(answers: Record<string, string>): boolean {
  const description = (answers.description ?? "").trim();
  const plan = (answers.approvedPlan ?? "").trim();
  return description.length > 0 || plan.length > 0;
}

export function handoffBlockReason(source: HandoffSource): string | null {
  if (source.sourceRoleId === "role_implementer") {
    if (source.turnInFlight) {
      return "Wait until the Implementer finishes this turn.";
    }
    if (!implementerAnswersReady(source.answers)) {
      return "Fill in the Implementer task and approved plan before sending to review.";
    }
    return null;
  }
  if (source.sourceRoleId !== "role_planner") {
    return "Send a plan from a Planner tab.";
  }
  if (source.fromTerminal) {
    const hasTerminal =
      (source.planFileText ?? "").trim().length > 0 ||
      source.selection.trim().length > 0 ||
      (source.terminalTail ?? "").trim().length > 0;
    if (!hasTerminal) return "There is no plan to send yet.";
    return null;
  }
  if (source.turnInFlight) {
    return "Wait until the Planner finishes this turn.";
  }
  const hasContent =
    source.latestMessage.trim().length > 0 ||
    source.plan.length > 0 ||
    source.todos.length > 0 ||
    source.selection.trim().length > 0;
  if (!hasContent) return "There is no plan to send yet.";
  return null;
}

export function formatPlanCard(plan: HandoffPlanEntry[], todos: HandoffTodo[]): string {
  const lines: string[] = [];
  if (plan.length > 0) {
    lines.push("## Plan");
    for (const entry of plan) {
      const priority = entry.priority?.trim() ? ` (${entry.priority.trim()})` : "";
      lines.push(`- [${entry.status}] ${entry.content}${priority}`);
    }
  }
  if (todos.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("## To-dos");
    for (const todo of todos) {
      lines.push(`- [${todo.status}] ${todo.content}`);
    }
  }
  return lines.join("\n");
}

export function composePlanText(
  source: HandoffSource,
  scope: HandoffScope,
): { text: string; emptyReason: string | null } {
  let text = "";
  if (scope === "message") text = source.latestMessage.trim();
  else if (scope === "card") text = formatPlanCard(source.plan, source.todos);
  else if (scope === "selection") text = source.selection.trim();
  else if (scope === "plan_file") text = (source.planFileText ?? "").trim();
  else if (scope === "terminal_tail") text = (source.terminalTail ?? "").trim();
  else {
    const message = source.latestMessage.trim();
    const card = formatPlanCard(source.plan, source.todos);
    text = message && card ? `${message}\n\n${card}` : message || card;
  }
  if (!text) return { text: "", emptyReason: "That choice has no content." };
  return { text, emptyReason: null };
}

export type ScopeChoice = {
  id: HandoffScope;
  label: string;
  enabled: boolean;
};

export function scopeChoices(source: HandoffSource): ScopeChoice[] {
  if (source.fromTerminal) {
    const fileLabel = source.planFileName
      ? `Newest plan file (${source.planFileName})`
      : "Newest plan file";
    return [
      {
        id: "plan_file",
        label: fileLabel,
        enabled: composePlanText(source, "plan_file").text.length > 0,
      },
      {
        id: "selection",
        label: "Selected text",
        enabled: composePlanText(source, "selection").text.length > 0,
      },
      {
        id: "terminal_tail",
        label: `Last ${TERMINAL_TAIL_LINES} lines`,
        enabled: composePlanText(source, "terminal_tail").text.length > 0,
      },
    ];
  }
  return [
    {
      id: "plan_and_todos",
      label: "Latest plan and to-dos",
      enabled: composePlanText(source, "plan_and_todos").text.length > 0,
    },
    {
      id: "message",
      label: "Whole latest plan message",
      enabled: composePlanText(source, "message").text.length > 0,
    },
    {
      id: "card",
      label: "Plan card (entries and to-dos)",
      enabled: composePlanText(source, "card").text.length > 0,
    },
    {
      id: "selection",
      label: "Selection",
      enabled: composePlanText(source, "selection").text.length > 0,
    },
  ];
}

export function defaultScope(source: HandoffSource): HandoffScope {
  if (source.fromTerminal) {
    if (composePlanText(source, "plan_file").text) return "plan_file";
    if (composePlanText(source, "selection").text) return "selection";
    if (composePlanText(source, "terminal_tail").text) return "terminal_tail";
    return "plan_file";
  }
  const preferred: HandoffScope[] = ["plan_and_todos", "message", "card", "selection"];
  for (const scope of preferred) {
    if (composePlanText(source, scope).text) return scope;
  }
  return "plan_and_todos";
}

function answer(values: Record<string, string>, key: string): string {
  return (values[key] ?? "").trim();
}

export function extractTitle(source: HandoffSource, planText: string): string {
  const fromAnswers = answer(source.answers, "title");
  if (fromAnswers) return takeChars(fromAnswers, 120);
  const heading = planText.match(/^#{1,3}[ \t]+(.+)$/m);
  if (heading?.[1]?.trim()) return takeChars(heading[1].trim(), 120);
  const firstLine = planText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("-"));
  if (firstLine) return takeChars(firstLine, 120);
  const label = source.sourceLabel.replace(/^Planner\s*·\s*/i, "").trim();
  return takeChars(label || "Planner hand-off", 120);
}

function extractDescription(source: HandoffSource, planText: string): string {
  const request = answer(source.answers, "request") || answer(source.answers, "description");
  if (request) return request;
  const paragraph = planText
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("#") && !part.startsWith("- ["));
  if (paragraph) return takeChars(paragraph, 4_000);
  return "Implement the plan from the Planner hand-off.";
}

function extractContext(source: HandoffSource): string {
  const parts: string[] = [];
  const expected = answer(source.answers, "expectedBehavior");
  const current = answer(source.answers, "currentBehavior");
  const extra = answer(source.answers, "additionalContext");
  if (expected) parts.push(`Expected behavior:\n${expected}`);
  if (current) parts.push(`Current behavior:\n${current}`);
  if (extra) parts.push(extra);
  return parts.join("\n\n");
}

function limitPlan(
  text: string,
  limits: HandoffLimits,
): { planText: string; inlinePlan: string; truncated: boolean; warning: string | null } {
  const original = charCount(text);
  let planText = text;
  const warnings: string[] = [];
  let truncated = false;
  if (original > limits.file) {
    planText = takeChars(text, limits.file);
    truncated = true;
    warnings.push(
      `Plan was truncated to ${limits.file.toLocaleString()} characters before it was saved.`,
    );
  }
  let inlinePlan = planText;
  if (charCount(planText) > limits.inline) {
    inlinePlan = takeChars(planText, limits.inline);
    truncated = true;
    const storedAsFile = charCount(planText) > limits.json;
    const where = storedAsFile
      ? "The rest is attached as a file in app data, not in the repo."
      : "The full text is saved with this hand-off in app data.";
    warnings.push(
      `Plan is ${original.toLocaleString()} characters. The form shows the first ${limits.inline.toLocaleString()}. ${where}`,
    );
  }
  return {
    planText,
    inlinePlan,
    truncated,
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

function firstKey(fields: HandoffField[], keys: string[]): string | null {
  const present = new Set(fields.map((field) => field.key));
  for (const key of keys) {
    if (present.has(key)) return key;
  }
  return null;
}

/** Implementer form → PR Reviewer fields (no plan-scope picker). */
export function mapImplementerToReviewer(
  source: HandoffSource,
  target: { roleId: string; fields: HandoffField[] },
  limits: HandoffLimits = DEFAULT_HANDOFF_LIMITS,
): MappedHandoff {
  const title = takeChars(
    answer(source.answers, "title") || source.sourceLabel.replace(/^Implementer\s*·\s*/i, "").trim(),
    120,
  );
  const description = answer(source.answers, "description");
  const planText = answer(source.answers, "approvedPlan");
  const originalTask = description
    ? title && !description.startsWith(title)
      ? `${title}\n\n${description}`
      : description
    : title || "Review the Implementer session.";
  const limited = limitPlan(planText || originalTask, limits);
  const answers: Record<string, string> = { cwd: source.cwd };
  const planField = firstKey(target.fields, PLAN_FIELD_KEYS);
  const descriptionKey = firstKey(target.fields, DESCRIPTION_FIELD_KEYS);
  if (descriptionKey) answers[descriptionKey] = takeChars(originalTask, 4_000);
  if (planField && planText) answers[planField] = limited.inlinePlan;
  const contextKey = firstKey(target.fields, CONTEXT_FIELD_KEYS);
  const context = answer(source.answers, "additionalContext");
  if (contextKey && context) answers[contextKey] = context;
  return {
    title: title || "Implementer hand-off",
    answers,
    planText: planText ? limited.planText : originalTask,
    inlinePlan: planText ? limited.inlinePlan : originalTask,
    planField,
    usesScratchPad: planField === null,
    truncated: limited.truncated,
    warning: limited.warning,
  };
}

export function mapHandoff(
  source: HandoffSource,
  scope: HandoffScope,
  target: { roleId: string; fields: HandoffField[] },
  limits: HandoffLimits = DEFAULT_HANDOFF_LIMITS,
): MappedHandoff {
  if (source.sourceRoleId === "role_implementer" && target.roleId === "role_pr_reviewer") {
    return mapImplementerToReviewer(source, target, limits);
  }
  const composed = composePlanText(source, scope);
  if (!composed.text) {
    return {
      title: extractTitle(source, ""),
      answers: { cwd: source.cwd },
      planText: "",
      inlinePlan: "",
      planField: null,
      usesScratchPad: false,
      truncated: false,
      warning: composed.emptyReason,
    };
  }
  const limited = limitPlan(composed.text, limits);
  const title = extractTitle(source, composed.text);
  const answers: Record<string, string> = { cwd: source.cwd };
  const planField = firstKey(target.fields, PLAN_FIELD_KEYS);
  if (target.fields.some((field) => field.key === "title")) {
    answers.title = title;
  }
  const taskField = target.fields.find((field) => field.key === "taskType");
  if (taskField) {
    const mapped = TASK_TYPE_TO_IMPLEMENTER[answer(source.answers, "taskType")] ?? "";
    const allowed = !taskField.options || taskField.options.includes(mapped);
    if (mapped && allowed) answers.taskType = mapped;
  }
  const descriptionKey = firstKey(target.fields, DESCRIPTION_FIELD_KEYS);
  if (descriptionKey) {
    answers[descriptionKey] = extractDescription(source, composed.text);
  }
  const contextKey = firstKey(target.fields, CONTEXT_FIELD_KEYS);
  const context = extractContext(source);
  if (contextKey && context) answers[contextKey] = context;
  if (planField) answers[planField] = limited.inlinePlan;
  return {
    title,
    answers,
    planText: limited.planText,
    inlinePlan: limited.inlinePlan,
    planField,
    usesScratchPad: planField === null,
    truncated: limited.truncated,
    warning: limited.warning,
  };
}
