import { chainMarkBlocked, type ChainCursor } from "./pad";

/**
 * After an agent request (permission, plan, question): the scratch-pad
 * chain, paused when the request is for one of this window's tabs. Agent
 * request events reach every window, so another window's must not pause it.
 */
export function chainAfterAgentRequest(
  cursor: ChainCursor | null,
  eventTabId: string,
  windowTabs: readonly { id: string }[],
): ChainCursor | null {
  if (!cursor || !windowTabs.some((tab) => tab.id === eventTabId)) return cursor;
  return chainMarkBlocked(cursor);
}
