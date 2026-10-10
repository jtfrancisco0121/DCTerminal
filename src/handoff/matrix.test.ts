/**
 * The hand-off matrix: every source role × allowed target × saved-role
 * variant × scope × surface. Each combination must leave the target form
 * complete and sensible (see `checkFill`). The built-in and saved-role cases
 * are also written to `src-tauri/src/coverage_tests/handoff_matrix.json`,
 * where Rust runs them through `merge_role_prompt` and the terminal prompt.
 */
import { describe, expect, it } from "vitest";
import seed from "../../seed/roles.seed.json";
import {
  charCount,
  composeOriginalTask,
  composePlanText,
  handoffFillSummary,
  handoffStartProblem,
  isFieldVisible,
  mapHandoff,
  reportScopeHint,
  scopeChoices,
  terminalHandoffInput,
  type HandoffField,
  type HandoffLimits,
  type HandoffScope,
  type HandoffSource,
  type HandoffSurface,
  type MappedHandoff,
} from "./map";
import { loopBackMessage } from "./routing";
import { BUILT_IN_ROLE_NAMES, HANDOFF_TRANSITIONS, handoffTargets, type RoleName } from "./transitions";

// ---------------------------------------------------------------------------
// Target roles: the shipped seed plus the shapes a user's saved roles can take.

type RoleJson = {
  id: string;
  name: string;
  templateText: string;
  templateVersion: number;
  templateHash: string;
  schemaTemplateHash: string;
  defaultMode: string;
  injection: string;
  color: string;
  isBuiltIn: boolean;
  fields: {
    key: string;
    label: string;
    type: string;
    required: boolean;
    options?: string[];
    showWhen?: { fieldKey: string; equals: string[] };
    emptyBehavior?: string;
  }[];
};

const SEED = (seed as unknown as { roles: RoleJson[] }).roles;
const seedRole = (id: string): RoleJson => {
  const role = SEED.find((r) => r.id === id);
  if (!role) throw new Error(`seed role ${id}`);
  return role;
};

const toFields = (role: RoleJson): HandoffField[] =>
  role.fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options,
    required: field.required,
    showWhen: field.showWhen ?? null,
  }));

type Variant = {
  id: string;
  roleId: string;
  role: RoleJson;
  /** The role is not the shipped seed: the Rust check gets it inline. */
  saved: boolean;
};

function savedRole(base: RoleJson, patch: Partial<RoleJson>): RoleJson {
  return { ...base, isBuiltIn: false, templateHash: "h", schemaTemplateHash: "h", ...patch };
}

const builtIn = (roleId: string): Variant => ({
  id: `${roleId}`,
  roleId,
  role: seedRole(roleId),
  saved: false,
});

const VARIANTS: Variant[] = [
  ...SEED.map((role) => builtIn(role.id)),
  {
    // Saved before the built-in Plan Reviewer keys were renamed.
    id: "role_plan_reviewer:legacy-keys",
    roleId: "role_plan_reviewer",
    saved: true,
    role: savedRole(seedRole("role_plan_reviewer"), {
      templateText:
        "Request:\n{{originalRequest}}\n\nPlan:\n{{candidatePlan}}\n\nContext:\n{{additionalContext}}",
      fields: [
        { key: "originalRequest", label: "Original Request", type: "multiline", required: true },
        { key: "candidatePlan", label: "Candidate Plan", type: "multiline", required: true },
        {
          key: "additionalContext",
          label: "Additional Context",
          type: "multiline",
          required: false,
          emptyBehavior: "literal:None provided",
        },
      ],
    }),
  },
  {
    // Same keys, labels renamed in the role editor.
    id: "role_implementer:renamed-labels",
    roleId: "role_implementer",
    saved: true,
    role: savedRole(seedRole("role_implementer"), {
      fields: seedRole("role_implementer").fields.map((field) => ({
        ...field,
        label:
          {
            taskType: "Kind of work",
            title: "Name",
            description: "Summary",
            approvedPlan: "Steps to build",
            additionalContext: "Anything else",
          }[field.key] ?? field.label,
      })),
    }),
  },
  {
    id: "role_pr_reviewer:renamed-labels",
    roleId: "role_pr_reviewer",
    saved: true,
    role: savedRole(seedRole("role_pr_reviewer"), {
      fields: seedRole("role_pr_reviewer").fields.map((field) => ({
        ...field,
        label:
          { originalTask: "What was asked", approvedPlan: "Agreed steps", additionalContext: "Extra info" }[
            field.key
          ] ?? field.label,
      })),
    }),
  },
  {
    // Required select whose options were renamed; Current Behavior follows the new Bug option.
    id: "role_planner:renamed-options",
    roleId: "role_planner",
    saved: true,
    role: savedRole(seedRole("role_planner"), {
      fields: seedRole("role_planner").fields.map((field) =>
        field.key === "taskType"
          ? { ...field, options: ["New feature", "Bug report", "Refactoring", "Chore"] }
          : field.key === "currentBehavior"
            ? { ...field, showWhen: { fieldKey: "taskType", equals: ["Bug report"] } }
            : field,
      ),
    }),
  },
  {
    // Custom role: odd keys, a one-line "Plan name", a required select the hand-off cannot know.
    id: "role_custom_odd",
    roleId: "role_custom_odd",
    saved: true,
    role: savedRole(seedRole("role_implementer"), {
      id: "role_custom_odd",
      name: "Odd Form",
      templateText:
        "Ask:\n{{ask_md}}\n\nName: {{plan_name}}\n\nSteps:\n{{steps_v2}}\n\nBackground:\n{{bg}}\n\nPriority: {{prio}}",
      fields: [
        { key: "ask_md", label: "What was asked", type: "multiline", required: true },
        { key: "plan_name", label: "Plan name", type: "text", required: false },
        { key: "steps_v2", label: "The plan (markdown)", type: "multiline", required: true },
        { key: "bg", label: "Background notes", type: "multiline", required: false },
        { key: "prio", label: "Priority", type: "select", required: true, options: ["P1", "P2", "P3"] },
      ],
    }),
  },
  {
    // Its template uses {{ticket}}, which no field fills.
    id: "role_custom_ghost",
    roleId: "role_custom_ghost",
    saved: true,
    role: savedRole(seedRole("role_implementer"), {
      id: "role_custom_ghost",
      name: "Ghost",
      templateText: "Plan:\n{{plan}}\n\nTicket: {{ticket}}",
      fields: [{ key: "plan", label: "Plan", type: "multiline", required: true }],
    }),
  },
];

const variantsFor = (roleId: string) => VARIANTS.filter((variant) => variant.roleId === roleId);

/** Built-in names, plus custom roles and edited rows whose targets are data. */
const ROLES: RoleName[] = [
  ...Object.entries(BUILT_IN_ROLE_NAMES)
    .filter(([id]) => id !== "role_planner" && id !== "role_codebase_audit")
    .map(([id, name]) => ({ id, name })),
  {
    id: "role_planner",
    name: "Planner",
    handoffTargets: [...HANDOFF_TRANSITIONS.role_planner, "role_pr_reviewer", "role_custom_odd", "role_custom_ghost"],
  },
  {
    id: "role_codebase_audit",
    name: "Codebase Audit",
    handoffTargets: [...HANDOFF_TRANSITIONS.role_codebase_audit, "role_implementer"],
  },
  { id: "role_custom_spec", name: "Spec Writer", handoffTargets: ["role_implementer", "role_developer", "role_custom_odd"] },
  { id: "role_custom_odd", name: "Odd Form" },
  { id: "role_custom_ghost", name: "Ghost" },
];

// ---------------------------------------------------------------------------
// Sources: one realistic tab per role, chat and terminal.

const CWD = "/Users/e2e/Projects/demo";

const PLANNER_BUG = {
  taskType: "Bug",
  title: "Login 500",
  request: "Expired tokens return 500 instead of 401.",
  expectedBehavior: "The API returns 401 with a refresh hint.",
  currentBehavior: "The handler panics on an expired token.",
  additionalContext: "Auth lives in src/auth/middleware.ts.",
};

const PLANNER_FEATURE_STALE = {
  taskType: "Feature",
  title: "Effort controls",
  request: "Let users pick reasoning effort.",
  expectedBehavior: "An effort picker in the chat header.",
  // Typed while the form said Bug; hidden now, so it must not travel.
  currentBehavior: "STALE hidden current behavior",
  additionalContext: "",
};

const PLAN_MESSAGE = [
  "## Plan",
  "",
  "Patch the middleware, then cover it with a test.",
  "",
  "| Step | File |",
  "|---|---|",
  "| 1 | middleware.ts |",
  "",
  "```bash",
  "# run the auth tests",
  "npm test -- auth",
  "```",
  "",
  "Last step: ship it (message end)",
].join("\n");

const REVIEW = [
  "### Verdict",
  "**APPROVED WITH CHANGES**",
  "",
  "## Reviewed plan",
  "1. Catch TokenExpired in the middleware",
  "2. Return 401 with a refresh hint",
  "3. Add the expired-token regression test (reviewed end)",
  "",
  "## Review notes",
  "- Cover refresh tokens too (notes end)",
].join("\n");

const RECOMMENDATIONS = [
  "# Recommendations",
  "",
  "## Feature: Effort controls",
  "",
  "### Problem",
  "Users cannot change reasoning effort.",
  "",
  "### Proposed Solution",
  "Add an effort picker next to the model picker.",
  "",
  "### Existing Capability",
  "The ACP session reports effort options.",
  "",
  "## Feature: Persist Up-arrow history",
  "",
  "### Problem",
  "Composer history is lost on restart.",
  "",
  "### Proposed Solution",
  "Save it with the scratch pad. (report end)",
].join("\n");

const finding = (severity: string, title: string, category: string, tag: string) =>
  [
    `## [${severity}] ${title}`,
    "",
    "Category:",
    category,
    "",
    "Location:",
    "src/auth/token.rs:42",
    "",
    "Problem:",
    `${title} happens under load.`,
    "",
    "Evidence:",
    "The log shows it.",
    "",
    "Recommended Direction:",
    `Fix ${title.toLowerCase()} at the source. (${tag})`,
  ].join("\n");

const AUDIT = [
  "# Codebase Audit",
  "",
  finding("HIGH", "Token leak", "Security", "high end"),
  "",
  finding("MEDIUM", "Slow listing", "Performance", "medium end"),
  "",
  finding("LOW", "Flaky auth test", "Testing", "audit end"),
].join("\n");

type SourceCase = { id: string; source: HandoffSource };

function base(roleId: string, overrides: Partial<HandoffSource>): HandoffSource {
  return {
    sourceRoleId: roleId,
    sourceTabId: `tab-${roleId}`,
    sourceLabel: `${BUILT_IN_ROLE_NAMES[roleId] ?? "Spec Writer"} · demo`,
    cwd: CWD,
    answers: {},
    latestMessage: "",
    plan: [],
    todos: [],
    selection: "",
    turnInFlight: false,
    ...overrides,
  };
}

const plannerFields = toFields(seedRole("role_planner"));
const planReviewerFields = toFields(seedRole("role_plan_reviewer"));

const SOURCES: SourceCase[] = [
  {
    id: "planner:bug",
    source: base("role_planner", {
      answers: PLANNER_BUG,
      sourceFields: plannerFields,
      latestMessage: PLAN_MESSAGE,
      plan: [{ content: "Patch middleware", status: "pending", priority: "high" }],
      todos: [{ content: "Write the expired-token test (card end)", status: "pending" }],
      planMarkdown:
        "# Fix expired-token handling\n\n1. Catch TokenExpired in the middleware\n2. Return 401 with a refresh hint\n3. Add a regression test (plan-mode end)",
      planFileText: "# Plan file: token fix\n\n- Patch\n- Test (file end)",
      planFileName: "token-fix.md",
      selection: "Catch TokenExpired in the middleware\n2. Return 401 (selection end)",
    }),
  },
  {
    id: "planner:feature-stale-hidden",
    source: base("role_planner", {
      answers: PLANNER_FEATURE_STALE,
      sourceFields: plannerFields,
      latestMessage: "## Effort picker\n\n1. Read effort options\n2. Add the picker (feature end)",
    }),
  },
  {
    id: "planner:terminal",
    source: base("role_planner", {
      answers: PLANNER_BUG,
      sourceFields: plannerFields,
      fromTerminal: true,
      planFileText: "# Plan file: token fix\n\n- Patch\n- Test (file end)",
      planFileName: "token-fix.md",
      selection: "1. Patch\n2. Test (terminal selection end)",
      terminalTail: "❯ claude\n\nPlan ready:\n1. Patch\n2. Test (tail end)",
    }),
  },
  {
    id: "plan_reviewer:chat",
    source: base("role_plan_reviewer", {
      answers: {
        originalTask: composeOriginalTask(PLANNER_BUG),
        plan: "1. Catch TokenExpired",
        additionalContext: "Auth lives in src/auth/middleware.ts.",
      },
      sourceFields: planReviewerFields,
      latestMessage: REVIEW,
      selection: "2. Return 401 with a refresh hint (review selection end)",
    }),
  },
  {
    id: "plan_reviewer:legacy-keys",
    source: base("role_plan_reviewer", {
      answers: {
        originalRequest: composeOriginalTask(PLANNER_BUG),
        candidatePlan: "1. Catch TokenExpired",
        additionalContext: "Auth lives in src/auth/middleware.ts.",
      },
      latestMessage: REVIEW,
    }),
  },
  {
    id: "plan_reviewer:crlf",
    source: base("role_plan_reviewer", {
      answers: {
        originalTask: composeOriginalTask(PLANNER_BUG).replace(/\n/g, "\r\n"),
        plan: "1. Catch TokenExpired",
        additionalContext: "  Auth lives in src/auth/middleware.ts.\r\n",
      },
      latestMessage: `\r\n  ${REVIEW.replace(/\n/g, "\r\n")}\r\n\r\n`,
    }),
  },
  {
    id: "plan_reviewer:terminal",
    source: base("role_plan_reviewer", {
      answers: {
        originalTask: composeOriginalTask(PLANNER_BUG),
        plan: "1. Catch TokenExpired",
        additionalContext: "",
      },
      fromTerminal: true,
      terminalTail: REVIEW,
      selection: "3. Add the expired-token regression test (tail selection end)",
    }),
  },
  {
    id: "implementer",
    source: base("role_implementer", {
      answers: {
        taskType: "Bug Fix",
        title: "Login 500",
        description: "Expired tokens return 500 instead of 401.",
        approvedPlan: "1. Catch TokenExpired\n2. Return 401\n3. Test (approved end)",
        additionalContext: "Auth lives in src/auth/middleware.ts.",
      },
      latestMessage: "Done. Patched the middleware and added a test. PR: https://github.com/a/b/pull/7",
      changes: [{ path: "src/auth/middleware.ts", additions: 12, deletions: 3 }],
      branch: "fix/login-500",
    }),
  },
  {
    id: "developer:with-task",
    source: base("role_developer", {
      answers: { title: "Tidy the auth module", request: "Remove dead token helpers." },
      latestMessage: "## Summary\n\nRemoved two helpers and updated imports. (dev end)",
    }),
  },
  {
    id: "developer:bare",
    source: base("role_developer", {
      latestMessage: "Removed two helpers and updated imports. (bare dev end)",
    }),
  },
  {
    id: "pr_reviewer",
    source: base("role_pr_reviewer", {
      answers: {
        originalTask: "Title: Login 500\n\nTask type: Bug Fix\n\nRequest:\nExpired tokens return 500 instead of 401.",
        approvedPlan: "1. Catch TokenExpired\n2. Return 401",
        additionalContext: "Branch: fix/login-500",
      },
      latestMessage: "### Verdict\n**CHANGES REQUESTED**\n\n1. The refresh path still panics (review end)",
    }),
  },
  {
    id: "recommendation:one-card",
    source: base("role_recommendation", {
      answers: { title: "Review the composer", request: "Find the next features." },
      latestMessage: RECOMMENDATIONS,
      selection: RECOMMENDATIONS.split("## Feature: Persist")[0].replace("# Recommendations\n\n", ""),
    }),
  },
  {
    id: "recommendation:two-cards-selected",
    source: base("role_recommendation", {
      latestMessage: RECOMMENDATIONS,
      // Dragged from inside the first card into the second.
      selection: RECOMMENDATIONS.slice(RECOMMENDATIONS.indexOf("## Feature: Effort")),
    }),
  },
  {
    id: "audit:one-finding",
    source: base("role_codebase_audit", {
      latestMessage: AUDIT,
      selection: finding("HIGH", "Token leak", "Security", "selected end"),
    }),
  },
  {
    id: "audit:terminal",
    source: base("role_codebase_audit", {
      fromTerminal: true,
      terminalTail: AUDIT,
      selection: finding("LOW", "Flaky auth test", "Testing", "terminal finding end"),
    }),
  },
  {
    id: "custom_spec",
    source: base("role_custom_spec", {
      answers: { goal_txt: "Document the token flow.", notes_x: "Keep it short." },
      sourceFields: [
        { key: "goal_txt", label: "Goal", type: "multiline" },
        { key: "notes_x", label: "Background notes", type: "multiline" },
      ],
      latestMessage: "# Token flow spec\n\n1. Diagram the flow\n2. Write it up (spec end)",
    }),
  },
];

// ---------------------------------------------------------------------------
// What a complete fill means.

/** Required fields a combination may leave for the user, by design. */
function expectedMissing(src: SourceCase, variant: Variant, scope: HandoffScope): string[] {
  const missing: string[] = [];
  if (variant.id === "role_custom_odd") missing.push("prio"); // nothing knows the priority
  const report = src.source.sourceRoleId === "role_recommendation" || src.source.sourceRoleId === "role_codebase_audit";
  const text = composePlanText(src.source, scope).text;
  const cards = (text.match(/^#{1,3}[ \t]+(?:Feature:|\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\])/gim) ?? []).length;
  if (report && variant.roleId === "role_planner" && cards > 1) {
    // A whole report or a selection across cards: only the request is filled (with a hint).
    missing.push("expectedBehavior");
    if (src.source.sourceRoleId === "role_codebase_audit") missing.push("taskType");
  }
  if (report && variant.roleId === "role_implementer" && cards > 1) missing.push("taskType");
  if (src.id === "custom_spec" && variant.roleId === "role_implementer") missing.push("taskType");
  if (src.id.startsWith("developer") && variant.roleId === "role_pr_reviewer") {
    // nothing: originalTask says where the work is, approvedPlan holds the summary
  }
  return missing.sort();
}

const PLAN_KEYS = ["approvedPlan", "plan", "implementationPlan", "candidatePlan", "proposedPlan", "reviewedPlan"];
const GENERIC_TITLE = /^(plan|summary|reviewed plan|review notes|verdict|recommendations|codebase audit|to-dos)$/i;

/** The field a person would expect the plan in, judged without map.ts. */
function plainPlanField(fields: HandoffField[]): string | null {
  const byKey = PLAN_KEYS.find((key) => fields.some((field) => field.key === key));
  if (byKey) return byKey;
  return (
    fields.find(
      (field) => field.type === "multiline" && /\bplan\b/i.test(field.label ?? ""),
    )?.key ?? null
  );
}

/** Lines of 20+ characters that appear in two different fields. */
function sharedLines(answers: Record<string, string>): string[] {
  const seen = new Map<string, string>();
  const shared: string[] = [];
  for (const [key, value] of Object.entries(answers)) {
    if (key === "cwd" || key === "taskType") continue;
    for (const line of new Set(value.split("\n").map((l) => l.trim()))) {
      if (line.length < 20) continue;
      const other = seen.get(line);
      if (other && other !== key) shared.push(`"${line}" in ${other} and ${key}`);
      else seen.set(line, key);
    }
  }
  return shared;
}

const lastLine = (text: string) => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
};

const count = (text: string, part: string) => (part ? text.split(part).length - 1 : 0);

/** `merge_template` + `handoff_terminal_prompt`, closely enough to count the plan. */
function simulatePrompt(
  role: RoleJson,
  values: Record<string, string>,
  handoffPlan: string | null,
): string {
  let text = role.templateText;
  for (const field of role.fields) {
    const visible = isFieldVisible({ key: field.key, showWhen: field.showWhen ?? null }, values);
    const value = visible ? (values[field.key] ?? "") : "";
    text = text.split(`{{${field.key}}}`).join(value);
  }
  text = text.split("{{cwd}}").join(CWD).trim();
  if (!template_mentions(role, "title") && values.title) text = `Title: ${values.title}\n\n---\n\n${text}`;
  if (!template_mentions(role, "request") && values.request) text = `${values.request}\n\n---\n\n${text}`;
  const plan = (handoffPlan ?? "").trim();
  if (!plan || text.includes(plan)) return text;
  return `${text}\n\nPlan from the hand-off:\n\n${plan}`;
}

function template_mentions(role: RoleJson, key: string): boolean {
  return role.templateText.includes(`{{${key}}}`);
}

type Combo = {
  name: string;
  src: SourceCase;
  variant: Variant;
  scope: HandoffScope;
  surface: HandoffSurface;
};

function checkFill(combo: Combo, mapped: MappedHandoff) {
  const { name, src, variant, scope, surface } = combo;
  const fields = toFields(variant.role);
  const target = { roleId: variant.roleId, fields, templateText: variant.role.templateText };
  const summary = handoffFillSummary(mapped, target);

  // Something to send, and it is the chosen scope's text.
  expect(mapped.planText.length, name).toBeGreaterThan(0);

  // 1. Every required field filled, or named as missing.
  expect([...summary.missingKeys].sort(), `${name}: missing`).toEqual(expectedMissing(src, variant, scope));
  const problem = handoffStartProblem(summary, variant.role.name);
  for (const label of summary.missing) expect(problem, name).toContain(label);
  if (variant.id === "role_custom_ghost") expect(problem, name).toContain("{{ticket}}");
  else expect(summary.unresolved, name).toEqual([]);

  // 2. No text repeated between fields; no Title/Task type line next to its own field.
  expect(sharedLines(mapped.answers), `${name}: duplicated`).toEqual([]);
  const keys = new Set(fields.map((field) => field.key));
  for (const [key, value] of Object.entries(mapped.answers)) {
    if (keys.has("title") && key !== "title") expect(value, `${name}: ${key}`).not.toMatch(/^Title:/m);
    if (keys.has("taskType") && key !== "taskType") {
      expect(value, `${name}: ${key}`).not.toMatch(/^Task type:/m);
    }
    // Clean text: no Windows line endings, no padding.
    expect(value, `${name}: ${key}`).not.toContain("\r");
    expect(value, `${name}: ${key}`).toBe(value.trim());
    // Hidden answers stay behind.
    expect(value, `${name}: ${key}`).not.toContain("STALE");
  }
  for (const field of fields) {
    if (field.key in mapped.answers) {
      expect(isFieldVisible(field, mapped.answers), `${name}: hidden ${field.key} filled`).toBe(true);
    }
  }

  // 3. The plan sits in the plan field when there is one, never only in the scratch pad.
  const report = src.source.sourceRoleId === "role_recommendation" || src.source.sourceRoleId === "role_codebase_audit";
  const planKey = plainPlanField(fields);
  if (report && variant.roleId === "role_planner") {
    // The card fills the request; sections with a field of their own move there.
    expect(mapped.planField, name).toBe("request");
    expect(mapped.answers.request, name).toContain(lastLine(mapped.planText.split("\n")[0]));
    const everything = Object.values(mapped.answers).join("\n");
    for (const line of mapped.planText.split("\n").map((l) => l.trim())) {
      // Section labels ("### Problem", "Evidence:") may go; their text may not.
      if (line.length < 20 || /^#|:$/.test(line)) continue;
      expect(everything, `${name}: lost "${line}"`).toContain(line);
    }
  } else if (planKey) {
    expect(mapped.planField, name).toBe(planKey);
    expect(mapped.answers[planKey], name).toBe(mapped.inlinePlan);
    expect(mapped.usesScratchPad, name).toBe(false);
  } else {
    expect(mapped.planField, name).toBeNull();
    expect(mapped.usesScratchPad, name).toBe(true);
  }

  // 4. Title and task type fit the target.
  if (keys.has("title") || fields.length === 0) {
    const title = mapped.answers.title ?? "";
    expect(title, `${name}: title`).not.toBe("");
    expect(title, `${name}: title`).not.toMatch(/[\r\n]|^#|\*\*|`/);
    expect(charCount(title), `${name}: title`).toBeLessThanOrEqual(120);
    expect(title, `${name}: title`).not.toMatch(GENERIC_TITLE);
  }
  const taskField = fields.find((field) => field.key === "taskType");
  if (taskField && mapped.answers.taskType) {
    expect(taskField.options, `${name}: taskType`).toContain(mapped.answers.taskType);
  }

  // 5. Nothing cut short without a warning.
  if (!mapped.warning) {
    expect(mapped.truncated, name).toBe(false);
    expect(mapped.inlinePlan, name).toBe(mapped.planText);
    expect(mapped.planText, name).toBe(composePlanTextFor(src.source, scope, variant, mapped));
  } else {
    expect(mapped.warning, name).toMatch(/characters/);
  }

  // 6. The prompt the agent gets holds the plan exactly once (terminal), or the
  //    form holds it once (chat; scratch-pad roles keep it out of the prompt).
  const marker = lastLine(mapped.planText);
  if (surface === "terminal") {
    const input = terminalHandoffInput(mapped);
    const prompt = simulatePrompt(variant.role, input.values, input.handoffPlan);
    expect(count(prompt, marker), `${name}: plan in terminal prompt`).toBe(1);
    for (const line of mapped.planText.split("\n").map((l) => l.trim())) {
      if (line.length < 20 || /^#|:$/.test(line)) continue;
      expect(prompt, `${name}: prompt lost "${line}"`).toContain(line);
    }
  } else {
    const prompt = simulatePrompt(variant.role, mapped.answers, null);
    const inField = mapped.planField !== null && !!mapped.answers[mapped.planField];
    const shown = inField && template_mentions(variant.role, mapped.planField ?? "");
    expect(count(prompt, marker), `${name}: plan in chat prompt`).toBe(shown ? 1 : 0);
  }
}

/** The text a scope should carry: the reviewed plan alone when a Plan Reviewer fills a plan field. */
function composePlanTextFor(
  source: HandoffSource,
  scope: HandoffScope,
  variant: Variant,
  mapped: MappedHandoff,
): string {
  const text = composePlanText(source, scope).text;
  if (source.sourceRoleId === "role_implementer" && variant.roleId === "role_pr_reviewer") {
    return mapped.planText; // the Implementer's own approved plan, not a scope
  }
  if (source.sourceRoleId === "role_plan_reviewer" && mapped.planField && variant.roleId !== "role_planner") {
    const reviewed = /## Reviewed plan\n([\s\S]*?)(?:\n## |$)/.exec(text);
    return reviewed ? reviewed[1].trim() : text;
  }
  return text;
}

function combos(): Combo[] {
  const out: Combo[] = [];
  for (const src of SOURCES) {
    for (const targetId of handoffTargets(src.source.sourceRoleId, ROLES)) {
      for (const variant of variantsFor(targetId)) {
        for (const choice of scopeChoices(src.source).filter((c) => c.enabled)) {
          for (const surface of ["chat", "terminal"] as const) {
            out.push({
              name: `${src.id} → ${variant.id} [${choice.id}, ${surface}]`,
              src,
              variant,
              scope: choice.id,
              surface,
            });
          }
        }
      }
    }
  }
  return out;
}

const ALL = combos();

describe("hand-off matrix", () => {
  it("covers every source role, every allowed target and every scope", () => {
    const pairs = new Set(ALL.map((c) => `${c.src.source.sourceRoleId}>${c.variant.roleId}`));
    for (const [from, targets] of Object.entries(HANDOFF_TRANSITIONS)) {
      for (const to of targets) expect(pairs, `${from} → ${to}`).toContain(`${from}>${to}`);
    }
    for (const custom of ["role_custom_spec>role_custom_odd", "role_planner>role_custom_ghost"]) {
      expect(pairs).toContain(custom);
    }
    const scopes = new Set(ALL.map((c) => c.scope));
    for (const scope of [
      "plan_mode",
      "plan_file",
      "plan_and_todos",
      "message",
      "card",
      "selection",
      "terminal_tail",
    ] as const) {
      expect(scopes, scope).toContain(scope);
    }
    expect(ALL.length).toBeGreaterThan(300);
  });

  describe.each(SOURCES.map((src) => [src.id, src] as const))("from %s", (_id, src) => {
    const mine = ALL.filter((c) => c.src === src);
    it.each(
      [...new Set(mine.map((c) => c.variant.id))].map((id) => [id] as const),
    )("to %s", (variantId) => {
      for (const combo of mine.filter((c) => c.variant.id === variantId)) {
        const fields = toFields(combo.variant.role);
        const mapped = mapHandoff(combo.src.source, combo.scope, {
          roleId: combo.variant.roleId,
          fields,
        });
        checkFill(combo, mapped);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Specific promises the matrix relies on.

const IMPLEMENTER = { roleId: "role_implementer", fields: toFields(seedRole("role_implementer")) };
const PLANNER = { roleId: "role_planner", fields: plannerFields };
const PR_REVIEWER = { roleId: "role_pr_reviewer", fields: toFields(seedRole("role_pr_reviewer")) };
const DEVELOPER = { roleId: "role_developer", fields: [] as HandoffField[] };
const source = (id: string) => SOURCES.find((s) => s.id === id)!.source;

describe("Report → Planner", () => {
  const audit = (category: string, severity = "HIGH") =>
    base("role_codebase_audit", {
      latestMessage: AUDIT,
      selection: finding(severity, "Token leak", category, "x"),
    });

  it.each([
    ["Security", "Bug"],
    ["Bug", "Bug"],
    ["Data integrity", "Bug"],
    ["Reliability", "Bug"],
    ["Accessibility", "Bug"],
    ["Performance", "Refactor"],
    ["Architecture", "Refactor"],
    ["Maintainability", "Refactor"],
    ["Technical debt", "Refactor"],
    ["CI/CD", "Chore"],
    ["Testing", "Chore"],
    ["Dependencies", "Chore"],
    ["Documentation", "Chore"],
    ["UX", "Feature"],
  ])("audit Category %s → Task Type %s", (category, taskType) => {
    const mapped = mapHandoff(audit(category), "selection", PLANNER);
    expect(mapped.answers.taskType).toBe(taskType);
    expect(mapped.answers.expectedBehavior).toBe("Fix token leak at the source. (x)");
    // Current Behavior shows only for Bug; otherwise the Problem stays in the request.
    if (taskType === "Bug") {
      expect(mapped.answers.currentBehavior).toBe("Token leak happens under load.");
      expect(mapped.answers.request).not.toContain("Token leak happens under load.");
    } else {
      expect(mapped.answers.currentBehavior).toBeUndefined();
      expect(mapped.answers.request).toContain("Token leak happens under load.");
    }
    expect(mapped.answers.request).not.toContain("Fix token leak at the source.");
  });

  it("an unknown Category leaves Task Type for the user and says so", () => {
    const mapped = mapHandoff(audit("Mystery"), "selection", PLANNER);
    expect(mapped.answers.taskType).toBeUndefined();
    const summary = handoffFillSummary(mapped, PLANNER);
    expect(summary.missing).toEqual(["Task Type"]);
    expect(handoffStartProblem(summary, "Planner")).toBe("The Planner form still needs: Task Type.");
  });

  it.each(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"])("[%s] severity is not part of the title", (severity) => {
    const mapped = mapHandoff(audit("Security", severity), "selection", PLANNER);
    expect(mapped.answers.title).toBe("Token leak");
  });

  it("a Recommendation card is a Feature, its Proposed Solution the expected behavior", () => {
    const mapped = mapHandoff(source("recommendation:one-card"), "selection", PLANNER);
    expect(mapped.answers).toMatchObject({
      title: "Effort controls",
      taskType: "Feature",
      expectedBehavior: "Add an effort picker next to the model picker.",
    });
    // Feature hides Current Behavior: the Problem stays in the request.
    expect(mapped.answers.currentBehavior).toBeUndefined();
    expect(mapped.answers.additionalContext).toContain("The ACP session reports effort options.");
    // The report tab's own form ("Review the composer") is not the task.
    expect(JSON.stringify(mapped.answers)).not.toContain("Review the composer");
  });

  it("a renamed Planner select still gets a valid task type", () => {
    const planner = { roleId: "role_planner", fields: toFields(variantsFor("role_planner")[1].role) };
    expect(mapHandoff(audit("Security"), "selection", planner).answers.taskType).toBe("Bug report");
    expect(mapHandoff(audit("Performance"), "selection", planner).answers.taskType).toBe("Refactoring");
    expect(mapHandoff(source("recommendation:one-card"), "selection", planner).answers.taskType).toBe(
      "New feature",
    );
  });

  it("a selection across two cards says only the request is filled", () => {
    const src = source("recommendation:two-cards-selected");
    const mapped = mapHandoff(src, "selection", PLANNER);
    expect(mapped.answers.title).toBe("Effort controls and 1 more");
    expect(mapped.answers.expectedBehavior).toBeUndefined();
    expect(reportScopeHint(src, "selection")).toMatch(/selection covers 2 cards/);
    expect(handoffFillSummary(mapped, PLANNER).missing).toEqual(["Expected Behavior"]);
  });
});

describe("send-backs (loop-back follow-ups)", () => {
  const cases = [
    ["role_plan_reviewer", "Plan Reviewer", "Revise the plan to address these findings, then reply with the full revised plan."],
    ["role_pr_reviewer", "PR Reviewer", "Address these findings, then summarize what changed."],
  ] as const;

  it.each(cases)("%s: findings, round and the ask", (roleId, name, ask) => {
    const src = base(roleId, { latestMessage: `\r\n  ${REVIEW.replace(/\n/g, "\r\n")}\r\n` });
    for (const scope of ["message", "plan_and_todos"] as const) {
      const findings = composePlanText(src, scope).text;
      const message = loopBackMessage(roleId, findings, 2);
      expect(message.startsWith(`Review findings from the ${name} (round 2):\n\n### Verdict`)).toBe(true);
      expect(message.endsWith(`(notes end)\n\n${ask}`)).toBe(true);
      expect(message).not.toContain("\r");
      expect(count(message, "(notes end)")).toBe(1);
    }
  });

  it("uses the saved role's name", () => {
    const roles = [{ id: "role_pr_reviewer", name: "Code Review" }];
    expect(loopBackMessage("role_pr_reviewer", "Fix it", 1, roles)).toMatch(
      /^Review findings from the Code Review \(round 1\):\n\nFix it\n\n/,
    );
  });

  it("a send-back that opens a new Planner tab restores the Planner form", () => {
    const mapped = mapHandoff(source("plan_reviewer:chat"), "message", PLANNER);
    expect(mapped.answers).toMatchObject({
      title: "Login 500",
      taskType: "Bug",
      request: PLANNER_BUG.request,
      expectedBehavior: PLANNER_BUG.expectedBehavior,
      currentBehavior: PLANNER_BUG.currentBehavior,
      additionalContext: PLANNER_BUG.additionalContext,
    });
    // The whole review (notes too) waits in the scratch pad.
    expect(mapped.usesScratchPad).toBe(true);
    expect(mapped.inlinePlan).toContain("(notes end)");
  });

  it("a PR Reviewer fix-up gives the Implementer the findings as its plan", () => {
    const mapped = mapHandoff(source("pr_reviewer"), "message", IMPLEMENTER);
    expect(mapped.answers).toMatchObject({
      title: "Login 500",
      taskType: "Bug Fix",
      description: "Expired tokens return 500 instead of 401.",
    });
    expect(mapped.answers.approvedPlan).toContain("The refresh path still panics");
  });
});

describe("unusual content", () => {
  const small: HandoffLimits = { inline: 1_000, json: 5_000, file: 20_000 };
  const long = (n: number) => `# Big plan\n\n${"- step\n".repeat(Math.ceil(n / 7))}`.slice(0, n - 12) + "\n(long end)";

  it.each([
    [2_000, /form shows the first 1,000.*saved with this hand-off/],
    [8_000, /form shows the first 1,000.*attached as a file/],
    [30_000, /truncated to 20,000 characters before it was saved/],
  ])("a %d-character plan warns how it was cut", (n, warning) => {
    const src = base("role_planner", { answers: PLANNER_BUG, latestMessage: long(n) });
    const mapped = mapHandoff(src, "message", IMPLEMENTER, small);
    expect(mapped.truncated).toBe(true);
    expect(mapped.warning).toMatch(warning);
    expect(charCount(mapped.answers.approvedPlan)).toBe(1_000);
    // The terminal gets the whole saved text once, not the cut copy and then the whole.
    const input = terminalHandoffInput(mapped);
    expect(input.handoffPlan).toBe(mapped.planText);
    expect(input.values.approvedPlan).toMatch(/full text .* follows this prompt/);
    const prompt = simulatePrompt(seedRole("role_implementer"), input.values, input.handoffPlan);
    expect(count(prompt, "- step\n- step\n- step")).toBeGreaterThan(0);
    expect(count(prompt, "# Big plan")).toBe(1);
  });

  it("a long request is shortened for the PR Reviewer with a warning", () => {
    const src = { ...source("implementer") };
    src.answers = { ...src.answers, description: `${"x".repeat(5_000)} (request end)` };
    const mapped = mapHandoff(src, "plan_and_todos", PR_REVIEWER);
    expect(charCount(mapped.answers.originalTask)).toBe(4_000);
    expect(mapped.warning).toMatch(/Original Task was shortened to 4,000 characters/);
  });

  it("markdown tables and code fences arrive intact, and a fenced `# comment` is not the title", () => {
    const src = base("role_developer", { latestMessage: `\n\n${PLAN_MESSAGE}\n\n` });
    const mapped = mapHandoff(src, "message", PR_REVIEWER);
    expect(mapped.answers.approvedPlan).toBe(PLAN_MESSAGE);
    const dev = mapHandoff(base("role_planner", { latestMessage: "```bash\n# run the auth tests\n```\n\nPatch it" }), "message", IMPLEMENTER);
    expect(dev.answers.title).toBe("Patch it");
  });

  it("Windows line endings never reach a title or a field", () => {
    const mapped = mapHandoff(source("plan_reviewer:crlf"), "message", IMPLEMENTER);
    expect(mapped.answers.title).toBe("Login 500");
    expect(mapped.answers.taskType).toBe("Bug Fix");
    expect(mapped.answers.description).toBe(
      [
        PLANNER_BUG.request,
        `Expected behavior:\n${PLANNER_BUG.expectedBehavior}`,
        `Current behavior:\n${PLANNER_BUG.currentBehavior}`,
      ].join("\n\n"),
    );
    expect(mapped.answers.approvedPlan).toBe(
      "1. Catch TokenExpired in the middleware\n2. Return 401 with a refresh hint\n3. Add the expired-token regression test (reviewed end)",
    );
    expect(mapped.answers.additionalContext).toBe(
      [
        "Review notes:\n- Cover refresh tokens too (notes end)",
        "Auth lives in src/auth/middleware.ts.",
      ].join("\n\n"),
    );
  });

  it("a Developer target gets Title and What to work on; the plan waits in the scratch pad", () => {
    const mapped = mapHandoff(source("plan_reviewer:chat"), "message", DEVELOPER);
    expect(mapped.answers.title).toBe("Login 500");
    expect(mapped.answers.request).toMatch(/^Expired tokens return 500 instead of 401\.\n\nExpected behavior:/);
    expect(mapped.usesScratchPad).toBe(true);
    // No plan field: the review is not split, so the notes are not lost.
    expect(mapped.inlinePlan).toContain("(notes end)");
    const summary = handoffFillSummary(mapped, DEVELOPER);
    expect(summary.filled.map((f) => f.label)).toEqual(["Title", "What to work on"]);
    expect(summary.scratchPad).toBe(true);
  });

  it("a one-line field is never given the plan", () => {
    const odd = variantsFor("role_custom_odd")[0];
    const mapped = mapHandoff(source("planner:bug"), "plan_mode", { roleId: odd.roleId, fields: toFields(odd.role) });
    expect(mapped.planField).toBe("steps_v2");
    expect(mapped.answers.plan_name).toBeUndefined();
    expect(mapped.answers.ask_md).toContain("Expired tokens return 500");
    // No behavior fields: expected and current behavior go with the request.
    expect(mapped.answers.ask_md).toContain(`Expected behavior:\n${PLANNER_BUG.expectedBehavior}`);
    expect(mapped.answers.bg).toBe(PLANNER_BUG.additionalContext);
  });
});

// ---------------------------------------------------------------------------
// Cases Rust runs through merge_role_prompt (src-tauri/src/coverage_tests/handoff_matrix.rs).

type RustCase = {
  name: string;
  /** A seed role id, or a key of `roles` for a saved variant. */
  role: string;
  values: Record<string, string>;
  handoffPlan: string | null;
  /** Error keys `merge_role_prompt` must return (required, bad option, unresolved). */
  errors: string[];
  marker: string;
  /** How often `marker` appears in the prompt that starts the agent. */
  markerCount: number;
};

describe("template merge fixture", () => {
  it("matches handoff_matrix.json (regenerate with `npx vitest run src/handoff/matrix.test.ts -u`)", async () => {
    const cases: RustCase[] = [];
    // Saved variants; `templateFrom` stands for a seed role's (long) template text.
    const roles: Record<string, RoleJson & { templateFrom?: string }> = {};
    for (const variant of VARIANTS.filter((v) => v.saved)) {
      const seedText = SEED.find((r) => r.templateText === variant.role.templateText);
      roles[variant.id] = seedText
        ? { ...variant.role, templateText: "", templateFrom: seedText.id }
        : variant.role;
    }
    const seen = new Set<string>();
    for (const combo of ALL) {
      // One scope per source and target variant keeps the fixture small.
      const key = `${combo.src.id}>${combo.variant.id}>${combo.surface}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fields = toFields(combo.variant.role);
      const mapped = mapHandoff(combo.src.source, combo.scope, { roleId: combo.variant.roleId, fields });
      const summary = handoffFillSummary(mapped, {
        roleId: combo.variant.roleId,
        fields,
        templateText: combo.variant.role.templateText,
      });
      const terminal = combo.surface === "terminal";
      const input = terminal ? terminalHandoffInput(mapped) : { values: mapped.answers, handoffPlan: null };
      const { cwd: _cwd, ...values } = input.values;
      const shown =
        mapped.planField !== null &&
        !!mapped.answers[mapped.planField] &&
        template_mentions(combo.variant.role, mapped.planField);
      cases.push({
        name: combo.name,
        role: combo.variant.id,
        values,
        handoffPlan: input.handoffPlan,
        errors: [...summary.missingKeys, ...summary.unresolved].sort(),
        marker: lastLine(mapped.planText),
        markerCount: terminal || shown ? 1 : 0,
      });
    }
    expect(cases.length).toBeGreaterThan(60);
    await expect(`${JSON.stringify({ roles, cases }, null, 1)}\n`).toMatchFileSnapshot(
      "../../src-tauri/src/coverage_tests/handoff_matrix.json",
    );
  });
});
