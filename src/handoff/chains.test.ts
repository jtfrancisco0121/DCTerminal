import { describe, expect, it } from "vitest";
import { advanceChain, chainLabel, newChain, nextChainRole, type ChainRef } from "./chains";

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
});
