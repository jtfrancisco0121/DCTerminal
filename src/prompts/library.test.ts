import { describe, expect, it } from "vitest";
import { defaultPromptName, filterPrompts, insertIntoPad } from "./library";

describe("insertIntoPad", () => {
  it("fills an empty pad", () => {
    expect(insertIntoPad("", "Review the diff")).toEqual({
      content: "Review the diff",
      caret: 15,
    });
  });

  it("appends after a blank line when there is no cursor", () => {
    expect(insertIntoPad("notes", "Plan it")).toEqual({
      content: "notes\n\nPlan it",
      caret: 14,
    });
    expect(insertIntoPad("notes\n", "Plan it").content).toBe("notes\n\nPlan it");
    expect(insertIntoPad("notes\n\n", "Plan it").content).toBe("notes\n\nPlan it");
  });

  it("replaces the selection or inserts at the cursor", () => {
    expect(insertIntoPad("fix THIS now", "the bug", { start: 4, end: 8 })).toEqual({
      content: "fix the bug now",
      caret: 11,
    });
    expect(insertIntoPad("ab", "X", { start: 1, end: 1 })).toEqual({ content: "aXb", caret: 2 });
  });

  it("clamps a stale selection to the current text", () => {
    expect(insertIntoPad("ab", "X", { start: 9, end: 12 })).toEqual({ content: "abX", caret: 3 });
  });
});

describe("defaultPromptName", () => {
  it("uses the first non-blank line, shortened", () => {
    expect(defaultPromptName("\n\n  Review the diff  \nmore")).toBe("Review the diff");
    const long = "x".repeat(80);
    expect(defaultPromptName(long)).toBe(`${"x".repeat(59)}…`);
    expect(defaultPromptName("   ")).toBe("");
  });
});

describe("filterPrompts", () => {
  const items = [
    { name: "Review diff", body: "List risks and tests" },
    { name: "Plan", body: "Write a step-by-step plan" },
  ];
  it("matches every word in the name or body, any case", () => {
    expect(filterPrompts(items, "")).toHaveLength(2);
    expect(filterPrompts(items, "RISKS review").map((p) => p.name)).toEqual(["Review diff"]);
    expect(filterPrompts(items, "step plan").map((p) => p.name)).toEqual(["Plan"]);
    expect(filterPrompts(items, "nope")).toEqual([]);
  });
});
