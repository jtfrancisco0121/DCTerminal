/**
 * Where each chain terminal's turns end, for the run lanes: when a terminal
 * stage of a pipeline run finishes a turn, the run's ledger notes it once
 * (`pipeline_turn_finished`), with a reviewer's verdict read from its reply.
 * The verdict parser is only for this display; nothing here decides or
 * carries anything out.
 *
 * Autopilot is the Rust run actor's alone (ADR-015, V3): it hears an
 * engine-2 run's bridged turns, runs the gates, decides and acts, and the
 * overview's Continue is a message to it. The v1 autopilot that read turns
 * from the session log and pasted keystrokes from here is gone (V6), so an
 * engine-1 run is manual only, even one saved with autopilot on.
 *
 * A turn that finished before this app session (a restart) is not noted
 * again.
 */
import { useCallback, useRef } from "react";
import { pipelineActorMessage, pipelineTurnFinished, type TabSummary, type TerminalSessionLog } from "../bridge";
import { parseReviewVerdict } from "../handoff/verdict";
import { ptyExitCode } from "../terminal/live";
import { finishedTurn, stageForTab } from "./stageTurn";

export type RunTurnsDeps = {
  tabs: () => TabSummary[];
};

export function useRunTurns(deps: RunTurnsDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  /** Turn keys already noted, per tab. */
  const handled = useRef(new Map<string, string>());
  /** Tabs whose log was read at least once since the app started. */
  const seen = useRef(new Set<string>());
  const startedAt = useRef(Date.now());

  /**
   * Call with each fresh session log of a terminal tab. Notes a finished
   * turn of a chain terminal in its run's ledger once. A bridged stage
   * (engine 2) is left out: the run actor records its turns.
   */
  const onTerminalLog = useCallback((tabId: string, log: TerminalSessionLog | null) => {
    const tab = depsRef.current.tabs().find((t) => t.id === tabId);
    if (!tab?.chain || tab.kind !== "terminal" || ptyExitCode(tabId) != null) return;
    if (tab.bridge) return;
    const turn = finishedTurn(tab.roleId, log);
    if (log && !seen.current.has(tabId)) {
      seen.current.add(tabId);
      // Finished before this app session (a restart): not noted again.
      const at = Date.parse(log?.lastPromptAt ?? "");
      if (turn && !(Number.isFinite(at) && at >= startedAt.current - 2000)) {
        handled.current.set(tabId, turn.key);
        return;
      }
    }
    if (!turn || !log || handled.current.get(tabId) === turn.key) return;
    const placed = stageForTab(tab.chain, tab.roleId);
    if (!placed) return;
    handled.current.set(tabId, turn.key);
    // intentionally silent: the lanes only lose a bar end.
    void pipelineTurnFinished(tab.chain.chainId, {
      stageId: placed.stage.id,
      roleId: tab.roleId,
      lane: tab.chain.lane ?? null,
      verdict: placed.stage.loopBack && !turn.awaitingPlan ? parseReviewVerdict(log.lastReply ?? "") : null,
    }).catch(() => {});
  }, []);

  /**
   * Overview › Continue on a run waiting after a restart: a message to its
   * run actor, which runs it again and decides the turn that finished while
   * the app was closed. The actor refuses an engine-1 run (manual only).
   */
  const continueRun = useCallback(async (runId: string) => {
    await pipelineActorMessage(runId, { kind: "continue" });
  }, []);

  return { onTerminalLog, continueRun };
}
