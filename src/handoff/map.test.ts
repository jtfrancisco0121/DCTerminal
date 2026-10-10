import { describe, expect, it } from "vitest";
import {
  carryChainTaskType,
  charCount,
  composePlanText,
  defaultScope,
  formatPlanCard,
  handoffBlockReason,
  latestAgentMessage,
  mapHandoff,
  needsChainTaskType,
  firstGithubPrUrl,
  reportCardCount,
  reportScopeHint,
  reportSection,
  scopeChoices,
  takeChars,
  type HandoffSource,
} from "./map";

const IMPLEMENTER_FIELDS = [
  { key: "taskType", options: ["Feature", "Bug Fix", "Refactor", "Improvement", "Other"] },
  { key: "title" },
  { key: "description" },
  { key: "approvedPlan" },
  { key: "additionalContext" },
];

const PLAN_REVIEWER_FIELDS = [
  { key: "originalTask" },
  { key: "plan" },
  { key: "additionalContext" },
];

const PLANNER_FIELDS = [
  { key: "taskType", options: ["Feature", "Bug", "Refactor", "Chore"] },
  { key: "title" },
  { key: "request" },
  { key: "expectedBehavior" },
  { key: "currentBehavior" },
  { key: "additionalContext" },
];

const REVIEWER_FIELDS = [
  { key: "originalTask" },
  { key: "approvedPlan" },
  { key: "additionalContext" },
];

function source(overrides: Partial<HandoffSource> = {}): HandoffSource {
  return {
    sourceRoleId: "role_planner",
    sourceTabId: "tab_planner",
    sourceLabel: "Planner · Login",
    cwd: "C:\\Repos\\Demo",
    answers: {
      taskType: "Bug",
      title: "Login 500",
      request: "Expired tokens return 500.",
      expectedBehavior: "Return 401.",
      currentBehavior: "The handler panics.",
      additionalContext: "See the auth middleware.",
    },
    latestMessage: "# Fix the login handler\n\nCheck the token expiry path.",
    plan: [{ content: "Read the handler", status: "pending", priority: "high" }],
    todos: [{ content: "Add a regression test", status: "pending" }],
    selection: "",
    turnInFlight: false,
    ...overrides,
  };
}

describe("handoff mapping", () => {
  it("defaults to the latest plan message plus its to-dos", () => {
    const body = composePlanText(source(), "plan_and_todos").text;
    expect(defaultScope(source())).toBe("plan_and_todos");
    expect(body).toContain("Check the token expiry path.");
    expect(body).toContain("## Plan");
    expect(body).toContain("- [pending] Read the handler (high)");
    expect(body).toContain("## To-dos");
    expect(body).toContain("- [pending] Add a regression test");
  });

  it("can send only the message, only the card, or a selection", () => {
    const plan = source({ selection: "just this paragraph" });
    expect(composePlanText(plan, "message").text).not.toContain("## To-dos");
    expect(composePlanText(plan, "message").text).toContain("Fix the login handler");
    expect(composePlanText(plan, "card").text.startsWith("## Plan")).toBe(true);
    expect(composePlanText(plan, "card").text).not.toContain("token expiry");
    expect(composePlanText(plan, "selection").text).toBe("just this paragraph");
    const choices = scopeChoices(plan);
    expect(choices.find((choice) => choice.id === "selection")?.enabled).toBe(true);
    expect(scopeChoices(source()).find((choice) => choice.id === "selection")?.enabled).toBe(
      false,
    );
  });

  it("maps a Planner bug onto the Implementer form fields", () => {
    const mapped = mapHandoff(source(), "plan_and_todos", {
      roleId: "role_implementer",
      fields: IMPLEMENTER_FIELDS,
    });
    expect(mapped.answers.cwd).toBe("C:\\Repos\\Demo");
    expect(mapped.answers.taskType).toBe("Bug Fix");
    expect(mapped.answers.title).toBe("Login 500");
    expect(mapped.answers.description).toBe("Expired tokens return 500.");
    expect(mapped.answers.approvedPlan).toContain("Check the token expiry path.");
    expect(mapped.answers.approvedPlan).toContain("## To-dos");
    expect(mapped.answers.additionalContext).toContain("Expected behavior:");
    expect(mapped.answers.additionalContext).toContain("Return 401.");
    expect(mapped.answers.additionalContext).toContain("Current behavior:");
    expect(mapped.answers.additionalContext).toContain("See the auth middleware.");
    expect(mapped.planField).toBe("approvedPlan");
    expect(mapped.usesScratchPad).toBe(false);
    expect(mapped.title).toBe("Login 500");
  });

  it("maps Planner task types onto Implementer options", () => {
    const mapType = (taskType: string) =>
      mapHandoff(source({ answers: { taskType } }), "message", {
        roleId: "role_implementer",
        fields: IMPLEMENTER_FIELDS,
      }).answers.taskType;
    expect(mapType("Feature")).toBe("Feature");
    expect(mapType("Refactor")).toBe("Refactor");
    expect(mapType("Chore")).toBe("Other");
    expect(mapType("Not a real type")).toBeUndefined();
  });

  it("maps the same plan onto PR Reviewer fields", () => {
    const mapped = mapHandoff(source(), "message", {
      roleId: "role_pr_reviewer",
      fields: REVIEWER_FIELDS,
    });
    // A reviewer's original request carries every Planner answer.
    expect(mapped.answers.originalTask).toBe(
      "Title: Login 500\n\nTask type: Bug\n\nRequest:\nExpired tokens return 500.\n\nExpected behavior:\nReturn 401.\n\nCurrent behavior:\nThe handler panics.",
    );
    expect(mapped.answers.approvedPlan).toContain("Fix the login handler");
    expect(mapped.answers.title).toBeUndefined();
    expect(mapped.answers.taskType).toBeUndefined();
  });

  it("keeps a Developer hand-off in the scratch pad because that role has no plan field", () => {
    const mapped = mapHandoff(source(), "message", {
      roleId: "role_developer",
      fields: [],
    });
    expect(mapped.answers).toEqual({ cwd: "C:\\Repos\\Demo" });
    expect(mapped.planField).toBeNull();
    expect(mapped.usesScratchPad).toBe(true);
    expect(mapped.inlinePlan).toContain("Fix the login handler");
  });

  it("takes the title from a heading, then the tab label", () => {
    const fromHeading = mapHandoff(
      source({ answers: {}, latestMessage: "## Ship the exporter\n\nDetails." }),
      "message",
      { roleId: "role_implementer", fields: IMPLEMENTER_FIELDS },
    );
    expect(fromHeading.title).toBe("Ship the exporter");
    const fromLabel = mapHandoff(
      source({
        answers: {},
        sourceLabel: "Planner · Nightly job",
        latestMessage: "- [pending] only a card line",
      }),
      "message",
      { roleId: "role_implementer", fields: IMPLEMENTER_FIELDS },
    );
    expect(fromLabel.answers.description).toBe("Implement the plan from the Planner hand-off.");
    expect(fromLabel.title).toBe("Nightly job");
  });

  it("truncates a long plan for the form and keeps a warning", () => {
    const message = `é${"x".repeat(30)}`;
    const mapped = mapHandoff(
      source({ latestMessage: message, plan: [], todos: [] }),
      "message",
      { roleId: "role_implementer", fields: IMPLEMENTER_FIELDS },
      { inline: 10, json: 20, file: 40 },
    );
    expect(charCount(mapped.inlinePlan)).toBe(10);
    expect(charCount(mapped.planText)).toBe(charCount(message));
    expect(mapped.truncated).toBe(true);
    expect(mapped.warning).toContain("The form shows the first 10.");
    expect(mapped.warning).toContain("attached as a file in app data");
    expect(mapped.answers.approvedPlan).toBe(mapped.inlinePlan);
  });

  it("truncates before save when the plan exceeds the file limit", () => {
    const message = "y".repeat(50);
    const mapped = mapHandoff(
      source({ latestMessage: message, plan: [], todos: [] }),
      "message",
      { roleId: "role_developer", fields: [] },
      { inline: 5, json: 10, file: 12 },
    );
    expect(mapped.planText).toBe("y".repeat(12));
    expect(mapped.inlinePlan).toBe("yyyyy");
    expect(mapped.warning).toContain("truncated to 12 characters before it was saved");
    expect(mapped.warning).toContain("attached as a file in app data");
  });

  it("counts characters without splitting a multi-unit character", () => {
    expect(takeChars("é🙂", 1)).toBe("é");
    expect(charCount("é🙂")).toBe(2);
  });

  it("maps an Implementer form onto PR Reviewer fields", () => {
    const mapped = mapHandoff(
      source({
        sourceRoleId: "role_implementer",
        answers: {
          title: "Login fix",
          description: "Tokens must refresh.",
          approvedPlan: "## Steps\n1. Patch handler",
          additionalContext: "QA noted flakes",
        },
      }),
      "plan_and_todos",
      { roleId: "role_pr_reviewer", fields: REVIEWER_FIELDS },
    );
    expect(mapped.answers.originalTask).toContain("Tokens must refresh");
    expect(mapped.answers.approvedPlan).toContain("Patch handler");
    expect(mapped.answers.additionalContext).toContain("QA noted flakes");
    expect(mapped.answers.additionalContext).toContain("Implementation summary:");
  });

  it("refuses a hand-off while the turn is still streaming or the tab is not a Planner", () => {
    expect(handoffBlockReason(source({ turnInFlight: true }))).toMatch(/finishes this turn/);
    expect(
      handoffBlockReason(source({ turnInFlight: true, awaitingPlanApproval: true })),
    ).toBeNull();
    expect(handoffBlockReason(source({ sourceRoleId: "role_general" }))).toMatch(/no hand-off/);
    expect(
      handoffBlockReason(
        source({
          sourceRoleId: "role_implementer",
          answers: {},
          turnInFlight: true,
        }),
      ),
    ).toMatch(/finishes this turn/);
    expect(
      handoffBlockReason(
        source({ latestMessage: "", plan: [], todos: [], selection: "" }),
      ),
    ).toMatch(/no plan/);
    expect(handoffBlockReason(source())).toBeNull();
  });

  it("uses the last agent segment as the plan message", () => {
    expect(
      latestAgentMessage([
        { kind: "agent", text: "first draft" },
        { kind: "tool", text: "read file" },
        { kind: "agent", text: "  final plan  " },
      ]),
    ).toBe("final plan");
  });

  it("defaults a terminal Planner to the plan file, then the selection", () => {
    const file = source({
      fromTerminal: true,
      turnInFlight: true,
      planFileText: "# Written by the CLI",
      planFileName: "login.plan.md",
      selection: "selected line",
      terminalTail: "tail line",
    });
    expect(handoffBlockReason(file)).toBeNull();
    expect(defaultScope(file)).toBe("plan_file");
    expect(composePlanText(file, "plan_file").text).toBe("# Written by the CLI");
    const choices = scopeChoices(file);
    expect(choices.map((choice) => choice.id)).toEqual([
      "plan_file",
      "selection",
      "terminal_tail",
    ]);
    expect(choices[0].label).toContain("login.plan.md");
    const selectionOnly = source({
      fromTerminal: true,
      latestMessage: "",
      plan: [],
      todos: [],
      selection: "only the selection",
      terminalTail: "tail",
    });
    expect(defaultScope(selectionOnly)).toBe("selection");
    expect(handoffBlockReason(selectionOnly)).toBeNull();
    const mapped = mapHandoff(file, "plan_file", {
      roleId: "role_implementer",
      fields: IMPLEMENTER_FIELDS,
    });
    expect(mapped.answers.approvedPlan).toContain("Written by the CLI");
    expect(mapped.planText).toContain("Written by the CLI");
  });

  it("formats a card that has to-dos and no plan entries", () => {
    expect(formatPlanCard([], [{ content: "Write tests", status: "completed" }])).toBe(
      "## To-dos\n- [completed] Write tests",
    );
    expect(composePlanText(source({ latestMessage: "   " }), "message").emptyReason).toMatch(
      /no content/,
    );
  });

  it("maps Planner → Plan Reviewer: plan in `plan`, request in `originalTask`", () => {
    const mapped = mapHandoff(source(), "plan_and_todos", {
      roleId: "role_plan_reviewer",
      fields: PLAN_REVIEWER_FIELDS,
    });
    expect(mapped.planField).toBe("plan");
    expect(mapped.answers.plan).toContain("Check the token expiry path.");
    expect(mapped.answers.originalTask).toContain("Expired tokens return 500.");
    expect(mapped.answers.additionalContext).toContain("See the auth middleware.");
    expect(mapped.usesScratchPad).toBe(false);
  });

  const reviewerMessage = [
    "### Verdict",
    "**APPROVED WITH CHANGES**",
    "",
    "## Reviewed plan",
    "1. Patch the handler",
    "2. Add a regression test",
    "",
    "## Review notes",
    "- Missing test for refresh tokens",
  ].join("\n");

  function planReviewerSource(overrides: Partial<HandoffSource> = {}) {
    return source({
      sourceRoleId: "role_plan_reviewer",
      sourceLabel: "Plan Reviewer · Login",
      answers: {
        originalTask: "Expired tokens return 500.",
        plan: "1. Patch the handler",
        additionalContext: "Auth lives in middleware.",
      },
      latestMessage: reviewerMessage,
      plan: [],
      todos: [],
      ...overrides,
    });
  }

  it("maps Plan Reviewer → Implementer: reviewed plan in approvedPlan, notes in context", () => {
    const mapped = mapHandoff(planReviewerSource(), "plan_and_todos", {
      roleId: "role_implementer",
      fields: IMPLEMENTER_FIELDS,
    });
    expect(mapped.answers.approvedPlan).toBe("1. Patch the handler\n2. Add a regression test");
    expect(mapped.answers.approvedPlan).not.toContain("Verdict");
    expect(mapped.answers.additionalContext).toContain("Missing test for refresh tokens");
    expect(mapped.answers.additionalContext).toContain("Auth lives in middleware.");
    expect(mapped.answers.description).toBe("Expired tokens return 500.");
    expect(mapped.planText).toContain("Patch the handler");
  });

  it("carries the chain's Planner task type through the Plan Reviewer", () => {
    const target = { roleId: "role_implementer", fields: IMPLEMENTER_FIELDS };
    const mapped = mapHandoff(planReviewerSource(), "plan_and_todos", target);
    expect(mapped.answers.taskType).toBeUndefined();
    expect(needsChainTaskType(mapped, target)).toBe(true);
    expect(carryChainTaskType(mapped, target, "Feature").answers.taskType).toBe("Feature");
    // Planner values become Implementer options.
    expect(carryChainTaskType(mapped, target, "Bug").answers.taskType).toBe("Bug Fix");
    expect(carryChainTaskType(mapped, target, "Chore").answers.taskType).toBe("Other");
    // Nothing on file, or a value the form cannot take: left empty.
    expect(carryChainTaskType(mapped, target, null)).toBe(mapped);
    expect(carryChainTaskType(mapped, target, "Spike").answers.taskType).toBeUndefined();
  });

  it("keeps a task type the source already gave, and fills only forms that have one", () => {
    const implementer = { roleId: "role_implementer", fields: IMPLEMENTER_FIELDS };
    const fromPlanner = mapHandoff(source(), "plan_and_todos", implementer);
    expect(fromPlanner.answers.taskType).toBe("Bug Fix");
    expect(needsChainTaskType(fromPlanner, implementer)).toBe(false);
    expect(carryChainTaskType(fromPlanner, implementer, "Feature").answers.taskType).toBe(
      "Bug Fix",
    );
    const reviewer = { roleId: "role_pr_reviewer", fields: REVIEWER_FIELDS };
    const toReviewer = mapHandoff(planReviewerSource(), "plan_and_todos", reviewer);
    expect(needsChainTaskType(toReviewer, reviewer)).toBe(false);
    expect(carryChainTaskType(toReviewer, reviewer, "Feature").answers.taskType).toBeUndefined();
    // A revision Planner takes the Planner's own value.
    const planner = { roleId: "role_planner", fields: PLANNER_FIELDS };
    const toPlanner = mapHandoff(planReviewerSource(), "plan_and_todos", planner);
    expect(carryChainTaskType(toPlanner, planner, "Bug").answers.taskType).toBe("Bug");
  });

  it("falls back to the whole last message when there is no Reviewed plan section", () => {
    const mapped = mapHandoff(
      planReviewerSource({ latestMessage: "Looks good. Ship step 1 then step 2." }),
      "message",
      { roleId: "role_implementer", fields: IMPLEMENTER_FIELDS },
    );
    expect(mapped.answers.approvedPlan).toBe("Looks good. Ship step 1 then step 2.");
  });

  it("Plan Reviewer can send back to the Planner with the review in the scratch pad", () => {
    const mapped = mapHandoff(planReviewerSource(), "message", {
      roleId: "role_planner",
      fields: PLANNER_FIELDS,
    });
    expect(mapped.answers.request).toBe("Expired tokens return 500.");
    expect(mapped.usesScratchPad).toBe(true);
    expect(mapped.inlinePlan).toContain("Review notes");
  });

  it("Plan Reviewer is a valid hand-off source once its turn is done", () => {
    expect(handoffBlockReason(planReviewerSource())).toBeNull();
    expect(handoffBlockReason(planReviewerSource({ turnInFlight: true }))).toMatch(
      /Plan Reviewer finishes this turn/,
    );
    expect(handoffBlockReason(planReviewerSource({ latestMessage: "" }))).toMatch(/no plan/);
  });

  it("Developer needs a finished turn with output before sending to review", () => {
    const dev = source({ sourceRoleId: "role_developer", answers: {} });
    expect(handoffBlockReason(dev)).toBeNull();
    expect(handoffBlockReason({ ...dev, turnInFlight: true })).toMatch(/finishes this turn/);
    expect(
      handoffBlockReason({ ...dev, latestMessage: "", plan: [], todos: [] }),
    ).toMatch(/nothing to send/);
  });

  it("a terminal Plan Reviewer can send its selection or tail", () => {
    const term = planReviewerSource({
      fromTerminal: true,
      latestMessage: "",
      selection: "",
      terminalTail: reviewerMessage,
    });
    expect(handoffBlockReason(term)).toBeNull();
    const mapped = mapHandoff(term, "terminal_tail", {
      roleId: "role_implementer",
      fields: IMPLEMENTER_FIELDS,
    });
    expect(mapped.answers.approvedPlan).toContain("Patch the handler");
    expect(mapped.answers.approvedPlan).not.toContain("Review notes");
  });

  it("every transition maps onto the target's real field keys", async () => {
    const { HANDOFF_TRANSITIONS } = await import("./transitions");
    const fieldsByRole: Record<string, { key: string; options?: string[] }[]> = {
      role_planner: PLANNER_FIELDS,
      role_plan_reviewer: PLAN_REVIEWER_FIELDS,
      role_implementer: IMPLEMENTER_FIELDS,
      role_pr_reviewer: REVIEWER_FIELDS,
      role_developer: [],
    };
    for (const [from, targets] of Object.entries(HANDOFF_TRANSITIONS)) {
      for (const to of targets) {
        const fields = fieldsByRole[to];
        expect(fields, `${from} -> ${to}`).toBeDefined();
        const src = source({
          sourceRoleId: from,
          answers: {
            title: "T",
            description: "D",
            approvedPlan: "P",
            originalTask: "O",
            plan: "P",
            request: "R",
          },
        });
        const mapped = mapHandoff(src, "plan_and_todos", { roleId: to, fields });
        const allowed = new Set(["cwd", ...fields.map((f) => f.key)]);
        for (const key of Object.keys(mapped.answers)) {
          expect(allowed.has(key), `${from} -> ${to}: ${key}`).toBe(true);
        }
        expect(mapped.planText.length, `${from} -> ${to}`).toBeGreaterThan(0);
      }
    }
  });

  it("prefers Claude plan-mode text for Plan Reviewer and Implementer", () => {
    const plan = "1. Add the picker\n2. Cache the list";
    const src = source({
      sourceRoleId: "role_planner",
      planMarkdown: plan,
      latestMessage: "older card text",
      answers: { request: "Model picker" },
    });
    expect(defaultScope(src)).toBe("plan_mode");
    const review = mapHandoff(src, "plan_mode", {
      roleId: "role_plan_reviewer",
      fields: PLAN_REVIEWER_FIELDS,
    });
    expect(review.answers.plan).toBe(plan);
    expect(review.answers.originalTask).toContain("Model picker");
    const implement = mapHandoff(src, "plan_mode", {
      roleId: "role_implementer",
      fields: IMPLEMENTER_FIELDS,
    });
    expect(implement.answers.approvedPlan).toBe(plan);
  });

  it("carries the implementation summary without pasting a diff", () => {
    const src = source({
      sourceRoleId: "role_implementer",
      latestMessage: "Shipped the picker.\nhttps://github.com/acme/app/pull/12",
      transcriptText: "see https://github.com/acme/app/pull/12 for review",
      branch: "feat/models",
      changes: [{ path: "src/models.ts", additions: 10, deletions: 2 }],
      answers: { title: "Models", description: "Add the picker", approvedPlan: "List models" },
    });
    const mapped = mapHandoff(src, "plan_and_todos", {
      roleId: "role_pr_reviewer",
      fields: REVIEWER_FIELDS,
    });
    expect(mapped.answers.additionalContext).toContain("Implementation summary:");
    expect(mapped.answers.additionalContext).toContain("src/models.ts +10 -2");
    expect(mapped.answers.additionalContext).toContain("Branch: feat/models");
    expect(mapped.answers.additionalContext).toContain("https://github.com/acme/app/pull/12");
    expect(mapped.answers.additionalContext).not.toContain("diff --git");
    expect(firstGithubPrUrl("no link")).toBeNull();
  });

  describe("Recommendation / Codebase Audit → Planner", () => {
    const FEATURE_CARD = [
      "## Feature: Effort controls for Claude tabs",
      "",
      "### Problem",
      "",
      "The adapter offers effort levels but the app only sends the model.",
      "",
      "### Proposed Solution",
      "",
      "Add an effort picker and per-role defaults.",
      "",
      "### Existing Capability",
      "",
      "session/set_config_option already switches models.",
      "",
      "### Codebase Fit",
      "",
      "models.rs, ModelPicker.tsx",
    ].join("\n");

    const FINDING = [
      "## [HIGH] Scratch pads are never pruned",
      "",
      "Category:",
      "Data",
      "",
      "Location:",
      "src-tauri/src/store/scratch_store.rs:89",
      "",
      "Problem:",
      "prune_orphans only runs in a test.",
      "",
      "Evidence:",
      "No production caller.",
      "",
      "Impact:",
      "scratch.json grows forever.",
      "",
      "Recommended Direction:",
      "Call prune_orphans at startup.",
      "",
      "Confidence:",
      "Confirmed",
    ].join("\n");

    function report(overrides: Partial<HandoffSource> = {}): HandoffSource {
      return source({
        sourceRoleId: "role_recommendation",
        sourceLabel: "Recommendation · DCTerminal",
        answers: {},
        latestMessage: `# Executive Summary\n\nIntro.\n\n${FEATURE_CARD}\n\n## Feature: Second idea\n\n### Problem\n\nOther.`,
        plan: [],
        todos: [],
        ...overrides,
      });
    }

    it("defaults to the selected card, else the whole report", () => {
      expect(defaultScope(report())).toBe("message");
      expect(defaultScope(report({ selection: FEATURE_CARD }))).toBe("selection");
      expect(scopeChoices(report()).map((c) => c.id)).toEqual(["selection", "message"]);
      expect(
        scopeChoices(report({ fromTerminal: true, terminalTail: "tail" })).map((c) => c.id),
      ).toEqual(["selection", "terminal_tail"]);
    });

    it("fills the Planner fields from one feature card", () => {
      const mapped = mapHandoff(report({ selection: FEATURE_CARD }), "selection", {
        roleId: "role_planner",
        fields: PLANNER_FIELDS,
      });
      expect(mapped.title).toBe("Effort controls for Claude tabs");
      expect(mapped.answers.title).toBe("Effort controls for Claude tabs");
      expect(mapped.answers.taskType).toBe("Feature");
      expect(mapped.answers.request).toBe(FEATURE_CARD);
      expect(mapped.answers.currentBehavior).toBe(
        "The adapter offers effort levels but the app only sends the model.",
      );
      expect(mapped.answers.expectedBehavior).toBe("Add an effort picker and per-role defaults.");
      expect(mapped.answers.additionalContext).toContain("From the Recommendation report");
      expect(mapped.answers.additionalContext).toContain("Codebase Fit:\nmodels.rs");
      expect(mapped.planField).toBe("request");
      expect(mapped.usesScratchPad).toBe(false);
      expect(mapped.planText).toBe(FEATURE_CARD);
    });

    it("fills the Planner fields from one audit finding", () => {
      const mapped = mapHandoff(
        report({ sourceRoleId: "role_codebase_audit", selection: FINDING }),
        "selection",
        { roleId: "role_planner", fields: PLANNER_FIELDS },
      );
      expect(mapped.answers.title).toBe("Scratch pads are never pruned");
      expect(mapped.answers.taskType).toBe("Bug");
      expect(mapped.answers.currentBehavior).toBe("prune_orphans only runs in a test.");
      expect(mapped.answers.expectedBehavior).toBe("Call prune_orphans at startup.");
      expect(mapped.answers.additionalContext).toContain("Location:\nsrc-tauri/src/store/scratch_store.rs:89");
      expect(mapped.answers.additionalContext).toContain("Impact:\nscratch.json grows forever.");
    });

    it("sends a whole report into the request only, with a hint to select one card", () => {
      const src = report();
      const mapped = mapHandoff(src, "message", { roleId: "role_planner", fields: PLANNER_FIELDS });
      expect(mapped.answers.request).toContain("Executive Summary");
      expect(mapped.answers.currentBehavior).toBeUndefined();
      expect(mapped.answers.expectedBehavior).toBeUndefined();
      expect(reportScopeHint(src, "message")).toMatch(/whole report/);
      expect(reportScopeHint(report({ selection: FEATURE_CARD }), "selection")).toBeNull();
    });

    it("reads inline, bold, and heading labels without matching longer words", () => {
      expect(reportSection("**Problem:** It breaks.\nMore.\n\nImpact: x", ["Problem"])).toBe(
        "It breaks.\nMore.",
      );
      expect(reportSection("Problems in general\nProblem\nReal one", ["Problem"])).toBe("Real one");
      expect(reportCardCount(`${FEATURE_CARD}\n\n${FINDING}`)).toBe(2);
    });

    it("reads a card selected from the rendered chat (no markdown marks)", () => {
      const rendered = [
        "Feature: Effort controls for Claude tabs",
        "Problem",
        "The adapter offers effort levels but the app only sends the model.",
        "",
        "Proposed Solution",
        "Add an effort picker and per-role defaults.",
      ].join("\n");
      const mapped = mapHandoff(report({ selection: rendered }), "selection", {
        roleId: "role_planner",
        fields: PLANNER_FIELDS,
      });
      expect(mapped.answers.title).toBe("Effort controls for Claude tabs");
      expect(mapped.answers.currentBehavior).toBe(
        "The adapter offers effort levels but the app only sends the model.",
      );
      expect(mapped.answers.expectedBehavior).toBe("Add an effort picker and per-role defaults.");
      const finding = "[HIGH] Scratch pads are never pruned\nCategory:\nData\nProblem:\nNo caller.";
      const audit = mapHandoff(
        report({ sourceRoleId: "role_codebase_audit", selection: finding }),
        "selection",
        { roleId: "role_planner", fields: PLANNER_FIELDS },
      );
      expect(audit.answers.title).toBe("Scratch pads are never pruned");
      expect(audit.answers.taskType).toBe("Bug");
    });

    it("is blocked until the report has content", () => {
      expect(handoffBlockReason(report({ latestMessage: "" }))).toBe(
        "There is no report to send yet.",
      );
      expect(handoffBlockReason(report())).toBeNull();
    });

    it("a Developer hand-off keeps the report in the scratch pad", () => {
      const mapped = mapHandoff(report({ selection: FEATURE_CARD }), "selection", {
        roleId: "role_developer",
        fields: [],
      });
      expect(mapped.usesScratchPad).toBe(true);
      expect(mapped.inlinePlan).toBe(FEATURE_CARD);
    });
  });
});

describe("hand-offs into and out of custom roles", () => {
  const CUSTOM_ID = "role_custom_ab12cd34ef56";

  it("maps a plan onto a custom role's fields by the usual keys", () => {
    const mapped = mapHandoff(source(), "plan_and_todos", {
      roleId: CUSTOM_ID,
      fields: [{ key: "title" }, { key: "task" }, { key: "plan" }, { key: "notes" }],
    });
    expect(mapped.answers.title).toBe("Login 500");
    expect(mapped.answers.task).toBe("Expired tokens return 500.");
    expect(mapped.answers.plan).toContain("Check the token expiry path.");
    expect(mapped.answers.notes).toContain("Expected behavior:\nReturn 401.");
    expect(mapped.planField).toBe("plan");
    expect(mapped.usesScratchPad).toBe(false);
  });

  it("falls back to the scratch pad when the custom role has no plan field", () => {
    const mapped = mapHandoff(source(), "message", {
      roleId: CUSTOM_ID,
      fields: [{ key: "title" }, { key: "request" }],
    });
    expect(mapped.answers.request).toBe("Expired tokens return 500.");
    expect(mapped.planField).toBeNull();
    expect(mapped.usesScratchPad).toBe(true);
    expect(mapped.inlinePlan).toContain("Check the token expiry path.");
  });

  it("a custom source role can hand off once it has targets as data", () => {
    const custom = source({ sourceRoleId: CUSTOM_ID, answers: {} });
    expect(handoffBlockReason(custom)).toMatch(/no hand-off targets/);
    const roles = [{ id: CUSTOM_ID, name: "Docs", handoffTargets: ["role_developer"] }];
    expect(handoffBlockReason(custom, roles)).toBeNull();
    expect(handoffBlockReason({ ...custom, turnInFlight: true }, roles)).toBe(
      "Wait until the Docs finishes this turn.",
    );
  });
});

describe("hand-off fields are found by meaning", () => {
  // Plan Reviewer roles saved before the built-in fields were renamed.
  const LEGACY_PLAN_REVIEWER = [
    { key: "originalRequest", label: "Original Request", type: "multiline" },
    { key: "candidatePlan", label: "Candidate Plan", type: "multiline" },
    { key: "additionalContext", label: "Additional Context", type: "multiline" },
  ];

  it("Planner → a Plan Reviewer saved with older field names fills every field", () => {
    const mapped = mapHandoff(source(), "message", {
      roleId: "role_plan_reviewer",
      fields: LEGACY_PLAN_REVIEWER,
    });
    expect(mapped.planField).toBe("candidatePlan");
    expect(mapped.usesScratchPad).toBe(false);
    expect(mapped.answers.candidatePlan).toContain("Fix the login handler");
    expect(mapped.answers.originalRequest).toContain("Title: Login 500");
    expect(mapped.answers.originalRequest).toContain("Expected behavior:\nReturn 401.");
    expect(mapped.answers.originalRequest).toContain("Current behavior:\nThe handler panics.");
    // Expected / current travel with the request, not twice.
    expect(mapped.answers.additionalContext).toBe("See the auth middleware.");
  });

  it("Planner → the built-in Plan Reviewer gets the whole request and its own context", () => {
    const mapped = mapHandoff(source(), "message", {
      roleId: "role_plan_reviewer",
      fields: PLAN_REVIEWER_FIELDS,
    });
    expect(mapped.planField).toBe("plan");
    expect(mapped.answers.originalTask).toContain("Request:\nExpired tokens return 500.");
    expect(mapped.answers.additionalContext).toBe("See the auth middleware.");
  });

  it("a custom role's fields are matched by their labels", () => {
    const mapped = mapHandoff(source(), "message", {
      roleId: "role_custom_review",
      fields: [
        { key: "spec", label: "Original requirements", type: "multiline" },
        { key: "draft", label: "Draft plan", type: "multiline" },
        { key: "misc", label: "Notes", type: "multiline" },
        { key: "kind", label: "Task kind", type: "select", options: ["A"] },
      ],
    });
    expect(mapped.planField).toBe("draft");
    expect(mapped.answers.spec).toContain("Title: Login 500");
    expect(mapped.answers.misc).toBe("See the auth middleware.");
    expect(mapped.answers.kind).toBeUndefined();
  });

  it("Plan Reviewer → Implementer recovers the title and task type from the original request", () => {
    const review = mapHandoff(source(), "message", {
      roleId: "role_plan_reviewer",
      fields: LEGACY_PLAN_REVIEWER,
    });
    const mapped = mapHandoff(
      source({
        sourceRoleId: "role_plan_reviewer",
        sourceLabel: "Plan Reviewer · Demo",
        answers: review.answers,
        latestMessage:
          "## Verdict\nAPPROVED\n\n## Reviewed plan\n1. Patch the handler\n\n## Review notes\n- Add a 401 test",
        plan: [],
        todos: [],
      }),
      "message",
      { roleId: "role_implementer", fields: IMPLEMENTER_FIELDS },
    );
    expect(mapped.answers.title).toBe("Login 500");
    expect(mapped.answers.taskType).toBe("Bug Fix");
    expect(mapped.answers.approvedPlan).toBe("1. Patch the handler");
    expect(mapped.answers.description).toContain("Expired tokens return 500.");
    expect(mapped.answers.additionalContext).toContain("Review notes:\n- Add a 401 test");
  });

  it("Implementer → PR Reviewer does not repeat a title the request already carries", () => {
    const block = "Title: Login 500\n\nTask type: Bug\n\nRequest:\nExpired tokens return 500.";
    const mapped = mapHandoff(
      source({
        sourceRoleId: "role_implementer",
        sourceLabel: "Implementer · Login 500",
        answers: { title: "Login 500", taskType: "Bug Fix", description: block, approvedPlan: "1. Patch" },
      }),
      "message",
      { roleId: "role_pr_reviewer", fields: REVIEWER_FIELDS },
    );
    expect(mapped.answers.originalTask).toBe(block);
    expect(mapped.answers.approvedPlan).toBe("1. Patch");
  });

  it("Implementer → PR Reviewer labels the title and task type when the request has none", () => {
    const mapped = mapHandoff(
      source({
        sourceRoleId: "role_implementer",
        sourceLabel: "Implementer · Login 500",
        answers: {
          title: "Login 500",
          taskType: "Bug Fix",
          description: "Expired tokens return 500.",
          approvedPlan: "1. Patch",
        },
      }),
      "message",
      { roleId: "role_pr_reviewer", fields: REVIEWER_FIELDS },
    );
    expect(mapped.answers.originalTask).toBe(
      "Title: Login 500\n\nTask type: Bug Fix\n\nRequest:\nExpired tokens return 500.",
    );
  });

  it("a chat Planner's plan file is offered and preferred when its plan card is gone", () => {
    const withFile = source({
      latestMessage: "I'll proceed with my recommended answers.",
      planFileText: "# Plan\n1. Patch the handler",
      planFileName: "cozy-stallman.md",
    });
    expect(scopeChoices(withFile).map((c) => c.id)).toContain("plan_file");
    expect(defaultScope(withFile)).toBe("plan_file");
    expect(defaultScope({ ...withFile, planMarkdown: "# Card plan" })).toBe("plan_mode");
  });
});

describe("terminal Implementer → PR Reviewer", () => {
  const terminal = (overrides: Partial<HandoffSource> = {}) =>
    source({
      sourceRoleId: "role_implementer",
      sourceLabel: "Implementer · Login",
      answers: {
        taskType: "Bug Fix",
        title: "Login 500",
        description: "Expired tokens return 500.",
        approvedPlan: "1. Return 401",
      },
      latestMessage: "",
      fromTerminal: true,
      selection: "",
      terminalTail: "Done: tokens now return 401.\nOpened https://github.com/acme/app/pull/42",
      transcriptText: "older output",
      changes: [{ path: "src/auth.ts", additions: 4, deletions: 1 }],
      branch: "fix/login",
      ...overrides,
    });

  it("uses the tail or selection as the summary, plus files, branch, and PR URL", () => {
    const mapped = mapHandoff(terminal(), "terminal_tail", {
      roleId: "role_pr_reviewer",
      fields: REVIEWER_FIELDS,
    });
    expect(mapped.answers.approvedPlan).toBe("1. Return 401");
    expect(mapped.answers.originalTask).toContain("Title: Login 500");
    const context = mapped.answers.additionalContext;
    expect(context).toContain("Implementation summary:\nDone: tokens now return 401.");
    expect(context).toContain("- src/auth.ts +4 -1");
    expect(context).toContain("Branch: fix/login");
    expect(context).toContain("Pull request: https://github.com/acme/app/pull/42");
    const picked = mapHandoff(terminal({ selection: "Only this part" }), "selection", {
      roleId: "role_pr_reviewer",
      fields: REVIEWER_FIELDS,
    });
    expect(picked.answers.additionalContext).toContain("Implementation summary:\nOnly this part");
  });

  it("offers no plan file, and needs only the Implementer form to send", () => {
    const empty = terminal({ terminalTail: "" });
    expect(scopeChoices(empty).map((c) => c.id)).toEqual(["selection", "terminal_tail"]);
    expect(defaultScope(empty)).toBe("terminal_tail");
    expect(handoffBlockReason(empty)).toBeNull();
    expect(handoffBlockReason({ ...empty, answers: {} })).toBe("There is no plan to send yet.");
  });
});
