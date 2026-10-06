import { describe, expect, it } from "vitest";
import {
  buildPalette,
  clampSplitSize,
  closeSplit,
  emptySplit,
  filterCommands,
  openSplit,
  pushClosed,
  reconcileSplit,
  reopenLast,
  splitCandidates,
  splitFromLayout,
  splitOpen,
  swapSplit,
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
    expect(split).toEqual({ mode: "horizontal", secondaryTabId: "tab_b", primarySize: 50 });
    expect(closeSplit().mode).toBe("single");
    expect(closeSplit({ ...split, primarySize: 30 }).primarySize).toBe(30);
  });

  it("swaps panes so the second tab becomes active", () => {
    const split = openSplit(emptySplit(), "vertical", "b");
    const swapped = swapSplit(split, "a");
    expect(swapped).toEqual({ split: { ...split, secondaryTabId: "a" }, activate: "b" });
    expect(swapSplit(emptySplit(), "a")).toBeNull();
  });

  it("never shows one tab in both panes and closes for a closed tab", () => {
    const split = openSplit(emptySplit(), "horizontal", "b");
    expect(reconcileSplit(split, ["a", "b"], "a", "b").secondaryTabId).toBe("a");
    expect(reconcileSplit(split, ["a", "b", "c"], "a", "c")).toBe(split);
    expect(splitOpen(reconcileSplit(split, ["a"], "a", "a"))).toBe(false);
    expect(splitCandidates([{ id: "a" }, { id: "b" }], "a")).toEqual([{ id: "b" }]);
  });

  it("restores a persisted layout and clamps the divider", () => {
    expect(
      splitFromLayout({ splitMode: "vertical", secondaryTabId: "b", primarySize: 99 }),
    ).toEqual({ mode: "vertical", secondaryTabId: "b", primarySize: 85 });
    expect(splitFromLayout({ splitMode: "nope", secondaryTabId: "b", primarySize: 40 }).mode).toBe(
      "single",
    );
    expect(clampSplitSize(Number.NaN)).toBe(50);
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
    expect(commands.some((c) => c.id === "swapPanes")).toBe(false);
    expect(commands.some((c) => c.id === "toggleFilePanel")).toBe(true);
    expect(commands.some((c) => c.id === "settings")).toBe(true);
    expect(commands.some((c) => c.id === "sendPlanImplementer")).toBe(false);
  });

  it("finds a tab in the palette by folder and by several words", () => {
    const commands = buildPalette({
      tabs: [{ id: "tab_1", label: "Planner · UI", cwd: "/Users/jt/Projects/Koneksi" }],
      canReopen: false,
      splitOpen: false,
    });
    const goto = (q: string) => filterCommands(commands, q).some((c) => c.id === "goto:tab_1");
    expect(goto("koneksi")).toBe(true);
    expect(goto("planner koneksi")).toBe(true);
    expect(goto("planner encryptor")).toBe(false);
  });

  it("offers New tab in worktree always and Remove worktree only on a worktree tab", () => {
    const plain = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
    expect(filterCommands(plain, "worktree").map((c) => c.id)).toEqual(["newWorktreeTab"]);
    expect(filterCommands(plain, "git branch").map((c) => c.id)).toContain("newWorktreeTab");
    const wt = buildPalette({
      tabs: [],
      canReopen: false,
      splitOpen: false,
      canRemoveWorktree: true,
    });
    expect(filterCommands(wt, "worktree").map((c) => c.id)).toEqual([
      "newWorktreeTab",
      "removeWorktree",
    ]);
  });

  it("finds the changes (diff) panel by diff, revert, or review", () => {
    const commands = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
    for (const query of ["diff", "changes", "revert", "review edits"]) {
      expect(filterCommands(commands, query).map((c) => c.id)).toContain("showChanges");
    }
  });

  it("offers plan hand-off commands on a Planner session", () => {
    const commands = buildPalette({
      tabs: [],
      canReopen: false,
      splitOpen: false,
      canSendPlan: true,
    });
    expect(commands.map((command) => command.id)).toEqual(
      expect.arrayContaining(["sendPlanImplementer", "sendPlanDeveloper"]),
    );
  });
});
