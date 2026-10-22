import { describe, expect, it } from "vitest";
import { eagleStartChain } from "./eagleStart";
import {
  LONG_TEXT_CHARS,
  SIZE_PIPELINE,
  firstRoleOfSize,
  parseRunSize,
  roleForSize,
  sizeMeta,
  sizeOfPipeline,
  sizeText,
  startRunSize,
  startSizeView,
  suggestSize,
} from "./sizes";

describe("run sizes (F3)", () => {
  it("maps each size to one built-in pipeline and back", () => {
    expect(SIZE_PIPELINE).toEqual({ S: "eagle2", M: "eagle1", L: "eagle-eye-l" });
    expect(sizeOfPipeline("eagle2")).toBe("S");
    expect(sizeOfPipeline("execute")).toBe("S");
    expect(sizeOfPipeline("eagle1")).toBe("M");
    expect(sizeOfPipeline("full")).toBe("M");
    expect(sizeOfPipeline("eagle-eye-l")).toBe("L");
    expect(sizeOfPipeline("bugfix")).toBeNull();
    expect(sizeOfPipeline(null)).toBeNull();
    expect([firstRoleOfSize("S"), firstRoleOfSize("M"), firstRoleOfSize("L")]).toEqual([
      "role_implementer",
      "role_planner",
      "role_analyst",
    ]);
    expect(parseRunSize("L")).toBe("L");
    expect(parseRunSize("XL")).toBeNull();
    expect(sizeMeta({ size: "L" })).toBe("Size L: Brief, PRD and architecture first, then M");
    expect(sizeMeta({})).toBeNull();
  });

  it("suggests L for new-feature words or a long request", () => {
    expect(suggestSize({ text: "Add a new tab for billing", tickets: 0 })).toEqual({ size: "L", why: 'it mentions "new tab"' });
    expect(suggestSize({ text: "New feature: offline sync", tickets: 1 }).size).toBe("L");
    expect(suggestSize({ text: "Redesign the settings page", tickets: 0 }).size).toBe("L");
    expect(suggestSize({ text: "x ".repeat(LONG_TEXT_CHARS), tickets: 0 })).toEqual({ size: "L", why: "the request is long" });
    // A word inside another word does not count.
    expect(suggestSize({ text: "Update the epicurean recipes list", tickets: 0 }).size).toBe("M");
  });

  it("suggests M when several tickets need a plan, and by default", () => {
    expect(suggestSize({ text: "Fix the QA round", tickets: 5 })).toEqual({ size: "M", why: "5 tickets need a plan that splits them" });
    expect(suggestSize({ text: "Move the sync settings into the account page", tickets: 0 })).toEqual({
      size: "M",
      why: "a change that needs a plan",
    });
    expect(suggestSize({ text: "", tickets: 0 })).toEqual({ size: "M", why: "the default" });
  });

  it("suggests S for a short fix, with one or two tickets at most", () => {
    expect(suggestSize({ text: "Fix the crash when the folder is gone", tickets: 0 })).toEqual({ size: "S", why: 'it mentions "fix"' });
    expect(suggestSize({ text: "Typo in the login button", tickets: 1 })).toEqual({ size: "S", why: 'one ticket and it mentions "typo"' });
    expect(suggestSize({ text: "Bugs in the sidebar", tickets: 2 }).why).toBe('two tickets and it mentions "bug"');
    expect(suggestSize({ text: "fix " + "detail ".repeat(200), tickets: 0 }).size, "a long fix needs a plan").toBe("M");
  });

  it("reads the start form's task fields", () => {
    expect(sizeText({ title: "Fix login", request: "It crashes", cwd: "/repo", additionalContext: "new feature" })).toBe("Fix login\nIt crashes");
  });
});

describe("the start flow's size picker (F3 wiring)", () => {
  it("shows the size of the chain the role begins, only with Eagle-Eye ticked", () => {
    const values = { title: "Add a new tab for reports", request: "Reports" };
    expect(startSizeView(eagleStartChain("role_planner"), false, values, 0)).toBeNull();
    expect(startSizeView(null, true, values, 0)).toBeNull();
    const view = startSizeView(eagleStartChain("role_planner"), true, values, 0);
    expect(view).toEqual({ chain: "eagle1", value: "M", suggestion: { size: "L", why: 'it mentions "new tab"' } });
    expect(startSizeView(eagleStartChain("role_implementer"), true, { description: "Fix it" }, 1)?.value).toBe("S");
    expect(startSizeView(eagleStartChain("role_analyst"), true, values, 0)?.value).toBe("L");
  });

  it("switches the form to the first role of the size you pick, and the start records that size", () => {
    expect(roleForSize("L", "role_planner")).toBe("role_analyst");
    expect(roleForSize("S", "role_planner")).toBe("role_implementer");
    expect(roleForSize("M", "role_planner")).toBeNull();
    // Picking L then starting begins Eagle-Eye L, and its run keeps L.
    const role = roleForSize("L", "role_planner")!;
    const chain = eagleStartChain(role);
    expect(chain).toBe("eagle-eye-l");
    expect(startRunSize(chain)).toBe("L");
    expect(startRunSize(eagleStartChain("role_implementer"))).toBe("S");
    expect(startRunSize(null)).toBeNull();
  });
});
