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
import { contractFindings, contractImplementation, contractPlan, contractReview } from "./contract";
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
  label?: string;
  type?: string;
  options?: string[];
  required?: boolean;
  /** Same rule as `field_visible` (Rust): shown only while `fieldKey` equals one of `equals`. */
  showWhen?: { fieldKey: string; equals: string[] } | null;
};

/** The role a hand-off opens. `templateText` lets the dialog spot tokens no field fills. */
export type HandoffTarget = {
  roleId: string;
  fields: HandoffField[];
  templateText?: string | null;
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
  /** Set when the source is a terminal-mode role tab. */
  fromTerminal?: boolean;
  /** Body of the newest plan file written after the terminal started. */
  planFileText?: string;
  planFileName?: string;
  /** The terminal's Claude session log was read: `latestMessage` is its last reply. */
  terminalLog?: boolean;
  /** Last lines of the terminal buffer, already stripped of ANSI codes. */
  terminalTail?: string;
  /** Claude ExitPlanMode body ("Ready to code?"). Preferred over the card. */
  planMarkdown?: string;
  /** The user wrote to the agent after that plan, so a newer reply may revise it. */
  planMarkdownStale?: boolean;
  /** Whole-tab snapshot: path and +/− only. Diffs are not pasted. */
  changes?: { path: string; additions: number | null; deletions: number | null }[];
  branch?: string | null;
  /** Transcript text scanned for the first GitHub pull-request URL. */
  transcriptText?: string;
  /** The source role's form fields, so hidden answers (Planner Current Behavior unless Bug) stay behind. */
  sourceFields?: HandoffField[];
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

/**
 * Fields are found by meaning: known keys first (built-in roles, older saved roles
 * such as Plan Reviewer's `originalRequest` / `candidatePlan`), then the label.
 */
const PLAN_FIELD_KEYS = [
  "approvedPlan",
  "plan",
  "implementationPlan",
  "candidatePlan",
  "proposedPlan",
  "reviewedPlan",
];
const DESCRIPTION_FIELD_KEYS = [
  "description",
  "request",
  "originalTask",
  "originalRequest",
  "task",
  "requirements",
];
const CONTEXT_FIELD_KEYS = ["additionalContext", "context", "notes"];
const PLAN_FIELD_LABEL = /\bplan\b/i;
const DESCRIPTION_FIELD_LABEL =
  /\b(original|request|requirements?|task|description|asked|goal|objective|problem|what to work on)\b/i;
const CONTEXT_FIELD_LABEL = /\b(context|notes|background|constraints)\b/i;
const EXPECTED_FIELD_LABEL = /\bexpected\b/i;
const CURRENT_FIELD_LABEL = /\b(current|actual)\b.*\bbehaviou?r\b/i;
/** A field that holds the whole original request, so it gets every Planner answer. */
const ORIGINAL_FIELD = /original|requirement/i;
const NOT_FREE_TEXT = new Set(["taskType", "title", "cwd"]);
const GITHUB_PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

/** First GitHub pull-request URL in a transcript. Large diffs are not used. */
export function firstGithubPrUrl(text: string): string | null {
  return text.match(GITHUB_PR_URL)?.[0] ?? null;
}

/** Implementer → PR Reviewer extra context. Paths and counts, never a diff. */
export function implementationContext(source: HandoffSource): string {
  const parts: string[] = [];
  const declared = contractImplementation(source.latestMessage);
  if (declared) {
    if (declared.summary) parts.push(`Implementation summary:\n${takeChars(declared.summary, 4_000)}`);
    if (declared.files) parts.push(`Files changed (Implementer's notes):\n${takeChars(declared.files, 4_000)}`);
    if (declared.tests) parts.push(`Tests run:\n${takeChars(declared.tests, 2_000)}`);
    if (declared.deviations) parts.push(`Deviations from the plan:\n${takeChars(declared.deviations, 2_000)}`);
  } else {
    const summary = source.latestMessage.trim();
    if (summary) parts.push(`Implementation summary:\n${takeChars(summary, 4_000)}`);
  }
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
  const pr =
    firstGithubPrUrl(declared?.pullRequest ?? "") ??
    firstGithubPrUrl(`${source.transcriptText ?? ""}\n${source.latestMessage}`);
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

/** True when the target asks for a task type the mapped hand-off did not fill. */
export function needsChainTaskType(
  mapped: MappedHandoff,
  target: { fields: HandoffField[] },
): boolean {
  return (
    !!mapped.planText &&
    !mapped.answers.taskType &&
    target.fields.some((field) => field.key === "taskType")
  );
}

/**
 * Fill the target's task type from the chain's step-1 form (Planner or
 * Implementer) when the source had none, e.g. Plan Reviewer → Implementer.
 */
export function carryChainTaskType(
  mapped: MappedHandoff,
  target: { fields: HandoffField[] },
  chainTaskType: string | null | undefined,
): MappedHandoff {
  const raw = chainTaskType?.trim() ?? "";
  const field = target.fields.find((f) => f.key === "taskType");
  if (!raw || !field || !needsChainTaskType(mapped, target)) return mapped;
  const value = taskTypeFor(field, raw);
  return value ? { ...mapped, answers: { ...mapped.answers, taskType: value } } : mapped;
}

/** Other names for a task type, so Planner, Implementer and renamed selects understand each other. */
const TASK_TYPE_ALIASES: Record<string, string[]> = {
  Bug: ["Bug Fix"],
  "Bug Fix": ["Bug"],
  Chore: ["Other"],
  Other: ["Chore"],
  Improvement: ["Feature"],
};

/**
 * The option a select can take for `wanted`: exact, then any case, then an option
 * that starts with the same word ("Bug" → "Bug Fix", "Feature" → "Feature request").
 * Free-text fields take the value as is. Empty when nothing fits.
 */
export function pickOption(options: string[] | undefined, wanted: string[]): string {
  const values = wanted.map((value) => value.trim()).filter(Boolean);
  if (!options || options.length === 0) return values[0] ?? "";
  for (const value of values) if (options.includes(value)) return value;
  for (const value of values) {
    const hit = options.find((option) => option.toLowerCase() === value.toLowerCase());
    if (hit) return hit;
  }
  // A renamed option: "Bug" → "Bug report", "Feature" → "New feature", "Refactor" → "Refactoring".
  for (const value of values) {
    const word = value.toLowerCase().split(/\s+/)[0];
    const hit = options.find((option) => {
      const lower = option.toLowerCase();
      return lower.split(/\s+/).includes(word) || lower.startsWith(value.toLowerCase());
    });
    if (hit) return hit;
  }
  return "";
}

function taskTypeFor(field: HandoffField, raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return pickOption(field.options, [
    value,
    TASK_TYPE_TO_IMPLEMENTER[value] ?? "",
    ...(TASK_TYPE_ALIASES[value] ?? []),
  ]);
}

/** Windows (`\r\n`) and old Mac (`\r`) line endings become `\n`, then the ends are trimmed. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

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

const REPLY_START = /^[ \t]*(?:#{1,6}[ \t]+\S|(?:\*\*|__)?verdict\b)/im;

/**
 * The agent's reply in the current turn. A reply split by tool calls (a
 * verdict, a check, then the reviewed plan) is joined from its first part
 * that opens with a heading or a Verdict label; short "Let me check" lines
 * before it are left out. Without such a part, the last agent message.
 */
export function latestReplyText(segments: { kind: string; text: string }[]): string {
  let start = segments.length;
  while (start > 0 && segments[start - 1].kind !== "user") start -= 1;
  const parts = segments.slice(start).filter((s) => s.kind === "agent" && s.text.trim());
  if (parts.length === 0) return latestAgentMessage(segments);
  const first = parts.findIndex((s) => REPLY_START.test(s.text));
  if (first < 0) return parts[parts.length - 1].text.trim();
  return parts
    .slice(first)
    .map((s) => s.text.trim())
    .join("\n\n");
}

/**
 * A plan message without its short lead-in ("Nothing has been approved yet.
 * Here is the revised plan:"), so the next role does not take the lead-in
 * as part of the plan. Only a few short lines before the first heading go.
 */
export function stripPlanPreamble(text: string): string {
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => /^#{1,3}[ \t]+\S/.test(line));
  if (heading <= 0) return text;
  const lead = lines.slice(0, heading).filter((line) => line.trim());
  const rest = lines.slice(heading).join("\n").trim();
  const leadChars = lead.join(" ").length;
  if (lead.length > 3 || leadChars > 300 || rest.length < leadChars) return text;
  return rest;
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
    // The Implementer's own form carries the task; the terminal adds a summary.
    if (roleId === "role_implementer" && implementerAnswersReady(source.answers)) return null;
    const hasTerminal =
      (source.planMarkdown ?? "").trim().length > 0 ||
      source.latestMessage.trim().length > 0 ||
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

/**
 * A Plan Reviewer section heading line. Accepts what models actually write:
 * "## Reviewed plan", "### **Revised Plan:**", "## 10. Reviewed implementation
 * plan", a bold "**Reviewed plan**" line, or a plain "Reviewed plan" line
 * (rendered markdown copied without its marks).
 */
function sectionHeading(title: string): RegExp {
  return new RegExp(
    `^[ \\t]*(#{1,6}[ \\t]+)?(?:\\*\\*|__)?[ \\t]*(?:\\d+[.)][ \\t]*)?(?:${title})[ \\t]*(?:\\*\\*|__)?[ \\t]*:?[ \\t]*(?:\\*\\*|__)?[ \\t]*$`,
    "gim",
  );
}
const REVIEWED_PLAN_HEADING = sectionHeading(
  "(?:final[ \\t]+)?(?:reviewed|revised|updated|corrected)[ \\t]+(?:implementation[ \\t]+)?plan",
);
const REVIEW_NOTES_HEADING = sectionHeading(
  "review(?:er)?(?:'s)?[ \\t]+notes|notes[ \\t]+for[ \\t]+(?:the[ \\t]+)?implementer",
);
/** Review sections that may follow the reviewed plan; anything else is part of the plan. */
const AFTER_PLAN_HEADING = sectionHeading(
  "(?:final[ \\t]+)?verdict|final[ \\t]+recommendation|review(?:er)?(?:'s)?[ \\t]+notes|notes[ \\t]+for[ \\t]+(?:the[ \\t]+)?implementer",
);

type HeadingHit = { start: number; end: number; level: number | null };

function headingHits(text: string, re: RegExp): HeadingHit[] {
  re.lastIndex = 0;
  return Array.from(text.matchAll(re), (m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    level: m[1] ? m[1].trim().length : null,
  }));
}

function lastOf<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

/** First markdown heading at `level` or higher after `from`. */
function nextHeadingAt(text: string, from: number, level: number): number | null {
  const next = new RegExp(`^[ \\t]*#{1,${level}}[ \\t]+\\S`, "m").exec(text.slice(from));
  return next ? from + next.index : null;
}

/**
 * Plan Reviewer output → the **Reviewed plan** and **Review notes** sections.
 * The reviewed plan is often the Planner's plan repeated, with its own `##`
 * headings, so it runs to the next review section (notes, verdict, final
 * recommendation), not to the next heading. The last heading of each kind
 * wins, so a reply that first quotes the instructions still splits.
 */
export function splitPlanReview(text: string): { plan: string; notes: string } {
  const declared = contractReview(text);
  if (declared) return declared;
  const planHit = lastOf(headingHits(text, REVIEWED_PLAN_HEADING));
  const notesHits = headingHits(text, REVIEW_NOTES_HEADING);
  let plan: string | null = null;
  if (planHit) {
    const stop = headingHits(text, AFTER_PLAN_HEADING).find((hit) => hit.start >= planHit.end);
    plan = text.slice(planHit.end, stop ? stop.start : text.length).trim() || null;
  }
  const notesHit =
    (planHit ? lastOf(notesHits.filter((hit) => hit.start >= planHit.end)) : undefined) ??
    lastOf(notesHits);
  let notes = "";
  if (notesHit) {
    const nextPlan = planHit && planHit.start > notesHit.end ? planHit.start : null;
    const nextHeading =
      notesHit.level !== null ? nextHeadingAt(text, notesHit.end, notesHit.level) : null;
    const ends = [nextPlan, nextHeading].filter((n): n is number => n !== null);
    notes = text.slice(notesHit.end, ends.length ? Math.min(...ends) : text.length).trim();
  }
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
  if (scope === "plan_mode") text = cleanText(source.planMarkdown ?? "");
  else if (scope === "message") text = cleanText(source.latestMessage);
  else if (scope === "card") text = cleanText(formatPlanCard(source.plan, source.todos));
  else if (scope === "selection") text = cleanText(source.selection);
  else if (scope === "plan_file") text = cleanText(source.planFileText ?? "");
  else if (scope === "terminal_tail") text = cleanText(source.terminalTail ?? "");
  else {
    const latest = cleanText(source.latestMessage);
    const message = source.sourceRoleId === "role_planner" ? stripPlanPreamble(latest) : latest;
    const card = cleanText(formatPlanCard(source.plan, source.todos));
    text = message && card ? `${message}\n\n${card}` : message || card;
  }
  if (!text) return { text: "", emptyReason: "That choice has no content." };
  // A reply that follows the hand-off contract hands on exactly its sections.
  if (source.sourceRoleId === "role_planner") text = contractPlan(text) ?? text;
  if (source.sourceRoleId === "role_pr_reviewer") text = contractFindings(text) || text;
  return { text, emptyReason: null };
}

export type ScopeChoice = {
  id: HandoffScope;
  label: string;
  enabled: boolean;
};

function lastReplyChoice(source: HandoffSource): ScopeChoice {
  return {
    id: "message",
    label: "Claude's last reply",
    enabled: composePlanText(source, "message").text.length > 0,
  };
}

/**
 * Terminal defaults once the session log is read: a Planner's ExitPlanMode
 * plan first; reviewers, the Implementer and other roles lead with the last
 * reply. A plan the user answered after is skipped while a newer reply exists.
 */
function terminalScopeOrder(source: HandoffSource): HandoffScope[] {
  const roleId = source.sourceRoleId;
  const order: HandoffScope[] =
    roleId === "role_planner"
      ? ["plan_mode", "message", "plan_file", "selection", "terminal_tail"]
      : isPlanSource(roleId)
        ? ["message", "plan_mode", "plan_file", "selection", "terminal_tail"]
        : ["message", "selection", "terminal_tail"];
  const newerReply = !!source.planMarkdownStale && !!source.latestMessage.trim();
  return order.filter(
    (scope) =>
      (scope !== "message" || !!source.terminalLog) &&
      (scope !== "plan_mode" || !newerReply) &&
      (scope !== "plan_file" || isPlanSource(roleId)),
  );
}

export function scopeChoices(source: HandoffSource): ScopeChoice[] {
  if (isReportSource(source.sourceRoleId)) {
    const latest: HandoffScope = source.fromTerminal ? "terminal_tail" : "message";
    return [
      {
        id: "selection",
        label: "Selected card or finding",
        enabled: composePlanText(source, "selection").text.length > 0,
      },
      ...(source.terminalLog ? [lastReplyChoice(source)] : []),
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
    const planSource = isPlanSource(source.sourceRoleId);
    const fileLabel = source.planFileName
      ? `Newest plan file (${source.planFileName})`
      : "Newest plan file";
    const terminalChoices: ScopeChoice[] = [];
    if (planSource && (source.planMarkdown ?? "").trim()) {
      terminalChoices.push({
        id: "plan_mode",
        label: source.planMarkdownStale
          ? "Claude's earlier plan (ExitPlanMode)"
          : "Claude's plan (ExitPlanMode)",
        enabled: composePlanText(source, "plan_mode").text.length > 0,
      });
    }
    if (source.terminalLog) terminalChoices.push(lastReplyChoice(source));
    // Only Planner and Plan Reviewer terminals write plan files.
    if (planSource) {
      terminalChoices.push({
        id: "plan_file",
        label: fileLabel,
        enabled: composePlanText(source, "plan_file").text.length > 0,
      });
    }
    terminalChoices.push(
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
    );
    return terminalChoices;
  }
  const choices: ScopeChoice[] = [];
  if ((source.planMarkdown ?? "").trim()) {
    choices.push({
      id: "plan_mode",
      label: source.planMarkdownStale
        ? "Claude's earlier plan (Ready to code?)"
        : "Claude's plan (Ready to code?)",
      enabled: composePlanText(source, "plan_mode").text.length > 0,
    });
  }
  if ((source.planFileText ?? "").trim()) {
    choices.push({
      id: "plan_file",
      label: source.planFileName ? `Plan file (${source.planFileName})` : "Plan file",
      enabled: true,
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
    if (source.terminalLog && composePlanText(source, "message").text) return "message";
    return source.fromTerminal ? "terminal_tail" : "message";
  }
  if (source.fromTerminal) {
    for (const scope of terminalScopeOrder(source)) {
      if (composePlanText(source, scope).text) return scope;
    }
    return isPlanSource(source.sourceRoleId) ? "plan_file" : "terminal_tail";
  }
  const preferred: HandoffScope[] = [
    "plan_mode",
    "plan_file",
    "plan_and_todos",
    "message",
    "card",
    "selection",
  ];
  // A reply written after the user answered the plan may revise it, so it
  // wins over a plan Claude submitted before that message.
  const newerReply = !!source.planMarkdownStale && !!source.latestMessage.trim();
  for (const scope of preferred) {
    if (newerReply && scope === "plan_mode") continue;
    if (composePlanText(source, scope).text) return scope;
  }
  return "plan_and_todos";
}

function answer(values: Record<string, string>, key: string): string {
  return cleanText(values[key] ?? "");
}

/** Headings that name a section, not the work ("## Plan", "## Reviewed plan"). */
const GENERIC_TITLE =
  /^(?:the\s+)?(?:(?:implementation|proposed|reviewed|approved|revised|final|updated)\s+)*(?:implementation\s+)?(?:plan|review notes|review|verdict|summary|overview|to-?dos|tasks|steps|notes|context|findings|recommendations|report|changes|codebase audit|audit|feature cards?)$/i;

/** One line, no markdown marks, no "Feature:" / "[HIGH]" / "Title:" prefix, at most 120 characters. */
export function cleanTitle(raw: string): string {
  const line = cleanText(raw).split("\n")[0] ?? "";
  const text = line
    .replace(/^#{1,6}[ \t]+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^(?:Title|Feature)[ \t]*:[ \t]*/i, "")
    .replace(/^\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\][ \t]*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[ \t]*:$/, "")
    .trim();
  return takeChars(text, 120).trim();
}

/** A title the user typed: kept as typed, on one line, at most 120 characters. */
function typedTitle(raw: string): string {
  const line = cleanText(raw).split("\n")[0] ?? "";
  return takeChars(line.replace(/\s+/g, " "), 120).trim();
}

/** Lines outside code fences, so a `# comment` in a bash block is never a heading. */
function proseLines(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}

/** Title from the answers, else the first heading that names the work, else the first prose line. */
export function extractTitle(source: HandoffSource, planText: string): string {
  const fromAnswers = typedTitle(requestParts(source.answers, source.sourceFields).title);
  if (fromAnswers) return fromAnswers;
  const lines = proseLines(cleanText(planText));
  for (const line of lines) {
    const heading = /^#{1,3}[ \t]+(.+)$/.exec(line);
    const title = heading ? cleanTitle(heading[1]) : "";
    if (title && !GENERIC_TITLE.test(title)) return title;
  }
  for (const line of lines) {
    if (!line || /^(#|[-*+>|]|\d+[.)][ \t])/.test(line)) continue;
    const title = cleanTitle(line);
    if (title && !GENERIC_TITLE.test(title)) return title;
  }
  const label = cleanTitle(source.sourceLabel.replace(/^[^·]*·\s*/, ""));
  return label || `${roleDisplayName(source.sourceRoleId)} hand-off`;
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

/** Field text cut to `max`, with a warning naming the field when anything was cut. */
function clip(
  text: string,
  max: number,
  label: string,
  warnings: string[],
): string {
  if (charCount(text) <= max) return text;
  warnings.push(`${label} was shortened to ${max.toLocaleString()} characters.`);
  return takeChars(text, max);
}

function joinWarnings(...parts: (string | null | undefined | string[])[]): string | null {
  const all = parts.flat().filter((part): part is string => !!part && part.trim().length > 0);
  return all.length > 0 ? all.join(" ") : null;
}

type FieldRole = "plan" | "description" | "context" | "expected" | "current";

const ROLE_KEYS: Record<FieldRole, string[]> = {
  plan: PLAN_FIELD_KEYS,
  description: DESCRIPTION_FIELD_KEYS,
  context: CONTEXT_FIELD_KEYS,
  expected: ["expectedBehavior", "expected"],
  current: ["currentBehavior", "actualBehavior", "current"],
};
const ROLE_LABELS: Record<FieldRole, RegExp> = {
  plan: PLAN_FIELD_LABEL,
  description: DESCRIPTION_FIELD_LABEL,
  context: CONTEXT_FIELD_LABEL,
  expected: EXPECTED_FIELD_LABEL,
  current: CURRENT_FIELD_LABEL,
};
/** Order matters: a field taken by an earlier role is not offered to a later one. */
const ROLE_ORDER: FieldRole[] = ["plan", "expected", "current", "description", "context"];
/** A plan or context never goes into a one-line or pick-list field. */
const LONG_TEXT_ONLY: ReadonlySet<FieldRole> = new Set(["plan", "context", "expected", "current"]);

/** The target field for `role`: a known key, else a free-text field whose label says so. */
function fieldFor(
  fields: HandoffField[],
  role: FieldRole,
  taken: ReadonlySet<string> = new Set(),
): string | null {
  const present = new Set(fields.map((field) => field.key));
  const byKey = ROLE_KEYS[role].find((key) => present.has(key) && !taken.has(key));
  if (byKey) return byKey;
  const known = new Set(Object.values(ROLE_KEYS).flat());
  const match = fields.find((field) => {
    if (taken.has(field.key) || NOT_FREE_TEXT.has(field.key) || known.has(field.key)) return false;
    if (field.type === "select" || field.type === "folder") return false;
    if (LONG_TEXT_ONLY.has(role) && field.type === "text") return false;
    const label = field.label ?? field.key;
    if (!ROLE_LABELS[role].test(label)) return false;
    // "Original plan" is a plan, and "Request notes" is context, not the request.
    if (role === "description") return !PLAN_FIELD_LABEL.test(label) && !CONTEXT_FIELD_LABEL.test(label);
    return true;
  });
  return match?.key ?? null;
}

type Slots = Record<FieldRole, string | null>;

/** Each meaning gets its own field: one field is never filled twice. */
function targetSlots(fields: HandoffField[]): Slots {
  const taken = new Set<string>();
  const slots = {} as Slots;
  for (const role of ROLE_ORDER) {
    const key = fieldFor(fields, role, taken);
    slots[role] = key;
    if (key) taken.add(key);
  }
  return slots;
}

/**
 * Title and "What to work on": what the form shows for a role with no fields
 * (Developer, General). Mirrors `fieldsForForm` in `startupFields.ts`.
 */
const LOOSE_FIELDS: HandoffField[] = [
  { key: "title", label: "Title", type: "text", required: false },
  { key: "request", label: "What to work on", type: "multiline", required: false },
];

/** The fields the target's form shows. */
export function handoffFormFields(fields: HandoffField[]): HandoffField[] {
  const own = fields.filter((field) => field.type !== "folder" && field.key !== "cwd");
  return own.length > 0 ? own : LOOSE_FIELDS;
}

export function isFieldVisible(field: HandoffField, values: Record<string, string>): boolean {
  if (!field.showWhen) return true;
  return field.showWhen.equals.includes((values[field.showWhen.fieldKey] ?? "").trim());
}

/** Answers without the ones the source form hides (a Feature's leftover Current Behavior). */
function visibleAnswers(source: HandoffSource): HandoffSource {
  const fields = source.sourceFields;
  if (!fields?.length) return source;
  const answers = { ...source.answers };
  for (const field of fields) {
    if (!isFieldVisible(field, source.answers)) delete answers[field.key];
  }
  return { ...source, answers };
}

function isOriginalField(fields: HandoffField[], key: string | null): boolean {
  if (!key) return false;
  const field = fields.find((f) => f.key === key);
  return ORIGINAL_FIELD.test(key) || ORIGINAL_FIELD.test(field?.label ?? "");
}

/** The request as the source tab saw it, under whichever key its role uses. */
function sourceRequest(values: Record<string, string>, fields?: HandoffField[]): string {
  for (const key of DESCRIPTION_FIELD_KEYS) {
    const value = answer(values, key);
    if (value) return value;
  }
  // A custom source role: its own request field, found by label.
  const key = fields?.length ? fieldFor(fields, "description") : null;
  return key ? answer(values, key) : "";
}

type RequestParts = {
  title: string;
  taskType: string;
  request: string;
  expected: string;
  current: string;
};

const BLOCK_LINE = /^(title|task type):[ \t]*(.+)$/i;
const BLOCK_SECTION = /^(request|expected behaviou?r|current behaviou?r):[ \t]*$/i;

/** Reads a block written by `composeOriginalTask` back into its parts. Null for plain text. */
function parseOriginalTask(text: string): RequestParts | null {
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim())?.trim() ?? "";
  const labelled =
    BLOCK_LINE.test(first) ||
    BLOCK_SECTION.test(first) ||
    lines.some((line) => /^(expected|current) behaviou?r:[ \t]*$/i.test(line.trim()));
  if (!labelled) return null;
  const parts: RequestParts = { title: "", taskType: "", request: "", expected: "", current: "" };
  const bodies: Record<"request" | "expected" | "current", string[]> = {
    request: [],
    expected: [],
    current: [],
  };
  let section: "request" | "expected" | "current" = "request";
  let inBody = false;
  for (const raw of lines) {
    const line = raw.trim();
    const single = inBody ? null : BLOCK_LINE.exec(line);
    if (single) {
      if (/^title$/i.test(single[1])) parts.title = single[2].trim();
      else parts.taskType = single[2].trim();
      continue;
    }
    const head = BLOCK_SECTION.exec(line);
    if (head) {
      const name = head[1].toLowerCase();
      section = name.startsWith("expected") ? "expected" : name.startsWith("current") ? "current" : "request";
      inBody = true;
      continue;
    }
    if (line) inBody = true;
    bodies[section].push(raw);
  }
  parts.request = bodies.request.join("\n").trim();
  parts.expected = bodies.expected.join("\n").trim();
  parts.current = bodies.current.join("\n").trim();
  return parts;
}

/** Title, task type, request and behaviors from Planner answers or a reviewer's original-request block. */
function requestParts(values: Record<string, string>, fields?: HandoffField[]): RequestParts {
  const raw = sourceRequest(values, fields);
  const block = raw ? parseOriginalTask(raw) : null;
  return {
    title: answer(values, "title") || block?.title || "",
    taskType: answer(values, "taskType") || block?.taskType || "",
    request: block ? block.request : raw,
    expected: answer(values, "expectedBehavior") || block?.expected || "",
    current: answer(values, "currentBehavior") || block?.current || "",
  };
}

const NO_PARTS: RequestParts = { title: "", taskType: "", request: "", expected: "", current: "" };

function composeParts(parts: RequestParts): string {
  const out: string[] = [];
  if (parts.title) out.push(`Title: ${parts.title}`);
  if (parts.taskType) out.push(`Task type: ${parts.taskType}`);
  if (parts.request) out.push(out.length > 0 ? `Request:\n${parts.request}` : parts.request);
  if (parts.expected) out.push(`Expected behavior:\n${parts.expected}`);
  if (parts.current) out.push(`Current behavior:\n${parts.current}`);
  return out.join("\n\n");
}

/**
 * Every Planner answer as one block, for a reviewer's "original request" field.
 * The labelled lines let later steps recover the title and task type.
 */
export function composeOriginalTask(values: Record<string, string>): string {
  return composeParts(requestParts(values));
}

function behaviorContext(parts: RequestParts, skip: { expected: boolean; current: boolean }): string[] {
  const out: string[] = [];
  if (parts.expected && !skip.expected) out.push(`Expected behavior:\n${parts.expected}`);
  if (parts.current && !skip.current) out.push(`Current behavior:\n${parts.current}`);
  return out;
}

/**
 * The session log's reply and ExitPlanMode plan as hand-off source fields.
 * The plan is stale when the user wrote to Claude after it.
 */
export function terminalLogFields(
  log: { lastReply: string; plan: string | null; planAt: string | null; lastPromptAt: string | null } | null,
): Pick<HandoffSource, "terminalLog" | "latestMessage" | "planMarkdown" | "planMarkdownStale"> {
  if (!log) return { latestMessage: "" };
  const plan = (log.plan ?? "").trim();
  const planAt = log.planAt ? Date.parse(log.planAt) : NaN;
  const promptAt = log.lastPromptAt ? Date.parse(log.lastPromptAt) : NaN;
  return {
    terminalLog: true,
    latestMessage: log.lastReply,
    planMarkdown: plan,
    planMarkdownStale: !!plan && promptAt > planAt,
  };
}

/**
 * A terminal Implementer's summary is the chosen scope: Claude's last reply
 * from the session log, else the selection or tail. The whole scrollback is
 * searched for the PR URL.
 */
export function terminalImplementerSource(
  source: HandoffSource,
  scope: HandoffScope,
): HandoffSource {
  if (!source.fromTerminal) return source;
  const summary = composePlanText(source, scope).text;
  return {
    ...source,
    latestMessage: summary,
    transcriptText: [source.transcriptText ?? "", source.terminalTail ?? "", summary].join("\n"),
  };
}

/** Implementer form → PR Reviewer fields (no plan-scope picker). */
export function mapImplementerToReviewer(
  source: HandoffSource,
  target: { roleId: string; fields: HandoffField[] },
  limits: HandoffLimits = DEFAULT_HANDOFF_LIMITS,
): MappedHandoff {
  const parts = requestParts(source.answers, source.sourceFields);
  const title =
    typedTitle(parts.title) ||
    cleanTitle(source.sourceLabel.replace(/^Implementer\s*·\s*/i, ""));
  const description = sourceRequest(source.answers, source.sourceFields);
  const planText = PLAN_FIELD_KEYS.map((key) => answer(source.answers, key)).find(Boolean) ?? "";
  // A description handed on from the Plan Reviewer already carries its Title / Task type lines.
  // A block that already names its title is passed on as is; otherwise the
  // Implementer's title and task type head the request and its behaviors.
  const originalTask = parseOriginalTask(description)?.title
    ? description
    : composeParts({ ...parts, title }) || "Review the Implementer session.";
  const warnings: string[] = [];
  const answers: Record<string, string> = { cwd: source.cwd };
  const fields = handoffFormFields(target.fields);
  const slots = targetSlots(fields);
  // With no approved plan, the original task is what the hand-off carries.
  const carried = planText || originalTask;
  const limited = limitPlan(carried, limits);
  if (slots.description) {
    answers[slots.description] = planText
      ? clip(originalTask, 4_000, labelOf(fields, slots.description), warnings)
      : limited.inlinePlan;
  }
  if (slots.plan && planText) answers[slots.plan] = limited.inlinePlan;
  const context = [answer(source.answers, "additionalContext"), implementationContext(source)]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  if (slots.context && context) {
    answers[slots.context] = clip(context, 8_000, labelOf(fields, slots.context), warnings);
  }
  if (fields.some((field) => field.key === "title")) answers.title = title;
  const planField = planText ? slots.plan : slots.description;
  return {
    title: title || "Implementer hand-off",
    answers,
    planText: limited.planText,
    inlinePlan: limited.inlinePlan,
    planField,
    usesScratchPad: planField === null,
    truncated: limited.truncated || warnings.length > 0,
    warning: joinWarnings(limited.warning, warnings),
  };
}

function labelOf(fields: HandoffField[], key: string): string {
  return fields.find((field) => field.key === key)?.label?.trim() || key;
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
  return sectionSpan(text.split("\n"), labels)?.body ?? "";
}

/**
 * Line range [start, end) and body of the first non-empty labelled section.
 * The first line under a bare label is its value even when it reads like a
 * label ("Category:" then "Dependencies").
 */
function sectionSpan(
  lines: string[],
  labels: string[],
): { start: number; end: number; body: string } | null {
  const matchers = labels.map(labelLine);
  const stops = REPORT_LABELS.map(labelLine);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const hit = matchers.map((re) => re.exec(line)).find((m) => m);
    if (!hit) continue;
    const body: string[] = hit[1]?.trim() ? [hit[1].trim()] : [];
    let end = i + 1;
    for (; end < lines.length; end += 1) {
      const next = lines[end].trim();
      if (/^#{1,6}[ \t]+\S/.test(next) || /^```/.test(next)) break;
      const valueLine = body.every((part) => !part.trim()) && !/^\*\*|:/.test(next);
      if (!valueLine && stops.some((re) => re.test(next))) break;
      body.push(lines[end]);
    }
    const out = body.join("\n").trim();
    if (out) return { start: i, end, body: out };
  }
  return null;
}

/** The card without the sections that now have fields of their own. */
function withoutSections(text: string, labels: string[]): string {
  let lines = text.split("\n");
  for (const label of labels) {
    const span = sectionSpan(lines, [label]);
    if (span) lines = [...lines.slice(0, span.start), ...lines.slice(span.end)];
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Number of feature-card / finding headings in a report. */
export function reportCardCount(text: string): number {
  return Array.from(text.matchAll(CARD_HEADING)).length;
}

/** Hint when a whole report (several cards) is about to be sent. */
export function reportScopeHint(source: HandoffSource, scope: HandoffScope): string | null {
  if (!isReportSource(source.sourceRoleId)) return null;
  const text = composePlanText(source, scope).text;
  const count = reportCardCount(text);
  if (count <= 1) return null;
  if (scope === "selection") {
    return `The selection covers ${count} cards, so only the request is filled. Select one feature card or finding to fill in the other Planner fields.`;
  }
  return "This sends the whole report. Select one feature card or finding in the transcript to fill in the Planner fields for just that item.";
}

function reportTitle(text: string): string {
  CARD_HEADING.lastIndex = 0;
  const card = CARD_HEADING.exec(text);
  CARD_HEADING.lastIndex = 0;
  return card?.[1] ? cleanTitle(card[1]) : "";
}

/** Planner task type for an audit finding's Category. Empty when the category says nothing. */
export function auditTaskType(category: string): string {
  const value = category.toLowerCase();
  if (/bug|security|data|reliab|error|auth|accessib|crash|leak/.test(value)) return "Bug";
  if (/architect|maintain|perform|debt|refactor|duplicat/.test(value)) return "Refactor";
  if (/ci\/cd|test|depend|config|ci\b|doc|build|tooling|lint/.test(value)) return "Chore";
  if (/feature|ux\b|usability/.test(value)) return "Feature";
  return "";
}

/** Task type a report card asks for: Recommendation cards are features, findings follow Category. */
function reportTaskType(source: HandoffSource, text: string): string {
  if (source.sourceRoleId !== "role_codebase_audit") return "Feature";
  return reportCardCount(text) <= 1 ? auditTaskType(reportSection(text, ["Category"])) : "";
}

/** "Effort controls", or "Effort controls and 2 more" for several cards. */
function reportTitleFor(source: HandoffSource, text: string): string {
  const count = reportCardCount(text);
  const first = reportTitle(text);
  if (first && count > 1) return cleanTitle(`${first} and ${count - 1} more`);
  return first || extractTitle({ ...source, answers: {} }, text);
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
  const fields = handoffFormFields(target.fields);
  const slots = targetSlots(fields);
  const keys = new Set(fields.map((field) => field.key));
  const warnings: string[] = [];
  const answers: Record<string, string> = { cwd: source.cwd };
  const title = reportTitleFor(source, text);
  if (keys.has("title")) answers.title = title;
  const taskField = fields.find((field) => field.key === "taskType");
  if (taskField) {
    const taskType = taskTypeFor(taskField, reportTaskType(source, text));
    if (taskType) answers.taskType = taskType;
  }
  // Sections that get their own field leave the request, so nothing is said twice.
  const placed: string[] = [];
  const shown = (key: string | null) => {
    const field = key ? fields.find((f) => f.key === key) : undefined;
    return !!field && isFieldVisible(field, answers);
  };
  if (single && !limited.truncated) {
    const current = reportSection(text, ["Problem"]);
    const expectedLabels = ["Proposed Solution", "Recommended Direction"];
    const expected = reportSection(text, expectedLabels);
    if (current && slots.current && shown(slots.current)) {
      answers[slots.current] = clip(current, 4_000, labelOf(fields, slots.current), warnings);
      placed.push("Problem");
    }
    if (expected && slots.expected && shown(slots.expected)) {
      answers[slots.expected] = clip(expected, 4_000, labelOf(fields, slots.expected), warnings);
      placed.push(...expectedLabels);
    }
  }
  if (slots.context) {
    const parts = [`From the ${sourceName} report (${source.sourceLabel}).`];
    if (single && !limited.truncated) {
      const extras =
        source.sourceRoleId === "role_codebase_audit"
          ? (["Location", "Evidence", "Impact"] as const)
          : (["Existing Capability", "Codebase Fit", "Dependencies"] as const);
      for (const label of extras) {
        const body = reportSection(text, [label]);
        if (body) {
          parts.push(`${label}:\n${body}`);
          placed.push(label);
        }
      }
    }
    answers[slots.context] = clip(parts.join("\n\n"), 8_000, labelOf(fields, slots.context), warnings);
  }
  if (slots.description) {
    answers[slots.description] = placed.length > 0 ? withoutSections(text, placed) : limited.inlinePlan;
  }
  return {
    title: title || `${sourceName} hand-off`,
    answers,
    planText: limited.planText,
    inlinePlan: limited.inlinePlan,
    // The report text lives in the request field, not the scratch pad.
    planField: slots.description,
    usesScratchPad: slots.description === null,
    truncated: limited.truncated || warnings.length > 0,
    warning: joinWarnings(limited.warning, warnings),
  };
}

function mapPlan(
  source: HandoffSource,
  scope: HandoffScope,
  target: { roleId: string; fields: HandoffField[] },
  limits: HandoffLimits,
): MappedHandoff {
  const fields = handoffFormFields(target.fields);
  const slots = targetSlots(fields);
  const composed = composePlanText(source, scope);
  let reviewNotes = "";
  // The reviewed plan goes in the plan field and the notes in context. With no
  // plan field (Developer, a Planner revision) the whole review stays together.
  if (
    source.sourceRoleId === "role_plan_reviewer" &&
    target.roleId !== "role_planner" &&
    slots.plan &&
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
  const report = isReportSource(source.sourceRoleId);
  // A report tab's own form ("review the composer") is not the task the card asks for.
  const parts = report ? NO_PARTS : requestParts(source.answers, source.sourceFields);
  const limited = limitPlan(composed.text, limits);
  const title = report
    ? reportTitleFor(source, composed.text)
    : extractTitle(source, composed.text);
  const answers: Record<string, string> = { cwd: source.cwd };
  if (fields.some((field) => field.key === "title")) answers.title = title;
  const taskField = fields.find((field) => field.key === "taskType");
  if (taskField) {
    const raw = report ? reportTaskType(source, composed.text) : parts.taskType;
    const taskType = taskTypeFor(taskField, raw);
    if (taskType) answers.taskType = taskType;
  }
  if (slots.expected && parts.expected) answers[slots.expected] = parts.expected;
  if (slots.current && parts.current) answers[slots.current] = parts.current;
  // A reviewer's "original request" gets every Planner answer, so expected and
  // current behavior travel with the request instead of landing in context.
  const wholeRequest = isOriginalField(fields, slots.description) && !!parts.request;
  // Behaviors without a field of their own travel with the request (the task as
  // asked), or in context when the form has no request field.
  const behaviors = wholeRequest
    ? []
    : behaviorContext(parts, { expected: !!slots.expected, current: !!slots.current });
  const withRequest = !!slots.description && !!parts.request;
  const context = [
    reviewNotes ? `Review notes:\n${reviewNotes}` : "",
    ...(withRequest ? [] : behaviors),
    answer(source.answers, "additionalContext"),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (slots.description) {
    let description = wholeRequest
      ? composeParts(parts)
      : [parts.request, ...(withRequest ? behaviors : [])].filter(Boolean).join("\n\n");
    // No context field (Developer's "What to work on"): the context goes with the request.
    if (!slots.context && context && description) description = `${description}\n\n${context}`;
    if (!description && slots.plan) description = fillerRequest(source, target.roleId);
    if (description) answers[slots.description] = description;
  }
  if (slots.context && context) answers[slots.context] = context;
  if (slots.plan) answers[slots.plan] = limited.inlinePlan;
  return {
    title,
    answers,
    planText: limited.planText,
    inlinePlan: limited.inlinePlan,
    planField: slots.plan,
    usesScratchPad: slots.plan === null,
    truncated: limited.truncated,
    warning: limited.warning,
  };
}

/** A required request the source never had: say where the work is, never repeat the plan. */
function fillerRequest(source: HandoffSource, targetRoleId: string): string {
  const from = roleDisplayName(source.sourceRoleId);
  if (targetRoleId === "role_plan_reviewer") return `Review the plan from the ${from} hand-off.`;
  if (/review/i.test(targetRoleId)) return `Review the work from the ${from} hand-off.`;
  return `Implement the plan from the ${from} hand-off.`;
}

/** Values for fields the target form hides (Planner Current Behavior unless Bug) are dropped. */
function dropHidden(mapped: MappedHandoff, fields: HandoffField[]): MappedHandoff {
  const hidden = fields.filter(
    (field) => field.key in mapped.answers && !isFieldVisible(field, mapped.answers),
  );
  if (hidden.length === 0) return mapped;
  const answers = { ...mapped.answers };
  for (const field of hidden) delete answers[field.key];
  const lostPlan = !!mapped.planField && !(mapped.planField in answers);
  return {
    ...mapped,
    answers,
    planField: lostPlan ? null : mapped.planField,
    usesScratchPad: mapped.usesScratchPad || lostPlan,
  };
}

export function mapHandoff(
  source: HandoffSource,
  scope: HandoffScope,
  target: { roleId: string; fields: HandoffField[] },
  limits: HandoffLimits = DEFAULT_HANDOFF_LIMITS,
): MappedHandoff {
  const visible = visibleAnswers(source);
  const fields = handoffFormFields(target.fields);
  if (source.sourceRoleId === "role_implementer" && target.roleId === "role_pr_reviewer") {
    return dropHidden(
      mapImplementerToReviewer(terminalImplementerSource(visible, scope), target, limits),
      fields,
    );
  }
  if (isReportSource(source.sourceRoleId) && target.roleId === "role_planner") {
    return dropHidden(mapReportToPlanner(visible, scope, target, limits), fields);
  }
  return dropHidden(mapPlan(visible, scope, target, limits), fields);
}

export type FillSummary = {
  /** Fields the hand-off fills, in form order. */
  filled: { key: string; label: string }[];
  /** Visible fields left blank. */
  empty: { key: string; label: string; required: boolean }[];
  /** Labels of visible required fields still blank (or a select value the field cannot take). */
  missing: string[];
  missingKeys: string[];
  /** `{{token}}`s in the target template that no field and no built-in fills. */
  unresolved: string[];
  /** The plan goes to the scratch pad because the form has no plan field. */
  scratchPad: boolean;
};

const BUILT_IN_TOKENS = new Set(["cwd", "folderName", "date", "roleName"]);

/** What the target form will hold after this hand-off, for the dialog and the terminal check. */
export function handoffFillSummary(mapped: MappedHandoff, target: HandoffTarget): FillSummary {
  const fields = handoffFormFields(target.fields);
  const summary: FillSummary = {
    filled: [],
    empty: [],
    missing: [],
    missingKeys: [],
    unresolved: [],
    scratchPad: mapped.usesScratchPad && mapped.planText.length > 0,
  };
  for (const field of fields) {
    if (!isFieldVisible(field, mapped.answers)) continue;
    const label = field.label?.trim() || field.key;
    const value = (mapped.answers[field.key] ?? "").trim();
    const badOption =
      !!value && field.type === "select" && !!field.options?.length && !field.options.includes(value);
    if (value && !badOption) summary.filled.push({ key: field.key, label });
    else summary.empty.push({ key: field.key, label, required: !!field.required });
    if ((field.required && !value) || badOption) {
      summary.missing.push(label);
      summary.missingKeys.push(field.key);
    }
  }
  const known = new Set([...target.fields.map((field) => field.key), ...BUILT_IN_TOKENS]);
  for (const match of (target.templateText ?? "").matchAll(/\{\{([^{}]*)\}\}/g)) {
    const token = match[1].trim();
    if (token && !known.has(token) && !summary.unresolved.includes(token)) {
      summary.unresolved.push(token);
    }
  }
  return summary;
}

/** Why a terminal hand-off cannot start yet, naming each field. Null when it can. */
export function handoffStartProblem(summary: FillSummary, targetName: string): string | null {
  const items = [
    ...summary.missing.map((label) => `${label} is required`),
    ...summary.unresolved.map(
      (token) => `the template uses {{${token}}}, which no field fills (fix the role in Settings > Roles)`,
    ),
  ];
  return terminalStartMessage(targetName, items);
}

/** The one message for a terminal hand-off that cannot start; null when `items` is empty. */
export function terminalStartMessage(targetName: string, items: string[]): string | null {
  if (items.length === 0) return null;
  return `The ${targetName} terminal cannot start: ${items.join("; ")}. Open it as Chat to fill these in.`;
}

/**
 * Values and plan for `role_terminal_start`. The terminal prompt adds the plan
 * after the merged template unless the template already holds it. When the form
 * holds a shortened copy, that field points at the full plan below instead, so
 * the agent gets the whole plan once.
 */
export function terminalHandoffInput(mapped: MappedHandoff): {
  values: Record<string, string>;
  handoffPlan: string;
} {
  const values = { ...mapped.answers };
  const holder = mapped.planField;
  const held = holder ? (values[holder] ?? "") : "";
  if (!holder || !held || held.includes(mapped.planText)) {
    return { values, handoffPlan: mapped.planText };
  }
  if (held === mapped.inlinePlan) {
    // The form copy was cut short (see the warning).
    values[holder] =
      `The full text (${charCount(mapped.planText).toLocaleString()} characters) follows this prompt under "Plan from the hand-off".`;
    return { values, handoffPlan: mapped.planText };
  }
  // The form holds the text split across its fields (one report card): nothing to add.
  return { values, handoffPlan: "" };
}
