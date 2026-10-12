/**
 * Background terminal starts (autopilot, fan-out lanes) one at a time. Each
 * waits its turn in the queue, then waits while another start holds the
 * start lock (a start you clicked), instead of failing.
 */
export function startQueue(locked: () => boolean, pollMs = 50) {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      while (locked()) await new Promise((resolve) => setTimeout(resolve, pollMs));
      return task();
    });
    // intentionally silent: a failed start fails its own caller, not the next one.
    tail = run.catch(() => {});
    return run;
  };
}
