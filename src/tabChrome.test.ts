import { describe, expect, it } from "vitest";
import {
  buildPalette,
  closeSplit,
  filterCommands,
  openSplit,
  pushClosed,
  reopenLast,
  tabAtIndex,
  CLOSED_TAB_LIMIT,
} from "./tabChrome";

describe("tab chrome", () => {
  it("reopens the most recently closed tab", () => {
    const first = pushClosed([], {
      id: "a",
      label: "A",
      roleId: "role_general",
      cwd: "C:\\a",
      color: "#58a6ff",
      answers: {},
      closedAt: 1,
    });
    const stack = pushClosed(first, {
      id: "b",
      label: "B",
      roleId: "role_developer",
      cwd: "C:\\b",
      color: "#3fb950",
      answers: { title: "B" },
      closedAt: 2,
    });
    const reopened = reopenLast(stack);
    expect(reopened.tab?.id).toBe("b");
    expect(reopened.stack.map((t) => t.id)).toEqual(["a"]);
  });

  it("caps the closed-tab stack", () => {
    let stack: ReturnType<typeof pushClosed> = [];
    for (let i = 0; i < CLOSED_TAB_LIMIT + 3; i += 1) {
      stack = pushClosed(stack, {
        id: `t${i}`,
        label: `T${i}`,
        roleId: "role_general",
        cwd: "C:\\w",
        color: "#8b949e",
        answers: {},
        closedAt: i,
      });
    }
    expect(stack).toHaveLength(CLOSED_TAB_LIMIT);
    expect(stack[0].id).toBe(`t${CLOSED_TAB_LIMIT + 2}`);
  });

  it("opens a side-by-side view of two tabs and can close it", () => {
    const split = openSplit({ mode: "single", secondaryTabId: null }, "horizontal", "tab_b");
    expect(split).toEqual({ mode: "horizontal", secondaryTabId: "tab_b" });
    expect(closeSplit().mode).toBe("single");
  });

  it("goes to a tab by 1-based position", () => {
    const tabs = ["a", "b", "c"];
    expect(tabAtIndex(tabs, 0)).toBe("a");
    expect(tabAtIndex(tabs, 8)).toBeNull();
  });

  it("filters the command palette", () => {
    const commands = buildPalette({
      tabs: [{ id: "tab_1", label: "Implementer · Login" }],
      canReopen: true,
      splitOpen: false,
    });
    expect(filterCommands(commands, "scratch").map((c) => c.id)).toContain("focusPad");
    expect(filterCommands(commands, "login").some((c) => c.id === "goto:tab_1")).toBe(
      true,
    );
    expect(commands.some((c) => c.id === "closeSplit")).toBe(false);
  });
});
