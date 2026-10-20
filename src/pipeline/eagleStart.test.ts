import { describe, expect, it } from "vitest";
import { pipelineDef, type PipelineDef } from "./defs";
import { eagleStartChain } from "./eagleStart";

describe("eagleStartChain", () => {
  it("the built-in Planner begins Eagle-Eye 1 and the Implementer Eagle-Eye 2; other roles none", () => {
    expect(eagleStartChain("role_planner")).toBe("eagle1");
    expect(eagleStartChain("role_implementer")).toBe("eagle2");
    expect(eagleStartChain("role_pr_reviewer")).toBeNull();
    expect(eagleStartChain("role_general")).toBeNull();
  });

  it("goes by the first stage's role and kind, so a copied Planner or Implementer begins the chain", () => {
    const eagle1 = pipelineDef("eagle1")!;
    const eagle2 = pipelineDef("eagle2")!;
    const copied1: PipelineDef = {
      ...eagle1,
      stages: [{ ...eagle1.stages[0], roleId: "role_custom_1", kind: "planner" }, ...eagle1.stages.slice(1)],
    };
    const copied2: PipelineDef = {
      ...eagle2,
      stages: [{ ...eagle2.stages[0], roleId: "role_custom_3", kind: "implementer" }, ...eagle2.stages.slice(1)],
    };
    expect(eagleStartChain("role_custom_1", [copied1, copied2])).toBe("eagle1");
    expect(eagleStartChain("role_custom_3", [copied1, copied2])).toBe("eagle2");
    // The built-in roles are no longer those chains' first stages.
    expect(eagleStartChain("role_planner", [copied1, copied2])).toBeNull();
    // A first stage marked generic begins no bridged chain.
    const generic: PipelineDef = { ...eagle1, stages: [{ ...eagle1.stages[0], kind: "generic" }, ...eagle1.stages.slice(1)] };
    expect(eagleStartChain("role_planner", [generic, eagle2])).toBeNull();
  });
});
