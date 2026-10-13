// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  chainLoopBack: vi.fn(async () => ({})),
  getClaudeUsage: vi.fn(async () => ({ configDir: "", windows: [], contextByTab: {} })),
  getPipelineRun: vi.fn(),
  getTab: vi.fn(async () => ({ tab: { answers: { cwd: "/repo", title: "Login 500" } } })),
  pipelineDecide: vi.fn(),
  pipelineNote: vi.fn(async () => {}),
  pipelineRunGates: vi.fn(async () => []),
  ptyWrite: vi.fn(async () => {}),
  setTabProvider: vi.fn(async () => {}),
  // HandoffIo (handoff/executor)
  getRole: vi.fn(async (id: string) => ({
    id,
    name: id,
    templateText: "",
    fields: ["originalTask", "approvedPlan", "additionalContext"].map((key) => ({
      key,
      label: key,
      type: "multiline",
      required: false,
    })),
  })),
  changesList: vi.fn(async () => ({ state: "none" })),
  gitRepoInfo: vi.fn(async () => ({ currentBranch: "fix/login" })),
  terminalPlanFile: vi.fn(async () => null),
  validateAndPreview: vi.fn(async () => ({ errors: [] })),
  handoffSave: vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: "handoff-1" })),
  handoffAttach: vi.fn(async (input: { id: string; tabId: string }) => ({
    record: { id: input.id, targetTabId: input.tabId },
    chain: null,
  })),
}));
const live = new Map<string, { exited: boolean }>();
vi.mock("../terminal/live", () => ({
  livePty: (id: string) => live.get(id) ?? null,
  notePtyInput: () => {},
  ptyExitCode: () => null,
}));
vi.mock("../terminal/park", () => ({
  terminalBracketedPaste: () => true,
  terminalTailText: () => "",
}));

import {
  chainLoopBack,
  getPipelineRun,
  handoffAttach,
  pipelineDecide,
  pipelineRunGates,
  ptyWrite,
  type PipelineRun,
  type TabSummary,
  type TerminalSessionLog,
} from "../bridge";
import type { TerminalState } from "../terminal/claudeState";
import { useAutopilot, type AutopilotDeps } from "./useAutopilot";

function tab(id: string, roleId: string, step: number): TabSummary {
  return {
    id,
    label: `Tab ${id}`,
    roleId,
    cwd: "/repo",
    kind: "terminal",
    terminalLaunch: "role",
    provider: "claude",
    phase: "terminal",
    mergedPromptChars: 0,
    startupPromptSent: true,
    hasTranscript: false,
    folderStatus: "ok",
    color: "#fff",
    acpSessionId: null,
    chain: { chainId: "ee_1", kind: "eagle1", step, total: 4 },
  } as TabSummary;
}

/** A prompt sent after the hook started, so its turn counts. */
const NOW = () => new Date(Date.now() + 1000).toISOString();

function log(reply: string, prompt = NOW()): TerminalSessionLog {
  return {
    sessionId: "s",
    path: "/x",
    turnDone: true,
    lastReply: reply,
    plan: null,
    planAt: null,
    lastPromptAt: prompt,
    toolCalls: [],
    openTool: null,
  };
}

function run(enabled: boolean): { run: PipelineRun } {
  return {
    run: {
      id: "ee_1",
      kind: "full",
      cwd: "/repo",
      stage: "implementer",
      overviewTabId: "",
      tabIds: {},
      createdAt: "x",
      chainId: "ee_1",
      autopilot: { enabled },
    },
  };
}

const IMPLEMENTED = [
  "## HANDOFF: Implementation summary\nIMPLEMENTED",
  "## HANDOFF: Files changed\nsrc/a.ts",
  "## HANDOFF: Tests run\nnpm test",
  "## HANDOFF: Deviations from the plan\nNone.",
  "## HANDOFF: Pull requests\nPR1 — https://github.com/jt/app/pull/7",
].join("\n\n");

function setup(tabs: TabSummary[], states: Record<string, TerminalState> = {}) {
  const deps: AutopilotDeps = {
    tabs: () => tabs,
    roles: () => null,
    terminalState: (id) => states[id],
    startTerminal: vi.fn(async () => "tab-new"),
    refreshTabs: vi.fn(async () => {}),
    notifyStop: vi.fn(),
    notice: vi.fn(),
    startLane: vi.fn(async () => true),
    sessionLog: () => null,
  };
  const { result } = renderHook(() => useAutopilot(deps));
  return { deps, onLog: result.current.onTerminalLog };
}

describe("useAutopilot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    live.clear();
  });

  it("runs the stage's checks, then opens the next stage's terminal on the chain", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "advance",
      stageId: "pr_reviewer",
      roleId: "role_pr_reviewer",
      reason: "on to PR Reviewer",
    });
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", log(IMPLEMENTED));
    await waitFor(() => expect(handoffAttach).toHaveBeenCalled());
    expect(pipelineRunGates).toHaveBeenCalledWith(
      "ee_1",
      "implementer",
      "/repo",
      ["https://github.com/jt/app/pull/7"],
      null,
    );
    expect(vi.mocked(pipelineDecide).mock.calls[0][1]).toMatchObject({
      stageId: "implementer",
      verdict: null,
      missingSections: [],
      chat: false,
    });
    expect(deps.startTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: "role_pr_reviewer" }),
    );
    expect(vi.mocked(handoffAttach).mock.calls[0][0]).toMatchObject({
      tabId: "tab-new",
      chain: { chainId: "ee_1", kind: "eagle1", step: 4, total: 4 },
      loopBack: null,
    });
  });

  it("a turn seen while autopilot was off is never replayed", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(false));
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    const finished = log(IMPLEMENTED);
    onLog("impl", finished);
    await waitFor(() => expect(getPipelineRun).toHaveBeenCalledTimes(1));
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    onLog("impl", finished);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getPipelineRun).toHaveBeenCalledTimes(1);
    expect(pipelineDecide).not.toHaveBeenCalled();
    expect(deps.startTerminal).not.toHaveBeenCalled();
  });

  it("sends a round back into the earlier stage's idle terminal", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "loopBack",
      stageId: "implementer",
      roleId: "role_implementer",
      reason: "round 1 goes back",
    });
    live.set("impl", { exited: false });
    const review =
      "## HANDOFF: Verdict\nREQUEST CHANGES\n\n## HANDOFF: Findings for the Implementer\n1. Guard the null token.";
    const { onLog } = setup(
      [tab("impl", "role_implementer", 3), tab("pr", "role_pr_reviewer", 4)],
      { impl: { kind: "idle" } },
    );
    onLog("pr", log(review));
    await waitFor(() => expect(chainLoopBack).toHaveBeenCalled());
    const pasted = String(vi.mocked(ptyWrite).mock.calls[0][1]);
    expect(vi.mocked(ptyWrite).mock.calls[0][0]).toBe("impl");
    expect(pasted).toContain("Review findings from the PR Reviewer (round 1)");
    expect(pasted).toContain("Guard the null token.");
    expect(vi.mocked(chainLoopBack).mock.calls[0][0]).toMatchObject({
      chainId: "ee_1",
      reviewerRoleId: "role_pr_reviewer",
      tabId: "impl",
      verdict: "REQUEST CHANGES",
    });
  });

  it("a round sent back is numbered by the reviewer's own edge, as the round cap counts it", async () => {
    // The plan went back once and the PR Reviewer sent it back once: run round 3, PR Reviewer round 2.
    const base = run(true).run;
    vi.mocked(getPipelineRun).mockResolvedValue({
      run: {
        ...base,
        round: 3,
        verdicts: [
          { roleId: "role_plan_reviewer", round: 1, verdict: "REQUEST CHANGES", at: "then" },
          { roleId: "role_pr_reviewer", round: 2, verdict: "REQUEST CHANGES", at: "then" },
        ],
      },
    });
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "loopBack",
      stageId: "implementer",
      roleId: "role_implementer",
      reason: "round 2 goes back",
    });
    live.set("impl", { exited: false });
    const review =
      "## HANDOFF: Verdict\nREQUEST CHANGES\n\n## HANDOFF: Findings for the Implementer\n1. Guard the null token.";
    const { onLog } = setup(
      [tab("impl", "role_implementer", 3), { ...tab("pr", "role_pr_reviewer", 4), chain: { chainId: "ee_1", kind: "eagle1", step: 4, total: 4, round: 3 } } as TabSummary],
      { impl: { kind: "idle" } },
    );
    onLog("pr", log(review));
    await waitFor(() => expect(chainLoopBack).toHaveBeenCalled());
    expect(String(vi.mocked(ptyWrite).mock.calls[0][1])).toContain("Review findings from the PR Reviewer (round 2)");
  });

  it("stops instead of pasting into a terminal that is waiting for you", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "loopBack",
      stageId: "implementer",
      roleId: "role_implementer",
      reason: "round 1 goes back",
    });
    live.set("impl", { exited: false });
    const { deps, onLog } = setup(
      [tab("impl", "role_implementer", 3), tab("pr", "role_pr_reviewer", 4)],
      { impl: { kind: "needs", needs: "permission", toolId: "t", toolTitle: "Bash" } },
    );
    onLog("pr", log("## HANDOFF: Verdict\nREQUEST CHANGES"));
    await waitFor(() => expect(deps.notifyStop).toHaveBeenCalled());
    expect(ptyWrite).not.toHaveBeenCalled();
    expect(vi.mocked(deps.notifyStop).mock.calls[0][1]).toContain("waiting for you");
  });

  it("a lane done starts the lanes it unblocked", async () => {
    const lanes = [
      { id: "pr1", title: "PR1", status: "approved", stage: "pr_reviewer", round: 1, tabIds: {} },
      { id: "pr2", title: "PR2", status: "waiting", dependsOn: ["pr1"], stage: "implementer", round: 1, tabIds: {} },
    ];
    vi.mocked(getPipelineRun).mockResolvedValue({ run: { ...run(true).run, lanes } });
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "laneDone",
      lane: "pr1",
      unblocked: ["pr2"],
      reason: "PR1 is approved. Starting pr2.",
    });
    const reviewer = { ...tab("pr", "role_pr_reviewer", 4), chain: { chainId: "ee_1", kind: "eagle1", step: 4, total: 4, lane: "pr1" } };
    const { deps, onLog } = setup([reviewer as TabSummary]);
    onLog("pr", log("## HANDOFF: Verdict\nAPPROVED\n\n## HANDOFF: Findings for the Implementer\nNone."));
    await waitFor(() => expect(deps.startLane).toHaveBeenCalled());
    expect(vi.mocked(deps.startLane).mock.calls[0][1].id).toBe("pr2");
    expect(vi.mocked(pipelineDecide).mock.calls[0][1].lane).toBe("pr1");
    expect(vi.mocked(pipelineRunGates)).not.toHaveBeenCalled();
  });

  it("a turn in an already-approved lane is ignored without a notice", async () => {
    const lanes = [{ id: "pr1", title: "PR1", status: "approved", stage: "pr_reviewer", round: 1, tabIds: {} }];
    vi.mocked(getPipelineRun).mockResolvedValue({ run: { ...run(true).run, lanes } });
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "ignore",
      lane: "pr1",
      reason: "That pull request is already approved.",
    });
    const reviewer = { ...tab("pr", "role_pr_reviewer", 4), chain: { chainId: "ee_1", kind: "eagle1", step: 4, total: 4, lane: "pr1" } };
    const { deps, onLog } = setup([reviewer as TabSummary]);
    onLog("pr", log("## HANDOFF: Verdict\nREQUEST CHANGES\n\n## HANDOFF: Findings for the Implementer\n1. Late."));
    await waitFor(() => expect(pipelineDecide).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.notifyStop).not.toHaveBeenCalled();
    expect(deps.notice).not.toHaveBeenCalled();
    expect(deps.startTerminal).not.toHaveBeenCalled();
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("a turn that finished before the app started is not acted on after a restart", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", log(IMPLEMENTED, "2026-01-01T00:00:00Z"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getPipelineRun).not.toHaveBeenCalled();
    expect(deps.startTerminal).not.toHaveBeenCalled();
  });

  it("parallel reviewers: waits for all, then decides once on their merged reviews", async () => {
    const { setPipelineDefs } = await import("./defs");
    setPipelineDefs([
      {
        id: "pair",
        name: "Pair",
        stages: [
          { id: "build", roleId: "role_implementer", title: "Implementer" },
          {
            id: "review",
            roleId: "role_pr_reviewer",
            title: "PR Reviewer",
            loopBack: { to: "build" },
            alsoReviewers: ["role_security"],
          },
        ],
      },
    ]);
    const on = (id: string, roleId: string, step: number) =>
      ({ ...tab(id, roleId, step), chain: { chainId: "ee_1", kind: "pair", step, total: 2 } }) as TabSummary;
    vi.mocked(getPipelineRun).mockResolvedValue({
      run: { ...run(true).run, kind: "pair", tabIds: { role_pr_reviewer: "pr", role_security: "sec" } },
    });
    vi.mocked(pipelineDecide).mockResolvedValue({ action: "stop", reason: "test" });
    const prLog = log("## HANDOFF: Verdict\nAPPROVED\n\n## HANDOFF: Findings for the Implementer\nNone.");
    const secLog = log("## HANDOFF: Verdict\nREQUEST CHANGES\n\n## HANDOFF: Findings for the Implementer\n1. Token in logs.");
    const logs: Record<string, TerminalSessionLog> = {};
    const tabs = [on("impl", "role_implementer", 1), on("pr", "role_pr_reviewer", 2), on("sec", "role_security", 2)];
    const deps: AutopilotDeps = {
      tabs: () => tabs,
      roles: () => null,
      terminalState: () => undefined,
      startTerminal: vi.fn(async () => "tab-new"),
      refreshTabs: vi.fn(async () => {}),
      notifyStop: vi.fn(),
      notice: vi.fn(),
      startLane: vi.fn(async () => true),
      sessionLog: (id) => logs[id],
    };
    const { result } = renderHook(() => useAutopilot(deps));
    result.current.onTerminalLog("pr", prLog);
    logs.pr = prLog;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pipelineDecide).not.toHaveBeenCalled();
    result.current.onTerminalLog("sec", secLog);
    logs.sec = secLog;
    await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(1));
    const report = vi.mocked(pipelineDecide).mock.calls[0][1];
    expect(report).toMatchObject({ stageId: "review", verdict: "REQUEST CHANGES", missingSections: [] });
    setPipelineDefs([]);
  });

  async function pairSetup() {
    const { setPipelineDefs } = await import("./defs");
    setPipelineDefs([
      {
        id: "pair",
        name: "Pair",
        stages: [
          { id: "build", roleId: "role_implementer", title: "Implementer" },
          {
            id: "review",
            roleId: "role_pr_reviewer",
            title: "PR Reviewer",
            loopBack: { to: "build" },
            alsoReviewers: ["role_security"],
          },
          { id: "after", roleId: "role_general", title: "After" },
        ],
      },
    ]);
    const on = (id: string, roleId: string, step: number) =>
      ({ ...tab(id, roleId, step), chain: { chainId: "ee_1", kind: "pair", step, total: 3 } }) as TabSummary;
    vi.mocked(getPipelineRun).mockResolvedValue({
      run: { ...run(true).run, kind: "pair", tabIds: { role_pr_reviewer: "pr", role_security: "sec" } },
    });
    const logs: Record<string, TerminalSessionLog> = {};
    const tabs = [on("impl", "role_implementer", 1), on("pr", "role_pr_reviewer", 2), on("sec", "role_security", 2)];
    const deps: AutopilotDeps = {
      tabs: () => tabs,
      roles: () => null,
      terminalState: () => ({ kind: "idle" }),
      startTerminal: vi.fn(async () => "tab-new"),
      refreshTabs: vi.fn(async () => {}),
      notifyStop: vi.fn(),
      notice: vi.fn(),
      startLane: vi.fn(async () => true),
      sessionLog: (id) => logs[id],
    };
    const { result } = renderHook(() => useAutopilot(deps));
    const send = (id: string, l: TerminalSessionLog) => {
      logs[id] = l;
      result.current.onTerminalLog(id, l);
    };
    return { deps, send, done: () => setPipelineDefs([]) };
  }

  it("parallel reviewers: sections are checked on the main reply, and a re-ask needs only the main reviewer", async () => {
    const { send, done } = await pairSetup();
    vi.mocked(pipelineDecide).mockResolvedValue({ action: "reask", stageId: "review", reason: "sections" });
    live.set("pr", { exited: false });
    send("sec", log("## HANDOFF: Verdict\nAPPROVED\n\n## HANDOFF: Findings for the Implementer\nNone."));
    send("pr", log("## HANDOFF: Verdict\nAPPROVED", "2099-01-01T00:00:00Z"));
    await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(1));
    expect(vi.mocked(pipelineDecide).mock.calls[0][1].missingSections).toEqual(["Findings for the Implementer"]);
    await waitFor(() => expect(ptyWrite).toHaveBeenCalled());
    expect(vi.mocked(ptyWrite).mock.calls[0][0]).toBe("pr");
    // Only the main reviewer answers again; the security review is reused.
    vi.mocked(pipelineDecide).mockResolvedValue({ action: "stop", reason: "test" });
    send("pr", log("## HANDOFF: Verdict\nAPPROVED\n\n## HANDOFF: Findings for the Implementer\nNone.", "2099-01-01T00:01:00Z"));
    await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(2));
    expect(vi.mocked(pipelineDecide).mock.calls[1][1]).toMatchObject({ verdict: "APPROVED", missingSections: [] });
    done();
  });

  it("parallel reviewers: advancing hands on the main reviewer's own reply", async () => {
    const { deps, send, done } = await pairSetup();
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "advance",
      stageId: "after",
      roleId: "role_general",
      reason: "next",
    });
    send("pr", log("Main review text.\n\n## HANDOFF: Verdict\nAPPROVED\n\n## HANDOFF: Findings for the Implementer\nNone."));
    send("sec", log("Security text.\n\n## HANDOFF: Verdict\nAPPROVED\n\n## HANDOFF: Findings for the Implementer\nNone."));
    await waitFor(() => expect(deps.startTerminal).toHaveBeenCalled());
    expect(pipelineDecide).toHaveBeenCalledTimes(1);
    const saved = JSON.stringify(vi.mocked(handoffAttach).mock.calls[0][0]);
    expect(saved).toContain("Main review text.");
    expect(saved).not.toContain("From the");
    done();
  });

  it("a tab whose log is not read yet is not marked as seen", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({ action: "stop", reason: "test" });
    const { onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", null);
    // The first real read still applies the restart rule: an old turn is skipped.
    onLog("impl", log(IMPLEMENTED, "2026-01-01T00:00:00Z"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getPipelineRun).not.toHaveBeenCalled();
  });
});

