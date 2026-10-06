/**
 * One prompt for a terminal, not one Enter per line.
 *
 * Bracketed paste (`ESC[200~` … `ESC[201~`) is how a TUI such as the Cursor
 * CLI keeps newlines inside the input. A bare CR is Enter and would submit
 * each line, so it is used only when the user chooses Send.
 */

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

export function encodeTerminalPaste(
  text: string,
  options: { bracketedPaste: boolean; submit: boolean },
): string {
  const body = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const pasted = options.bracketedPaste ? `${PASTE_START}${body}${PASTE_END}` : body;
  return options.submit ? `${pasted}\r` : pasted;
}
