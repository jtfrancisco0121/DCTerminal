import { terminalPlanFile } from "../bridge";
import { livePty } from "../terminal/live";
import { terminalSelection, terminalTailText } from "../terminal/park";

/**
 * Reads text from a terminal tab for the pipeline overview. Read-only.
 * Each returns "" when the terminal is not open in this window.
 */
export type TerminalReader = {
  selection: (tabId: string) => string;
  tail: (tabId: string) => string;
  /** Newest plan file since the terminal started (provider plans folder). */
  planFile: (tabId: string) => Promise<string>;
};

export const liveTerminalReader: TerminalReader = {
  selection: (tabId) => terminalSelection(tabId),
  tail: (tabId) => terminalTailText(tabId),
  planFile: async (tabId) => {
    const pty = livePty(tabId);
    if (!pty) return "";
    const file = await terminalPlanFile(pty.startedAt, tabId).catch(() => null);
    return file?.text.trim() ?? "";
  },
};
