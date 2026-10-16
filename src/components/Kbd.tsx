import { detectPlatform, shortcutLabel, type Platform } from "../keymap";

type Props = {
  /** A keymap action id, e.g. `send` or `focusPad`. */
  action?: string;
  /**
   * Literal keys instead of an action, e.g. "Esc" in a key legend. Read out
   * by screen readers, since the legend's text needs them.
   */
  keys?: string;
  /** Defaults to this window's platform (⌘ on macOS, Ctrl elsewhere). */
  platform?: Platform;
  className?: string;
};

/**
 * The shortcut for a keymap action, as a small key hint beside a button label.
 * Hidden from screen readers so a button keeps its plain name ("Send"); the
 * shortcut list names every shortcut for them. Renders nothing for an id
 * without a shortcut.
 */
export function Kbd({ action, keys, platform, className }: Props) {
  const resolved =
    platform ?? detectPlatform(typeof navigator === "undefined" ? "" : navigator.platform);
  const label = keys ?? (action ? shortcutLabel(action, resolved) : null);
  if (!label) return null;
  return (
    <kbd
      className={`kbd-hint${className ? ` ${className}` : ""}`}
      aria-hidden={keys === undefined ? "true" : undefined}
    >
      {label}
    </kbd>
  );
}
