import { describe, expect, it } from "vitest";
import type { PipelineRun, RunEvent } from "../bridge";
import { planHeading, planOfRun, runIdOfTab } from "./planPane";

function run(patch: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "ee_1",
    kind: "eagle1",
    cwd: "/repo",
    stage: "implementer",
    overviewTabId: "",
    tabIds: {},
    createdAt: "2026-10-16T09:00:00Z",
    updatedAt: "2026-10-16T10:00:00Z",
    ...patch,
  };
}

const event = (patch: Partial<RunEvent>): RunEvent => ({
  at: "2026-10-16T09:30:00Z",
  kind: "note",
  round: 1,
  summary: "",
  ...patch,
});

describe("runIdOfTab", () => {
  it("prefers the chain's run, then the preset run, else none", () => {
    expect(runIdOfTab({ chain: { chainId: "ee_1", kind: "eagle1", step: 1, total: 4 }, pipelineRunId: "p" })).toBe("ee_1");
    expect(runIdOfTab({ chain: null, pipelineRunId: " p1 " })).toBe("p1");
    expect(runIdOfTab({ chain: null, pipelineRunId: null })).toBeNull();
    expect(runIdOfTab(null)).toBeNull();
  });
});

describe("planOfRun", () => {
  it("shows the approved plan with the round its approval was recorded in", () => {
    const plan = planOfRun(
      run({
        approvedPlan: " Do it ",
        candidatePlan: "draft",
        events: [
          event({ outcome: "planApproved", round: 1, at: "2026-10-16T09:10:00Z" }),
          event({ outcome: "planApproved", round: 2, at: "2026-10-16T09:40:00Z" }),
        ],
      }),
    );
    expect(plan).toEqual({ text: "Do it", source: "approved", round: 2, updatedAt: "2026-10-16T09:40:00Z" });
    expect(planHeading(plan)).toBe("Plan · approved in round 2");
  });

  it("an approved plan without a recorded approval has no round", () => {
    const plan = planOfRun(run({ approvedPlan: "Do it" }));
    expect(plan?.round).toBeNull();
    expect(plan?.updatedAt).toBe("2026-10-16T10:00:00Z");
    expect(planHeading(plan)).toBe("Plan · approved");
  });

  it("falls back to the candidate while none is approved", () => {
    const plan = planOfRun(run({ approvedPlan: "  ", candidatePlan: "Maybe this" }));
    expect(plan?.source).toBe("candidate");
    expect(planHeading(plan)).toBe("Plan · candidate");
  });

  it("a chain run shows the plan it handed to the Implementer", () => {
    const plan = planOfRun(
      run({
        handoffs: { role_implementer: { text: "Plan text", at: "2026-10-16T09:50:00Z" } },
        events: [event({ kind: "handoff", roleId: "role_implementer", round: 3 })],
      }),
    );
    expect(plan).toMatchObject({ source: "handoff", round: 3, updatedAt: "2026-10-16T09:50:00Z" });
    expect(planHeading(plan)).toBe("Plan · handed to the Implementer in round 3");
  });

  it("has nothing to show before any plan exists", () => {
    expect(planOfRun(run())).toBeNull();
    expect(planHeading(null)).toBe("Plan");
  });
});
