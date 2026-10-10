import { describe, expect, it } from "vitest";
import {
  advanceChain,
  chainLabel,
  chainTabFor,
  loopBackChain,
  loopBackStep,
  newChain,
  nextChainRole,
  type ChainRef,
} from "./chains";

function eagle1(step: number): ChainRef {
  return { chainId: "ee_1", kind: "eagle1", step, total: 4 };
}

describe("Eagle-Eye chains", () => {
  it("labels a step and names the next role on that edge", () => {
    const chain = eagle1(2);
    expect(chainLabel(chain)).toBe("Eagle-Eye 1 · step 2 of 4");
    expect(nextChainRole(chain, "role_plan_reviewer")).toBe("role_implementer");
    expect(nextChainRole(chain, "role_planner")).toBeNull();
  });

  it("advances only along the next edge", () => {
    const chain = eagle1(1);
    expect(advanceChain(chain, "role_planner", "role_plan_reviewer")).toEqual({
      ...chain,
      step: 2,
    });
    expect(advanceChain(chain, "role_planner", "role_implementer")).toBeNull();
    expect(advanceChain(eagle1(4), "role_pr_reviewer", "role_implementer")).toBeNull();
  });

  it("starts Eagle-Eye 2 at the Implementer", () => {
    const chain = newChain("eagle2", 10);
    expect(chain).toEqual({ chainId: "ee_10", kind: "eagle2", step: 1, total: 2 });
    expect(chainLabel(chain)).toBe("Eagle-Eye 2 · step 1 of 2");
    expect(advanceChain(chain, "role_implementer", "role_pr_reviewer")?.step).toBe(2);
  });

  it("labels the round after a loop-back", () => {
    expect(chainLabel({ ...eagle1(1), round: 1 })).toBe("Eagle-Eye 1 · step 1 of 4");
    expect(chainLabel({ ...eagle1(1), round: 2 })).toBe("Eagle-Eye 1 · step 1 of 4 · round 2");
    // Forward hand-offs keep the round.
    expect(advanceChain({ ...eagle1(1), round: 2 }, "role_planner", "role_plan_reviewer")).toEqual({
      ...eagle1(2),
      round: 2,
    });
  });

  it("loops back only from the chain's reviewer to its earlier stage", () => {
    expect(loopBackStep(eagle1(2), "role_plan_reviewer", "role_planner")).toBe(1);
    expect(loopBackStep(eagle1(4), "role_pr_reviewer", "role_implementer")).toBe(3);
    expect(loopBackStep(eagle1(2), "role_plan_reviewer", "role_implementer")).toBeNull();
    // The tab is not on the reviewer's step.
    expect(loopBackStep(eagle1(3), "role_pr_reviewer", "role_implementer")).toBeNull();
    const ee2: ChainRef = { chainId: "ee_2", kind: "eagle2", step: 2, total: 2 };
    expect(loopBackChain(ee2, "role_pr_reviewer", "role_implementer")).toEqual({
      ...ee2,
      step: 1,
      round: 2,
    });
    expect(loopBackChain({ ...eagle1(2), round: 2 }, "role_plan_reviewer", "role_planner")).toEqual(
      { ...eagle1(1), round: 3 },
    );
  });

  it("finds the chain's tab for a step, preferring a live one", () => {
    const tabs = [
      { id: "a", chain: eagle1(1) },
      { id: "b", chain: eagle1(2) },
      { id: "c", chain: eagle1(1) },
      { id: "d", chain: { ...eagle1(1), chainId: "other" } },
      { id: "e", chain: null },
    ];
    expect(chainTabFor(tabs, eagle1(2), 1)?.id).toBe("c");
    expect(chainTabFor(tabs, eagle1(2), 1, (tab) => tab.id === "a")?.id).toBe("a");
    expect(chainTabFor(tabs, eagle1(2), 1, () => false)?.id).toBe("c");
    expect(chainTabFor(tabs, eagle1(2), 3)).toBeNull();
  });
});
