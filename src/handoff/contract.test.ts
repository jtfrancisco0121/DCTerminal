import { describe, expect, it } from "vitest";
import {
  contractFindings,
  contractImplementation,
  contractPlan,
  contractReview,
  handoffSections,
  hasHandoffContract,
} from "./contract";
import { composePlanText, implementationContext, mapHandoff, splitPlanReview, type HandoffSource } from "./map";
import { parseReviewVerdict, parseTerminalVerdict } from "./verdict";

const PLANNER_REPLY = [
  "## 1. Task Understanding",
  "Users want an effort picker.",
  "## 10. Implementation Plan",
  "### Step 1",
  "Draft step that is superseded below.",
  "## 15. Hand-off",
  "## HANDOFF: Plan",
  "Add an effort picker next to the model picker.",
  "",
  "1. EffortPicker.tsx — new component.",
  "2. bridge.ts — send set_config_option.",
  "",
  "## HANDOFF: Open questions",
  "None.",
].join("\n");

const REVIEW_REPLY = [
  "### Verdict",
  "**REQUIRES REVISION** was my first read, but the fixes are small.",
  "### 9. Final Recommendation",
  "- **Update the plan, then proceed**",
  "## HANDOFF: Verdict",
  "APPROVED WITH CHANGES",
  "## HANDOFF: Reviewed plan",
  "## Plan",
  "1. Add EffortPicker.",
  "## Tests",
  "- picker hides with no options",
  "## HANDOFF: Review notes",
  "- Step 3 was missing.",
].join("\n");

function source(overrides: Partial<HandoffSource>): HandoffSource {
  return {
    sourceRoleId: "role_planner",
    sourceTabId: "tab-1",
    sourceLabel: "Planner · Effort",
    cwd: "/repo",
    answers: { title: "Effort", taskType: "Feature", request: "Let users pick effort" },
    latestMessage: "",
    plan: [],
    todos: [],
    selection: "",
    turnInFlight: false,
    ...overrides,
  };
}

describe("hand-off contract", () => {
  it("reads sections by name, last one wins, and stops at the next hand-off heading", () => {
    const text = "## HANDOFF: Plan\nv1\n## HANDOFF: Plan\nv2\n## HANDOFF: Open questions\nNone.";
    const sections = handoffSections(text);
    expect(sections.get("plan")).toBe("v2");
    expect(sections.get("open questions")).toBe("None.");
    expect(hasHandoffContract(text)).toBe(true);
    expect(hasHandoffContract("## Plan\n1. x")).toBe(false);
  });

  it("accepts bold and plain headings from rendered or copied text", () => {
    expect(contractPlan("**HANDOFF: Plan**\n1. Do it\n\nHANDOFF: Open questions\nWhich API?")).toBe(
      "1. Do it\n\nOpen questions:\nWhich API?",
    );
  });

  it("a Planner's contract plan is what the next role receives", () => {
    expect(contractPlan(PLANNER_REPLY)).toBe(
      "Add an effort picker next to the model picker.\n\n1. EffortPicker.tsx — new component.\n2. bridge.ts — send set_config_option.",
    );
    const composed = composePlanText(source({ latestMessage: PLANNER_REPLY }), "message");
    expect(composed.text).not.toContain("Task Understanding");
    expect(composed.text).toContain("EffortPicker.tsx");
    const mapped = mapHandoff(source({ latestMessage: PLANNER_REPLY }), "message", {
      roleId: "role_plan_reviewer",
      fields: [{ key: "originalTask" }, { key: "plan" }, { key: "additionalContext" }],
    });
    expect(mapped.answers.plan).toBe(contractPlan(PLANNER_REPLY));
  });

  it("a Plan Reviewer's contract wins over its earlier headings and verdict prose", () => {
    expect(contractReview(REVIEW_REPLY)).toEqual({
      plan: "## Plan\n1. Add EffortPicker.\n## Tests\n- picker hides with no options",
      notes: "- Step 3 was missing.",
    });
    expect(splitPlanReview(REVIEW_REPLY).plan).toContain("## Tests");
    expect(parseReviewVerdict(REVIEW_REPLY)).toBe("APPROVED WITH CHANGES");
  });

  it("the newest round's contract verdict wins in a terminal's scrollback", () => {
    const scrollback = "## HANDOFF: Verdict\nREQUIRES REVISION\n...\n## HANDOFF: Verdict\nAPPROVED\n";
    expect(parseTerminalVerdict(scrollback)).toBe("APPROVED");
  });

  it("a PR Reviewer's findings are what goes back to the Implementer", () => {
    const review = [
      "## 2. Findings",
      "### 🟡 MEDIUM style nit",
      "## HANDOFF: Verdict",
      "REQUEST CHANGES",
      "## HANDOFF: Findings for the Implementer",
      "1. src/a.ts:10 — null check missing; add a guard.",
    ].join("\n");
    expect(parseReviewVerdict(review)).toBe("REQUEST CHANGES");
    expect(contractFindings(review)).toBe("1. src/a.ts:10 — null check missing; add a guard.");
    const composed = composePlanText(
      source({ sourceRoleId: "role_pr_reviewer", latestMessage: review }),
      "message",
    );
    expect(composed.text).toBe("1. src/a.ts:10 — null check missing; add a guard.");
    expect(contractFindings("## HANDOFF: Findings for the Implementer\nNone.")).toBe("");
  });

  it("an Implementer's contract becomes labelled PR Reviewer context", () => {
    const reply = [
      "Lots of narration.",
      "## HANDOFF: Implementation summary",
      "Added the picker. IMPLEMENTED",
      "## HANDOFF: Files changed",
      "src/EffortPicker.tsx — new",
      "## HANDOFF: Tests run",
      "npm test — pass",
      "## HANDOFF: Deviations from the plan",
      "None.",
      "## HANDOFF: Pull request",
      "https://github.com/acme/demo/pull/7",
    ].join("\n");
    expect(contractImplementation(reply)?.deviations).toBe("");
    const context = implementationContext(
      source({ sourceRoleId: "role_implementer", latestMessage: reply }),
    );
    expect(context).toContain("Implementation summary:\nAdded the picker. IMPLEMENTED");
    expect(context).toContain("Files changed (Implementer's notes):\nsrc/EffortPicker.tsx — new");
    expect(context).toContain("Tests run:\nnpm test — pass");
    expect(context).not.toContain("Deviations");
    expect(context).not.toContain("Lots of narration");
    expect(context).toContain("Pull request: https://github.com/acme/demo/pull/7");
  });

  it("replies without the contract keep the older parsing", () => {
    expect(contractPlan("## Plan\n1. x")).toBeNull();
    expect(splitPlanReview("## Reviewed plan\n1. x\n## Review notes\n- y")).toEqual({ plan: "1. x", notes: "- y" });
  });

  it("a round-2 PR Reviewer is told which earlier findings to check", () => {
    const context = implementationContext(
      source({
        sourceRoleId: "role_implementer",
        latestMessage: "## HANDOFF: Implementation summary\nFixed both. IMPLEMENTED",
        previousReview: { round: 1, findings: "1. src/a.ts:10 — add a guard" },
      }),
    );
    expect(context).toContain(
      "Findings from the previous review (round 1). Check each one is resolved and say which in your review:\n1. src/a.ts:10 — add a guard",
    );
  });

  it("a plan that ships as several pull requests carries its list to the next role", () => {
    const list = [
      "1. PR1 — Rename identity: koneksi-engine, R2 + T4. Depends on: none",
      "2. PR3 — Startup sync: koneksi-engine, R1 + R3. Depends on: PR1",
      "3. Release — Manual step: cut an engine release.",
    ].join("\n");
    const planner = [
      "## HANDOFF: Plan",
      "1. Fix the engine.",
      "## HANDOFF: Pull requests",
      list,
      "## HANDOFF: Open questions",
      "None.",
    ].join("\n");
    expect(contractPlan(planner)).toBe(`1. Fix the engine.\n\nPull requests:\n${list}`);
    const single = planner.replace(list, "One pull request.");
    expect(contractPlan(single)).toBe("1. Fix the engine.");

    const review = [
      "## HANDOFF: Verdict",
      "APPROVED",
      "## HANDOFF: Reviewed plan",
      "1. Fix the engine.",
      "## HANDOFF: Pull requests",
      list,
      "## HANDOFF: Review notes",
      "None.",
    ].join("\n");
    expect(contractReview(review)?.plan).toBe(`1. Fix the engine.\n\nPull requests:\n${list}`);
    // A reviewed plan that already repeats the list is not given it twice.
    const repeated = review.replace("1. Fix the engine.", `1. Fix the engine.\n\nPull requests:\n${list}`);
    expect(contractReview(repeated)?.plan.match(/Pull requests:/g)).toHaveLength(1);
  });

  it("an Implementer's several pull requests all reach the PR Reviewer", () => {
    const prs = [
      "PR1 — https://github.com/koneksi/engine/pull/11 — branch fix/rename, based on main — koneksi-engine",
      "PR3 — https://github.com/koneksi/engine/pull/12 — branch fix/sync, based on fix/rename — koneksi-engine",
      "PR6 — https://github.com/koneksi/desktop/pull/40 — branch fix/t2, based on main — koneksi-desktop",
      "Manual step — waiting for the user: cut engine release v1.2.6",
    ].join("\n");
    const reply = [
      "## HANDOFF: Implementation summary",
      "Built all units. IMPLEMENTED",
      "## HANDOFF: Pull requests",
      prs,
    ].join("\n");
    expect(contractImplementation(reply)?.pullRequest).toBe(prs);
    const context = implementationContext(source({ sourceRoleId: "role_implementer", latestMessage: reply }));
    expect(context).toContain(`Pull requests:\n${prs}`);
    expect(context).not.toContain("Pull request: ");
  });
});
