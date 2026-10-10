import { describe, expect, it } from "vitest";
import {
  composePlanText,
  defaultScope,
  handoffBlockReason,
  mapHandoff,
  scopeChoices,
  terminalLogFields,
  type HandoffSource,
} from "./map";
import { terminalLogVerdict } from "./verdict";

type Log = Parameters<typeof terminalLogFields>[0] & object;

const log = (over: Partial<Log> = {}): Log => ({
  lastReply: "Here is the summary.",
  plan: null,
  planAt: null,
  lastPromptAt: "2026-10-10T10:00:00Z",
  ...over,
});

function terminal(roleId: string, logged: Log | null, over: Partial<HandoffSource> = {}): HandoffSource {
  return {
    sourceRoleId: roleId,
    sourceTabId: "tab_t",
    sourceLabel: "Terminal",
    cwd: "/repo",
    answers: {},
    plan: [],
    todos: [],
    selection: "",
    turnInFlight: false,
    fromTerminal: true,
    planFileText: "",
    terminalTail: "tail line",
    ...terminalLogFields(logged),
    ...over,
  };
}

const ids = (source: HandoffSource) => scopeChoices(source).map((choice) => choice.id);

describe("terminalLogFields", () => {
  it("is empty without a log, so the screen choices stay as they were", () => {
    expect(terminalLogFields(null)).toEqual({ latestMessage: "" });
    expect(ids(terminal("role_planner", null, { planFileText: "# file" }))).toEqual([
      "plan_file",
      "selection",
      "terminal_tail",
    ]);
  });

  it("marks the plan stale when a prompt came after it", () => {
    const fresh = terminalLogFields(
      log({ plan: "# Plan", planAt: "2026-10-10T10:05:00Z", lastPromptAt: "2026-10-10T10:00:00Z" }),
    );
    expect(fresh).toMatchObject({ terminalLog: true, planMarkdown: "# Plan", planMarkdownStale: false });
    const stale = terminalLogFields(
      log({ plan: "# Plan", planAt: "2026-10-10T10:00:00Z", lastPromptAt: "2026-10-10T10:05:00Z" }),
    );
    expect(stale.planMarkdownStale).toBe(true);
  });
});

describe("terminal hand-off scopes from the session log", () => {
  const planned = log({
    lastReply: "Plan submitted.",
    plan: "# Fix login\n\n1. Return 401",
    planAt: "2026-10-10T10:05:00Z",
  });

  it("Planner: plan, then last reply, plan file, selection, tail", () => {
    const src = terminal("role_planner", planned, { planFileText: "# file", selection: "sel" });
    expect(ids(src)).toEqual(["plan_mode", "message", "plan_file", "selection", "terminal_tail"]);
    expect(scopeChoices(src)[0].label).toBe("Claude's plan (ExitPlanMode)");
    expect(scopeChoices(src)[1].label).toBe("Claude's last reply");
    expect(defaultScope(src)).toBe("plan_mode");
    expect(composePlanText(src, "plan_mode").text).toBe("# Fix login\n\n1. Return 401");
    expect(defaultScope(terminal("role_planner", log(), { planFileText: "# file" }))).toBe("message");
    expect(defaultScope(terminal("role_planner", log({ lastReply: "" }), { planFileText: "# f" }))).toBe(
      "plan_file",
    );
    expect(defaultScope(terminal("role_planner", log({ lastReply: "" }), { selection: "sel" }))).toBe(
      "selection",
    );
    expect(defaultScope(terminal("role_planner", log({ lastReply: "" })))).toBe("terminal_tail");
  });

  it("Planner: a plan the user answered gives way to the newer reply", () => {
    const stale = log({
      lastReply: "Revised: also cover refresh tokens.",
      plan: "# Old plan",
      planAt: "2026-10-10T10:00:00Z",
      lastPromptAt: "2026-10-10T10:05:00Z",
    });
    const src = terminal("role_planner", stale);
    expect(scopeChoices(src)[0].label).toBe("Claude's earlier plan (ExitPlanMode)");
    expect(defaultScope(src)).toBe("message");
    expect(defaultScope(terminal("role_planner", { ...stale, lastReply: "" }))).toBe("plan_mode");
  });

  it("Plan Reviewer and PR Reviewer lead with the last reply", () => {
    const review = terminal("role_plan_reviewer", planned, { planFileText: "# file" });
    expect(defaultScope(review)).toBe("message");
    expect(defaultScope(terminal("role_pr_reviewer", log()))).toBe("message");
    expect(ids(terminal("role_pr_reviewer", log()))).toEqual(["message", "selection", "terminal_tail"]);
    expect(defaultScope(terminal("role_plan_reviewer", log({ lastReply: "" }), { planFileText: "# f" }))).toBe(
      "plan_file",
    );
  });

  it("reports keep a selected card first, then the last reply", () => {
    expect(ids(terminal("role_codebase_audit", log()))).toEqual([
      "selection",
      "message",
      "terminal_tail",
    ]);
    expect(defaultScope(terminal("role_codebase_audit", log()))).toBe("message");
    expect(defaultScope(terminal("role_codebase_audit", log(), { selection: "## [HIGH] X" }))).toBe(
      "selection",
    );
    expect(defaultScope(terminal("role_codebase_audit", null))).toBe("terminal_tail");
  });

  it("a last reply alone is enough to send", () => {
    const src = terminal("role_plan_reviewer", log(), { terminalTail: "" });
    expect(handoffBlockReason(src)).toBeNull();
  });

  it("Implementer → PR Reviewer uses the last reply as the implementation summary", () => {
    const src = terminal(
      "role_implementer",
      log({ lastReply: "Done: tokens now return 401.\nhttps://github.com/acme/app/pull/7" }),
      {
        answers: { title: "Login 500", description: "Expired tokens return 500.", approvedPlan: "1. Return 401" },
        terminalTail: "noisy screen",
      },
    );
    expect(ids(src)).toEqual(["message", "selection", "terminal_tail"]);
    const scope = defaultScope(src);
    expect(scope).toBe("message");
    const mapped = mapHandoff(src, scope, {
      roleId: "role_pr_reviewer",
      fields: [{ key: "originalTask" }, { key: "approvedPlan" }, { key: "additionalContext" }],
    });
    const context = mapped.answers.additionalContext;
    expect(context).toContain("Implementation summary:\nDone: tokens now return 401.");
    expect(context).not.toContain("noisy screen");
    expect(context).toContain("Pull request: https://github.com/acme/app/pull/7");
  });
});

describe("terminalLogVerdict", () => {
  it("reads the finished turn's reply first", () => {
    expect(
      terminalLogVerdict({ turnDone: true, lastReply: "## Verdict\nREQUEST CHANGES" }, "Verdict: APPROVED"),
    ).toBe("REQUEST CHANGES");
  });

  it("falls back to the screen while the turn runs, without a log, or with no verdict", () => {
    expect(terminalLogVerdict({ turnDone: false, lastReply: "Verdict: REJECTED" }, "Verdict: APPROVED")).toBe(
      "APPROVED",
    );
    expect(terminalLogVerdict(null, "Verdict: APPROVED WITH CHANGES")).toBe("APPROVED WITH CHANGES");
    expect(terminalLogVerdict({ turnDone: true, lastReply: "Thanks, noted." }, "Verdict: APPROVED")).toBe(
      "APPROVED",
    );
  });
});
