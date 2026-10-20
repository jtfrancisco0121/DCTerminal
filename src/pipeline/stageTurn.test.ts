import { describe, expect, it } from "vitest";
import type { TabSummary, TerminalSessionLog } from "../bridge";
import { finishedTurn, stageForTab, terminalStageSource } from "./stageTurn";

function log(patch: Partial<TerminalSessionLog> = {}): TerminalSessionLog {
  return {
    sessionId: "s1",
    path: "/x.jsonl",
    turnDone: true,
    lastReply: "done",
    plan: null,
    planAt: null,
    lastPromptAt: "2026-10-13T10:00:00Z",
    toolCalls: [],
    openTool: null,
    ...patch,
  };
}

describe("stage turns", () => {
  it("places a chain tab on its pipeline stage only when the role matches", () => {
    const chain = { chainId: "ee_1", kind: "eagle1", step: 2, total: 4 };
    expect(stageForTab(chain, "role_plan_reviewer")?.stage.id).toBe("plan_reviewer");
    expect(stageForTab(chain, "role_planner")).toBeNull();
    expect(stageForTab(null, "role_planner")).toBeNull();
  });

  it("a turn counts once it is done, or when a Planner waits on its plan", () => {
    expect(finishedTurn("role_implementer", log())?.awaitingPlan).toBe(false);
    expect(finishedTurn("role_implementer", log({ turnDone: false }))).toBeNull();
    const planning = log({
      turnDone: false,
      plan: "# Plan",
      openTool: { id: "t1", name: "ExitPlanMode", title: "Plan" },
    });
    expect(finishedTurn("role_planner", planning)).toEqual({
      key: "s1|2026-10-13T10:00:00Z|plan|t1",
      awaitingPlan: true,
    });
    // Only a Planner hands on from its plan dialog.
    expect(finishedTurn("role_implementer", planning)).toBeNull();
    // A new prompt is a new turn.
    expect(finishedTurn("role_implementer", log({ lastPromptAt: "later" }))?.key).not.toBe(
      finishedTurn("role_implementer", log())?.key,
    );
  });
  it("a manual hand-off source carries the tab's pipeline, so a copied role keeps its stage kind (H4)", () => {
    const tab = {
      id: "t",
      label: "Copied Implementer",
      roleId: "role_custom_3",
      cwd: "/repo",
      chain: { chainId: "cp_1", kind: "copies", step: 3, total: 4 },
    } as TabSummary;
    const source = terminalStageSource({ tab, log: log(), answers: {}, tail: "", awaitingPlan: false });
    expect(source.sourceChainKind).toBe("copies");
    expect(terminalStageSource({ tab: { ...tab, chain: null } as TabSummary, log: log(), answers: {}, tail: "", awaitingPlan: false }).sourceChainKind).toBeNull();
  });
});
