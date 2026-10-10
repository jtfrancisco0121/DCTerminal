/** Terminal tabs: take a "This turn" snapshot when the scratch pad sends a
 * command, the way chat tabs do before every prompt. */

import { changesSnapshot } from "../bridge";

/** At most one snapshot per tab in this window (a burst of sends is one turn). */
export const TURN_SNAPSHOT_MIN_GAP_MS = 2000;
/** How long a send waits for the snapshot before writing anyway. */
export const TURN_SNAPSHOT_WAIT_MS = 400;

type Options = {
  snapshot: (tabId: string) => Promise<unknown>;
  now?: () => number;
  minGapMs?: number;
  waitMs?: number;
};

export type TurnSnapshotter = ((tabId: string) => Promise<void>) & {
  /** When the last snapshot for the tab started (ms), if any. */
  lastAt: (tabId: string) => number | undefined;
};

/** A pad snapshot this close before a logged prompt was taken for it. */
export const PROMPT_SNAPSHOT_SLACK_MS = 5000;

/**
 * A prompt typed straight into a terminal: the session log shows a prompt
 * not seen before, sent after the tab was first watched, with no pad
 * snapshot taken for it.
 */
export function promptNeedsSnapshot(opts: {
  promptAt: string | null;
  seenPromptAt: string | null | undefined;
  watchedSinceMs: number;
  lastSnapshotMs: number | undefined;
}): boolean {
  const { promptAt, seenPromptAt, watchedSinceMs, lastSnapshotMs } = opts;
  if (!promptAt || promptAt === seenPromptAt) return false;
  const at = Date.parse(promptAt);
  if (Number.isNaN(at) || at < watchedSinceMs) return false;
  return lastSnapshotMs === undefined || lastSnapshotMs < at - PROMPT_SNAPSHOT_SLACK_MS;
}

/**
 * Returns `beforeSend(tabId)`. It starts a snapshot (unless one started for
 * the tab within `minGapMs`) and resolves when the snapshot finishes or
 * after `waitMs`, whichever is first. It never rejects: a folder outside git
 * or a failed snapshot just means no diff, never a blocked send.
 */
export function createTurnSnapshotter({
  snapshot,
  now = Date.now,
  minGapMs = TURN_SNAPSHOT_MIN_GAP_MS,
  waitMs = TURN_SNAPSHOT_WAIT_MS,
}: Options): TurnSnapshotter {
  const lastAt = new Map<string, number>();
  const before = (tabId: string) => {
    const at = now();
    const previous = lastAt.get(tabId);
    if (previous !== undefined && at - previous < minGapMs) return Promise.resolve();
    lastAt.set(tabId, at);
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(snapshot(tabId));
    } catch {
      return Promise.resolve();
    }
    const done = started.then(
      () => undefined,
      () => undefined,
    );
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    return Promise.race([done, timeout]);
  };
  return Object.assign(before, { lastAt: (tabId: string) => lastAt.get(tabId) });
}

/** The app-wide snapshotter for terminal scratch-pad sends. */
export const snapshotTerminalTurn = createTurnSnapshotter({
  snapshot: (tabId) => changesSnapshot(tabId),
});
