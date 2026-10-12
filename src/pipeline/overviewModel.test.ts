import { describe, expect, it } from "vitest";
import type { PipelineRun, TabSummary, TerminalSessionLog } from "../bridge";
import type { TabRuntime } from "../liveTabs";
import { laneStatus, overviewStages, pullPlannerText, pullPlanReviewText } from "./overviewModel";
import type { TerminalReader } from "./terminalText";

const tab = (partial: Partial<TabSummary>): TabSummary => ({
  id: "tab_impl",
  label: "Implementer",
  roleId: "role_implementer",
  cwd: "/repo",
  phase: "running",
  mergedPromptChars: 0,
  startupPromptSent: true,
  hasTranscript: false,
  folderStatus: "ok",
  color: "",
  kind: "terminal",
  terminalLaunch: "role",
  acpSessionId: null,
  provider: "claude",
  ...partial,
});

const reader: TerminalReader = {
  tail: () => "",
  selection: () => "",
  planFile: async () => "",
};

describe("laneStatus with a terminal state", () => {
  const t = tab({});

  it("shows an exited terminal in red with its code", () => {
    expect(laneStatus(t, undefined, { kind: "exited", code: 137 })).toEqual({
      label: "Exited · code 137",
      tone: "error",
    });
  });

  it("names what the terminal needs", () => {
    const needs = (n: "plan" | "question" | "permission") =>
      laneStatus(t, undefined, { kind: "needs", needs: n, toolId: "t1", toolTitle: "x" });
    expect(needs("plan")).toEqual({ label: "Needs you: plan to review", tone: "needs" });
    expect(needs("question")).toEqual({ label: "Needs you: question", tone: "needs" });
    expect(needs("permission")).toEqual({ label: "Needs you: permission request", tone: "needs" });
  });

  it("shows working, and falls back to the tab when idle", () => {
    expect(laneStatus(t, undefined, { kind: "working" })).toEqual({
      label: "Working…",
      tone: "live",
    });
    expect(laneStatus(t, undefined, { kind: "idle" })).toEqual(laneStatus(t, undefined));
    expect(laneStatus(t, undefined, { kind: "idle" })).toEqual({
      label: "Session open",
      tone: "live",
    });
  });

  it("still reports a missing tab", () => {
    expect(laneStatus(undefined, undefined, { kind: "exited", code: 1 }).label).toBe("Missing tab");
  });
});

describe("overviewStages terminal states", () => {
  it("passes each stage's terminal state to its lane", () => {
    const run = {
      id: "run_1",
      kind: "execute",
      cwd: "/repo",
      stage: "implement",
      overviewTabId: "tab_ov",
      tabIds: { role_implementer: "tab_impl" },
      createdAt: "2026-10-12T00:00:00Z",
    } as PipelineRun;
    const runtimes: Record<string, TabRuntime> = {};
    const stages = overviewStages(run, [tab({})], runtimes, reader, {
      tab_impl: { kind: "exited", code: 2 },
    });
    const impl = stages.find((s) => s.tabId === "tab_impl")!;
    expect(impl.status).toEqual({ label: "Exited · code 2", tone: "error" });
    const without = overviewStages(run, [tab({})], runtimes, reader);
    expect(without.find((s) => s.tabId === "tab_impl")!.status.tone).toBe("live");
  });
});

describe("log-derived verdicts and plans for Claude terminals", () => {
  const log = (p: Partial<TerminalSessionLog>): TerminalSessionLog => ({
    sessionId: "s",
    path: "/x",
    turnDone: true,
    lastReply: "",
    plan: null,
    planAt: null,
    lastPromptAt: null,
    toolCalls: [],
    ...p,
  });
  const staleTail: TerminalReader = {
    tail: () => "Verdict: rejected (stale xterm)",
    selection: () => "",
    planFile: async () => "",
  };
  const run = {
    id: "run_1",
    kind: "execute",
    cwd: "/repo",
    stage: "review",
    overviewTabId: "tab_ov",
    tabIds: { role_pr_reviewer: "tab_rev", role_planner: "tab_plan", role_plan_reviewer: "tab_pr" },
    createdAt: "2026-10-12T00:00:00Z",
  } as PipelineRun;
  const term = (id: string, roleId: string, extra = {}) =>
    tab({ id, roleId, kind: "terminal", terminalLaunch: "role", ...extra });

  it("reads a reviewer verdict from the session log, not the xterm tail", () => {
    const tabs = [term("tab_rev", "role_pr_reviewer")];
    const logs = { tab_rev: log({ lastReply: "All good.\n\nVerdict: APPROVED" }) };
    const stages = overviewStages(run, tabs, {}, staleTail, undefined, logs);
    expect(stages.find((s) => s.tabId === "tab_rev")!.verdict).toBe("APPROVED");
  });

  it("shows no verdict for a Claude terminal whose log is not read yet", () => {
    const tabs = [term("tab_rev", "role_pr_reviewer")];
    const stages = overviewStages(run, tabs, {}, staleTail, undefined, {});
    expect(stages.find((s) => s.tabId === "tab_rev")!.verdict).toBeNull();
  });

  it("still reads a Cursor terminal from xterm text", () => {
    const tabs = [term("tab_rev", "role_pr_reviewer", { provider: "cursor" })];
    const stages = overviewStages(run, tabs, {}, staleTail, undefined, {});
    expect(stages.find((s) => s.tabId === "tab_rev")!.verdict).not.toBeNull();
  });

  it("pulls the Planner's ExitPlanMode plan, skipping a stale one", async () => {
    const tabs = [term("tab_plan", "role_planner")];
    const fresh = { tab_plan: log({ plan: "# Plan A", lastReply: "reply" }) };
    expect((await pullPlannerText(run, tabs, {}, staleTail, fresh)).text).toBe("# Plan A");
    const stale = {
      tab_plan: log({
        plan: "# Plan A",
        planAt: "2026-10-12T00:00:00Z",
        lastPromptAt: "2026-10-12T00:05:00Z",
        lastReply: "newer reply",
      }),
    };
    expect((await pullPlannerText(run, tabs, {}, staleTail, stale)).text).toBe("newer reply");
    const none = await pullPlannerText(run, tabs, {}, staleTail, {});
    expect(none.text).toBe("");
  });

  it("pulls the reviewed plan from the Plan Reviewer's log reply", () => {
    const tabs = [term("tab_pr", "role_plan_reviewer")];
    const logs = { tab_pr: log({ lastReply: "Reviewed plan\n\nDo the thing." }) };
    const pulled = pullPlanReviewText(run, tabs, {}, staleTail, logs);
    expect(pulled.text).toContain("Do the thing.");
    expect(pulled.text).not.toContain("stale xterm");
  });
});
