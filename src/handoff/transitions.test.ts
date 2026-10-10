import { describe, expect, it } from "vitest";
import {
  HANDOFF_TRANSITIONS,
  handoffMenuItems,
  handoffTargets,
  isCaptureSource,
  isHandoffSource,
  isPlanSource,
  isReportSource,
  isValidTransition,
  roleDisplayName,
} from "./transitions";

describe("hand-off transitions", () => {
  it("Planner hands off to Plan Reviewer first, then Implementer and Developer", () => {
    expect(handoffTargets("role_planner")).toEqual([
      "role_plan_reviewer",
      "role_implementer",
      "role_developer",
    ]);
  });

  it("keeps Planner → PR Reviewer out of the default list", () => {
    expect(isValidTransition("role_planner", "role_pr_reviewer")).toBe(false);
  });

  it("Plan Reviewer hands off to Implementer, Developer, or back to Planner", () => {
    expect(handoffTargets("role_plan_reviewer")).toEqual([
      "role_implementer",
      "role_developer",
      "role_planner",
    ]);
    expect(isHandoffSource("role_plan_reviewer")).toBe(true);
  });

  it("Implementer and Developer hand off to PR Reviewer; PR Reviewer back to Implementer", () => {
    expect(handoffTargets("role_implementer")).toEqual(["role_pr_reviewer"]);
    expect(handoffTargets("role_developer")).toEqual(["role_pr_reviewer"]);
    expect(handoffTargets("role_pr_reviewer")).toEqual(["role_implementer"]);
  });

  it("Recommendation and Codebase Audit hand off to Planner first, then Developer", () => {
    expect(handoffTargets("role_recommendation")).toEqual(["role_planner", "role_developer"]);
    expect(handoffTargets("role_codebase_audit")).toEqual(["role_planner", "role_developer"]);
    expect(isReportSource("role_recommendation")).toBe(true);
    expect(isReportSource("role_planner")).toBe(false);
    expect(isCaptureSource("role_codebase_audit")).toBe(true);
    expect(isCaptureSource("role_plan_reviewer")).toBe(true);
    expect(isCaptureSource("role_implementer")).toBe(false);
  });

  it("roles outside the table have no targets", () => {
    expect(handoffTargets("role_general")).toEqual([]);
    expect(handoffTargets("role_custom")).toEqual([]);
    expect(isHandoffSource("role_general")).toBe(false);
    expect(isValidTransition("role_general", "role_implementer")).toBe(false);
  });

  it("plan sources are Planner and Plan Reviewer", () => {
    expect(isPlanSource("role_planner")).toBe(true);
    expect(isPlanSource("role_plan_reviewer")).toBe(true);
    expect(isPlanSource("role_implementer")).toBe(false);
  });

  it("every target is itself a known role id", () => {
    for (const targets of Object.values(HANDOFF_TRANSITIONS)) {
      for (const target of targets) expect(target).toMatch(/^role_/);
    }
  });

  it("reads role names from the loaded roles, with built-in fallbacks", () => {
    const roles = [{ id: "role_plan_reviewer", name: "Plan Critic" }];
    expect(roleDisplayName("role_plan_reviewer", roles)).toBe("Plan Critic");
    expect(roleDisplayName("role_plan_reviewer")).toBe("Plan Reviewer");
    expect(roleDisplayName("role_pr_reviewer", roles)).toBe("PR Reviewer");
    expect(roleDisplayName("role_unknown")).toBe("role");
  });

  it("terminal menu: Planner lists Send to Plan Reviewer; Plan Reviewer lists Send to Implementer", () => {
    expect(handoffMenuItems("role_planner").map((item) => item.label)).toEqual([
      "Send to Plan Reviewer",
      "Send to Implementer",
      "Send to Developer",
    ]);
    expect(handoffMenuItems("role_plan_reviewer")[0]).toEqual({
      target: "role_implementer",
      label: "Send to Implementer",
    });
    expect(handoffMenuItems("role_general")).toEqual([]);
  });
});
