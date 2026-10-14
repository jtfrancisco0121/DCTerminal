import { describe, expect, it } from "vitest";
import { filterPrompts } from "./library";
import {
  REPLY_TEMPLATES,
  REPLY_TEMPLATE_ROLES,
  replyTemplateRoleOrder,
  whenParts,
} from "./replyTemplates";

describe("REPLY_TEMPLATES", () => {
  it("has 46 templates with unique ids, covering every pipeline role and any role", () => {
    expect(REPLY_TEMPLATES).toHaveLength(46);
    const ids = REPLY_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const counts = Object.fromEntries(
      REPLY_TEMPLATE_ROLES.map((role) => [role, REPLY_TEMPLATES.filter((t) => t.roleId === role).length]),
    );
    expect(counts).toEqual({
      any: 7,
      role_planner: 11,
      role_plan_reviewer: 8,
      role_implementer: 11,
      role_pr_reviewer: 9,
    });
  });

  it("keeps HTML out of titles, bodies and when lines", () => {
    const tag = /<\/?(code|pre|p|span|div|br|em|strong|b|i|a)\b[^>]*>/i;
    const entity = /&(lt|gt|amp|quot|#\d+);/;
    for (const t of REPLY_TEMPLATES) {
      for (const text of [t.title, t.when, t.body]) {
        expect(text).not.toMatch(tag);
        expect(text).not.toMatch(entity);
        expect(text.trim()).toBe(text);
        expect(text).not.toBe("");
      }
    }
  });

  it("keeps the guide wording, placeholders included", () => {
    const missing = REPLY_TEMPLATES.find((t) => t.id === "any.missing-handoff-sections");
    expect(missing?.body).toBe(
      "Your reply is missing the HANDOFF sections. Repeat your result, complete and self-contained, ending with the HANDOFF sections your instructions list, using those headings exactly. Put nothing after them.",
    );
    expect(missing?.when).toBe(
      "The reply ends without its `HANDOFF:` headings, or Send fills almost nothing.",
    );
    const answers = REPLY_TEMPLATES.find((t) => t.id === "planner.answering-open-questions");
    expect(answers?.body.startsWith("Answers to your open questions:\n1. …\n2. …")).toBe(true);
    expect(REPLY_TEMPLATES.some((t) => t.body.includes("<repo or folder>"))).toBe(true);
  });

  it("is searchable by title, when and body", () => {
    const named = REPLY_TEMPLATES.map((t) => ({ ...t, name: t.title }));
    expect(filterPrompts(named, "stacked wrong base").map((t) => t.id)).toEqual([
      "pr-reviewer.a-stacked-pr-was-reviewed-against-the-wrong-base",
    ]);
    expect(filterPrompts(named, "this branch has conflicts").map((t) => t.id)).toEqual([
      "implementer.a-branch-conflicts-with-main",
    ]);
    expect(filterPrompts(named, "gh auth login").map((t) => t.id)).toEqual([
      "implementer.github-access-is-fixed",
    ]);
  });
});

describe("replyTemplateRoleOrder", () => {
  it("puts the tab's role first, then any role, then the pipeline order", () => {
    expect(replyTemplateRoleOrder("role_implementer")).toEqual([
      "role_implementer",
      "any",
      "role_planner",
      "role_plan_reviewer",
      "role_pr_reviewer",
    ]);
  });

  it("uses the pipeline order without a role or for a role with no templates", () => {
    const pipeline = [
      "role_planner",
      "role_plan_reviewer",
      "role_implementer",
      "role_pr_reviewer",
      "any",
    ];
    expect(replyTemplateRoleOrder(null)).toEqual(pipeline);
    expect(replyTemplateRoleOrder("role_developer")).toEqual(pipeline);
    expect(replyTemplateRoleOrder("any")).toEqual(pipeline);
  });
});

describe("whenParts", () => {
  it("splits backtick spans into code parts", () => {
    expect(whenParts("`HANDOFF: Open questions` isn't `None.`")).toEqual([
      { text: "HANDOFF: Open questions", code: true },
      { text: " isn't ", code: false },
      { text: "None.", code: true },
    ]);
  });
});
