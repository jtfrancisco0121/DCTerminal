import { autopilotPendingStops, listenAutopilotStopped, type AutopilotStoppedEvent } from "../bridge";

/**
 * Every stop the core made by itself (a stall, or a turn that finished while
 * the app was closed), including the ones made before this listener existed:
 * the startup reconcile runs while the window loads, so the core holds those
 * until asked. Asked only once the listener is attached, so nothing is lost
 * in between and the core hands each held stop over once. Returns a dispose.
 */
export function subscribeAutopilotStops(onStop: (event: AutopilotStoppedEvent) => void): () => void {
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
      const held = await autopilotPendingStops();
      if (!disposed) for (const event of held) onStop(event);
    })
    // intentionally silent: the overview still shows the stop; only the toast is lost.
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}
