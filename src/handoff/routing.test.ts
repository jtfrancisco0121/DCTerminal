import { describe, expect, it } from "vitest";
import type { ChainRef } from "./chains";
import { handoffRoute, loopBackFindings, loopBackMessage } from "./routing";
import { handoffTargets } from "./transitions";
import type { ReviewVerdict } from "./verdict";

const chain = (step: number): ChainRef => ({ chainId: "ee_1", kind: "eagle1", step, total: 4 });

function route(sourceRoleId: string, verdict: ReviewVerdict | null, step?: number) {
  return handoffRoute({
    sourceRoleId,
    targets: handoffTargets(sourceRoleId),
    verdict,
    chain: step ? chain(step) : null,
  });
}

describe("handoffRoute", () => {
  it("Plan Reviewer approved: Next is the Implementer", () => {
    for (const verdict of ["APPROVED", "APPROVED WITH CHANGES"] as const) {
      expect(route("role_plan_reviewer", verdict, 2)).toEqual({
        primaryTarget: "role_implementer",
        primaryLabel: "Next: Send to Implementer",
        complete: false,
      });
    }
  });

  it("Plan Reviewer wants revision: primary goes back to the Planner", () => {
    for (const verdict of ["REQUIRES REVISION", "REJECTED", "REQUEST CHANGES"] as const) {
      expect(route("role_plan_reviewer", verdict, 2)).toEqual({
        primaryTarget: "role_planner",
        primaryLabel: "Send back to Planner",
        complete: false,
      });
    }
  });

  it("PR Reviewer: changes go back to the Implementer, approval completes", () => {
    expect(route("role_pr_reviewer", "REQUEST CHANGES", 4)).toMatchObject({
      primaryTarget: "role_implementer",
      primaryLabel: "Send back to Implementer",
    });
    expect(route("role_pr_reviewer", "APPROVED", 4)).toEqual({
      primaryTarget: null,
      primaryLabel: null,
      complete: true,
    });
    // Approved with changes is left to the user.
    expect(route("role_pr_reviewer", "APPROVED WITH CHANGES", 4).primaryTarget).toBeNull();
  });

  it("no verdict keeps today's chain Next", () => {
    expect(route("role_plan_reviewer", null, 2).primaryLabel).toBe("Next: Send to Implementer");
    expect(route("role_plan_reviewer", null)).toEqual({
      primaryTarget: null,
      primaryLabel: null,
      complete: false,
    });
    expect(route("role_planner", null, 1).primaryTarget).toBe("role_plan_reviewer");
    expect(route("role_pr_reviewer", null, 4).primaryTarget).toBeNull();
  });

  it("outside a chain the verdict still picks the primary", () => {
    expect(route("role_plan_reviewer", "APPROVED").primaryTarget).toBe("role_implementer");
    expect(route("role_plan_reviewer", "REQUIRES REVISION").primaryLabel).toBe(
      "Send back to Planner",
    );
    expect(route("role_pr_reviewer", "REQUEST CHANGES").primaryTarget).toBe("role_implementer");
    expect(route("role_pr_reviewer", "APPROVED").complete).toBe(true);
  });

  it("never offers a target the role cannot reach", () => {
    expect(
      handoffRoute({
        sourceRoleId: "role_plan_reviewer",
        targets: ["role_implementer"],
        verdict: "REQUIRES REVISION",
      }).primaryTarget,
    ).toBeNull();
  });

  it("uses loaded role names", () => {
    expect(
      handoffRoute({
        sourceRoleId: "role_plan_reviewer",
        targets: handoffTargets("role_plan_reviewer"),
        verdict: "REJECTED",
        roles: [{ id: "role_planner", name: "Architect" }],
      }).primaryLabel,
    ).toBe("Send back to Architect");
  });
});

describe("loopBackMessage", () => {
  it("frames the findings for the earlier stage", () => {
    expect(loopBackMessage("role_pr_reviewer", "  - bug\n", 1)).toBe(
      "Review findings from the PR Reviewer (round 1):\n\n- bug\n\nAddress these findings, then push to the same branch so the existing pull request updates (do not open a new one). End your reply with the HANDOFF sections: Implementation summary, Files changed, Tests run, Deviations from the plan, and Pull request (the same URL).",
    );
    expect(loopBackMessage("role_plan_reviewer", "x", 2)).toMatch(
      /^Review findings from the Plan Reviewer \(round 2\)[\s\S]*revised plan, ending with the `## HANDOFF: Plan`/,
    );
  });

  it("reads the findings back out of a send-back, old or new wording", () => {
    const sent = loopBackMessage("role_pr_reviewer", "1. src/a.ts:3 — add a guard", 1);
    expect(loopBackFindings(sent)).toEqual({ from: "PR Reviewer", round: 1, findings: "1. src/a.ts:3 — add a guard" });
    const old = "Review findings from the PR Reviewer (round 2):\n\n- bug\n\nAddress these findings, then summarize what changed.";
    expect(loopBackFindings(old)?.findings).toBe("- bug");
    expect(loopBackFindings("## Reviewed plan\n1. x")).toBeNull();
  });
});
