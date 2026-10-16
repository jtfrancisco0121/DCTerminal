/**
 * A tab's live PTY as React state: renders again when it starts, is
 * replaced (restart, resume) or exits. `livePty()` read during render alone
 * would only catch up on an unrelated re-render.
 */
import { useSyncExternalStore } from "react";
import { livePty, livePtyVersion, subscribeLivePty, type LivePty } from "./live";

export function useLivePty(id: string | null | undefined): LivePty | undefined {
  useSyncExternalStore(subscribeLivePty, livePtyVersion);
  return id ? livePty(id) : undefined;
}

/** When the tab's running PTY started (ms); null when none runs (not started, or exited). */
export function useLivePtyStart(id: string | null | undefined): number | null {
  const live = useLivePty(id);
  return live && !live.exited ? live.startedAt : null;
}
