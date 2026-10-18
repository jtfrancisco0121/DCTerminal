import { livePty } from "./terminal/live";

/** Tabs whose work stops when they go away: an agent turn that is running,
 * or a terminal whose shell is live. */
export function liveTabs<T extends { id: string; phase: string; kind?: string }>(
  tabs: readonly T[],
): T[] {
  return tabs.filter((t) => t.phase === "running" || (t.kind === "terminal" && !!livePty(t.id)));
}
