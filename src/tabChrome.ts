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
};

export function emptySplit(): SplitState {
  return { mode: "single", secondaryTabId: null };
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
  _state: SplitState,
  mode: "horizontal" | "vertical",
  secondaryTabId: string,
): SplitState {
  return { mode, secondaryTabId };
}

export function closeSplit(): SplitState {
  return emptySplit();
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

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((cmd) => {
    const hay = `${cmd.title} ${cmd.group} ${cmd.keywords ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
}

export function buildPalette(opts: {
  tabs: { id: string; label: string }[];
  canReopen: boolean;
  splitOpen: boolean;
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
    { id: "focusPad", title: "Focus scratch pad", group: "Composer" },
    { id: "focusInput", title: "Focus input", group: "Composer" },
    { id: "transferPad", title: "Transfer scratch pad", group: "Composer" },
    { id: "send", title: "Send", group: "Composer" },
    { id: "shortcutsHelp", title: "Keyboard shortcuts", group: "Help" },
    { id: "settings", title: "Settings", group: "Help" },
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
    commands.splice(
      commands.findIndex((c) => c.id === "closeSplit"),
      1,
    );
  }
  for (const tab of opts.tabs) {
    commands.push({
      id: `goto:${tab.id}`,
      title: `Switch to: ${tab.label}`,
      group: "Tabs",
      keywords: tab.label,
    });
  }
  return commands;
}
