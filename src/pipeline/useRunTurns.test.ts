// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  pipelineActorMessage: vi.fn(async () => ({})),
  pipelineRunGates: vi.fn(async () => []),
  pipelineTurnFinished: vi.fn(async () => {}),
  ptyWrite: vi.fn(async () => {}),
}));
vi.mock("../terminal/live", () => ({
  ptyExitCode: () => null,
}));

import {
  pipelineActorMessage,
  pipelineRunGates,
  pipelineTurnFinished,
  ptyWrite,
  type TabSummary,
  type TerminalSessionLog,
} from "../bridge";
import { setPipelineDefs, type PipelineDef } from "./defs";
import { useRunTurns } from "./useRunTurns";

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

const IMPLEMENTED = [
  "## HANDOFF: Implementation summary\nIMPLEMENTED",
  "## HANDOFF: Pull requests\nPR1 — https://github.com/jt/app/pull/7",
].join("\n\n");

function setup(tabs: TabSummary[]) {
  const { result } = renderHook(() => useRunTurns({ tabs: () => tabs }));
  return { onLog: result.current.onTerminalLog, continueRun: result.current.continueRun };
}

/** A PR Reviewer tab launched with the bridge (engine 2). */
function bridgedReviewer(): TabSummary {
  return { ...tab("pr", "role_pr_reviewer", 4), bridge: { runId: "ee_1", stage: "pr_reviewer" } } as TabSummary;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("useRunTurns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPipelineDefs([]);
  });

  it("an engine-1 run with autopilot on is manual only: its turn is noted, nothing is carried out", async () => {
    // V6: nothing on the frontend runs checks, decides, pastes or opens a terminal.
    const { onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", log(IMPLEMENTED));
    await waitFor(() => expect(pipelineTurnFinished).toHaveBeenCalledTimes(1));
    await settle();
    expect(pipelineRunGates).not.toHaveBeenCalled();
    expect(ptyWrite).not.toHaveBeenCalled();
    expect(pipelineActorMessage).not.toHaveBeenCalled();
  });

  it("notes each finished turn in the ledger once, with a reviewer's verdict", async () => {
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

  it("a turn that finished before the app started is not noted again after a restart", async () => {
    const { onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", log(IMPLEMENTED, "2026-01-01T00:00:00Z"));
    await settle();
    expect(pipelineTurnFinished).not.toHaveBeenCalled();
  });

  it("a tab whose log is not read yet is not marked as seen", async () => {
    const { onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", null);
    // The first real read still applies the restart rule: an old turn is skipped.
    onLog("impl", log(IMPLEMENTED, "2026-01-01T00:00:00Z"));
    await settle();
    expect(pipelineTurnFinished).not.toHaveBeenCalled();
  });

  it("a turn you interrupted is not a finished turn", async () => {
    // 08:40:16: the Implementer's turn ended with "[Request interrupted by user]".
    const { onLog } = setup([tab("impl", "role_implementer", 3)]);
    onLog("impl", { ...log("Checking the fix is still on the branch."), interrupted: true });
    await settle();
    expect(pipelineTurnFinished).not.toHaveBeenCalled();
  });

  it("a bridged stage's turn is left to the run actor, which records it", async () => {
    const { onLog } = setup([tab("impl", "role_implementer", 3), bridgedReviewer()]);
    onLog("pr", log("## HANDOFF: Verdict\nAPPROVED"));
    await settle();
    expect(pipelineTurnFinished).not.toHaveBeenCalled();
  });

  it("Continue is a message to the run's actor", async () => {
    const { continueRun } = setup([bridgedReviewer()]);
    await continueRun("ee_1");
    expect(pipelineActorMessage).toHaveBeenCalledWith("ee_1", { kind: "continue" });
  });

  it("Continue that the actor refuses (an engine-1 run) rejects", async () => {
    vi.mocked(pipelineActorMessage).mockRejectedValueOnce(
      new Error("This run uses the older pipeline engine; its buttons work as before."),
    );
    const { continueRun } = setup([tab("impl", "role_implementer", 3)]);
    await expect(continueRun("ee_1")).rejects.toThrow("older pipeline engine");
  });
  it("a copied Planner's plan-wait and a copied reviewer's verdict are noted like the built-in ones (H4 kinds)", async () => {
    // Settings › Roles › Duplicate: the stages are told apart by kind, not role id or loop-back.
    const copies: PipelineDef = {
      id: "copies",
      name: "Copies",
      stages: [
        { id: "plan", roleId: "role_custom_1", title: "Planner", kind: "planner" },
        { id: "review", roleId: "role_custom_2", title: "Reviewer", kind: "reviewer" },
      ],
    };
    setPipelineDefs([copies]);
    const on = (t: TabSummary, step: number) =>
      ({ ...t, chain: { chainId: "cp_1", kind: "copies", step, total: 2 } }) as TabSummary;
    const planner = on(tab("plan", "role_custom_1", 1), 1);
    const reviewer = on(tab("rev", "role_custom_2", 2), 2);
    const { onLog } = setup([planner, reviewer]);
    onLog("plan", {
      ...log(""),
      turnDone: false,
      plan: "# The plan",
      openTool: { id: "t1", name: "ExitPlanMode", title: "Plan" },
    });
    await waitFor(() =>
      expect(pipelineTurnFinished).toHaveBeenCalledWith("cp_1", {
        stageId: "plan",
        roleId: "role_custom_1",
        lane: null,
        verdict: null,
      }),
    );
    onLog("rev", log("## HANDOFF: Verdict\nREQUEST CHANGES"));
    await waitFor(() =>
      expect(pipelineTurnFinished).toHaveBeenCalledWith("cp_1", {
        stageId: "review",
        roleId: "role_custom_2",
        lane: null,
        verdict: "REQUEST CHANGES",
      }),
    );
  });
});
