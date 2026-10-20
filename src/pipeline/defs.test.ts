import { afterEach, describe, expect, it } from "vitest";
import { missingHandoffSections } from "../handoff/contract";
import { handoffRoute, loopBackMessage } from "../handoff/routing";
import { isPlanSource } from "../handoff/transitions";
import { isReviewerRole } from "../handoff/verdict";
import { finishedTurn } from "./stageTurn";
import {
  behaviourRole,
  pipelineDef,
  pipelineStages,
  roleBehaviour,
  setPipelineDefs,
  stageBehaviour,
  stageKind,
  type PipelineDef,
} from "./defs";

/** Eagle-Eye 1 built from copies of every role, as Settings › Roles › Duplicate makes them. */
const COPIED: PipelineDef = {
  id: "copies",
  name: "Copies",
  stages: [
    { id: "plan", roleId: "role_custom_1", title: "Planner", kind: "planner" },
    { id: "plan_review", roleId: "role_custom_2", title: "Plan Reviewer", loopBack: { to: "plan" } },
    { id: "build", roleId: "role_custom_3", title: "Implementer", kind: "implementer" },
    { id: "review", roleId: "role_custom_4", title: "PR Reviewer", loopBack: { to: "build" } },
    { id: "notes", roleId: "role_custom_5", title: "Release notes" },
  ],
};

describe("stage kinds (Track H4)", () => {
  afterEach(() => setPipelineDefs([]));

  it("built-in stages say their kind; left out, it comes from the role, then the loop-back", () => {
    const eagle1 = pipelineDef("eagle1")!;
    expect(eagle1.stages.map((s) => s.kind)).toEqual(["planner", "reviewer", "implementer", "reviewer"]);
    expect(eagle1.stages.map((s) => stageKind({ ...s, kind: undefined }))).toEqual(
      eagle1.stages.map((s) => s.kind),
    );
    expect(COPIED.stages.map(stageKind)).toEqual(["planner", "reviewer", "implementer", "reviewer", "generic"]);
    // A reviewer reviews the plan when its round goes back to a planner.
    expect(COPIED.stages.map((s) => stageBehaviour(COPIED, s))).toEqual([
      "planner",
      "plan_reviewer",
      "implementer",
      "pr_reviewer",
      "generic",
    ]);
  });

  it("a copied role behaves like its original on its pipeline, and does nothing special off it", () => {
    setPipelineDefs([COPIED]);
    expect(roleBehaviour("role_custom_4", "copies")).toBe("pr_reviewer");
    expect(roleBehaviour("role_custom_4")).toBe("generic");
    expect(roleBehaviour("role_pr_reviewer")).toBe("pr_reviewer");
    expect(behaviourRole("copies", "implementer")).toBe("role_custom_3");
    expect(behaviourRole("full", "implementer")).toBe("role_implementer");
    expect(isReviewerRole("role_custom_2", "copies")).toBe(true);
    expect(isPlanSource("role_custom_2", "copies")).toBe(true);
    expect(isPlanSource("role_custom_3", "copies")).toBe(false);
  });

  it("a copied role owes its original's HANDOFF sections and gets its original's asks", () => {
    setPipelineDefs([COPIED]);
    const bare = "Looks fine.";
    expect(missingHandoffSections("role_custom_4", bare, "copies")).toEqual(
      missingHandoffSections("role_pr_reviewer", bare),
    );
    expect(missingHandoffSections("role_custom_1", bare, "copies")).toEqual(
      missingHandoffSections("role_planner", bare),
    );
    expect(missingHandoffSections("role_custom_5", bare, "copies")).toEqual([]);
    // A copied Plan Reviewer sends the round back asking for a revised plan.
    expect(loopBackMessage("role_custom_2", "1. Fix it.", 1, null, "copies")).toContain("Revise the plan");
    expect(loopBackMessage("role_custom_4", "1. Fix it.", 1, null, "copies")).toContain("push to the same branch");
    // A copied PR Reviewer approving the last review step completes; a copied Plan Reviewer hands on.
    const chain = { chainId: "c", kind: "copies", step: 2, total: 5 };
    expect(
      handoffRoute({ sourceRoleId: "role_custom_2", targets: ["role_custom_3"], verdict: "APPROVED", chain }),
    ).toMatchObject({ primaryTarget: "role_custom_3" });
  });

  it("a copied Planner waiting on its plan dialog has finished its turn", () => {
    setPipelineDefs([COPIED]);
    const waiting = {
      sessionId: "s",
      path: "/x",
      turnDone: false,
      lastReply: "",
      plan: "# Plan",
      planAt: null,
      lastPromptAt: "t",
      toolCalls: [],
      openTool: { id: "t1", name: "ExitPlanMode", title: "Plan" },
    };
    expect(finishedTurn("role_custom_1", waiting, "copies")?.awaitingPlan).toBe(true);
    expect(finishedTurn("role_custom_1", waiting)).toBeNull();
  });

  it("an unknown run kind has no stages instead of reading as Eagle-Eye 1", () => {
    expect(pipelineStages("mystery")).toEqual([]);
    expect(pipelineStages("full")).toHaveLength(4);
  });
});
