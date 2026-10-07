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

export type SplitMode = "single" | "horizontal" | "vertical";

export type SplitState = {
  mode: SplitMode;
  secondaryTabId: string | null;
  /** Main pane size in percent. Kept when the split closes. */
  primarySize?: number;
};

export const DEFAULT_SPLIT_SIZE = 50;

export function emptySplit(primarySize = DEFAULT_SPLIT_SIZE): SplitState {
  return { mode: "single", secondaryTabId: null, primarySize };
}

export function splitOpen(state: SplitState): boolean {
  return state.mode !== "single" && !!state.secondaryTabId;
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

export function splitFromLayout(layout: {
  splitMode: string;
  secondaryTabId: string | null;
  primarySize: number;
}): SplitState {
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
  "toggleFilePanel",
  "showChanges",
  "find",
  "searchChats",
  "chatHistory",
  "sendPlanImplementer",
  "sendPlanDeveloper",
  "sendPlanReviewer",
  "sendImplementerToReviewer",
  "exportTranscript",
  "showLogs",
  "pipelineWorkspace",
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
  canSendPlan?: boolean;
  canExportTranscript?: boolean;
  canSendImplementerToReviewer?: boolean;
  /** The active tab was opened in a worktree. */
  canRemoveWorktree?: boolean;
  /** The active tab can change model (absent for plain shells). */
  model?: PaletteModelOptions | null;
}): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    { id: "newTab", title: "New tab", group: "Tabs" },
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
      id: "pipelineWorkspace",
      title: "New pipeline workspace (Planner / Implementer / Reviewer)",
      group: "Workspaces",
      keywords: "planner implementer reviewer pipeline preset tabs",
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
  if (opts.splitOpen) {
    commands.push(
      { id: "closeSplit", title: "Close split", group: "Split", keywords: "pane" },
      { id: "swapPanes", title: "Swap panes", group: "Split" },
      { id: "focusOtherPane", title: "Focus other pane", group: "Split" },
    );
  }
  if (opts.canSendPlan) {
    commands.push(
      {
        id: "sendPlanImplementer",
        title: "Hand off plan to Implementer…",
        group: "Hand-off",
        keywords: "handoff send planner plan implementer",
      },
      {
        id: "sendPlanDeveloper",
        title: "Hand off plan to Developer…",
        group: "Hand-off",
        keywords: "handoff send planner plan developer",
      },
      {
        id: "sendPlanReviewer",
        title: "Hand off plan to PR Reviewer…",
        group: "Hand-off",
        keywords: "handoff send planner plan reviewer pr review",
      },
    );
  } else {
    commands.push({
      id: "handoffHelp",
      title: "Hand off plan…",
      group: "Hand-off",
      keywords: "handoff send planner plan implementer developer reviewer",
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
