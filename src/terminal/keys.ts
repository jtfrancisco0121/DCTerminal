import type { TerminalLaunch } from "../bridge";

export type TerminalKeyEvent = {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
};

/** ESC then CR: the new-line sequence Claude Code's /terminal-setup installs. */
export const SHIFT_ENTER_SEQUENCE = "\x1b\r";

/**
 * Only Claude Code terminals get the ESC+CR rewrite. A plain shell or Cursor
 * CLI keeps xterm's CR, so Shift+Enter still runs the command there.
 */
export function shiftEnterSendsNewline(launch: TerminalLaunch): boolean {
  return launch === "role" || launch === "claude-cli";
}

/**
 * True for Shift+Enter alone. xterm would send a bare CR, which submits the
 * prompt. The app sends ESC+CR instead, so Claude Code inserts a new line.
 */
export function isShiftEnter(event: TerminalKeyEvent): boolean {
  return (
    event.key === "Enter" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.isComposing
  );
}
