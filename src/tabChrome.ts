export const CLOSED_TAB_LIMIT = 15;

export const TAB_COLOR_CHOICES = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#f0883e",
  "#bc8cff",
  "#f85149",
  "#8b949e",
];

export type ClosedTab = {
  id: string;
  label: string;
  roleId: string;
  cwd: string;
  color: string;
  answers: Record<string, string>;
  closedAt: number;
};

export type SplitMode = "single" | "horizontal" | "vertical" | "grid";

export type SplitState = {
  mode: SplitMode;
  secondaryTabId: string | null;
  /** Main pane size in percent. Kept when the split closes. */
  primarySize?: number;
  /** Grid mode: the tabs on screen, in cell order. */
  gridTabIds?: string[];
};

/** Most tabs a grid shows at once (matches `GRID_MAX_TABS` in Rust). */
export const GRID_MAX_TABS = 6;

export const DEFAULT_SPLIT_SIZE = 50;

export function emptySplit(primarySize = DEFAULT_SPLIT_SIZE): SplitState {
  return { mode: "single", secondaryTabId: null, primarySize };
}

export function splitOpen(state: SplitState): boolean {
  if (state.mode === "grid") return gridOpen(state);
  return state.mode !== "single" && !!state.secondaryTabId;
}

export function gridOpen(state: SplitState): boolean {
  return state.mode === "grid" && (state.gridTabIds?.length ?? 0) >= 2;
}

/**
 * Grid of `ids` (deduplicated, capped). The active tab always gets a cell:
 * it replaces the last one when the grid is full.
 */
export function openGrid(state: SplitState, ids: string[], activeId: string | null): SplitState {
  const unique = ids.filter((id, i) => id && ids.indexOf(id) === i);
  let cells = unique.slice(0, GRID_MAX_TABS);
  if (activeId && !cells.includes(activeId)) {
    cells = cells.length < GRID_MAX_TABS ? [...cells, activeId] : [...cells.slice(0, -1), activeId];
  }
  if (cells.length < 2) return closeSplit(state);
  return {
    mode: "grid",
    secondaryTabId: null,
    gridTabIds: cells,
    primarySize: clampSplitSize(state.primarySize),
  };
}

/** Add one tab to the grid, or start a grid of the active tab and that tab. */
export function addToGrid(state: SplitState, tabId: string, activeId: string | null): SplitState {
  const current = gridOpen(state) ? (state.gridTabIds ?? []) : activeId ? [activeId] : [];
  if (current.includes(tabId) || current.length >= GRID_MAX_TABS) return state;
  return openGrid(state, [...current, tabId], activeId);
}

export function removeFromGrid(state: SplitState, tabId: string): SplitState {
  if (!gridOpen(state)) return state;
  const cells = (state.gridTabIds ?? []).filter((id) => id !== tabId);
  return cells.length >= 2 ? { ...state, gridTabIds: cells } : closeSplit(state);
}

/**
 * Cells per row. Landscape fills columns first (2 → 1×2, 4 → 2×2, 6 → 2×3);
 * portrait fills rows first (2 → 2×1, 3 → 3×1, 6 → 3×2).
 */
export function gridRows(count: number, portrait: boolean): number[] {
  if (count <= 0) return [];
  if (count <= 3) return portrait ? Array(count).fill(1) : [count];
  if (count === 4) return [2, 2];
  if (portrait) return count === 5 ? [2, 2, 1] : [2, 2, 2];
  return count === 5 ? [3, 2] : [3, 3];
}

export function clampSplitSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_SPLIT_SIZE;
  return Math.min(85, Math.max(15, size));
}

/** Tabs the second pane may show: every open tab except the active one. */
export function splitCandidates<T extends { id: string }>(tabs: T[], activeId: string | null): T[] {
  return tabs.filter((tab) => tab.id !== activeId);
}

/**
 * Swap the panes. The second pane's tab becomes active and the active tab
 * moves to the second pane. Returns null when there is nothing to swap.
 */
export function swapSplit(
  state: SplitState,
  activeId: string | null,
): { split: SplitState; activate: string } | null {
  if (!splitOpen(state) || !activeId || !state.secondaryTabId) return null;
  if (state.secondaryTabId === activeId) return null;
  return {
    split: { ...state, secondaryTabId: activeId },
    activate: state.secondaryTabId,
  };
}

/**
 * Keep the split valid after a tab change. Selecting the tab that is in the
 * second pane swaps the panes, so one tab is never shown twice. A closed
 * tab closes the split.
 */
export function reconcileSplit(
  state: SplitState,
  tabIds: string[],
  previousActive: string | null,
  nextActive: string | null,
): SplitState {
  if (state.mode === "grid") return reconcileGrid(state, tabIds, previousActive, nextActive);
  if (!splitOpen(state)) return state;
  if (!state.secondaryTabId || !tabIds.includes(state.secondaryTabId)) {
    return emptySplit(state.primarySize);
  }
  if (nextActive && state.secondaryTabId === nextActive) {
    if (previousActive && previousActive !== nextActive && tabIds.includes(previousActive)) {
      return { ...state, secondaryTabId: previousActive };
    }
    return emptySplit(state.primarySize);
  }
  return state;
}

/**
 * Cells stay where they are. A closed tab leaves the grid. Selecting a tab
 * that is not on screen puts it in the cell of the tab it replaced, so the
 * other cells never move or disappear.
 */
function reconcileGrid(
  state: SplitState,
  tabIds: string[],
  previousActive: string | null,
  nextActive: string | null,
): SplitState {
  let cells = (state.gridTabIds ?? []).filter((id) => tabIds.includes(id));
  if (nextActive && !cells.includes(nextActive)) {
    const slot = previousActive ? cells.indexOf(previousActive) : -1;
    if (slot >= 0) cells = cells.map((id, i) => (i === slot ? nextActive : id));
    else if (cells.length < GRID_MAX_TABS) cells = [...cells, nextActive];
    else cells = [...cells.slice(0, -1), nextActive];
  }
  if (cells.length < 2) return closeSplit(state);
  const same =
    cells.length === (state.gridTabIds ?? []).length &&
    cells.every((id, i) => id === state.gridTabIds?.[i]);
  return same ? state : { ...state, gridTabIds: cells };
}

export function splitFromLayout(layout: {
  splitMode: string;
  secondaryTabId: string | null;
  primarySize: number;
  gridTabIds?: string[];
}): SplitState {
  if (layout.splitMode === "grid") {
    const cells = layout.gridTabIds ?? [];
    if (cells.length >= 2) {
      return {
        mode: "grid",
        secondaryTabId: null,
        gridTabIds: cells.slice(0, GRID_MAX_TABS),
        primarySize: clampSplitSize(layout.primarySize),
      };
    }
    return emptySplit(clampSplitSize(layout.primarySize));
  }
  const mode: SplitMode =
    layout.splitMode === "horizontal" || layout.splitMode === "vertical"
      ? layout.splitMode
      : "single";
  if (mode === "single" || !layout.secondaryTabId) return emptySplit(clampSplitSize(layout.primarySize));
  return { mode, secondaryTabId: layout.secondaryTabId, primarySize: clampSplitSize(layout.primarySize) };
}

export function pushClosed(stack: ClosedTab[], tab: ClosedTab): ClosedTab[] {
  const without = stack.filter((item) => item.id !== tab.id);
  return [tab, ...without].slice(0, CLOSED_TAB_LIMIT);
}

export function reopenLast(stack: ClosedTab[]): {
  tab: ClosedTab | null;
  stack: ClosedTab[];
} {
  if (stack.length === 0) return { tab: null, stack };
  const [tab, ...rest] = stack;
  return { tab, stack: rest };
}

export function openSplit(
  state: SplitState,
  mode: "horizontal" | "vertical",
  secondaryTabId: string,
): SplitState {
  return { mode, secondaryTabId, primarySize: clampSplitSize(state.primarySize) };
}

export function closeSplit(state?: SplitState): SplitState {
  return emptySplit(clampSplitSize(state?.primarySize));
}

export function tabAtIndex<T>(tabs: T[], index: number): T | null {
  if (index < 0 || index >= tabs.length) return null;
  return tabs[index] ?? null;
}

/** Palette groups, in the order the palette lists them. */
export const PALETTE_GROUPS = [
  "Tabs",
  "Worktree",
  "Split",
  "Files",
  "Search",
  "History",
  "Hand-off",
  "Model",
  "Prompts",
  "Workspaces",
  "Composer",
  "Terminal",
  "Setup",
  "Help",
  "Diagnostics",
  "Open tabs",
] as const;

export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** Every fixed palette action. StartupForm's runPalette must handle each one. */
export const PALETTE_ACTIONS = [
  "newTab",
  "newWindow",
  "closeTab",
  "reopenClosedTab",
  "nextTab",
  "prevTab",
  "renameTab",
  "tabSwitcher",
  "newWorktreeTab",
  "removeWorktree",
  "splitRight",
  "splitDown",
  "closeSplit",
  "swapPanes",
  "focusOtherPane",
  "toggleGrid",
  "addToGrid",
  "toggleFilePanel",
  "showChanges",
  "find",
  "searchChats",
  "chatHistory",
  "sendPlanPlanReviewer",
  "sendPlanImplementer",
  "sendPlanDeveloper",
  "sendToPlanner",
  "sendImplementerToReviewer",
  "exportTranscript",
  "showLogs",
  "pipelineWorkspace",
  "executionPipelineWorkspace",
  "startEagleEye1",
  "startEagleEye2",
  "handoffHelp",
  "changeModel",
  "refreshModels",
  "promptLibrary",
  "savePrompt",
  "workspaces",
  "saveWorkspace",
  "focusPad",
  "focusInput",
  "transferPad",
  "send",
  "toggleTerminal",
  "transferToTerminal",
  "firstRunSetup",
  "shortcutsHelp",
  "toggleShortcutBar",
  "switchTheme",
  "settings",
  "toggleCapture",
] as const;

export type PaletteAction = (typeof PALETTE_ACTIONS)[number];

export type PaletteCommand = {
  id: string;
  title: string;
  group: PaletteGroup;
  keywords?: string;
  /** Short note shown next to the title, e.g. "current". */
  hint?: string;
  /** Listed only once the user types (long lists such as models). */
  searchOnly?: boolean;
};

export type PaletteRoute =
  | { kind: "action"; id: PaletteAction }
  | { kind: "goto"; tabId: string }
  | { kind: "model"; model: string | null };

/** Turn a palette command id into what to run, or null if it is unknown. */
export function parsePaletteId(id: string): PaletteRoute | null {
  if (id.startsWith("goto:")) {
    const tabId = id.slice("goto:".length);
    return tabId ? { kind: "goto", tabId } : null;
  }
  if (id.startsWith("model:")) {
    const model = id.slice("model:".length);
    return { kind: "model", model: model || null };
  }
  return (PALETTE_ACTIONS as readonly string[]).includes(id)
    ? { kind: "action", id: id as PaletteAction }
    : null;
}

/**
 * Every word in the query must appear in the title, group, or keywords.
 * Search-only commands are left out until the user types.
 */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return commands.filter((cmd) => !cmd.searchOnly);
  return commands.filter((cmd) => {
    const hay = `${cmd.title} ${cmd.group} ${cmd.keywords ?? ""}`.toLowerCase();
    return tokens.every((token) => hay.includes(token));
  });
}

export type PaletteModelOptions = {
  /** The tab's own model; null means it follows the default. */
  current: string | null;
  /** The model the tab gets when it follows the default. */
  inherited: string;
  models: { id: string; label: string }[];
};

export function buildPalette(opts: {
  tabs: { id: string; label: string; cwd?: string }[];
  canReopen: boolean;
  splitOpen: boolean;
  /** The grid view is on screen (Swap / Focus other pane do not apply). */
  gridOpen?: boolean;
  /** Another tab can still join the grid. */
  canAddToGrid?: boolean;
  canSendPlan?: boolean;
  /** Hand-off targets of the active plan source (Planner / Plan Reviewer). Default: the Planner's. */
  sendPlanTargets?: readonly string[];
  canExportTranscript?: boolean;
  canSendImplementerToReviewer?: boolean;
  /** The active tab was opened in a worktree. */
  canRemoveWorktree?: boolean;
  /** The active tab can change model (absent for plain shells). */
  model?: PaletteModelOptions | null;
}): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    { id: "newTab", title: "New tab", group: "Tabs" },
    { id: "newWindow", title: "New window", group: "Tabs", keywords: "account claude" },
    { id: "closeTab", title: "Close tab", group: "Tabs" },
    { id: "nextTab", title: "Next tab", group: "Tabs" },
    { id: "prevTab", title: "Previous tab", group: "Tabs" },
    { id: "renameTab", title: "Rename tab", group: "Tabs" },
    { id: "tabSwitcher", title: "Go to tab…", group: "Tabs" },
    {
      id: "newWorktreeTab",
      title: "New tab in worktree…",
      group: "Worktree",
      keywords: "git branch worktree",
    },
    { id: "splitRight", title: "Split right", group: "Split", keywords: "pane side by side" },
    { id: "splitDown", title: "Split down", group: "Split", keywords: "pane stacked" },
    {
      id: "toggleGrid",
      title: opts.gridOpen ? "Close grid view" : "Show tabs in a grid",
      group: "Split",
      keywords: "grid tile monitor all panes terminals chats",
    },
    { id: "toggleFilePanel", title: "Toggle file panel", group: "Files", keywords: "tree explorer" },
    {
      id: "showChanges",
      title: "Show changes (diff)…",
      group: "Files",
      keywords: "diff revert accept review edits git agent",
    },
    {
      id: "find",
      title: "Find in tab",
      group: "Search",
      keywords: "search text chat terminal scrollback",
    },
    {
      id: "searchChats",
      title: "Search all chats…",
      group: "Search",
      keywords: "find history transcript closed saved messages",
    },
    {
      id: "chatHistory",
      title: "Chat history for this folder…",
      group: "History",
      keywords: "resume past chats previous sessions cursor cli agent conversations",
    },
    {
      id: "changeModel",
      title: "Change model…",
      group: "Model",
      keywords: "switch llm",
    },
    {
      id: "refreshModels",
      title: "Refresh model list",
      group: "Model",
      keywords: "reload models cli",
    },
    {
      id: "promptLibrary",
      title: "Prompt library…",
      group: "Prompts",
      keywords: "saved prompts snippets templates recent sends history insert scratch pad",
    },
    {
      id: "savePrompt",
      title: "Save scratch pad as prompt…",
      group: "Prompts",
      keywords: "prompt library snippet template name",
    },
    {
      id: "startEagleEye1",
      title: "Start Eagle-Eye 1…",
      group: "Hand-off",
      keywords: "eagle eye planner plan reviewer implementer chain",
    },
    {
      id: "startEagleEye2",
      title: "Start Eagle-Eye 2…",
      group: "Hand-off",
      keywords: "eagle eye implementer reviewer chain",
    },
    {
      id: "pipelineWorkspace",
      title: "New pipeline workspace (eagle-eye + 4 roles)",
      group: "Workspaces",
      keywords: "planner implementer reviewer pipeline preset tabs",
    },
    {
      id: "executionPipelineWorkspace",
      title: "New execution pipeline (eagle-eye + 2 roles)",
      group: "Workspaces",
      keywords: "implementer reviewer execute approved plan pipeline preset tabs",
    },
    {
      id: "workspaces",
      title: "Open workspace…",
      group: "Workspaces",
      keywords: "workspaces restore load saved tabs folders session layout",
    },
    {
      id: "saveWorkspace",
      title: "Save tabs as workspace…",
      group: "Workspaces",
      keywords: "workspace save tabs folders roles layout",
    },
    { id: "focusPad", title: "Focus scratch pad", group: "Composer" },
    { id: "focusInput", title: "Focus input", group: "Composer" },
    { id: "transferPad", title: "Transfer scratch pad", group: "Composer" },
    { id: "send", title: "Send", group: "Composer" },
    { id: "toggleTerminal", title: "Toggle terminal pane", group: "Terminal" },
    {
      id: "transferToTerminal",
      title: "Transfer scratch pad to terminal",
      group: "Terminal",
    },
    {
      id: "firstRunSetup",
      title: "Run first-run setup…",
      group: "Setup",
      keywords: "setup onboarding welcome cursor cli agent login sign in detect folder role",
    },
    { id: "shortcutsHelp", title: "Keyboard shortcuts", group: "Help" },
    {
      id: "toggleShortcutBar",
      title: "Toggle shortcut bar",
      group: "Help",
      keywords: "shortcut bar hints keys bottom status show hide",
    },
    {
      id: "switchTheme",
      title: "Switch theme (GitHub Dark / Light)",
      group: "Help",
      keywords: "theme appearance dark light colors github",
    },
    { id: "settings", title: "Settings", group: "Help" },
    {
      id: "toggleCapture",
      title: "Toggle permission payload capture",
      group: "Diagnostics",
    },
  ];
  if (opts.canReopen) {
    commands.push({ id: "reopenClosedTab", title: "Reopen closed tab", group: "Tabs" });
  }
  if (opts.canRemoveWorktree) {
    commands.push({
      id: "removeWorktree",
      title: "Remove this tab's worktree…",
      group: "Worktree",
      keywords: "git branch worktree delete",
    });
  }
  if (opts.canAddToGrid) {
    commands.push({
      id: "addToGrid",
      title: "Add tab to grid…",
      group: "Split",
      keywords: "grid tile monitor pane",
    });
  }
  if (opts.splitOpen && !opts.gridOpen) {
    commands.push(
      { id: "closeSplit", title: "Close split", group: "Split", keywords: "pane" },
      { id: "swapPanes", title: "Swap panes", group: "Split" },
      { id: "focusOtherPane", title: "Focus other pane", group: "Split" },
    );
  }
  if (opts.canSendPlan) {
    const targets = opts.sendPlanTargets ?? [
      "role_plan_reviewer",
      "role_implementer",
      "role_developer",
    ];
    const planCommands: (PaletteCommand & { target: string })[] = [
      {
        id: "sendPlanPlanReviewer",
        target: "role_plan_reviewer",
        title: "Hand off plan to Plan Reviewer…",
        group: "Hand-off",
        keywords: "handoff send planner plan reviewer review eagle",
      },
      {
        id: "sendPlanImplementer",
        target: "role_implementer",
        title: "Hand off plan to Implementer…",
        group: "Hand-off",
        keywords: "handoff send planner plan implementer",
      },
      {
        id: "sendPlanDeveloper",
        target: "role_developer",
        title: "Hand off plan to Developer…",
        group: "Hand-off",
        keywords: "handoff send planner plan developer",
      },
      {
        id: "sendToPlanner",
        target: "role_planner",
        title: "Send to Planner…",
        group: "Hand-off",
        keywords: "handoff send planner plan recommendation audit finding feature revise",
      },
    ];
    for (const { target, ...command } of planCommands) {
      if (targets.includes(target)) commands.push(command);
    }
  } else {
    commands.push({
      id: "handoffHelp",
      title: "Hand off plan…",
      group: "Hand-off",
      keywords: "handoff send planner plan implementer developer reviewer plan reviewer",
    });
  }
  if (opts.canSendImplementerToReviewer) {
    commands.push({
      id: "sendImplementerToReviewer",
      title: "Hand off to PR Reviewer…",
      group: "Hand-off",
      keywords: "handoff send implementer reviewer pr review",
    });
  }
  if (opts.canExportTranscript) {
    commands.push({
      id: "exportTranscript",
      title: "Export transcript…",
      group: "History",
      keywords: "export markdown transcript save chat",
    });
  }
  commands.push({
    id: "showLogs",
    title: "Show session logs…",
    group: "Diagnostics",
    keywords: "stderr debug agent log drawer",
  });
  if (opts.model) {
    const { current, inherited, models } = opts.model;
    commands.push({
      id: "model:",
      title: `Use default model (${inherited})`,
      group: "Model",
      keywords: "switch llm inherit",
      hint: current === null ? "current" : undefined,
      searchOnly: true,
    });
    for (const model of models) {
      commands.push({
        id: `model:${model.id}`,
        title: `Use model: ${model.label}`,
        group: "Model",
        keywords: `switch llm ${model.id}`,
        hint: current === model.id ? "current" : undefined,
        searchOnly: true,
      });
    }
  }
  for (const tab of opts.tabs) {
    commands.push({
      id: `goto:${tab.id}`,
      title: `Switch to: ${tab.label}`,
      group: "Open tabs",
      keywords: `${tab.label} ${tab.cwd ?? ""} go to tab`,
    });
  }
  const rank = (group: PaletteGroup) => PALETTE_GROUPS.indexOf(group);
  // Array.prototype.sort is stable, so each group keeps the order above.
  return commands.sort((a, b) => rank(a.group) - rank(b.group));
}
