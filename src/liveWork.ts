import { ptyRunning } from "./bridge";
import { livePty } from "./terminal/live";

type LiveTab = { id: string; phase: string; kind?: string };

/** Tabs whose work stops when they go away: an agent turn that is running,
 * or a terminal whose shell is live in this view. */
export function liveTabs<T extends LiveTab>(tabs: readonly T[]): T[] {
  return tabs.filter((t) => t.phase === "running" || (t.kind === "terminal" && !!livePty(t.id)));
}

/**
 * {@link liveTabs}, plus terminals with no view whose program still runs in
 * the backend: a hidden pipeline stage (V5) never watched, or one whose
 * Watch closed. Closing the window or replacing the tabs stops those too,
 * so the questions count them. When the backend cannot answer, the views
 * it knows are what counts.
 */
export async function liveTabsNow<T extends LiveTab>(
  tabs: readonly T[],
  running: (ids: string[]) => Promise<string[]> = ptyRunning,
): Promise<T[]> {
  const viewed = new Set(liveTabs(tabs).map((t) => t.id));
  const unseen = tabs.filter((t) => t.kind === "terminal" && !viewed.has(t.id)).map((t) => t.id);
  let hidden = new Set<string>();
  if (unseen.length > 0) {
    try {
      hidden = new Set(await running(unseen));
    } catch {
      // intentionally silent: the question still counts every viewed terminal.
    }
  }
  return tabs.filter((t) => viewed.has(t.id) || hidden.has(t.id));
}
