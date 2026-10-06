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

export type PaletteCommand = {
  id: string;
  title: string;
  group: string;
  keywords?: string;
};

/** Every word in the query must appear in the title, group, or keywords. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return commands;
  return commands.filter((cmd) => {
    const hay = `${cmd.title} ${cmd.group} ${cmd.keywords ?? ""}`.toLowerCase();
    return tokens.every((token) => hay.includes(token));
  });
}

export function buildPalette(opts: {
  tabs: { id: string; label: string; cwd?: string }[];
  canReopen: boolean;
  splitOpen: boolean;
  canSendPlan?: boolean;
}): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    { id: "newTab", title: "New tab", group: "Tabs" },
    { id: "closeTab", title: "Close tab", group: "Tabs" },
    { id: "reopenClosedTab", title: "Reopen closed tab", group: "Tabs" },
    { id: "nextTab", title: "Next tab", group: "Tabs" },
    { id: "prevTab", title: "Previous tab", group: "Tabs" },
    { id: "renameTab", title: "Rename tab", group: "Tabs" },
    { id: "tabSwitcher", title: "Go to tab…", group: "Tabs" },
    { id: "splitRight", title: "Split right", group: "Panes" },
    { id: "splitDown", title: "Split down", group: "Panes" },
    { id: "closeSplit", title: "Close split", group: "Panes" },
    { id: "swapPanes", title: "Swap panes", group: "Panes" },
    { id: "focusOtherPane", title: "Focus other pane", group: "Panes" },
    { id: "toggleFilePanel", title: "Toggle file panel", group: "Files", keywords: "tree explorer" },
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
    { id: "shortcutsHelp", title: "Keyboard shortcuts", group: "Help" },
    { id: "settings", title: "Settings", group: "Help" },
    ...(opts.canSendPlan
      ? [
          {
            id: "sendPlanImplementer",
            title: "Send plan to Implementer",
            group: "Hand-off",
            keywords: "planner plan implementer",
          },
          {
            id: "sendPlanDeveloper",
            title: "Send plan to Developer",
            group: "Hand-off",
            keywords: "planner plan developer",
          },
        ]
      : []),
    {
      id: "toggleCapture",
      title: "Toggle permission payload capture",
      group: "Diagnostics",
    },
  ];
  if (!opts.canReopen) {
    commands.splice(
      commands.findIndex((c) => c.id === "reopenClosedTab"),
      1,
    );
  }
  if (!opts.splitOpen) {
    for (const id of ["closeSplit", "swapPanes", "focusOtherPane"]) {
      commands.splice(
        commands.findIndex((c) => c.id === id),
        1,
      );
    }
  }
  for (const tab of opts.tabs) {
    commands.push({
      id: `goto:${tab.id}`,
      title: `Switch to: ${tab.label}`,
      group: "Tabs",
      keywords: `${tab.label} ${tab.cwd ?? ""} go to tab`,
    });
  }
  return commands;
}
