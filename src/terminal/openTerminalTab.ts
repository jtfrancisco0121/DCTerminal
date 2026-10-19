/**
 * Open a terminal tab (Claude Code or a plain shell) in a folder. The same
 * live-PTY steps as opening a Cursor/Claude chat in a terminal, without resume.
 */
import { ptyOpen, shellTerminalStart } from "../bridge";
import { beginLivePty, clearPtyOpening, dropLivePty, livePty, markPtyOpening, rekeyLivePty } from "./live";
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

/**
 * Attaches to a stage terminal the run actor started with no view (an
 * engine-2 run, V3): `pty_open` of that id hands over what it printed so
 * far and streams the rest, like a terminal started here quietly. Does
 * nothing when this app already holds the terminal. Throws when it cannot
 * attach.
 */
export async function attachStageTerminal(tab: { id: string; cwd: string; roleId: string }): Promise<void> {
  if (livePty(tab.id) || !markPtyOpening(tab.id)) return;
  const live = beginLivePty(tab.id);
  try {
    await ptyOpen({
      id: tab.id,
      cwd: tab.cwd,
      launch: "role",
      roleId: tab.roleId,
      prompt: null,
      resumeSessionId: null,
      ...measuredTerminalSize(),
      attach: true,
      onOutput: live.channel,
    });
  } catch (err: unknown) {
    dropLivePty(tab.id);
    throw err;
  } finally {
    clearPtyOpening(tab.id);
  }
}
