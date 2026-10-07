import { describe, expect, it } from "vitest";
import {
  charCount,
  composePlanText,
  defaultScope,
  formatPlanCard,
  handoffBlockReason,
  latestAgentMessage,
  mapHandoff,
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
    expect(mapped.answers.originalTask).toBe("Expired tokens return 500.");
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
    expect(mapped.answers.additionalContext).toBe("QA noted flakes");
  });

  it("refuses a hand-off while the turn is still streaming or the tab is not a Planner", () => {
    expect(handoffBlockReason(source({ turnInFlight: true }))).toMatch(/finishes this turn/);
    expect(handoffBlockReason(source({ sourceRoleId: "role_developer" }))).toMatch(/Planner/);
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
});
