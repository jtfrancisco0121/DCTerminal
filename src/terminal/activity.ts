/**
 * Terminal tabs have no ACP signals, so busy means "output kept arriving
 * recently that was not just the echo of a keystroke". When a busy tab goes
 * quiet after the user typed in it, `sweep` reports it as settled so the
 * chip can show a finished dot.
 */

export type ActivitySweep = { busy: string[]; settled: string[] };

export function createActivityTracker(opts: { quietMs?: number; echoMs?: number } = {}) {
  const quietMs = opts.quietMs ?? 3000;
  const echoMs = opts.echoMs ?? 500;
  const lastInput = new Map<string, number>();
  const lastOutput = new Map<string, number>();
  const wasBusy = new Set<string>();

  const tracked = (id: string) => !id.includes("::");

  function isBusy(id: string, now = Date.now()): boolean {
    const out = lastOutput.get(id);
    return out !== undefined && now - out < quietMs;
  }

  return {
    input(id: string, now = Date.now()) {
      if (tracked(id)) lastInput.set(id, now);
    },
    output(id: string, now = Date.now()) {
      if (!tracked(id)) return;
      const typed = lastInput.get(id);
      if (typed !== undefined && now - typed < echoMs) return;
      lastOutput.set(id, now);
    },
    isBusy,
    sweep(now = Date.now()): ActivitySweep {
      const busy: string[] = [];
      const settled: string[] = [];
      for (const id of lastOutput.keys()) {
        if (isBusy(id, now)) {
          busy.push(id);
          wasBusy.add(id);
        } else if (wasBusy.delete(id) && lastInput.has(id)) {
          // Only after the user typed something: a startup banner is not a result.
          settled.push(id);
        }
      }
      return { busy: busy.sort(), settled: settled.sort() };
    },
    forget(id: string) {
      lastInput.delete(id);
      lastOutput.delete(id);
      wasBusy.delete(id);
    },
  };
}

/** App-wide tracker fed by the PTY channels and terminal keystrokes. */
export const terminalActivity = createActivityTracker();

/**
 * xterm's onData also carries the terminal's automatic replies (cursor
 * position, device attributes, focus in/out). Those are not the user.
 */
export function isUserInput(data: string): boolean {
  if (!data) return false;
  // CSI replies ending in R, c, or n, and focus reports.
  if (/^\x1b\[[\d;?]*[Rcn]$/.test(data)) return false;
  if (data === "\x1b[I" || data === "\x1b[O") return false;
  return true;
}
