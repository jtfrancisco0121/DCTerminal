import { describe, expect, it } from "vitest";
import {
  addToGrid,
  GRID_MAX_TABS,
  gridOpen,
  gridRows,
  openGrid,
  removeFromGrid,
  buildPalette,
  clampSplitSize,
  closeSplit,
  emptySplit,
  filterCommands,
  openSplit,
  PALETTE_GROUPS,
  parsePaletteId,
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

  it("omits export transcript when canExportTranscript is false", () => {
    const off = buildPalette({
      tabs: [],
      canReopen: false,
      splitOpen: false,
      canExportTranscript: false,
    });
    expect(off.some((c) => c.id === "exportTranscript")).toBe(false);
    const on = buildPalette({
      tabs: [],
      canReopen: false,
      splitOpen: false,
      canExportTranscript: true,
    });
    expect(on.some((c) => c.id === "exportTranscript")).toBe(true);
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

  it("can run first-run setup again", () => {
    const commands = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
    expect(filterCommands(commands, "setup").map((c) => c.id)).toContain("firstRunSetup");
    expect(filterCommands(commands, "login cli").map((c) => c.id)).toContain("firstRunSetup");
  });

  it("opens and saves workspaces", () => {
    const commands = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
    expect(filterCommands(commands, "workspace").map((c) => c.id)).toEqual(
      expect.arrayContaining(["workspaces", "saveWorkspace"]),
    );
    expect(filterCommands(commands, "restore session layout").map((c) => c.id)).toContain(
      "workspaces",
    );
  });

  it("opens the prompt library and saves the pad as a prompt", () => {
    const commands = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
    expect(filterCommands(commands, "prompt").map((c) => c.id)).toEqual(
      expect.arrayContaining(["promptLibrary", "savePrompt"]),
    );
    expect(filterCommands(commands, "recent sends").map((c) => c.id)).toContain("promptLibrary");
    expect(filterCommands(commands, "snippet").map((c) => c.id)).toContain("promptLibrary");
  });

  it("offers find in tab and search all chats", () => {
    const commands = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
    expect(filterCommands(commands, "find").map((c) => c.id)).toEqual(
      expect.arrayContaining(["find", "searchChats"]),
    );
    expect(filterCommands(commands, "transcript history").map((c) => c.id)).toContain(
      "searchChats",
    );
  });

  it("finds the changes (diff) panel by diff, revert, or review", () => {
    const commands = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
    for (const query of ["diff", "changes", "revert", "review edits"]) {
      expect(filterCommands(commands, query).map((c) => c.id)).toContain("showChanges");
    }
  });

  it("finds the activity log by activity, commands, or network and routes it", () => {
    const commands = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
    for (const query of ["activity", "show activity", "commands", "network", "audit"]) {
      expect(filterCommands(commands, query).map((c) => c.id)).toContain("showActivity");
    }
    expect(commands.find((c) => c.id === "showActivity")?.title).toBe("Show activity…");
    expect(parsePaletteId("showActivity")).toEqual({ kind: "action", id: "showActivity" });
  });

  it("offers plan hand-off commands on a Planner session", () => {
    const commands = buildPalette({
      tabs: [],
      canReopen: false,
      splitOpen: false,
      canSendPlan: true,
    });
    expect(commands.map((command) => command.id)).toEqual(
      expect.arrayContaining(["sendPlanPlanReviewer", "sendPlanImplementer", "sendPlanDeveloper"]),
    );
    expect(commands.map((command) => command.id)).not.toContain("sendPlanReviewer");
  });

  it("a Plan Reviewer session only offers its own targets", () => {
    const commands = buildPalette({
      tabs: [],
      canReopen: false,
      splitOpen: false,
      canSendPlan: true,
      sendPlanTargets: ["role_implementer", "role_developer", "role_planner"],
    });
    const ids = filterCommands(commands, "hand off").map((c) => c.id);
    expect(ids.filter((id) => id.startsWith("send"))).toEqual([
      "sendPlanImplementer",
      "sendPlanDeveloper",
      "sendToPlanner",
    ]);
    expect(ids).toEqual(expect.arrayContaining(["startEagleEye1", "startEagleEye2"]));
  });

  it("offers the chain overview only for a tab on an Eagle-Eye chain", () => {
    const base = { tabs: [], canReopen: false, splitOpen: false };
    const off = buildPalette(base).map((c) => c.id);
    expect(off).not.toContain("openChainOverview");
    const on = buildPalette({ ...base, canOpenChainOverview: true });
    const command = on.find((c) => c.id === "openChainOverview");
    expect(command?.title).toBe("Open chain overview…");
    expect(command?.group).toBe("Hand-off");
    expect(parsePaletteId("openChainOverview")).toEqual({
      kind: "action",
      id: "openChainOverview",
    });
  });

  it("a Recommendation or Audit session offers Send to Planner and Developer", () => {
    const commands = buildPalette({
      tabs: [],
      canReopen: false,
      splitOpen: false,
      canSendPlan: true,
      sendPlanTargets: ["role_planner", "role_developer"],
    });
    const ids = commands.map((c) => c.id).filter((id) => /^send(Plan|To)/.test(id));
    expect(ids).toEqual(["sendPlanDeveloper", "sendToPlanner"]);
    expect(commands.find((c) => c.id === "sendToPlanner")?.title).toBe("Send to Planner…");
  });

  describe("fuller palette (F9)", () => {
    const models = {
      current: "gpt-5",
      inherited: "sonnet-4",
      models: [
        { id: "gpt-5", label: "GPT-5" },
        { id: "sonnet-4", label: "Sonnet 4" },
      ],
    };
    const everything = () =>
      buildPalette({
        tabs: [{ id: "tab_1", label: "Main" }],
        canReopen: true,
        splitOpen: true,
        canSendPlan: true,
        canRemoveWorktree: true,
        model: models,
      });
    const groupOf = (id: string) => everything().find((c) => c.id === id)?.group;

    it("groups the core actions under one name each", () => {
      expect(groupOf("sendPlanImplementer")).toBe("Hand-off");
      expect(groupOf("sendPlanDeveloper")).toBe("Hand-off");
      expect(groupOf("newWorktreeTab")).toBe("Worktree");
      expect(groupOf("removeWorktree")).toBe("Worktree");
      for (const id of ["splitRight", "splitDown", "closeSplit", "swapPanes", "focusOtherPane"]) {
        expect(groupOf(id)).toBe("Split");
      }
      expect(groupOf("changeModel")).toBe("Model");
      expect(groupOf("refreshModels")).toBe("Model");
      expect(groupOf("chatHistory")).toBe("History");
      expect(groupOf("searchChats")).toBe("Search");
      expect(groupOf("find")).toBe("Search");
      expect(groupOf("promptLibrary")).toBe("Prompts");
      expect(groupOf("workspaces")).toBe("Workspaces");
      for (const group of [
        "Hand-off",
        "Worktree",
        "Split",
        "Model",
        "History",
        "Search",
        "Prompts",
        "Workspaces",
      ]) {
        expect(PALETTE_GROUPS).toContain(group);
      }
    });

    it("uses only known groups and lists them in group order", () => {
      const commands = everything();
      const order = commands.map((c) => PALETTE_GROUPS.indexOf(c.group));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("titles commands that open a dialog with an ellipsis", () => {
      const titles = Object.fromEntries(everything().map((c) => [c.id, c.title]));
      expect(titles.sendPlanImplementer).toBe("Hand off plan to Implementer…");
      expect(titles.sendPlanDeveloper).toBe("Hand off plan to Developer…");
      expect(titles.sendPlanPlanReviewer).toBe("Hand off plan to Plan Reviewer…");
      expect(titles.sendPlanReviewer).toBeUndefined();
      expect(titles.changeModel).toBe("Change model…");
      expect(titles.chatHistory).toBe("Chat history for this folder…");
    });

    it("always lists a hand-off entry, explaining it when no plan can be sent", () => {
      const plain = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
      const ids = filterCommands(plain, "hand off").map((c) => c.id);
      expect(ids).toEqual(["startEagleEye1", "startEagleEye2", "handoffHelp"]);
      expect(filterCommands(plain, "handoff").map((c) => c.id)).toEqual(["handoffHelp"]);
      const planner = filterCommands(everything(), "hand off")
        .map((c) => c.id)
        .filter((id) => id.startsWith("send"));
      expect(planner).toEqual([
        "sendPlanPlanReviewer",
        "sendPlanImplementer",
        "sendPlanDeveloper",
      ]);
    });

    it("offers each model only while searching, marking the current one", () => {
      const commands = everything();
      expect(filterCommands(commands, "").some((c) => c.id.startsWith("model:"))).toBe(false);
      const found = filterCommands(commands, "use model");
      expect(found.map((c) => c.id)).toEqual(["model:", "model:gpt-5", "model:sonnet-4"]);
      expect(found[0].title).toBe("Use default model (sonnet-4)");
      expect(found[1]).toMatchObject({ title: "Use model: GPT-5", hint: "current" });
      expect(filterCommands(commands, "sonnet").map((c) => c.id)).toContain("model:sonnet-4");
      expect(filterCommands(commands, "model").map((c) => c.id)).toEqual(
        expect.arrayContaining(["changeModel", "refreshModels", "model:gpt-5"]),
      );
    });

    it("lists Change model without model choices when the tab has no model", () => {
      const plain = buildPalette({ tabs: [], canReopen: false, splitOpen: false });
      const ids = filterCommands(plain, "model").map((c) => c.id);
      expect(ids).toEqual(["changeModel", "refreshModels"]);
    });

    it("toggles the shortcut bar and switches theme (U7, U8)", () => {
      const commands = everything();
      expect(filterCommands(commands, "shortcut bar").map((c) => c.id)).toContain(
        "toggleShortcutBar",
      );
      expect(filterCommands(commands, "hints").map((c) => c.id)).toContain("toggleShortcutBar");
      expect(filterCommands(commands, "theme").map((c) => c.id)).toContain("switchTheme");
      expect(filterCommands(commands, "light").map((c) => c.id)).toContain("switchTheme");
      expect(parsePaletteId("toggleShortcutBar")).toEqual({ kind: "action", id: "toggleShortcutBar" });
    });

    it("finds chat history by resume, past, or sessions", () => {
      const commands = everything();
      for (const query of ["history", "resume", "past chats", "sessions"]) {
        expect(filterCommands(commands, query).map((c) => c.id)).toContain("chatHistory");
      }
    });

    it("can route every command it lists", () => {
      for (const command of everything()) {
        expect(parsePaletteId(command.id), command.id).not.toBeNull();
      }
      expect(parsePaletteId("goto:tab_1")).toEqual({ kind: "goto", tabId: "tab_1" });
      expect(parsePaletteId("model:")).toEqual({ kind: "model", model: null });
      expect(parsePaletteId("model:a:b")).toEqual({ kind: "model", model: "a:b" });
      expect(parsePaletteId("splitRight")).toEqual({ kind: "action", id: "splitRight" });
      expect(parsePaletteId("nope")).toBeNull();
    });
  });
});

describe("grid view", () => {
  const ids = ["a", "b", "c", "d"];

  it("lays out cells by window shape", () => {
    expect(gridRows(2, false)).toEqual([2]);
    expect(gridRows(3, false)).toEqual([3]);
    expect(gridRows(4, false)).toEqual([2, 2]);
    expect(gridRows(6, false)).toEqual([3, 3]);
    expect(gridRows(5, false)).toEqual([3, 2]);
    expect(gridRows(2, true)).toEqual([1, 1]);
    expect(gridRows(3, true)).toEqual([1, 1, 1]);
    expect(gridRows(6, true)).toEqual([2, 2, 2]);
    expect(gridRows(0, true)).toEqual([]);
  });

  it("opens with the active tab, dedupes, and caps at six", () => {
    const grid = openGrid(emptySplit(), ["a", "b", "a", "c", "d", "e", "f", "g"], "z");
    expect(grid.mode).toBe("grid");
    expect(grid.gridTabIds).toHaveLength(GRID_MAX_TABS);
    expect(grid.gridTabIds).toContain("z");
    expect(new Set(grid.gridTabIds).size).toBe(GRID_MAX_TABS);
    expect(splitOpen(grid)).toBe(true);
    expect(gridOpen(openGrid(emptySplit(), ["a"], "a"))).toBe(false);
  });

  it("keeps every cell in place when a cell's tab is selected", () => {
    const grid = openGrid(emptySplit(), ids, "a");
    expect(reconcileSplit(grid, ids, "a", "c")).toBe(grid);
  });

  it("puts a tab from outside the grid into the cell of the tab it replaced", () => {
    const grid = openGrid(emptySplit(), ["a", "b", "c"], "b");
    const next = reconcileSplit(grid, ["a", "b", "c", "x"], "b", "x");
    expect(next.gridTabIds).toEqual(["a", "x", "c"]);
  });

  it("drops closed tabs and closes below two cells", () => {
    const grid = openGrid(emptySplit(), ["a", "b", "c"], "a");
    expect(reconcileSplit(grid, ["a", "b"], "a", "a").gridTabIds).toEqual(["a", "b"]);
    expect(reconcileSplit(grid, ["a"], "a", "a").mode).toBe("single");
  });

  it("adds and removes cells", () => {
    const start = addToGrid(emptySplit(), "b", "a");
    expect(start.gridTabIds).toEqual(["a", "b"]);
    const more = addToGrid(start, "c", "a");
    expect(more.gridTabIds).toEqual(["a", "b", "c"]);
    expect(addToGrid(more, "c", "a")).toBe(more);
    expect(removeFromGrid(more, "b").gridTabIds).toEqual(["a", "c"]);
    expect(removeFromGrid(removeFromGrid(more, "b"), "c").mode).toBe("single");
  });

  it("restores a saved grid and ignores a grid of one", () => {
    const restored = splitFromLayout({
      splitMode: "grid",
      secondaryTabId: null,
      primarySize: 50,
      gridTabIds: ["a", "b"],
    });
    expect(restored.gridTabIds).toEqual(["a", "b"]);
    expect(
      splitFromLayout({ splitMode: "grid", secondaryTabId: null, primarySize: 50, gridTabIds: ["a"] })
        .mode,
    ).toBe("single");
  });

  it("lists grid commands in the palette and hides pane-only ones", () => {
    const off = buildPalette({ tabs: [], canReopen: false, splitOpen: false, canAddToGrid: true });
    expect(off.find((c) => c.id === "toggleGrid")?.title).toBe("Show tabs in a grid");
    expect(off.some((c) => c.id === "addToGrid")).toBe(true);
    const on = buildPalette({ tabs: [], canReopen: false, splitOpen: true, gridOpen: true });
    expect(on.find((c) => c.id === "toggleGrid")?.title).toBe("Close grid view");
    expect(on.some((c) => c.id === "swapPanes")).toBe(false);
  });
});
