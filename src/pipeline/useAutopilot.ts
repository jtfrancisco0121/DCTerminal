/**
 * The autopilot driver (ADR-014): when a terminal stage of a run with
 * autopilot on finishes a turn, run the stage's checks, ask the core what to
 * do (`pipeline_decide`), and do it: open the next stage's terminal, send a
 * round back, paste a failed check's output or the missing-sections ask into
 * the same tab, or stop and tell you why. Every step lands in the run's
 * ledger. Manual runs are never touched.
 */
import { useCallback, useRef } from "react";
import {
  chainLoopBack,
  getClaudeUsage,
  getPipelineRun,
  getTab,
  type PipelineRun,
  type RunLane,
  pipelineDecide,
  pipelineNote,
  pipelineRunGates,
  ptyWrite,
  setTabProvider,
  type AutopilotDecision,
  type TabSummary,
  type TerminalSessionLog,
} from "../bridge";
import { chainTabFor, loopBackChain, type ChainRef } from "../handoff/chains";
import { ASK_FOR_HANDOFF_SECTIONS } from "../handoff/contract";
import { attachHandoff, prepareHandoff, saveHandoff, type LoopBackStep } from "../handoff/executor";
import { defaultScope, githubPrUrls, terminalHandoffInput, type HandoffSource } from "../handoff/map";
import { loopBackMessage } from "../handoff/routing";
import type { RoleName } from "../handoff/transitions";
import { livePty, notePtyInput, ptyExitCode } from "../terminal/live";
import { terminalBracketedPaste, terminalTailText } from "../terminal/park";
import { encodeTerminalPaste } from "../terminal/paste";
import type { TerminalState } from "../terminal/claudeState";
import type { ProviderId } from "../provider/types";
import {
  finishedTurn,
  loopBackText,
  stageForTab,
  terminalStageSource,
  turnReport,
  usagePercent,
} from "./autopilot";

export type AutopilotDeps = {
  tabs: () => TabSummary[];
  roles: () => readonly RoleName[] | null;
  terminalState: (tabId: string) => TerminalState | undefined;
  /** Starts a role terminal without taking focus; the new tab id, or null. */
  startTerminal: (options: {
    roleId: string;
    values: Record<string, string>;
    handoffPlan: string | null;
  }) => Promise<string | null>;
  refreshTabs: () => Promise<unknown>;
  /** Tells you autopilot stopped on `tabId` (toast and system notification). */
  notifyStop: (tabId: string, reason: string) => void;
  notice: (title: string, body: string) => void;
  /** Starts a waiting lane's Implementer (fanOut.startLane). */
  startLane: (run: PipelineRun, lane: RunLane) => Promise<void>;
};

type Job = { tab: TabSummary; chain: ChainRef; log: TerminalSessionLog; awaitingPlan: boolean };

/** Paste `text` into a live terminal and press Enter, like the scratch pad's Send. */
async function pasteInto(tabId: string, text: string): Promise<void> {
  notePtyInput(tabId);
  await ptyWrite(
    tabId,
    encodeTerminalPaste(text, { bracketedPaste: terminalBracketedPaste(tabId), submit: true }),
  );
}

function liveIdleTerminal(tab: TabSummary, state: TerminalState | undefined): boolean {
  const pty = livePty(tab.id);
  return tab.kind === "terminal" && !!pty && !pty.exited && (!state || state.kind === "idle");
}

export function useAutopilot(deps: AutopilotDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  /** Turn keys already handled, per tab. */
  const handled = useRef(new Map<string, string>());
  /** Tabs whose turn is being handled now. */
  const busy = useRef(new Set<string>());

  const stop = useCallback(async (runId: string, tabId: string, stageId: string | null, why: string) => {
    // intentionally silent: the toast below still tells you; the ledger line is extra.
    await pipelineNote(runId, { stageId, summary: why, stop: true }).catch(() => {});
    depsRef.current.notifyStop(tabId, why);
  }, []);

  /** Open the decision's stage in a new terminal, carrying this stage's reply. */
  const openStage = useCallback(
    async (
      job: Job,
      source: HandoffSource,
      targetRoleId: string,
      loopBack: LoopBackStep | null,
      verdict: string | null,
    ): Promise<string | null> => {
      const d = depsRef.current;
      const scope = defaultScope(source);
      const prepared = await prepareHandoff({
        source,
        scope,
        surface: "terminal",
        targetRoleId,
        sourceChain: job.chain,
        loopBack,
        roles: d.roles(),
      });
      if (!prepared.ok) return prepared.error;
      const record = await saveHandoff(prepared.value, scope);
      const terminal = terminalHandoffInput(prepared.value.mapped);
      const tabId = await d.startTerminal({
        roleId: targetRoleId,
        values: { ...terminal.values, cwd: source.cwd },
        handoffPlan: terminal.handoffPlan,
      });
      if (!tabId) return "The terminal did not start.";
      const provider: ProviderId = job.tab.provider ?? "claude";
      await setTabProvider(tabId, provider);
      await attachHandoff({ record, tabId, prepared: prepared.value, loopBack, verdict });
      await d.refreshTabs();
      return null;
    },
    [],
  );

  const carryOut = useCallback(
    async (job: Job, runId: string, decision: AutopilotDecision, reply: string, verdict: string | null) => {
      const d = depsRef.current;
      const { tab, chain } = job;
      const fail = (what: string) =>
        stop(runId, tab.id, decision.stageId ?? null, `Autopilot could not ${what}`);
      switch (decision.action) {
        case "stop":
          depsRef.current.notifyStop(tab.id, decision.reason);
          return;
        case "complete":
          d.notice("Run complete", decision.reason);
          return;
        case "laneDone": {
          const ids = decision.unblocked ?? [];
          if (!ids.length) return;
          const view = await getPipelineRun(runId);
          for (const id of ids) {
            const lane = view.run.lanes?.find((l) => l.id === id);
            if (!lane) continue;
            try {
              await d.startLane(view.run, lane);
            } catch (err: unknown) {
              await fail(`start ${lane.title}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return;
        }
        case "reask":
        case "retry": {
          const text = decision.action === "reask" ? ASK_FOR_HANDOFF_SECTIONS : (decision.message ?? "");
          if (!liveIdleTerminal(tab, d.terminalState(tab.id))) {
            await fail(`paste into ${tab.label}: the terminal is not open and idle.`);
            return;
          }
          await pasteInto(tab.id, text);
          return;
        }
        case "advance": {
          if (!decision.roleId) return;
          const answers = await getTab(tab.id)
            .then(({ tab: record }) => ({ ...record.answers }))
            .catch(() => ({ cwd: tab.cwd }));
          const source = terminalStageSource({
            tab,
            log: job.log,
            answers,
            tail: terminalTailText(tab.id),
            roles: d.roles(),
            awaitingPlan: job.awaitingPlan,
          });
          const error = await openStage(job, source, decision.roleId, null, null);
          if (error) await fail(`open ${decision.stageId}: ${error}`);
          return;
        }
        case "loopBack": {
          if (!decision.roleId) return;
          const next = loopBackChain(chain, tab.roleId, decision.roleId);
          if (!next) {
            await fail(`send the round back: ${decision.roleId} is not this stage's loop-back.`);
            return;
          }
          const tabs = d.tabs();
          const live = (t: TabSummary) => !!livePty(t.id) && !livePty(t.id)?.exited;
          const target = chainTabFor(tabs, chain, next.step, live);
          const findings = loopBackText(reply);
          const round = Math.max(1, chain.round ?? 1);
          if (target && live(target)) {
            const state = d.terminalState(target.id);
            if (!liveIdleTerminal(target, state)) {
              const why =
                state?.kind === "needs"
                  ? `${target.label} is waiting for you (${state.needs}). Answer it there, then send the findings back yourself.`
                  : `${target.label} is still working. Send the findings back when its turn ends.`;
              await stop(runId, tab.id, decision.stageId ?? null, why);
              return;
            }
            const text = loopBackMessage(tab.roleId, findings, round, d.roles());
            await pasteInto(target.id, text);
            await chainLoopBack({
              chainId: chain.chainId,
              reviewerRoleId: tab.roleId,
              tabId: target.id,
              verdict,
              handoffText: text,
              lane: chain.lane ?? null,
            });
            await d.refreshTabs();
            return;
          }
          // The earlier stage's terminal is gone: a new one on the chain.
          const answers = await getTab(tab.id)
            .then(({ tab: record }) => ({ ...record.answers }))
            .catch(() => ({ cwd: tab.cwd }));
          const source = terminalStageSource({
            tab,
            log: job.log,
            answers,
            tail: terminalTailText(tab.id),
            roles: d.roles(),
            awaitingPlan: false,
          });
          const error = await openStage(
            job,
            source,
            decision.roleId,
            { chainId: chain.chainId, next },
            verdict,
          );
          if (error) await fail(`send the round back: ${error}`);
          return;
        }
      }
    },
    [openStage, stop],
  );

  /**
   * Call with each fresh session log of a terminal tab. Handles a finished
   * turn once, and only for a chain run with autopilot on.
   */
  const onTerminalLog = useCallback(
    (tabId: string, log: TerminalSessionLog | null) => {
      const d = depsRef.current;
      const tab = d.tabs().find((t) => t.id === tabId);
      if (!tab?.chain || tab.kind !== "terminal" || ptyExitCode(tabId) != null) return;
      const turn = finishedTurn(tab.roleId, log);
      if (!turn || !log || handled.current.get(tabId) === turn.key || busy.current.has(tabId)) return;
      const placed = stageForTab(tab.chain, tab.roleId);
      if (!placed) return;
      // Marked on first sight, autopilot on or off: turning it on later
      // takes over from the next turn and never replays an old one.
      handled.current.set(tabId, turn.key);
      busy.current.add(tabId);
      const job: Job = { tab, chain: tab.chain, log, awaitingPlan: turn.awaitingPlan };
      void (async () => {
        const runId = tab.chain!.chainId;
        try {
          const view = await getPipelineRun(runId).catch(() => null);
          if (!view?.run.autopilot?.enabled) return;
          const reply = (turn.awaitingPlan ? log.plan : log.lastReply)?.trim() ?? "";
          const lane = tab.chain!.lane ?? null;
          if (placed.stage.gates?.length) {
            await pipelineRunGates(runId, placed.stage.id, tab.cwd, githubPrUrls(log.lastReply), lane);
          }
          // intentionally silent: without usage data autopilot simply does not pause for it.
          const usage = usagePercent(await getClaudeUsage().catch(() => null));
          const report = turnReport({
            stage: placed.stage,
            reply,
            chat: false,
            usage,
            awaitingPlan: turn.awaitingPlan,
            lane,
          });
          const decision = await pipelineDecide(runId, report);
          await carryOut(job, runId, decision, reply, report.verdict);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          await stop(runId, tabId, placed.stage.id, `Autopilot stopped: ${message}`);
        } finally {
          busy.current.delete(tabId);
        }
      })();
    },
    [carryOut, stop],
  );

  return { onTerminalLog };
}
