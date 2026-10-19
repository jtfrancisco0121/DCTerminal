/**
 * Dev-only: force a render error in one pane so the Playwright spec can
 * check that the rest of the window survives (e2e/ui/pane-crash.spec.ts).
 * `window.__dctCrashPane(paneId)` is set only when `import.meta.env.DEV`;
 * PaneBoundary renders the probe under the same guard, so a production
 * build drops this module.
 */
import { useSyncExternalStore } from "react";

const requested = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function requestPaneCrash(paneId: string): void {
  requested.add(paneId);
  notify();
}

export function clearPaneCrash(paneId: string): void {
  if (requested.delete(paneId)) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Throws while a crash is requested for `paneId`. */
export function DevCrashProbe({ paneId }: { paneId: string }) {
  const crash = useSyncExternalStore(subscribe, () => requested.has(paneId));
  if (crash) throw new Error(`Forced pane crash (dev): ${paneId}`);
  return null;
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __dctCrashPane?: (paneId: string) => void }).__dctCrashPane =
    requestPaneCrash;
}
