import { shortcutRows, type Platform } from "../keymap";

/** U7: id stored in ui.tipsSeen once the welcome tip is dismissed. */
export const FIRST_USE_TIP_ID = "welcome";

export function shouldShowTip(opts: {
  loaded: boolean;
  tipsSeen: string[];
  /** A dialog (first-run setup, palette, settings) is in front. */
  blocked: boolean;
}): boolean {
  return opts.loaded && !opts.blocked && !opts.tipsSeen.includes(FIRST_USE_TIP_ID);
}

type Props = {
  platform: Platform;
  barOn: boolean;
  onDismiss: () => void;
  onShowBar: () => void;
};

/** U7: one small first-use card; dismissing it records the tip as seen. */
export function FirstUseTip({ platform, barOn, onDismiss, onShowBar }: Props) {
  const rows = shortcutRows(platform);
  const keys = (action: string) => rows.find((row) => row.action === action)?.keys ?? "";
  return (
    <div className="first-use-tip" role="status" aria-label="Tip">
      <p>
        <strong>Tip:</strong> <kbd>{keys("commandPalette")}</kbd> opens every command,{" "}
        <kbd>{keys("tabSwitcher")}</kbd> jumps to a tab, <kbd>{keys("shortcutsHelp")}</kbd>{" "}
        lists all shortcuts.
      </p>
      <div className="first-use-tip-actions">
        {!barOn && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              onShowBar();
              onDismiss();
            }}
          >
            Show shortcut bar
          </button>
        )}
        <button type="button" className="primary-button" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}
