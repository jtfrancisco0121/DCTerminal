/**
 * Watching a bridged pipeline stage (V5, D27, D28): whether its terminal
 * takes keystrokes now, and Take over / Hand back. The backend decides
 * (`pty_input_state`): a stage on autopilot is read-only except while it
 * needs you or you took it over. This view tells it when the stage needs
 * you (`needs`, from the session log, the screen or the bridge), and reads
 * the state again whenever the run changes.
 */
import { useCallback, useEffect, useState } from "react";
import {
  listenChainRunUpdated,
  pipelineActorMessage,
  ptyInputState,
  ptyStageNeeds,
  type BridgeTag,
  type StageInput,
} from "../bridge";
import { errorText } from "../components/InlineNotice";
import type { StageWatch } from "../components/TerminalView";

type StageTab = { id: string; bridge?: BridgeTag | null };

export function useStageWatch(
  tab: StageTab | null | undefined,
  needs: boolean,
  onError: (title: string, body: string) => void,
): StageWatch | null {
  const tabId = tab?.id ?? null;
  const runId = tab?.bridge?.runId ?? null;
  const [input, setInput] = useState<{ tabId: string; state: StageInput } | null>(null);

  const read = useCallback(
    (load: Promise<StageInput>, id: string) =>
      load
        .then((state) => setInput({ tabId: id, state }))
        // intentionally silent: the backend still refuses keystrokes it must; the next read retries.
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    if (!tabId || !runId) return;
    void read(ptyStageNeeds(tabId, needs), tabId);
  }, [needs, read, runId, tabId]);

  useEffect(() => {
    if (!tabId || !runId) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenChainRunUpdated(() => {
      if (!disposed) void read(ptyInputState(tabId), tabId);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      // intentionally silent: Take over and Hand back here still read the state again.
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [read, runId, tabId]);

  const act = useCallback(
    async (kind: "takeOver" | "handBack") => {
      if (!tabId || !runId) return;
      try {
        await pipelineActorMessage(runId, { kind, tabId });
      } catch (err: unknown) {
        onError(kind === "takeOver" ? "Not taken over" : "Not handed back", errorText(err));
      }
      await read(ptyInputState(tabId), tabId);
    },
    [onError, read, runId, tabId],
  );

  const state = input && input.tabId === tabId ? input.state : null;
  if (!tabId || !runId || !state?.stage) return null;
  return {
    canType: state.open,
    takenOver: state.takenOver,
    onTakeOver: () => void act("takeOver"),
    onHandBack: () => void act("handBack"),
  };
}
