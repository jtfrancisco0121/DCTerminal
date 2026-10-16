/**
 * One prompt for a terminal, not one Enter per line.
 *
 * Bracketed paste (`ESC[200~` … `ESC[201~`) is how a TUI such as the Cursor
 * CLI keeps newlines inside the input. A bare CR is Enter and would submit
 * each line, so it is used only when the user chooses Send.
 */

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * Text safe to paste: newlines as `\n`, and no escape sequence or control
 * byte but `\t` and `\n`. Pasted terminal output can hold `ESC[201~`, which
 * would end the bracketed paste early and submit every later line.
 */
export function cleanPasteText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // OSC, terminated by BEL or ST.
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
      // DCS / SOS / PM / APC strings, terminated by ST.
      .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
      // CSI sequences, the paste markers among them.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // Other escapes (ESC 7, ESC ( B, ...).
      .replace(/\x1b[ -/]*[0-~]/g, "")
      // The control bytes left, a lone ESC among them; C1 too.
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
  );
}

export function encodeTerminalPaste(
  text: string,
  options: { bracketedPaste: boolean; submit: boolean },
): string {
  const body = cleanPasteText(text);
  const pasted = options.bracketedPaste ? `${PASTE_START}${body}${PASTE_END}` : body;
  return options.submit ? `${pasted}\r` : pasted;
}
