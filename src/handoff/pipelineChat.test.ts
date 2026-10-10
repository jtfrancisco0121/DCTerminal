/** Chat-tab pipeline edge cases: reviewer reply shapes, plan sources, stale plans. */
import { describe, expect, it } from "vitest";
import {
  composePlanText,
  defaultScope,
  latestReplyText,
  mapHandoff,
  scopeChoices,
  splitPlanReview,
  stripPlanPreamble,
  type HandoffSource,
} from "./map";

const PLAN = "1. Patch the handler\n2. Add a regression test";
const NOTES = "- Missing test for refresh tokens";

function source(overrides: Partial<HandoffSource> = {}): HandoffSource {
  return {
    sourceRoleId: "role_planner",
    sourceTabId: "tab-1",
    sourceLabel: "Planner",
    cwd: "/repo",
    answers: { request: "Expired tokens return 500." },
    latestMessage: "",
    plan: [],
    todos: [],
    selection: "",
    turnInFlight: false,
    ...overrides,
  };
}

describe("splitPlanReview heading variants", () => {
  const cases: [string, string, string][] = [
    ["exact", "## Reviewed plan", "## Review notes"],
    ["bold in heading", "## **Reviewed Plan**", "## **Review Notes**"],
    ["colon and case", "### REVIEWED PLAN:", "### Review notes:"],
    ["revised plan", "## Revised plan", "## Reviewer notes"],
    ["numbered", "## 10. Reviewed implementation plan", "## 11. Review notes"],
    ["bold line, no #", "**Reviewed plan**", "**Review notes**"],
    ["bold label with colon", "**Revised plan:**", "**Notes for the Implementer:**"],
    ["rendered markdown selection", "Reviewed plan", "Review notes"],
  ];
  for (const [name, planHeading, notesHeading] of cases) {
    it(name, () => {
      const reply = [
        "### Verdict",
        "**APPROVED WITH CHANGES**",
        "",
        "### 9. Final Recommendation",
        "Update the plan, then proceed",
        "",
        planHeading,
        PLAN,
        "",
        notesHeading,
        NOTES,
      ].join("\n");
      expect(splitPlanReview(reply)).toEqual({ plan: PLAN, notes: NOTES });
    });
  }

  it("keeps the plan's own ## headings inside the reviewed plan", () => {
    const plan = [
      "## 1. Task Understanding",
      "Return 401 for expired tokens.",
      "",
      "## 10. Implementation Plan",
      "### Step 1",
      "Patch the handler",
    ].join("\n");
    const reply = `## Verdict\nAPPROVED\n\n## Reviewed plan\n${plan}\n\n## Review notes\n${NOTES}`;
    expect(splitPlanReview(reply)).toEqual({ plan, notes: NOTES });
  });

  it("reads the last Reviewed plan heading, not one quoted earlier", () => {
    const reply = [
      "The template asks for:",
      "## Reviewed plan",
      "(placeholder)",
      "## Verdict",
      "APPROVED",
      "## Reviewed plan",
      PLAN,
    ].join("\n");
    expect(splitPlanReview(reply).plan).toBe(PLAN);
  });

  it("notes before the plan stop at the plan heading", () => {
    const reply = `## Review notes\n${NOTES}\n\n## Reviewed plan\n${PLAN}`;
    expect(splitPlanReview(reply)).toEqual({ plan: PLAN, notes: NOTES });
  });

  it("without a Reviewed plan section, the whole reply is the plan", () => {
    expect(splitPlanReview("Looks good, ship it.")).toEqual({ plan: "Looks good, ship it.", notes: "" });
  });

  it("maps a bold-heading review onto the Implementer fields", () => {
    const reply = `**Verdict:** APPROVED\n\n**Reviewed plan**\n${PLAN}\n\n**Review notes**\n${NOTES}`;
    const mapped = mapHandoff(
      source({ sourceRoleId: "role_plan_reviewer", latestMessage: reply, answers: {} }),
      "message",
      { roleId: "role_implementer", fields: [{ key: "approvedPlan" }, { key: "additionalContext" }] },
    );
    expect(mapped.answers.approvedPlan).toBe(PLAN);
    expect(mapped.answers.additionalContext).toBe(`Review notes:\n${NOTES}`);
  });
});

describe("latestReplyText", () => {
  it("joins a reply split by tool calls, from its first headed part", () => {
    const segments = [
      { kind: "user", text: "Review this plan" },
      { kind: "agent", text: "Let me check the handler." },
      { kind: "tool", text: "Read src/auth.ts" },
      { kind: "agent", text: "## Verdict\nAPPROVED WITH CHANGES" },
      { kind: "tool", text: "Grep refresh" },
      { kind: "agent", text: `## Reviewed plan\n${PLAN}` },
    ];
    expect(latestReplyText(segments)).toBe(`## Verdict\nAPPROVED WITH CHANGES\n\n## Reviewed plan\n${PLAN}`);
  });

  it("is the last message when no part opens with a heading", () => {
    const segments = [
      { kind: "agent", text: "## Old reply" },
      { kind: "user", text: "and?" },
      { kind: "agent", text: "Checking." },
      { kind: "tool", text: "Read a.ts" },
      { kind: "agent", text: "All good." },
    ];
    expect(latestReplyText(segments)).toBe("All good.");
  });

  it("falls back to the last agent message when this turn has none yet", () => {
    const segments = [
      { kind: "agent", text: "## Plan\n1. Step" },
      { kind: "user", text: "go on" },
    ];
    expect(latestReplyText(segments)).toBe("## Plan\n1. Step");
  });
});

describe("Planner plan sources", () => {
  it("drops a short lead-in before the plan heading", () => {
    const plan = "# Plan: Effort picker\n\n1. Add the picker\n2. Send set_config_option";
    expect(stripPlanPreamble(`Nothing has been approved yet. Here is the revised plan:\n\n${plan}`)).toBe(plan);
    // A long lead-in may carry real content: kept.
    const long = `${"Context that matters. ".repeat(20)}\n\n${plan}`;
    expect(stripPlanPreamble(long)).toBe(long);
    expect(stripPlanPreamble(plan)).toBe(plan);
  });

  it("the default scope sends the Planner's plan without the lead-in", () => {
    const plan = "## Plan\n\n1. Add the picker\n2. Send set_config_option\n3. Hide it without options";
    const src = source({ latestMessage: `Nothing has been approved yet.\n\n${plan}` });
    expect(composePlanText(src, defaultScope(src)).text).toBe(plan);
    // The whole message is still one click away.
    expect(composePlanText(src, "message").text).toContain("Nothing has been approved yet.");
  });

  it("a reply after the user answered the plan wins over that older plan", () => {
    const fresh = source({ planMarkdown: "# Plan v1", latestMessage: "Nothing has been approved yet." });
    expect(defaultScope(fresh)).toBe("plan_mode");
    const stale = { ...fresh, planMarkdownStale: true, latestMessage: "# Plan v2\n1. Revised" };
    expect(defaultScope(stale)).toBe("plan_and_todos");
    expect(composePlanText(stale, defaultScope(stale)).text).toBe("# Plan v2\n1. Revised");
    expect(scopeChoices(stale).find((c) => c.id === "plan_mode")?.label).toBe(
      "Claude's earlier plan (Ready to code?)",
    );
    // With no newer reply, the older plan is still the best source.
    expect(defaultScope({ ...stale, latestMessage: "" })).toBe("plan_mode");
  });
});
