import { shortcutRows, type Platform, type ShortcutAction } from "../keymap";

/** U7: the everyday shortcuts shown in the optional bottom bar, in order. */
export const SHORTCUT_BAR_ACTIONS = [
  "commandPalette",
  "tabSwitcher",
  "newTab",
  "find",
  "toggleFilePanel",
  "splitRight",
  "shortcutsHelp",
] as const satisfies readonly ShortcutAction[];

export type ShortcutBarAction = (typeof SHORTCUT_BAR_ACTIONS)[number];

const SHORT_LABELS: Record<ShortcutBarAction, string> = {
  commandPalette: "Commands",
  tabSwitcher: "Go to tab",
  newTab: "New tab",
  find: "Find",
  toggleFilePanel: "Files",
  splitRight: "Split",
  shortcutsHelp: "All shortcuts",
};

export type ShortcutBarItem = { action: ShortcutBarAction; label: string; keys: string };

export function shortcutBarItems(platform: Platform): ShortcutBarItem[] {
  const rows = shortcutRows(platform);
  return SHORTCUT_BAR_ACTIONS.map((action) => ({
    action,
    label: SHORT_LABELS[action],
    // First row is the primary chord; later rows are alternates.
    keys: rows.find((row) => row.action === action)?.keys ?? "",
  }));
}

type Props = {
  platform: Platform;
  onRun: (action: ShortcutBarAction) => void;
  onHide?: () => void;
};

/** U7: compact key hints for the right end of the status bar. */
export function ShortcutBar({ platform, onRun, onHide }: Props) {
  return (
    <div className="shortcut-bar" role="group" aria-label="Shortcut bar">
      {shortcutBarItems(platform).map((item) => (
        <button
          key={item.action}
          type="button"
          className="shortcut-bar-item"
          onClick={() => onRun(item.action)}
          title={`${item.label} (${item.keys})`}
        >
          <kbd>{item.keys}</kbd>
          <span>{item.label}</span>
        </button>
      ))}
      {onHide && (
        <button
          type="button"
          className="shortcut-bar-hide"
          onClick={onHide}
          aria-label="Hide shortcut bar"
          title="Hide shortcut bar (turn it back on in Settings → Shortcuts or the command palette)"
        >
          ×
        </button>
      )}
    </div>
  );
}
