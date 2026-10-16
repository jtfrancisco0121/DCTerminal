/**
 * Open a terminal tab (Claude Code or a plain shell) in a folder. The same
 * live-PTY steps as opening a Cursor/Claude chat in a terminal, without resume.
 */
import { shellTerminalStart } from "../bridge";
import { beginLivePty, dropLivePty, rekeyLivePty } from "./live";
import { measuredTerminalSize } from "./park";

export type NewTerminalLaunch = "claude-cli" | "shell";

/**
 * Starts the terminal and returns its tab id. `reuseTabId` turns that tab
 * (an untouched draft) into the terminal instead of adding one. Throws with a
 * readable message when the terminal does not start.
 */
export async function startTerminalTab(
  launch: NewTerminalLaunch,
  cwd: string,
  reuseTabId: string | null = null,
): Promise<string> {
  const pendingId = reuseTabId ?? `starting-${Date.now()}`;
  const live = beginLivePty(pendingId);
  try {
    const result = await shellTerminalStart({
      tabId: reuseTabId,
      cwd,
      launch,
      ...measuredTerminalSize(),
      onOutput: live.channel,
    });
    if (result.errors.length > 0 || !result.tabId) {
      throw new Error(result.errors[0]?.message ?? "The terminal did not start.");
    }
    if (result.tabId !== pendingId) rekeyLivePty(pendingId, result.tabId);
    return result.tabId;
  } catch (err: unknown) {
    dropLivePty(pendingId);
    throw err;
  }
}
