// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  chainLoopBack: vi.fn(async () => ({})),
  getClaudeUsage: vi.fn(async () => ({ configDir: "", windows: [], contextByTab: {} })),
  getPipelineRun: vi.fn(),
  getTab: vi.fn(async () => ({ tab: { answers: { cwd: "/repo", title: "Login 500" } } })),
  pipelineBridgeTurn: vi.fn(async () => null),
  pipelineContinue: vi.fn(async () => []),
  pipelineDecide: vi.fn(),
  pipelineNote: vi.fn(async () => {}),
  pipelineReleaseHandoff: vi.fn(async () => {}),
  pipelineRunGates: vi.fn(async () => []),
  pipelineTurnFinished: vi.fn(async () => {}),
  ptyWrite: vi.fn(async () => {}),
  setTabProvider: vi.fn(async () => {}),
  terminalSessionLog: vi.fn(async () => null),
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
  pipelineBridgeTurn,
  pipelineContinue,
  pipelineDecide,
  pipelineNote,
  pipelineReleaseHandoff,
  pipelineRunGates,
  pipelineTurnFinished,
  ptyWrite,
  setTabProvider,
  terminalSessionLog,
  type BridgeTurn,
  type PipelineRun,
  type TabSummary,
  type TerminalSessionLog,
} from "../bridge";
import type { RoleName } from "../handoff/transitions";
import type { TerminalState } from "../terminal/claudeState";
import { setPipelineDefs } from "./defs";
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

function setup(
  tabs: TabSummary[],
  states: Record<string, TerminalState> = {},
  roles: readonly RoleName[] | null = null,
) {
  const deps: AutopilotDeps = {
    tabs: () => tabs,
    roles: () => roles,
    terminalState: (id) => states[id],
    startTerminal: vi.fn(async () => "tab-new"),
    refreshTabs: vi.fn(async () => {}),
    notifyStop: vi.fn(),
    notice: vi.fn(),
    startLane: vi.fn(async () => true),
    sessionLog: () => null,
  };
  const { result } = renderHook(() => useAutopilot(deps));
  return {
    deps,
    onLog: result.current.onTerminalLog,
    onBridgeTurn: result.current.onBridgeTurn,
    continueRun: result.current.continueRun,
  };
}

/** A PR Reviewer tab launched with the bridge (engine 2). */
function bridgedReviewer(): TabSummary {
  return { ...tab("pr", "role_pr_reviewer", 4), bridge: { runId: "ee_1", stage: "pr_reviewer" } } as TabSummary;
}

function bridgeTurn(patch: Partial<BridgeTurn> = {}): BridgeTurn {
  return {
    schema: 1,
    runId: "ee_1",
    stageKey: "pr_reviewer",
    stageId: "pr_reviewer",
    roleId: "role_pr_reviewer",
    tabId: "pr",
    turn: "p-1",
    outcome: "result",
    endedAt: new Date(Date.now() + 1000).toISOString(),
    lastAssistantMessage: "## HANDOFF: Verdict\nREQUEST CHANGES",
    blocked: true,
    result: {
      schema: 1,
      verdict: "CHANGES_REQUIRED",
      findings: [{ severity: "HIGH", file: "src/a.ts:4", summary: "Null token." }],
    },
    ...patch,
  };
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
      1,
    );
    expect(vi.mocked(pipelineDecide).mock.calls[0][1]).toMatchObject({
      stageId: "implementer",
      verdict: null,
      missingSections: [],
      chat: false,
      // The round the turn ends, and the turn itself: stale or repeated turns are refused.
      round: 1,
      turn: expect.stringMatching(/^impl\|s\|/),
    });
    // The chain it joins goes with the start: its stage kind sets the permission mode.
    expect(deps.startTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: "role_pr_reviewer",
        chain: expect.objectContaining({ chainId: "ee_1", kind: "eagle1", step: 4 }),
      }),
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

  it("notes each finished turn in the ledger once, autopilot on or off, with a reviewer's verdict", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(false));
    const { onLog } = setup([tab("impl", "role_implementer", 3), tab("rev", "role_pr_reviewer", 4)]);
    const finished = log(IMPLEMENTED);
    onLog("impl", finished);
    onLog("impl", finished);
    onLog("rev", log("## HANDOFF: Verdict\nREQUEST CHANGES"));
    await waitFor(() => expect(pipelineTurnFinished).toHaveBeenCalledTimes(2));
    expect(pipelineTurnFinished).toHaveBeenNthCalledWith(1, "ee_1", {
      stageId: "implementer",
      roleId: "role_implementer",
      lane: null,
      verdict: null,
    });
    expect(pipelineTurnFinished).toHaveBeenNthCalledWith(2, "ee_1", {
      stageId: "pr_reviewer",
      roleId: "role_pr_reviewer",
      lane: null,
      verdict: "REQUEST CHANGES",
    });
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

  it("a turn you interrupted is not a finished turn", async () => {
    // 08:40:16: the Implementer's turn ended with "[Request interrupted by user]".
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", { ...log("Checking the fix is still on the branch."), interrupted: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pipelineTurnFinished).not.toHaveBeenCalled();
    expect(pipelineRunGates).not.toHaveBeenCalled();
    expect(pipelineDecide).not.toHaveBeenCalled();
    expect(deps.startTerminal).not.toHaveBeenCalled();
  });

  it("a turn whose tab got a newer prompt while its checks ran is not decided on", async () => {
    // The checks ran 27 s; a round was sent back into the tab meanwhile.
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    const finished = log(IMPLEMENTED);
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    const newer = { ...finished, turnDone: false, lastPromptAt: new Date(Date.now() + 5000).toISOString() };
    deps.sessionLog = (id) => (id === "impl" ? newer : null);
    onLog("impl", finished);
    await waitFor(() => expect(pipelineNote).toHaveBeenCalled());
    expect(vi.mocked(pipelineNote).mock.calls[0][1]).toMatchObject({
      stageId: "implementer",
      summary: "Skipped Implementer's turn: Tab impl got a newer prompt while its checks ran.",
      stop: false,
    });
    expect(pipelineDecide).not.toHaveBeenCalled();
    expect(deps.startTerminal).not.toHaveBeenCalled();
  });

  it("a hand-off made already is skipped: no second terminal, no notice", async () => {
    // 08:42:41 you handed the turn on; 08:42:44 autopilot's checks finished.
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "skip",
      stageId: "implementer",
      roleId: "role_implementer",
      reason: "Implementer finished: already handed on by you.",
    });
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", log(IMPLEMENTED));
    await waitFor(() => expect(pipelineDecide).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.startTerminal).not.toHaveBeenCalled();
    expect(deps.notifyStop).not.toHaveBeenCalled();
    expect(deps.notice).not.toHaveBeenCalled();
  });

  it("a hand-off that could not be made gives its claim back", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "advance",
      stageId: "pr_reviewer",
      roleId: "role_pr_reviewer",
      reason: "on to PR Reviewer",
      claim: "advance:implementer#1",
    });
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    vi.mocked(deps.startTerminal).mockResolvedValue(null);
    onLog("impl", log(IMPLEMENTED));
    await waitFor(() => expect(deps.notifyStop).toHaveBeenCalled());
    expect(pipelineReleaseHandoff).toHaveBeenCalledWith("ee_1", "advance:implementer#1");
  });

  it("opens the next stage's terminal as the source tab's provider, not switched after it started", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "advance",
      stageId: "pr_reviewer",
      roleId: "role_pr_reviewer",
      reason: "on to PR Reviewer",
    });
    const { deps, onLog } = setup([{ ...tab("impl", "role_implementer", 3), provider: "cursor" } as TabSummary]);
    onLog("impl", log(IMPLEMENTED));
    await waitFor(() => expect(handoffAttach).toHaveBeenCalled());
    expect(deps.startTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: "role_pr_reviewer", provider: "cursor" }),
    );
    expect(setTabProvider).not.toHaveBeenCalled();
  });

  it("an older log read during the checks is not a newer prompt", async () => {
    // A read that started before the turn ended lands while its checks run.
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({ action: "stop", reason: "test" });
    const finished = log(IMPLEMENTED);
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    const older = { ...finished, turnDone: false, lastPromptAt: new Date(Date.now() - 60_000).toISOString() };
    deps.sessionLog = (id) => (id === "impl" ? older : null);
    onLog("impl", finished);
    await waitFor(() => expect(pipelineDecide).toHaveBeenCalled());
    expect(pipelineNote).not.toHaveBeenCalledWith(
      "ee_1",
      expect.objectContaining({ summary: expect.stringContaining("newer prompt") }),
    );
  });

  it("records the round going back before pasting the findings into the earlier stage", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "loopBack",
      stageId: "implementer",
      roleId: "role_implementer",
      reason: "round 1 goes back",
      claim: "back:pr_reviewer#1",
    });
    live.set("impl", { exited: false });
    const order: string[] = [];
    vi.mocked(chainLoopBack).mockImplementationOnce(async () => {
      order.push("record");
      return {} as never;
    });
    vi.mocked(ptyWrite).mockImplementationOnce(async () => {
      order.push("paste");
    });
    const { onLog } = setup(
      [tab("impl", "role_implementer", 3), tab("pr", "role_pr_reviewer", 4)],
      { impl: { kind: "idle" } },
    );
    onLog("pr", log("## HANDOFF: Verdict\nREQUEST CHANGES\n\n## HANDOFF: Findings for the Implementer\n1. Guard it."));
    await waitFor(() => expect(order).toEqual(["record", "paste"]));
    // The text recorded is the text pasted.
    expect(vi.mocked(chainLoopBack).mock.calls[0][0].handoffText).toContain("Guard it.");
    expect(String(vi.mocked(ptyWrite).mock.calls[0][1])).toContain("Guard it.");
  });

  it("a loop-back whose round could not be recorded stops the run instead of pasting", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "loopBack",
      stageId: "implementer",
      roleId: "role_implementer",
      reason: "round 1 goes back",
      claim: "back:pr_reviewer#1",
    });
    live.set("impl", { exited: false });
    vi.mocked(chainLoopBack).mockRejectedValueOnce(new Error("disk full"));
    const { deps, onLog } = setup(
      [tab("impl", "role_implementer", 3), tab("pr", "role_pr_reviewer", 4)],
      { impl: { kind: "idle" } },
    );
    onLog("pr", log("## HANDOFF: Verdict\nREQUEST CHANGES\n\n## HANDOFF: Findings for the Implementer\n1. Guard it."));
    await waitFor(() => expect(deps.notifyStop).toHaveBeenCalled());
    expect(ptyWrite).not.toHaveBeenCalled();
    expect(pipelineReleaseHandoff).toHaveBeenCalledWith("ee_1", "back:pr_reviewer#1");
    expect(pipelineNote).toHaveBeenCalledWith(
      "ee_1",
      expect.objectContaining({
        stop: true,
        reason: "carry_out_failed",
        summary: expect.stringContaining("disk full"),
      }),
    );
  });

  it("a late turn after the run completed runs no checks and decides nothing", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue({ run: { ...run(true).run, status: "complete" } });
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", log(IMPLEMENTED));
    await waitFor(() => expect(getPipelineRun).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pipelineRunGates).not.toHaveBeenCalled();
    expect(pipelineDecide).not.toHaveBeenCalled();
    expect(deps.startTerminal).not.toHaveBeenCalled();
  });

  it("a turn while the run waits for you runs no checks; the core notes it was left alone", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue({
      run: { ...run(true).run, status: "waiting", stopReason: "checkpoint" },
    });
    vi.mocked(pipelineDecide).mockResolvedValue({ action: "skip", reason: "waiting for you" });
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", log(IMPLEMENTED));
    await waitFor(() => expect(pipelineDecide).toHaveBeenCalled());
    expect(pipelineRunGates).not.toHaveBeenCalled();
    expect(deps.notifyStop).not.toHaveBeenCalled();
  });

  it("Continue after a restart decides the turn that finished while the app was closed", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "advance",
      stageId: "pr_reviewer",
      roleId: "role_pr_reviewer",
      reason: "on to PR Reviewer",
    });
    const before = log(IMPLEMENTED, "2026-01-01T00:00:00Z");
    vi.mocked(pipelineContinue).mockResolvedValue(["impl"]);
    vi.mocked(terminalSessionLog).mockResolvedValue(before);
    const { deps, onLog, continueRun } = setup([tab("impl", "role_implementer", 3)]);
    // First sight after the restart: never acted on by itself.
    onLog("impl", before);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pipelineDecide).not.toHaveBeenCalled();

    await continueRun("ee_1");
    expect(pipelineContinue).toHaveBeenCalledWith("ee_1");
    await waitFor(() => expect(handoffAttach).toHaveBeenCalled());
    expect(vi.mocked(pipelineDecide).mock.calls[0][1].turn).toBe("impl|s|2026-01-01T00:00:00Z");
    expect(deps.startTerminal).toHaveBeenCalledWith(expect.objectContaining({ roleId: "role_pr_reviewer" }));
  });

  it("Continue decides a stage tab whose log was not read since the restart", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({ action: "skip", reason: "handed on already" });
    vi.mocked(pipelineContinue).mockResolvedValue(["impl", "gone"]);
    vi.mocked(terminalSessionLog).mockImplementation(async (id: string) =>
      id === "impl" ? log(IMPLEMENTED, "2026-01-01T00:00:00Z") : null,
    );
    const { continueRun } = setup([tab("impl", "role_implementer", 3)]);
    await continueRun("ee_1");
    await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(1));
    expect(terminalSessionLog).toHaveBeenCalledWith("gone");
  });

  it("Continue leaves a tab with no log yet to the restart check when its log shows up", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineContinue).mockResolvedValue(["impl"]);
    vi.mocked(terminalSessionLog).mockResolvedValue(null);
    const { onLog, continueRun } = setup([tab("impl", "role_implementer", 3)]);
    await continueRun("ee_1");
    // The log read later holds a turn from before the restart: still not acted on.
    onLog("impl", log(IMPLEMENTED, "2026-01-01T00:00:00Z"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getPipelineRun).not.toHaveBeenCalled();
    expect(pipelineDecide).not.toHaveBeenCalled();
  });

  it("Continue that the core refuses decides nothing and rejects", async () => {
    vi.mocked(pipelineContinue).mockRejectedValue(new Error("This run is not waiting after a restart."));
    const { continueRun } = setup([tab("impl", "role_implementer", 3)]);
    await expect(continueRun("ee_1")).rejects.toThrow("not waiting after a restart");
    expect(terminalSessionLog).not.toHaveBeenCalled();
    expect(pipelineDecide).not.toHaveBeenCalled();
  });

  describe("bridged stages (engine 2)", () => {
    it("a bridged reviewer's turn is never decided from its log", async () => {
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      const { onLog } = setup([tab("impl", "role_implementer", 3), bridgedReviewer()]);
      onLog("pr", log("## HANDOFF: Verdict\nAPPROVED"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pipelineDecide).not.toHaveBeenCalled();
      expect(pipelineTurnFinished).not.toHaveBeenCalled();
    });

    it("decides on the submitted result and sends its findings back", async () => {
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      vi.mocked(pipelineDecide).mockResolvedValue({
        action: "loopBack",
        stageId: "implementer",
        roleId: "role_implementer",
        reason: "round 1 goes back",
      });
      live.set("impl", { exited: false });
      const { onBridgeTurn } = setup([tab("impl", "role_implementer", 3), bridgedReviewer()], {
        impl: { kind: "idle" },
      });
      // The reply's own words say APPROVED; the tool call is what counts.
      onBridgeTurn(bridgeTurn({ lastAssistantMessage: "## HANDOFF: Verdict\nAPPROVED" }));
      await waitFor(() => expect(chainLoopBack).toHaveBeenCalled());
      expect(vi.mocked(pipelineDecide).mock.calls[0][1]).toMatchObject({
        stageId: "pr_reviewer",
        verdict: "REQUEST CHANGES",
        findings: [{ severity: "HIGH", summary: "Null token." }],
        findingsKnown: true,
        missingSections: [],
        noResult: false,
        round: 1,
        turn: "pr|bridge|p-1",
      });
      expect(pipelineTurnFinished).toHaveBeenCalledWith("ee_1", {
        stageId: "pr_reviewer",
        roleId: "role_pr_reviewer",
        lane: null,
        verdict: "REQUEST CHANGES",
      });
      const pasted = String(vi.mocked(ptyWrite).mock.calls[0][1]);
      expect(pasted).toContain("1. [HIGH] src/a.ts:4: Null token.");
      expect(vi.mocked(chainLoopBack).mock.calls[0][0]).toMatchObject({ verdict: "REQUEST CHANGES", tabId: "impl" });
    });

    it("a turn that ended without the tool is decided as no_result", async () => {
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      vi.mocked(pipelineDecide).mockResolvedValue({ action: "stop", reason: "no result", stopReason: "no_result" });
      const { deps, onBridgeTurn } = setup([bridgedReviewer()]);
      onBridgeTurn(bridgeTurn({ outcome: "no_result", result: null }));
      await waitFor(() => expect(deps.notifyStop).toHaveBeenCalledWith("pr", "no result", "no_result"));
      expect(vi.mocked(pipelineDecide).mock.calls[0][1]).toMatchObject({ noResult: true, verdict: null });
    });

    it("a bridged reviewer that hit the usage limit reports it, runs no checks and stops as usage_limit", async () => {
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      vi.mocked(pipelineDecide).mockResolvedValue({
        action: "stop",
        stageId: "pr_reviewer",
        reason: "PR Reviewer hit a Claude usage limit: You've hit your limit. Carry on yourself once it resets.",
        stopReason: "usage_limit",
      });
      vi.mocked(terminalSessionLog).mockResolvedValue({
        ...log("You've hit your limit"),
        rateLimit: "You've hit your limit",
      });
      const { deps, onBridgeTurn } = setup([bridgedReviewer()]);
      onBridgeTurn(bridgeTurn({ outcome: "no_result", result: null, lastAssistantMessage: "You've hit your limit" }));
      await waitFor(() => expect(deps.notifyStop).toHaveBeenCalled());
      expect(pipelineRunGates).not.toHaveBeenCalled();
      expect(vi.mocked(pipelineDecide).mock.calls[0][1]).toMatchObject({
        rateLimit: "You've hit your limit",
        noResult: true,
        usagePercent: null,
      });
      expect(vi.mocked(deps.notifyStop).mock.calls[0][2]).toBe("usage_limit");
    });

    it("the same turn is decided once, and other tabs' turns are not this tab's", async () => {
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      vi.mocked(pipelineDecide).mockResolvedValue({ action: "skip", reason: "x" });
      const { onBridgeTurn } = setup([bridgedReviewer(), tab("impl", "role_implementer", 3)]);
      onBridgeTurn(bridgeTurn());
      onBridgeTurn(bridgeTurn());
      // A tab that is not bridged: never decided from an event.
      onBridgeTurn(bridgeTurn({ tabId: "impl" }));
      await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pipelineDecide).toHaveBeenCalledTimes(1);
    });

    it("a turn the event missed is read back from the bridge when the log shows the turn ended", async () => {
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      vi.mocked(pipelineDecide).mockResolvedValue({ action: "skip", reason: "x" });
      vi.mocked(pipelineBridgeTurn).mockResolvedValue(bridgeTurn());
      const { onLog } = setup([bridgedReviewer()]);
      onLog("pr", log("## HANDOFF: Verdict\nREQUEST CHANGES"));
      await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(1));
      expect(pipelineBridgeTurn).toHaveBeenCalledWith("pr");
    });

    it("a Resume that switched the run to engine 1 decides nothing: the bridge already decided the turn and autopilot is off", async () => {
      // First the bridge's turn is decided once.
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      vi.mocked(pipelineDecide).mockResolvedValue({ action: "skip", reason: "x" });
      vi.mocked(pipelineBridgeTurn).mockResolvedValue(bridgeTurn());
      const tabs = [bridgedReviewer()];
      const { onLog } = setup(tabs);
      const reply = log("## HANDOFF: Verdict\nREQUEST CHANGES");
      onLog("pr", reply);
      await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(1));
      // The Resume's gate: the core dropped the tag and turned autopilot off.
      vi.mocked(getPipelineRun).mockResolvedValue(run(false));
      vi.mocked(pipelineBridgeTurn).mockResolvedValue(null);
      // The resumed session's log still shows the same finished turn, first
      // while the tab list still has the tag, then after any later refresh.
      onLog("pr", reply);
      await new Promise((resolve) => setTimeout(resolve, 20));
      tabs[0] = tab("pr", "role_pr_reviewer", 4);
      onLog("pr", reply);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pipelineDecide).toHaveBeenCalledTimes(1);
      expect(vi.mocked(pipelineDecide).mock.calls[0][1].turn).toBe("pr|bridge|p-1");
    });

    it("a tab that lost its bridge with autopilot still on never decides the bridge's turn again, only its next one", async () => {
      // A Resume of a tab that no longer owns its stage: the core drops the
      // tag but the run stays on engine 2 with autopilot on.
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      vi.mocked(pipelineDecide).mockResolvedValue({ action: "skip", reason: "x" });
      // The bridge's turn ended after its prompt, as a real turn does.
      vi.mocked(pipelineBridgeTurn).mockResolvedValue(bridgeTurn({ endedAt: "2099-01-01T00:01:00Z" }));
      const tabs = [bridgedReviewer()];
      const { onLog } = setup(tabs);
      const reply = log("## HANDOFF: Verdict\nREQUEST CHANGES", "2099-01-01T00:00:00Z");
      onLog("pr", reply);
      await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(1));
      tabs[0] = tab("pr", "role_pr_reviewer", 4);
      onLog("pr", reply);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pipelineDecide).toHaveBeenCalledTimes(1);
      // A turn after that is the v1 path's to decide.
      onLog("pr", log("## HANDOFF: Verdict\nAPPROVED", "2099-01-01T00:05:00Z"));
      await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(2));
      expect(vi.mocked(pipelineDecide).mock.calls[1][1].turn).not.toContain("|bridge|");
    });

    it("after a Restart with a new session, a tab that lost its bridge still gets its first new turn decided", async () => {
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      vi.mocked(pipelineDecide).mockResolvedValue({ action: "skip", reason: "x" });
      const ended = new Date(Date.now() + 1000);
      vi.mocked(pipelineBridgeTurn).mockResolvedValue(bridgeTurn({ endedAt: ended.toISOString() }));
      const tabs = [bridgedReviewer()];
      const { onLog } = setup(tabs);
      onLog("pr", log("## HANDOFF: Verdict\nREQUEST CHANGES", new Date(ended.getTime() - 60_000).toISOString()));
      await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(1));
      // Restarted unbridged with a new session; its first read already shows
      // a finished turn prompted after the bridge's turn ended.
      tabs[0] = tab("pr", "role_pr_reviewer", 4);
      const fresh = { ...log("## HANDOFF: Verdict\nAPPROVED", new Date(ended.getTime() + 60_000).toISOString()), sessionId: "s-new" };
      onLog("pr", fresh);
      await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(2));
      expect(vi.mocked(pipelineDecide).mock.calls[1][1].turn).not.toContain("|bridge|");
    });

    it("a bridge turn that ended before the app started waits for Continue", async () => {
      vi.mocked(getPipelineRun).mockResolvedValue(run(true));
      vi.mocked(pipelineDecide).mockResolvedValue({ action: "skip", reason: "x" });
      const old = bridgeTurn({ endedAt: "2026-01-01T00:00:00Z" });
      vi.mocked(pipelineBridgeTurn).mockResolvedValue(old);
      vi.mocked(pipelineContinue).mockResolvedValue(["pr"]);
      const { onLog, continueRun } = setup([bridgedReviewer()]);
      onLog("pr", log("## HANDOFF: Verdict\nREQUEST CHANGES", "2026-01-01T00:00:00Z"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pipelineDecide).not.toHaveBeenCalled();
      await continueRun("ee_1");
      await waitFor(() => expect(pipelineDecide).toHaveBeenCalledTimes(1));
      expect(vi.mocked(pipelineDecide).mock.calls[0][1].turn).toBe("pr|bridge|p-1");
    });
  });

  it("a rate-limited turn runs no checks, reports the error and tells you it stopped for usage_limit", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(run(true));
    vi.mocked(pipelineDecide).mockResolvedValue({
      action: "stop",
      stageId: "implementer",
      reason: "Implementer hit a Claude usage limit: You've hit your limit. Carry on yourself once it resets.",
      stopReason: "usage_limit",
    });
    const { deps, onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", { ...log("You've hit your limit"), rateLimit: "You've hit your limit" });
    await waitFor(() => expect(deps.notifyStop).toHaveBeenCalled());
    expect(pipelineRunGates).not.toHaveBeenCalled();
    expect(vi.mocked(pipelineDecide).mock.calls[0][1]).toMatchObject({
      rateLimit: "You've hit your limit",
      // No usage reading: unknown, not 0.
      usagePercent: null,
    });
    expect(vi.mocked(deps.notifyStop).mock.calls[0]).toEqual([
      "impl",
      "Implementer hit a Claude usage limit: You've hit your limit. Carry on yourself once it resets.",
      "usage_limit",
    ]);
  });

  it("a stop autopilot makes itself while carrying out names carry_out_failed in the notification", async () => {
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
      { impl: { kind: "working" } as TerminalState },
    );
    onLog("pr", log("## HANDOFF: Verdict\nREQUEST CHANGES"));
    await waitFor(() => expect(deps.notifyStop).toHaveBeenCalled());
    expect(vi.mocked(deps.notifyStop).mock.calls[0][2]).toBe("carry_out_failed");
  });
});

describe("a duplicated PR Reviewer in a pipeline of your own (Track H4)", () => {
  const COPY = "role_custom_7";

  beforeEach(() => {
    vi.clearAllMocks();
    live.clear();
  });

  /** Eagle-Eye 2, or the same pipeline with its PR Reviewer swapped for a copy. */
  function chainTabs(copied: boolean): { kind: string; runKind: string; tabs: TabSummary[] } {
    const kind = copied ? "copied_review" : "eagle2";
    if (copied) {
      setPipelineDefs([
        {
          id: kind,
          name: "Copied review",
          stages: [
            { id: "implementer", roleId: "role_implementer", title: "Implementer" },
            { id: "pr_reviewer", roleId: COPY, title: "PR Reviewer", loopBack: { to: "implementer", minSeverity: "MEDIUM" } },
          ],
        },
      ]);
    }
    const on = (t: TabSummary, step: number) => ({ ...t, chain: { chainId: "ee_1", kind, step, total: 2 } }) as TabSummary;
    return {
      kind,
      runKind: copied ? kind : "execute",
      tabs: [on(tab("impl", "role_implementer", 1), 1), on(tab("pr", copied ? COPY : "role_pr_reviewer", 2), 2)],
    };
  }

  /** The reviewer forgets its sections, is asked again, then asks for changes. */
  async function reviewerTurns(copied: boolean) {
    vi.clearAllMocks();
    live.clear();
    const { runKind, tabs } = chainTabs(copied);
    vi.mocked(getPipelineRun).mockResolvedValue({ run: { ...run(true).run, kind: runKind } });
    live.set("impl", { exited: false });
    live.set("pr", { exited: false });
    // The copy keeps its original's name (Settings › Roles › Duplicate adds " copy"; renamed here).
    const roles = copied ? [{ id: COPY, name: "PR Reviewer" }] : null;
    const { onLog } = setup(tabs, { impl: { kind: "idle" }, pr: { kind: "idle" } }, roles);
    vi.mocked(pipelineDecide).mockResolvedValueOnce({ action: "reask", stageId: "pr_reviewer", reason: "sections" });
    onLog("pr", log("Looks risky: the token can be null.", "2099-01-01T00:00:00Z"));
    await waitFor(() => expect(ptyWrite).toHaveBeenCalledTimes(1));
    const reported = vi.mocked(pipelineDecide).mock.calls[0][1];
    const reask = vi.mocked(ptyWrite).mock.calls[0];
    vi.mocked(pipelineDecide).mockResolvedValueOnce({
      action: "loopBack",
      stageId: "implementer",
      roleId: "role_implementer",
      reason: "round 1 goes back",
    });
    onLog("pr", log(REVIEW_CHANGES, "2099-01-01T00:01:00Z"));
    await waitFor(() => expect(ptyWrite).toHaveBeenCalledTimes(2));
    const second = vi.mocked(pipelineDecide).mock.calls[1][1];
    const back = vi.mocked(ptyWrite).mock.calls[1];
    const recorded = vi.mocked(chainLoopBack).mock.calls[0][0];
    if (copied) setPipelineDefs([]);
    return {
      missingSections: reported.missingSections,
      reask: [reask[0], String(reask[1])],
      verdict: second.verdict,
      findingsKnown: second.findingsKnown,
      back: [back[0], String(back[1])],
      recorded: { tabId: recorded.tabId, verdict: recorded.verdict },
    };
  }

  const REVIEW_CHANGES = [
    "## HANDOFF: Verdict\nREQUEST CHANGES",
    "## HANDOFF: Findings for the Implementer\n1. Guard the null token.",
    '## HANDOFF: Result\n```json\n{"verdict": "REQUEST CHANGES", "findings": [{"severity": "MEDIUM", "summary": "Null token."}]}\n```',
  ].join("\n\n");

  it("re-asks and loops exactly like the built-in PR Reviewer", async () => {
    const builtIn = await reviewerTurns(false);
    expect(builtIn.missingSections).toEqual(["Verdict", "Findings for the Implementer"]);
    expect(builtIn.reask[0]).toBe("pr");
    expect(builtIn.reask[1]).toContain("missing the HANDOFF sections");
    expect(builtIn.back[0]).toBe("impl");
    expect(builtIn.back[1]).toContain("push to the same branch");
    expect(await reviewerTurns(true)).toEqual(builtIn);
  });
});
