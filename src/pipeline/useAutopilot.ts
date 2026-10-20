/**
 * The autopilot driver (ADR-014): when a terminal stage of a run with
 * autopilot on finishes a turn, run the stage's checks, ask the core what to
 * do (`pipeline_decide`), and do it: open the next stage's terminal, send a
 * round back, paste a failed check's output or the missing-sections ask into
 * the same tab, or stop and tell you why. Every step lands in the run's
 * ledger. Manual runs are never touched.
 *
 * A turn that finished before this app session (a restart) is never acted
 * on by itself (D29): the core puts its run in `waiting` with
 * `app_restarted`, and `continueRun` (the overview's Continue) decides it.
 *
 * A bridged stage (engine 2, ADR-015: a reviewer launched with the bridge)
 * is different: its turn end and its result come from the Rust core
 * (`onBridgeTurn`, fed by `pipeline-bridge-turn`), never from its log or its
 * reply's text. Its log only wakes a read-back (`pipelineBridgeTurn`) in
 * case an event was missed.
 */
import { useCallback, useRef } from "react";
import {
  chainLoopBack,
  getClaudeUsage,
  getPipelineRun,
  getTab,
  type PipelineRun,
  pipelineBridgeTurn,
  pipelineContinue,
  type RunLane,
  pipelineDecide,
  pipelineNote,
  pipelineReleaseHandoff,
  pipelineRunGates,
  pipelineTurnFinished,
  ptyWrite,
  terminalSessionLog,
  type AutopilotDecision,
  type BridgeTurn,
  type StopReason,
  type TabSummary,
  type TerminalSessionLog,
} from "../bridge";
import { chainTabFor, loopBackChain, loopBackRecord, type ChainRef } from "../handoff/chains";
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
import { pipelineDef, stageBehaviour, stageOfRole, stageRoles } from "./defs";
import { reviewRound } from "./runReport";
import { parseReviewVerdict } from "../handoff/verdict";
import { roleDisplayName } from "../handoff/transitions";
import {
  bridgeFindingsText,
  bridgeTurnReport,
  bridgeVerdict,
  finishedTurn,
  loopBackText,
  reviseVerdict,
  mergeReviews,
  stageForTab,
  terminalStageSource,
  turnId,
  turnReport,
  usagePercent,
} from "./autopilot";

export type AutopilotDeps = {
  tabs: () => TabSummary[];
  roles: () => readonly RoleName[] | null;
  terminalState: (tabId: string) => TerminalState | undefined;
  /**
   * Starts a role terminal without taking focus, as `provider`, for the
   * chain step `chain` (a bridged stage launches with the bridge); the new
   * tab id, or null.
   */
  startTerminal: (options: {
    roleId: string;
    values: Record<string, string>;
    handoffPlan: string | null;
    provider: ProviderId;
    /** The chain tag the new tab joins: its stage kind sets the permission mode. */
    chain: ChainRef | null;
  }) => Promise<string | null>;
  refreshTabs: () => Promise<unknown>;
  /** Tells you autopilot stopped on `tabId` and why (toast and system notification). */
  notifyStop: (tabId: string, reason: string, code: StopReason | null) => void;
  notice: (title: string, body: string) => void;
  /** Claims and starts a waiting lane's Implementer (fanOut.startLane); false when it was not waiting. */
  startLane: (run: PipelineRun, lane: RunLane) => Promise<boolean>;
  /** The newest session log read for a tab, if any. */
  sessionLog: (tabId: string) => TerminalSessionLog | null | undefined;
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

/** The round a run (or its lane) is on now. */
function currentRound(run: PipelineRun, lane: string | null): number {
  const laneRound = lane ? run.lanes?.find((l) => l.id === lane)?.round : undefined;
  return Math.max(1, laneRound ?? run.round ?? 1);
}

/** `latest` is a prompt sent after the turn's own (`turn`). */
function promptAfterTurn(latest: string | null | undefined, turn: string | null | undefined): boolean {
  if (!latest || latest === turn) return false;
  const at = Date.parse(latest);
  const since = Date.parse(turn ?? "");
  // A prompt whose time cannot be compared still counts as newer, as before.
  return !Number.isFinite(at) || !Number.isFinite(since) || at > since;
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
  /** Stage reviewers' turn keys already decided on with their parallel reviewers. */
  const merged = useRef(new Set<string>());
  /** Tabs whose log was read at least once since the app started. */
  const seen = useRef(new Set<string>());
  const startedAt = useRef(Date.now());
  /** Bridged tabs: the bridge turn (`prompt_id`) last handled. */
  const handledBridge = useRef(new Map<string, string>());
  /** Bridged tabs: a turn that ended while the previous one was still being handled. */
  const pendingBridge = useRef(new Map<string, BridgeTurn>());

  const stop = useCallback(
    async (runId: string, tabId: string, stageId: string | null, why: string, reason: StopReason = "carry_out_failed") => {
      // intentionally silent: the toast below still tells you; the ledger line is extra.
      // Default: autopilot decided, but could not carry the decision out.
      await pipelineNote(runId, { stageId, summary: why, stop: true, reason }).catch(() => {});
      depsRef.current.notifyStop(tabId, why, reason);
    },
    [],
  );

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
      // The next stage launches as this stage's provider; switching it after
      // the CLI started would leave the tab saying one and running the other.
      const tabId = await d.startTerminal({
        roleId: targetRoleId,
        values: { ...terminal.values, cwd: source.cwd },
        handoffPlan: terminal.handoffPlan,
        provider: job.tab.provider ?? "claude",
        chain: loopBack?.next ?? prepared.value.nextChain,
      });
      if (!tabId) return "The terminal did not start.";
      await attachHandoff({ record, tabId, prepared: prepared.value, loopBack, verdict });
      await d.refreshTabs();
      return null;
    },
    [],
  );

  const carryOut = useCallback(
    async (
      job: Job,
      runId: string,
      decision: AutopilotDecision,
      reply: string,
      verdict: string | null,
      /** A bridged reviewer's findings, as a loop-back sends them (else read from `reply`). */
      findingsText?: string,
    ) => {
      const d = depsRef.current;
      const { tab, chain } = job;
      // The hand-off did not happen: give its claim back, so a hand-off you
      // make next is not taken for a duplicate of it.
      // intentionally silent: a claim left behind only adds a warning to your own hand-off.
      const release = () =>
        decision.claim ? pipelineReleaseHandoff(runId, decision.claim).catch(() => {}) : Promise.resolve();
      const fail = async (what: string) => {
        await release();
        await stop(runId, tab.id, decision.stageId ?? null, `Autopilot could not ${what}`);
      };
      switch (decision.action) {
        case "ignore":
          // A late turn in an already-approved lane, or one decided on already.
          return;
        case "skip":
          // A stale turn, or a hand-off made already: the ledger says which.
          return;
        case "stop":
          depsRef.current.notifyStop(tab.id, decision.reason, decision.stopReason ?? null);
          return;
        case "complete":
          d.notice("Run complete", decision.reason);
          return;
        case "laneDone": {
          const ids = decision.unblocked ?? [];
          if (!ids.length) return;
          const view = await getPipelineRun(runId);
          for (const id of ids) {
            // startLane re-reads the run and skips a lane no longer waiting.
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
          if (error) {
            await fail(`open ${decision.stageId}: ${error}`);
            return;
          }
          // The next stage's parallel reviewers review the same work.
          const next = pipelineDef(chain.kind)?.stages.find((s) => s.id === decision.stageId);
          for (const extra of next?.alsoReviewers ?? []) {
            const failed = await openStage(job, source, extra, null, null);
            // The stage itself opened, so its claim stays.
            if (failed) {
              await stop(
                runId,
                tab.id,
                decision.stageId ?? null,
                `Autopilot could not open ${roleDisplayName(extra, d.roles())}: ${failed}`,
              );
            }
          }
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
          const findings = findingsText || loopBackText(reply) || reply.trim();
          if (target && live(target)) {
            const state = d.terminalState(target.id);
            if (!liveIdleTerminal(target, state)) {
              const why =
                state?.kind === "needs"
                  ? `${target.label} is waiting for you (${state.needs}). Answer it there, then send the findings back yourself.`
                  : `${target.label} is still working. Send the findings back when its turn ends.`;
              await release();
              await stop(runId, tab.id, decision.stageId ?? null, why);
              return;
            }
            // The reviewer's own round on this edge, as the round cap counts it.
            const view = await getPipelineRun(runId);
            const def = pipelineDef(view.run.kind) ?? pipelineDef(chain.kind);
            const reviewer = def ? stageOfRole(def, tab.roleId) : null;
            const round = reviewer
              ? reviewRound(view.run, decision.lane, reviewer)
              : Math.max(1, chain.round ?? 1);
            const text = loopBackMessage(tab.roleId, findings, round, d.roles(), chain.kind);
            // Record the round first: pasted into an unrecorded round, the
            // stage's next turn would be skipped as handed on already.
            try {
              await chainLoopBack(loopBackRecord(chain, tab.roleId, target.id, verdict, text));
            } catch (err: unknown) {
              await fail(`record round ${round} going back: ${err instanceof Error ? err.message : String(err)}`);
              return;
            }
            await pasteInto(target.id, text);
            await d.refreshTabs();
            return;
          }
          // The earlier stage's terminal is gone: a new one on the chain.
          const answers = await getTab(tab.id)
            .then(({ tab: record }) => ({ ...record.answers }))
            .catch(() => ({ cwd: tab.cwd }));
          // The findings sent are the decided reply (merged, with parallel reviewers).
          const source = terminalStageSource({
            tab,
            log: { ...job.log, lastReply: reply },
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

  /** Itself, for a turn queued while the tab's previous turn was handled. */
  const onBridgeTurnRef = useRef<(turn: BridgeTurn) => void>(() => {});

  /**
   * A bridged stage's finished turn (engine 2): the bridge says the turn
   * ended and what `submit_result` reported. Recorded in the ledger, then,
   * on a run with autopilot on, decided once per turn and carried out.
   */
  const onBridgeTurn = useCallback(
    (turn: BridgeTurn) => {
      const d = depsRef.current;
      const tab = d.tabs().find((t) => t.id === turn.tabId);
      if (!tab?.chain || !tab.bridge || tab.kind !== "terminal" || ptyExitCode(tab.id) != null) return;
      if (tab.bridge.runId !== turn.runId || tab.bridge.stage !== turn.stageKey) return;
      if (handledBridge.current.get(tab.id) === turn.turn) return;
      if (busy.current.has(tab.id)) {
        pendingBridge.current.set(tab.id, turn);
        return;
      }
      const placed = stageForTab(tab.chain, tab.roleId);
      if (!placed) return;
      handledBridge.current.set(tab.id, turn.turn);
      const chain = tab.chain;
      const runId = chain.chainId;
      busy.current.add(tab.id);
      void (async () => {
        /** The decision's hand-off claim until it is carried out. */
        let claimed: string | undefined;
        try {
          const view = await getPipelineRun(runId).catch(() => null);
          const revise = reviseVerdict(placed.def, placed.stage);
          const lane = chain.lane ?? null;
          // intentionally silent: the lanes only lose a bar end.
          void pipelineTurnFinished(runId, {
            stageId: placed.stage.id,
            roleId: tab.roleId,
            lane,
            verdict: turn.outcome === "result" ? bridgeVerdict(turn.result?.verdict, revise) : null,
          }).catch(() => {});
          if (!view?.run.autopilot?.enabled) return;
          // Complete is final: a late turn changes nothing.
          if (view.run.status === "complete") return;
          const acting = !view.run.status || view.run.status === "running";
          // The log is read only to carry the reply on in a hand-off.
          // intentionally silent: the hand-off falls back to the bridge's last message.
          const fresh = (await terminalSessionLog(tab.id).catch(() => null)) ?? d.sessionLog(tab.id) ?? null;
          const reply = turn.lastAssistantMessage.trim() || fresh?.lastReply?.trim() || "";
          const log: TerminalSessionLog = fresh
            ? { ...fresh, lastReply: reply }
            : { sessionId: "", path: "", turnDone: true, lastReply: reply, plan: null, planAt: null, lastPromptAt: null, toolCalls: [] };
          const job: Job = { tab, chain, log, awaitingPlan: false };
          const round = currentRound(view.run, lane);
          // A turn cut off by a usage limit ends without the tool: it stops
          // as usage_limit (H5), not no_result, and runs no checks.
          const rateLimit = fresh?.rateLimit?.trim() || null;
          if (acting && !rateLimit && placed.stage.gates?.length) {
            await pipelineRunGates(runId, placed.stage.id, tab.cwd, githubPrUrls(reply), lane, round);
            // The checks take a while: a turn started since is the stage's result now.
            // intentionally silent: an unreadable stage counts as unchanged.
            const latest = await pipelineBridgeTurn(tab.id).catch(() => turn);
            if (latest?.turn !== turn.turn) {
              // intentionally silent: the ledger line is extra; nothing else happens either way.
              await pipelineNote(runId, {
                stageId: placed.stage.id,
                summary: `Skipped ${placed.stage.title}'s turn: ${tab.label} got a newer prompt while its checks ran.`,
                stop: false,
              }).catch(() => {});
              return;
            }
          }
          // intentionally silent: unknown usage (no reading, or a stale one) is
          // null, never 0: autopilot carries on, and a rate-limit error stops it.
          const usage = usagePercent(await getClaudeUsage().catch(() => null));
          const report = bridgeTurnReport({ stage: placed.stage, turn, usage, rateLimit, lane, revise });
          const decision = await pipelineDecide(runId, { ...report, round, turn: `${tab.id}|bridge|${turn.turn}` });
          claimed = decision.claim;
          const findings = bridgeFindingsText(turn.result?.findings ?? []);
          await carryOut(job, runId, decision, reply, report.verdict, findings);
          claimed = undefined;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          // intentionally silent: a claim left behind only adds a warning to your own hand-off.
          if (claimed) await pipelineReleaseHandoff(runId, claimed).catch(() => {});
          await stop(runId, tab.id, placed.stage.id, `Autopilot stopped: ${message}`);
        } finally {
          busy.current.delete(tab.id);
          const next = pendingBridge.current.get(tab.id);
          if (next) {
            pendingBridge.current.delete(tab.id);
            onBridgeTurnRef.current(next);
          }
        }
      })();
    },
    [carryOut, stop],
  );
  onBridgeTurnRef.current = onBridgeTurn;

  /**
   * A bridged tab's log shows its turn ended: read the bridge's turn back,
   * in case its event was missed. One that ended before this app session
   * waits for Continue (D29).
   */
  const readBridgeTurn = useCallback(
    async (tabId: string) => {
      // intentionally silent: the event (or Continue) still delivers the turn.
      const turn = await pipelineBridgeTurn(tabId).catch(() => null);
      if (!turn || handledBridge.current.get(tabId) === turn.turn) return;
      const at = Date.parse(turn.endedAt);
      if (!(Number.isFinite(at) && at >= startedAt.current - 2000)) {
        handledBridge.current.set(tabId, turn.turn);
        return;
      }
      onBridgeTurn(turn);
    },
    [onBridgeTurn],
  );

  /**
   * Call with each fresh session log of a terminal tab. Handles a finished
   * turn once: on every chain terminal it records where the turn ended (run
   * lanes), and only on a chain run with autopilot on does it act on it.
   */
  const onTerminalLog = useCallback(
    (tabId: string, log: TerminalSessionLog | null) => {
      const d = depsRef.current;
      const tab = d.tabs().find((t) => t.id === tabId);
      if (!tab?.chain || tab.kind !== "terminal" || ptyExitCode(tabId) != null) return;
      if (tab.bridge) {
        // Engine 2: the bridge reports this tab's turns (onBridgeTurn).
        if (log?.turnDone && !busy.current.has(tabId)) void readBridgeTurn(tabId);
        return;
      }
      const turn = finishedTurn(tab.roleId, log, tab.chain.kind);
      if (log && !seen.current.has(tabId)) {
        seen.current.add(tabId);
        // Finished before this app session (a restart): never acted on again.
        const at = Date.parse(log?.lastPromptAt ?? "");
        if (turn && !(Number.isFinite(at) && at >= startedAt.current - 2000)) {
          handled.current.set(tabId, turn.key);
          return;
        }
      }
      if (!turn || !log || handled.current.get(tabId) === turn.key || busy.current.has(tabId)) return;
      const placed = stageForTab(tab.chain, tab.roleId);
      if (!placed) return;
      // Marked on first sight, autopilot on or off: turning it on later
      // takes over from the next turn and never replays an old one.
      handled.current.set(tabId, turn.key);
      // Every chain run's ledger notes where each turn ended (run lanes),
      // autopilot on or off. intentionally silent: the lanes only lose a bar end.
      void pipelineTurnFinished(tab.chain.chainId, {
        stageId: placed.stage.id,
        roleId: tab.roleId,
        lane: tab.chain.lane ?? null,
        verdict: placed.stage.loopBack && !turn.awaitingPlan ? parseReviewVerdict(log.lastReply ?? "") : null,
      }).catch(() => {});
      busy.current.add(tabId);
      let job: Job = { tab, chain: tab.chain, log, awaitingPlan: turn.awaitingPlan };
      void (async () => {
        const runId = tab.chain!.chainId;
        /** The decision's hand-off claim until it is carried out. */
        let claimed: string | undefined;
        try {
          const view = await getPipelineRun(runId).catch(() => null);
          if (!view?.run.autopilot?.enabled) return;
          // Complete is final: a late turn changes nothing.
          if (view.run.status === "complete") return;
          // Waiting for you (or stopped): no checks; the core notes the turn was left alone.
          const acting = !view.run.status || view.run.status === "running";
          let reply = (turn.awaitingPlan ? log.plan : log.lastReply)?.trim() ?? "";
          let ownReply = reply;
          // A refused request (usage limit) stops the run; nothing else is checked.
          let rateLimit = log.rateLimit?.trim() || null;
          const roles = stageRoles(placed.stage);
          if (roles.length > 1) {
            // Parallel reviewers: decide when the stage's own reviewer has a
            // finished turn not decided on yet and every parallel reviewer
            // has finished one (its latest, even if used before). A re-ask
            // then needs only the stage's reviewer to answer again.
            const laneId = tab.chain!.lane ?? null;
            const tabIds = laneId
              ? (view.run.lanes?.find((l) => l.id === laneId)?.tabIds ?? {})
              : view.run.tabIds;
            const reviews = roles.map((role) => {
              const id = tabIds[role];
              // This tab's log is the one just read; the others' are stored.
              const own = id === tabId ? log : id ? d.sessionLog(id) : null;
              const done = id ? finishedTurn(role, own, tab.chain!.kind) : null;
              return { role, id, log: own, key: done ? `${id}|${done.key}` : null };
            });
            const first = reviews[0];
            if (reviews.some((r) => !r.id || !r.key || !r.log) || merged.current.has(first.key!)) return;
            rateLimit = reviews.map((r) => r.log?.rateLimit?.trim()).find((text) => !!text) ?? null;
            merged.current.add(first.key!);
            const main = d.tabs().find((t) => t.id === first.id);
            if (!main?.chain) return;
            ownReply = first.log!.lastReply.trim();
            reply = mergeReviews(
              reviews.map((r) => ({
                name: roleDisplayName(r.role, d.roles()),
                reply: r.log?.lastReply ?? "",
              })),
              // A plan reviewer's "changes" verdict; the stage's kind says which it is.
              stageBehaviour(placed.def, placed.stage) === "plan_reviewer" ? "REQUIRES REVISION" : "REQUEST CHANGES",
            );
            // The hand-off carries the stage reviewer's own reply; the merged one decides.
            job = { tab: main, chain: main.chain, log: first.log!, awaitingPlan: false };
          }
          const lane = job.chain.lane ?? null;
          // The round this turn ends: a round sent back while its checks run makes it stale.
          const round = currentRound(view.run, lane);
          const turnKey = turnId(job.tab.id, job.log);
          if (acting && !rateLimit && placed.stage.gates?.length) {
            await pipelineRunGates(
              runId,
              placed.stage.id,
              job.tab.cwd,
              githubPrUrls(job.log.lastReply),
              lane,
              round,
            );
          }
          // The checks take a while: a newer prompt in the tab since (a round
          // sent back, your own message) means this turn's reply is not the
          // stage's result any more. Only a later prompt counts: a read that
          // landed out of order carries an older one.
          const latest = d.sessionLog(job.tab.id);
          if (promptAfterTurn(latest?.lastPromptAt, job.log.lastPromptAt)) {
            // intentionally silent: the ledger line is extra; nothing else happens either way.
            await pipelineNote(runId, {
              stageId: placed.stage.id,
              summary: `Skipped ${placed.stage.title}'s turn: ${job.tab.label} got a newer prompt while its checks ran.`,
              stop: false,
            }).catch(() => {});
            return;
          }
          // intentionally silent: unknown usage (no reading, or a stale one) is
          // null, never 0: autopilot carries on, and a rate-limit error stops it.
          const usage = usagePercent(await getClaudeUsage().catch(() => null));
          const report = turnReport({
            stage: placed.stage,
            reply,
            chat: false,
            usage,
            rateLimit,
            awaitingPlan: turn.awaitingPlan,
            lane,
            ownReply,
            chainKind: job.chain.kind,
          });
          const decision = await pipelineDecide(runId, { ...report, round, turn: turnKey });
          claimed = decision.claim;
          await carryOut(job, runId, decision, reply, report.verdict);
          claimed = undefined;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          // intentionally silent: a claim left behind only adds a warning to your own hand-off.
          if (claimed) await pipelineReleaseHandoff(runId, claimed).catch(() => {});
          await stop(runId, tabId, placed.stage.id, `Autopilot stopped: ${message}`);
        } finally {
          busy.current.delete(tabId);
        }
      })();
    },
    [carryOut, readBridgeTurn, stop],
  );

  /**
   * Overview › Continue on a run waiting after a restart: the core runs it
   * again, then each of its current stage tabs' turns is decided as if it
   * had just finished (one decided before the quit is ignored by the core).
   * A bridged tab's turn is read back from the bridge.
   */
  const continueRun = useCallback(
    async (runId: string) => {
      const tabIds = await pipelineContinue(runId);
      for (const tabId of tabIds) {
        if (depsRef.current.tabs().find((t) => t.id === tabId)?.bridge) {
          // intentionally silent: a stage with no finished turn has nothing to decide.
          const turn = await pipelineBridgeTurn(tabId).catch(() => null);
          handledBridge.current.delete(tabId);
          if (turn) onBridgeTurn(turn);
          continue;
        }
        // intentionally silent: a tab with no log has no turn to decide.
        const log = await terminalSessionLog(tabId).catch(() => null);
        // Seen only with a log, as onTerminalLog marks it: a log that shows
        // up later still gets the restart check.
        if (log) seen.current.add(tabId);
        handled.current.delete(tabId);
        onTerminalLog(tabId, log);
      }
    },
    [onBridgeTurn, onTerminalLog],
  );

  return { onTerminalLog, onBridgeTurn, continueRun };
}
