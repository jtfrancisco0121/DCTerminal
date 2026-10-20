import { autopilotPendingStops, listenAutopilotStopped, type AutopilotStoppedEvent } from "../bridge";

/**
 * Every stop the core made by itself (a stall, or a turn that finished while
 * the app was closed), including the ones made before this listener existed:
 * the startup reconcile runs while the window loads, so the core holds those
 * until asked. Asked only once the listener is attached and `ownTabs` (this
 * window's tab ids, once its tab list has loaded) resolves, so nothing is
 * lost in between; the core hands over only the stops on those tabs, once,
 * and keeps the rest for the windows that own them. Returns a dispose.
 */
export function subscribeAutopilotStops(
  onStop: (event: AutopilotStoppedEvent) => void,
  ownTabs: Promise<string[]>,
): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listenAutopilotStopped((event) => {
    if (!disposed) onStop(event);
  })
    .then(async (stop) => {
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      const tabIds = await ownTabs;
      if (disposed) return;
      const held = await autopilotPendingStops(tabIds);
      if (!disposed) for (const event of held) onStop(event);
    })
    // intentionally silent: the overview still shows the stop; only the toast is lost.
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** A promise resolved once, by the first `resolve` call; later calls do nothing. */
export function onceValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
