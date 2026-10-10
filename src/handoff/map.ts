/**
 * Role → role hand-off (see `transitions.ts` for which roles may hand off to which).
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
import {
  isHandoffSource,
  isPlanSource,
  isReportSource,
  roleDisplayName,
  type RoleName,
} from "./transitions";

export {
  HANDOFF_TRANSITIONS,
  handoffMenuItems,
  handoffTargets,
  isCaptureSource,
  isHandoffSource,
  isPlanSource,
  isReportSource,
  isValidTransition,
  roleDisplayName,
} from "./transitions";
export type { HandoffTargetId, RoleName } from "./transitions";

export const INLINE_PLAN_CHARS = 100_000;
export const JSON_PLAN_CHARS = 1_000_000;
export const FILE_PLAN_CHARS = 8_000_000;

export type HandoffScope =
  | "plan_mode"
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
  /** The turn is only waiting for the user to approve its plan, so the plan is final. */
  awaitingPlanApproval?: boolean;
  /** Set when the source is a terminal-mode role tab (Planner or Plan Reviewer). */
  fromTerminal?: boolean;
  /** Body of the newest plan file written after the terminal started. */
  planFileText?: string;
  planFileName?: string;
  /** Last lines of the terminal buffer, already stripped of ANSI codes. */
  terminalTail?: string;
  /** Claude ExitPlanMode body ("Ready to code?"). Preferred over the card. */
  planMarkdown?: string;
  /** Whole-tab snapshot: path and +/− only. Diffs are not pasted. */
  changes?: { path: string; additions: number | null; deletions: number | null }[];
  branch?: string | null;
  /** Transcript text scanned for the first GitHub pull-request URL. */
  transcriptText?: string;
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
const REVIEWED_PLAN_HEADING = /^#{1,6}[ \t]+(?:\*\*)?Reviewed plan(?:\*\*)?[ \t]*:?[ \t]*$/im;
const REVIEW_NOTES_HEADING = /^#{1,6}[ \t]+(?:\*\*)?Review notes(?:\*\*)?[ \t]*:?[ \t]*$/im;
const CONTEXT_FIELD_KEYS = ["additionalContext", "context", "notes"];
const GITHUB_PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

/** First GitHub pull-request URL in a transcript. Large diffs are not used. */
export function firstGithubPrUrl(text: string): string | null {
  return text.match(GITHUB_PR_URL)?.[0] ?? null;
}

/** Implementer → PR Reviewer extra context. Paths and counts, never a diff. */
export function implementationContext(source: HandoffSource): string {
  const parts: string[] = [];
  const summary = source.latestMessage.trim();
  if (summary) parts.push(`Implementation summary:\n${takeChars(summary, 4_000)}`);
  const files = source.changes ?? [];
  if (files.length > 0) {
    const lines = files.slice(0, 40).map((file) => {
      const add = file.additions == null ? "?" : `+${file.additions}`;
      const del = file.deletions == null ? "?" : `-${file.deletions}`;
      return `- ${file.path} ${add} ${del}`;
    });
    if (files.length > 40) lines.push(`- … ${files.length - 40} more`);
    parts.push(`Changed files:\n${lines.join("\n")}`);
  }
  if (source.branch?.trim()) parts.push(`Branch: ${source.branch.trim()}`);
  const pr = firstGithubPrUrl(`${source.transcriptText ?? ""}\n${source.latestMessage}`);
  if (pr) parts.push(`Pull request: ${pr}`);
  return parts.join("\n\n");
}

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

export function handoffFromRole(sourceRoleId: string, roles?: readonly RoleName[] | null): string {
  return roleDisplayName(sourceRoleId, roles);
}

function implementerAnswersReady(answers: Record<string, string>): boolean {
  const description = (answers.description ?? "").trim();
  const plan = (answers.approvedPlan ?? "").trim();
  return description.length > 0 || plan.length > 0;
}

function hasChatContent(source: HandoffSource): boolean {
  return (
    (source.planMarkdown ?? "").trim().length > 0 ||
    source.latestMessage.trim().length > 0 ||
    source.plan.length > 0 ||
    source.todos.length > 0 ||
    source.selection.trim().length > 0
  );
}

export function handoffBlockReason(
  source: HandoffSource,
  roles?: readonly RoleName[] | null,
): string | null {
  const roleId = source.sourceRoleId;
  if (!isHandoffSource(roleId, roles)) {
    return "This role has no hand-off targets. Pick some in Settings > Roles, or send from a Planner, Plan Reviewer, Implementer, Developer, PR Reviewer, Recommendation, or Codebase Audit tab.";
  }
  const name = roleDisplayName(roleId, roles);
  if (source.fromTerminal) {
    const hasTerminal =
      (source.planFileText ?? "").trim().length > 0 ||
      source.selection.trim().length > 0 ||
      (source.terminalTail ?? "").trim().length > 0;
    if (!hasTerminal) return "There is no plan to send yet.";
    return null;
  }
  if (source.turnInFlight && !source.awaitingPlanApproval) {
    return `Wait until the ${name} finishes this turn.`;
  }
  if (roleId === "role_implementer") {
    if (!implementerAnswersReady(source.answers)) {
      return "Fill in the Implementer task and approved plan before sending to review.";
    }
    return null;
  }
  if (isPlanSource(roleId)) {
    return hasChatContent(source) ? null : "There is no plan to send yet.";
  }
  if (isReportSource(roleId)) {
    return hasChatContent(source) ? null : "There is no report to send yet.";
  }
  return hasChatContent(source) ? null : "There is nothing to send yet.";
}

/** Text under a markdown heading, up to the next heading of the same or higher level. */
function sectionUnder(text: string, heading: RegExp): string | null {
  const match = heading.exec(text);
  if (!match) return null;
  const level = match[0].match(/^#+/)?.[0].length ?? 2;
  const rest = text.slice(match.index + match[0].length);
  const next = new RegExp(`^#{1,${level}}[ \\t]+\\S`, "m").exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  return body || null;
}

/** Plan Reviewer output → the **Reviewed plan** and **Review notes** sections. */
export function splitPlanReview(text: string): { plan: string; notes: string } {
  const plan = sectionUnder(text, REVIEWED_PLAN_HEADING);
  const notes = sectionUnder(text, REVIEW_NOTES_HEADING) ?? "";
  return { plan: plan ?? text.trim(), notes };
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
  if (scope === "plan_mode") text = (source.planMarkdown ?? "").trim();
  else if (scope === "message") text = source.latestMessage.trim();
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
  if (isReportSource(source.sourceRoleId)) {
    const latest: HandoffScope = source.fromTerminal ? "terminal_tail" : "message";
    return [
      {
        id: "selection",
        label: "Selected card or finding",
        enabled: composePlanText(source, "selection").text.length > 0,
      },
      {
        id: latest,
        label: source.fromTerminal
          ? `Last ${TERMINAL_TAIL_LINES} lines`
          : "Whole latest report",
        enabled: composePlanText(source, latest).text.length > 0,
      },
    ];
  }
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
  const choices: ScopeChoice[] = [];
  if ((source.planMarkdown ?? "").trim()) {
    choices.push({
      id: "plan_mode",
      label: "Plan mode (Ready to code?)",
      enabled: composePlanText(source, "plan_mode").text.length > 0,
    });
  }
  choices.push(
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
  );
  return choices;
}

export function defaultScope(source: HandoffSource): HandoffScope {
  if (isReportSource(source.sourceRoleId)) {
    if (composePlanText(source, "selection").text) return "selection";
    return source.fromTerminal ? "terminal_tail" : "message";
  }
  if (source.fromTerminal) {
    if (composePlanText(source, "plan_file").text) return "plan_file";
    if (composePlanText(source, "selection").text) return "selection";
    if (composePlanText(source, "terminal_tail").text) return "terminal_tail";
    return "plan_file";
  }
  const preferred: HandoffScope[] = [
    "plan_mode",
    "plan_and_todos",
    "message",
    "card",
    "selection",
  ];
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
  const label = source.sourceLabel.replace(/^[^·]*·\s*/, "").trim();
  return takeChars(label || `${roleDisplayName(source.sourceRoleId)} hand-off`, 120);
}

function extractDescription(source: HandoffSource, planText: string): string {
  const request =
    answer(source.answers, "request") ||
    answer(source.answers, "description") ||
    answer(source.answers, "originalTask");
  if (request) return request;
  const paragraph = planText
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("#") && !part.startsWith("- ["));
  if (paragraph) return takeChars(paragraph, 4_000);
  return `Implement the plan from the ${roleDisplayName(source.sourceRoleId)} hand-off.`;
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
  const context = [answer(source.answers, "additionalContext"), implementationContext(source)]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  if (contextKey && context) answers[contextKey] = takeChars(context, 8_000);
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

/** Labels used by the Recommendation feature card and the Codebase Audit finding. */
const REPORT_LABELS = [
  "Problem",
  "Proposed Solution",
  "User Workflow",
  "Value",
  "Existing Capability",
  "Codebase Fit",
  "Technical Requirements",
  "Complexity",
  "Risk",
  "Dependencies",
  "Example",
  "Category",
  "Location",
  "Evidence",
  "Impact",
  "Trigger / Scenario",
  "Root Cause",
  "Recommended Direction",
  "Related Components",
  "Confidence",
  "GitHub Issue",
];

/** "## Feature: X" or "## [HIGH] X". The marks are optional: a selection of rendered markdown has none. */
const CARD_HEADING = /^(?:#{1,3}[ \t]+)?(?:Feature:|\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\])[ \t]*(.+)$/gim;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelLine(label: string): RegExp {
  return new RegExp(
    `^(?:#{1,6}[ \\t]+)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?[ \\t]*(?::(?:\\*\\*)?[ \\t]*(.*))?$`,
    "i",
  );
}

/**
 * Body of a labelled section in a card ("### Problem" or "Problem:"), up to
 * the next heading or the next known label. Inline text after "Label:" counts.
 */
export function reportSection(text: string, labels: string[]): string {
  const lines = text.split("\n");
  const matchers = labels.map(labelLine);
  const stops = REPORT_LABELS.map(labelLine);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const hit = matchers.map((re) => re.exec(line)).find((m) => m);
    if (!hit) continue;
    const body: string[] = hit[1]?.trim() ? [hit[1].trim()] : [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].trim();
      if (/^#{1,6}[ \t]+\S/.test(next) || /^```/.test(next)) break;
      if (stops.some((re) => re.test(next))) break;
      body.push(lines[j]);
    }
    const out = body.join("\n").trim();
    if (out) return out;
  }
  return "";
}

/** Number of feature-card / finding headings in a report. */
export function reportCardCount(text: string): number {
  return Array.from(text.matchAll(CARD_HEADING)).length;
}

/** Hint when a whole report (several cards) is about to be sent. */
export function reportScopeHint(source: HandoffSource, scope: HandoffScope): string | null {
  if (!isReportSource(source.sourceRoleId) || scope === "selection") return null;
  const text = composePlanText(source, scope).text;
  if (reportCardCount(text) <= 1) return null;
  return "This sends the whole report. Select one feature card or finding in the transcript to fill in the Planner fields for just that item.";
}

function reportTitle(text: string): string {
  CARD_HEADING.lastIndex = 0;
  const card = CARD_HEADING.exec(text);
  CARD_HEADING.lastIndex = 0;
  if (card?.[1]?.trim()) return card[1].trim();
  return "";
}

function auditTaskType(category: string): string {
  const value = category.toLowerCase();
  if (/bug|security|data|reliab|error|auth/.test(value)) return "Bug";
  if (/architect|maintain|perform|debt|refactor/.test(value)) return "Refactor";
  if (/ci\/cd|test|depend|config|ci\b/.test(value)) return "Chore";
  return "";
}

/**
 * Recommendation / Codebase Audit → Planner. One feature card or finding
 * fills the Planner's request, current and expected behavior, and context.
 * The full text always goes into the request field.
 */
export function mapReportToPlanner(
  source: HandoffSource,
  scope: HandoffScope,
  target: { roleId: string; fields: HandoffField[] },
  limits: HandoffLimits = DEFAULT_HANDOFF_LIMITS,
): MappedHandoff {
  const composed = composePlanText(source, scope);
  const sourceName = roleDisplayName(source.sourceRoleId);
  if (!composed.text) {
    return {
      title: `${sourceName} hand-off`,
      answers: { cwd: source.cwd },
      planText: "",
      inlinePlan: "",
      planField: null,
      usesScratchPad: false,
      truncated: false,
      warning: composed.emptyReason,
    };
  }
  const text = composed.text;
  const limited = limitPlan(text, limits);
  const single = reportCardCount(text) <= 1;
  const keys = new Set(target.fields.map((field) => field.key));
  const answers: Record<string, string> = { cwd: source.cwd };
  const title = takeChars(
    (single && reportTitle(text)) || extractTitle({ ...source, answers: {} }, text),
    120,
  );
  if (keys.has("title")) answers.title = title;
  const taskField = target.fields.find((field) => field.key === "taskType");
  if (taskField) {
    const isAudit = source.sourceRoleId === "role_codebase_audit";
    const taskType = isAudit
      ? single
        ? auditTaskType(reportSection(text, ["Category"]))
        : ""
      : "Feature";
    const allowed = !taskField.options || taskField.options.includes(taskType);
    if (taskType && allowed) answers.taskType = taskType;
  }
  const descriptionKey = firstKey(target.fields, DESCRIPTION_FIELD_KEYS);
  if (descriptionKey) answers[descriptionKey] = limited.inlinePlan;
  if (single) {
    const current = reportSection(text, ["Problem"]);
    const expected = reportSection(text, ["Proposed Solution", "Recommended Direction"]);
    if (current && keys.has("currentBehavior")) answers.currentBehavior = takeChars(current, 4_000);
    if (expected && keys.has("expectedBehavior")) {
      answers.expectedBehavior = takeChars(expected, 4_000);
    }
  }
  const contextKey = firstKey(target.fields, CONTEXT_FIELD_KEYS);
  if (contextKey) {
    const parts = [`From the ${sourceName} report (${source.sourceLabel}).`];
    if (single) {
      const extras =
        source.sourceRoleId === "role_codebase_audit"
          ? (["Location", "Evidence", "Impact"] as const)
          : (["Existing Capability", "Codebase Fit", "Dependencies"] as const);
      for (const label of extras) {
        const body = reportSection(text, [label]);
        if (body) parts.push(`${label}:\n${body}`);
      }
    }
    answers[contextKey] = takeChars(parts.join("\n\n"), 8_000);
  }
  return {
    title: title || `${sourceName} hand-off`,
    answers,
    planText: limited.planText,
    inlinePlan: limited.inlinePlan,
    // The report text lives in the request field, not the scratch pad.
    planField: descriptionKey,
    usesScratchPad: descriptionKey === null,
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
  if (isReportSource(source.sourceRoleId) && target.roleId === "role_planner") {
    return mapReportToPlanner(source, scope, target, limits);
  }
  const composed = composePlanText(source, scope);
  let reviewNotes = "";
  if (
    source.sourceRoleId === "role_plan_reviewer" &&
    target.roleId !== "role_planner" &&
    composed.text
  ) {
    const split = splitPlanReview(composed.text);
    composed.text = split.plan;
    reviewNotes = split.notes;
  }
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
  const baseContext = extractContext(source);
  const context = reviewNotes
    ? [`Review notes:\n${reviewNotes}`, baseContext].filter(Boolean).join("\n\n")
    : baseContext;
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
