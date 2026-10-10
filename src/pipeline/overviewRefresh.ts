/**
 * When the chain overview refetches its run. Rust sends `chain-run-updated`
 * after every change the overview shows, so the poll is only a fallback
 * (e.g. an event sent while the listener was still registering).
 */
export const OVERVIEW_FALLBACK_POLL_MS = 30_000;

export type CoalescedReload = {
  /** Fetch now, or once more after the fetch in flight ends. */
  request(): void;
  stop(): void;
};

/** A burst of events costs at most one fetch in flight plus one after it. */
export function coalescedReload(load: () => Promise<unknown>): CoalescedReload {
  let running = false;
  let again = false;
  let stopped = false;
  const run = async () => {
    running = true;
    try {
      do {
        again = false;
        try {
          await load();
        } catch {
          // The overview shows its own load errors.
        }
      } while (again && !stopped);
    } finally {
      running = false;
    }
  };
  return {
    request() {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      void run();
    },
    stop() {
      stopped = true;
    },
  };
}

/** The event names a run by id; an Eagle-Eye run's id is its chain id. */
export function isForRun(event: { chainId: string }, runId: string): boolean {
  return event.chainId.trim() === runId.trim();
}
