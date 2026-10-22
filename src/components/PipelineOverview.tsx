import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { DisabledReason } from "./DisabledReason";
import type { GateResult, PipelineRun, PlannedTask, ProviderModelSettings, TabSummary } from "../bridge";
import {
  exportTextFile,
  getPipelineRun,
  listenChainRunUpdated,
  pipelinePromotePlan,
  pipelineRunGates,
  pipelineRunTasks,
  pipelineSetAutopilot,
  pipelineSetCandidatePlan,
} from "../bridge";
import {
  behaviourRole,
  DEFAULT_PAUSE_AT_USAGE_PERCENT,
  maxRounds,
  pipelineDef,
  pipelineStages,
  stageBehaviour,
  type StageDef,
} from "../pipeline/defs";
import { stopReasonText } from "../pipeline/stopReasons";
import { autopilotUsageLine, type RateWindow } from "../usage/limits";
import { eventLabel, eventTime, followUps, formatRunReport, reviewRound, stageTitle } from "../pipeline/runReport";
import { githubPrUrls } from "../handoff/map";
import { lanesFromReply, lanesFromTasks } from "../pipeline/prPlan";
import { errorText } from "./InlineNotice";
import { RunLanes } from "./RunLanes";
import { VerifyWaitPanel } from "./VerifyWaitPanel";
import { verifyWaitKey } from "../pipeline/verify";
import { StoryCheckpointPanel } from "./StoryCheckpointPanel";
import { StoryList } from "./StoryList";
import { StoryResendButton } from "./StoryResendButton";
import { laneStories, storyProgress, storyWaitKey } from "../pipeline/stories";
import {
  coalescedReload,
  isForRun,
  OVERVIEW_FALLBACK_POLL_MS,
} from "../pipeline/overviewRefresh";
import type { TabRuntime } from "../liveTabs";
import { pipelineName, type PipelineKind } from "../pipeline/stages";
import {
  laneLabel,
  overviewStages,
  pullPlannerText,
  pullPlanReviewText,
  stageReply,
  verdictHistory,
  type SessionLogs,
} from "../pipeline/overviewModel";
import { liveTerminalReader, type TerminalReader } from "../pipeline/terminalText";
import { TicketsSinceIntake } from "./TicketsSinceIntake";
import { ClickUpUpdates } from "./ClickUpUpdates";
import { RoundSummary } from "./RoundSummary";
import { haikuDefaultModeNote } from "../pipeline/haikuMode";
import { parseReviewVerdict, verdictTone } from "../handoff/verdict";
import { roleDisplayName } from "../handoff/transitions";
import type { TerminalState } from "../terminal/claudeState";

type Props = {
  runId: string;
  cwd: string;
  tabs: TabSummary[];
  runtimes: Record<string, TabRuntime>;
  onJump: (tabId: string) => void;
  onWatch: (tabId: string) => void;
  onRefreshTabs: () => Promise<unknown>;
  onNotice: (title: string, body: string) => void;
  /** Reads terminal stage tabs. Tests pass a fake. */
  terminalReader?: TerminalReader;
  /** Claude role terminal states by tab id (Working / Needs you / Exited). */
  terminalStates?: Record<string, TerminalState>;
  /** Claude session logs by tab id: verdicts and plans of Claude terminals come from here. */
  sessionLogs?: SessionLogs;
  /** Fan the run out into one lane per pull request (ADR-014 phase 3). */
  onFanOut?: (runId: string) => Promise<void>;
  /** Start a waiting lane's Implementer. */
  onStartLane?: (runId: string, laneId: string) => Promise<void>;
  /** Marks an active lane approved by hand, then starts the lanes that unblocks. */
  onApproveLane?: (runId: string, laneId: string) => Promise<void>;
  /** Marks a run without lanes complete by hand (autopilot stopped at its last stage). */
  onApproveRun?: (runId: string) => Promise<void>;
  /** Continue a run waiting after a restart: autopilot decides the turn that finished meanwhile. */
  onContinue?: (runId: string) => Promise<void>;
  /** Engine 2 (V5, D28): take a stage over from autopilot, or hand it back. */
  onStageControl?: (runId: string, tabId: string, kind: "takeOver" | "handBack") => Promise<void>;
  /** The latest Claude limit windows, for the autopilot usage line. Null: not loaded. */
  usageWindows?: RateWindow[] | null;
  /** Model settings, to say when a stage on Haiku runs in default mode (D12a). */
  modelSettings?: ProviderModelSettings | null;
};

/** "Round 4", or "Round 2 of at most 3" when the loop-back has a round cap. */
function roundText(round: number, stage: StageDef): string {
  const cap = maxRounds(stage);
  return cap == null ? `Round ${round}` : `Round ${round} of at most ${cap}`;
}

function overviewTitle(run: PipelineRun, kind: PipelineKind): string {
  if (!run.chainId) return "Pipeline overview";
  return `${pipelineName(kind)} overview`;
}

function overviewMeta(kind: PipelineKind): string {
  if (kind === "execute") return "Implement → PR review";
  if (kind === "full") return "Plan → review → implement → PR";
  return pipelineStages(kind)
    .map((stage) => stage.title)
    .join(" → ");
}

function GateList({ results, label }: { results: GateResult[]; label: string }) {
  return (
    <ul className="pipeline-gates" aria-label={label}>
      {results.map((result, i) => (
        <li key={`${result.kind}-${i}`} className={`pipeline-gate pipeline-gate-${result.status}`}>
          <span className="pipeline-gate-status">{result.status}</span> <code>{result.label}</code>{" "}
          {result.summary}
          {result.output?.trim() && (
            <details>
              <summary>Output</summary>
              <pre className="plan-markdown">{result.output}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Saves the run report (`formatRunReport`) where the user picks. */
async function exportRunReport(run: PipelineRun): Promise<string | null> {
  const path = await save({
    defaultPath: `${pipelineName(run.kind).replace(/[^\w-]+/g, "-")}-${run.id}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
    title: "Export run report",
  });
  if (!path) return null;
  await exportTextFile(path, formatRunReport(run));
  return path;
}

export function PipelineOverview({
  runId,
  cwd,
  tabs,
  runtimes,
  onJump,
  onWatch,
  onRefreshTabs,
  onNotice,
  terminalReader = liveTerminalReader,
  terminalStates,
  sessionLogs,
  onFanOut,
  onStartLane,
  onApproveLane,
  onApproveRun,
  onContinue,
  onStageControl,
  usageWindows = null,
  modelSettings = null,
}: Props) {
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [candidateDraft, setCandidateDraft] = useState("");
  const [approvedDraft, setApprovedDraft] = useState("");
  // The plan boxes stay folded until they hold text or the user opens them.
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [approvedOpen, setApprovedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  /** Engine 2: the Planner's tasks (`tasks.json`), which the fan-out offer reads. */
  const [runTasks, setRunTasks] = useState<PlannedTask[] | null>(null);

  const reload = useCallback(async () => {
    try {
      const view = await getPipelineRun(runId);
      setRun(view.run);
      setLoadError(null);
      if ((view.run.engine ?? 1) >= 2) {
        let planned: PlannedTask[] | null = null;
        try {
          planned = (await pipelineRunTasks(runId))?.tasks ?? null;
        } catch {
          // intentionally silent: without tasks.json the offer reads the plan stage's reply.
        }
        setRunTasks(planned);
      } else {
        // Engine 1 fans out from the plan stage's reply, never another run's tasks.
        setRunTasks(null);
      }
      setCandidateDraft((prev) => prev || view.run.candidatePlan || "");
      setApprovedDraft((prev) => prev || view.run.approvedPlan || "");
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [runId]);

  useEffect(() => {
    const refresh = coalescedReload(reload);
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listenChainRunUpdated((event) => {
      if (isForRun(event, runId)) refresh.request();
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      // intentionally silent: without the live event the overview still polls on a timer.
      .catch(() => {});
    refresh.request();
    const timer = window.setInterval(() => refresh.request(), OVERVIEW_FALLBACK_POLL_MS);
    return () => {
      disposed = true;
      refresh.stop();
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [reload, runId]);

  const kind = (run?.kind ?? "full") as PipelineKind;

  const setAutopilot = async (enabled: boolean) => {
    if (!run) return;
    try {
      await pipelineSetAutopilot(run.id, enabled);
      await reload();
    } catch (err: unknown) {
      onNotice("Autopilot not changed", errorText(err));
    }
  };

  /** Runs a stage's checks now, against its tab's folder and the PRs its reply names. */
  const runChecks = async (stageId: string, tab: TabSummary | undefined, reply: string) => {
    if (!run) return;
    setChecking((prev) => ({ ...prev, [stageId]: true }));
    try {
      await pipelineRunGates(run.id, stageId, tab?.cwd ?? null, githubPrUrls(reply));
      await reload();
    } catch (err: unknown) {
      onNotice("Checks did not run", errorText(err));
    } finally {
      setChecking((prev) => ({ ...prev, [stageId]: false }));
    }
  };

  const fanOut = async () => {
    if (!run || !onFanOut) return;
    setBusy(true);
    try {
      await onFanOut(run.id);
      await reload();
    } catch (err: unknown) {
      onNotice("Did not fan out", errorText(err));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const startLaneNow = async (laneId: string) => {
    if (!run || !onStartLane) return;
    setBusy(true);
    try {
      await onStartLane(run.id, laneId);
      await reload();
    } catch (err: unknown) {
      onNotice("Lane did not start", errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const approveLaneNow = async (laneId: string) => {
    if (!run || !onApproveLane) return;
    setBusy(true);
    try {
      await onApproveLane(run.id, laneId);
      await reload();
    } catch (err: unknown) {
      onNotice("Lane not marked approved", errorText(err));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const approveRunNow = async () => {
    if (!run || !onApproveRun) return;
    setBusy(true);
    try {
      await onApproveRun(run.id);
      await reload();
    } catch (err: unknown) {
      onNotice("Run not marked complete", errorText(err));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const continueNow = async () => {
    if (!run || !onContinue) return;
    setBusy(true);
    try {
      await onContinue(run.id);
      await reload();
    } catch (err: unknown) {
      onNotice("Run not continued", errorText(err));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const controlStage = async (tabId: string, kind: "takeOver" | "handBack") => {
    if (!run || !onStageControl) return;
    setBusy(true);
    try {
      await onStageControl(run.id, tabId, kind);
    } catch (err: unknown) {
      onNotice(kind === "takeOver" ? "Not taken over" : "Not handed back", errorText(err));
    } finally {
      await reload();
      setBusy(false);
    }
  };

  const exportReport = async () => {
    if (!run) return;
    try {
      const path = await exportRunReport(run);
      if (path) onNotice("Run report saved", path);
    } catch (err: unknown) {
      onNotice("Run report not saved", errorText(err));
    }
  };

  const pullFromPlanner = async () => {
    if (!run) return;
    const pulled = await pullPlannerText(run, tabs, runtimes, terminalReader, sessionLogs);
    if (pulled.text) setCandidateDraft(pulled.text);
    else onNotice("Nothing to pull", pulled.reason ?? "No Planner reply yet.");
  };

  const pullFromPlanReviewer = () => {
    if (!run) return;
    const pulled = pullPlanReviewText(run, tabs, runtimes, terminalReader, sessionLogs);
    if (pulled.text) setApprovedDraft(pulled.text);
    else onNotice("Nothing to pull", pulled.reason ?? "No Plan Reviewer reply yet.");
  };

  const saveCandidate = async () => {
    const text = candidateDraft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await pipelineSetCandidatePlan(runId, text);
      await reload();
      await onRefreshTabs();
      onNotice("Candidate plan saved", "Plan Reviewer tab can use this in its form.");
    } catch (err: unknown) {
      onNotice("Could not save plan", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const promote = async () => {
    const text = approvedDraft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await pipelinePromotePlan(runId, text);
      await reload();
      await onRefreshTabs();
      const implId = run ? run.tabIds[behaviourRole(run.kind, "implementer")] : undefined;
      onNotice("Approved for implementation", "Implementer form updated. Open that tab and Start.");
      if (implId) onJump(implId);
    } catch (err: unknown) {
      onNotice("Could not promote plan", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="pipeline-overview">
        <p className="error">{loadError}</p>
      </section>
    );
  }

  if (!run) {
    return (
      <section className="pipeline-overview">
        <p className="hint">Loading pipeline…</p>
      </section>
    );
  }

  const stages = overviewStages(run, tabs, runtimes, terminalReader, terminalStates, sessionLogs);
  // The implementer stage's role on this pipeline (a copied Implementer keeps its own id).
  const implementerRole = behaviourRole(run.kind, "implementer");
  const implementerTab = tabs.find((t) => t.id === run.tabIds[implementerRole]);
  // A chain's Implementer may already be running; promote only fills a draft form.
  const canPromote = !run.chainId || implementerTab?.phase === "draft";
  // Why promote is off: the Implementer runs already, or there is none yet
  // (autopilot waiting at the checkpoint, say), and Hand off starts it.
  const promoteBlocked = !run.chainId
    ? null
    : implementerTab
      ? "The Implementer tab already started. Use Hand off on the Plan Reviewer tab."
      : run.tabIds[implementerRole]
        ? "The Implementer tab is closed. Use Hand off on the Plan Reviewer tab to start a new one."
        : "There is no Implementer tab yet. Use Hand off on the Plan Reviewer tab to start it.";
  const originalRequest = run.originalRequest?.trim() ?? "";
  const round = Math.max(1, run.round ?? 1);
  const def = pipelineDef(run.kind);
  const stageDefs = pipelineStages(run.kind);
  // An engine-1 run is manual only (V6): its saved autopilot flag does nothing.
  // A run a mid-run engine switch made manual (`manualOnly`) is engine 1 too.
  const manualOnly = (run.engine ?? 1) < 2 || !!run.manualOnly;
  const autopilotOn = !manualOnly && !!run.autopilot?.enabled;
  // Mark complete is only for a run that reached its last stage.
  const atLastStage = stageDefs.length > 0 && run.stage === stageDefs[stageDefs.length - 1].id;
  const later = followUps(run);
  const events = [...(run.events ?? [])].reverse();
  const lanes = run.lanes ?? [];
  // From the fan-out stage on, rounds are per lane (shown in Pull requests).
  const fanOutIndex = run.fanOutStage ? stageDefs.findIndex((s) => s.id === run.fanOutStage) : -1;
  // Fan-out reads the Planner's tasks (engine 2), else the pull-request list
  // in the reply of the stage before the Implementer.
  const fanStage = (def && stageDefs.find((s) => stageBehaviour(def, s) === "implementer")) ?? null;
  const planStage = fanStage ? stageDefs[stageDefs.indexOf(fanStage) - 1] ?? null : null;
  const planTab = planStage ? tabs.find((t) => t.id === run.tabIds[planStage.roleId]) : undefined;
  // Engine 2 reads the Planner's tasks.json; otherwise the plan stage's reply.
  const plannedPrs =
    run.chainId && !lanes.length && planTab && fanStage
      ? runTasks
        ? lanesFromTasks(runTasks)
        : lanesFromReply(stageReply(planTab, runtimes[planTab.id], terminalReader, sessionLogs))
      : [];
  const implementerStarted = !!fanStage && !!tabs.find(
    (t) => t.id === run.tabIds[fanStage.roleId] && t.phase !== "draft",
  );
  const laneTab = (id: string | undefined) => (id ? tabs.find((t) => t.id === id) : undefined);
  const laneBlocked = (deps: string[] = []) =>
    deps.filter((dep) => lanes.find((l) => l.id === dep)?.status !== "approved");

  return (
    <section className="pipeline-overview" aria-label="Pipeline overview">
      <header className="pipeline-overview-header">
        <div>
          <h2 className="pipeline-overview-title">{overviewTitle(run, kind)}</h2>
          <p className="hint pipeline-overview-meta">
            {overviewMeta(kind)} · <span className="pipeline-overview-cwd">{cwd || run.cwd}</span>
          </p>
        </div>
        <p className="hint">
          Stage: <strong>{run.stage}</strong>
          {round > 1 && <span className="pipeline-round"> · round {round}</span>}
        </p>
      </header>

      {run.chainId && def && (
        <section className="pipeline-autopilot" aria-label="Autopilot">
          <label className="pipeline-autopilot-toggle">
            <input
              type="checkbox"
              checked={autopilotOn}
              disabled={manualOnly}
              title={
                run.manualOnly
                  ? "This run is manual from now on: it was switched from the pipeline bridge to engine 1 mid-run."
                  : undefined
              }
              onChange={(e) => void setAutopilot(e.currentTarget.checked)}
            />{" "}
            <strong>Autopilot</strong>
          </label>
          <p className="hint">
            {run.manualOnly
              ? "This run is manual from now on: it was switched from the pipeline bridge to engine 1 mid-run, so autopilot cannot be turned back on. Hand each stage on yourself; start a new run to use autopilot."
              : manualOnly
                ? "This run is manual only: it started before pipeline v2, or its pipeline has a stage autopilot cannot follow (parallel reviewers, or a stage that is not a planner, reviewer or implementer). Hand each stage on yourself; start a new run to use autopilot."
                : autopilotOn
                  ? "After each terminal stage's turn, the checks run and the run moves on, sends a round back, or stops for you. Rounds go back until the reviewer approves (or up to a round cap, if the pipeline sets one). It stops before a checkpoint, when Claude needs you, near your usage limit, and when Claude refuses a request for a usage limit. It never merges."
                  : "Off: every hand-off waits for you. Turn it on to let terminal stages hand on by themselves."}
          </p>
          {run.engineNote && (
            <p className="hint" data-testid="engine-note">
              {run.engineNote}
            </p>
          )}
          {autopilotOn && usageWindows && (
            <p className="hint" data-testid="autopilot-usage">
              {
                autopilotUsageLine(
                  usageWindows,
                  def.autopilot?.pauseAtUsagePercent ?? DEFAULT_PAUSE_AT_USAGE_PERCENT,
                ).text
              }
            </p>
          )}
          {autopilotOn && run.autopilot?.waiting && (
            <p className="pipeline-autopilot-waiting" role="status">
              Waiting for you:{" "}
              {stopReasonText(run.stopReason) && <strong>{stopReasonText(run.stopReason)} </strong>}
              {run.autopilot.waiting}
            </p>
          )}
          {autopilotOn && <VerifyWaitPanel key={verifyWaitKey(run)} run={run} onDone={reload} onNotice={onNotice} />}
          {autopilotOn && <StoryCheckpointPanel key={storyWaitKey(run)} run={run} onDone={reload} onNotice={onNotice} />}
          {autopilotOn && run.status === "waiting" && run.stopReason === "app_restarted" && onContinue && (
            <div className="button-row">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                title="Let autopilot act on the turn that finished while the app was closed."
                onClick={() => void continueNow()}
              >
                Continue
              </button>
            </div>
          )}
          {autopilotOn && run.autopilot?.waiting && lanes.length === 0 && atLastStage && onApproveRun && (
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                title={
                  def.approveAtEnd
                    ? "Approve the round's scope and wave order. The run is then complete."
                    : "Approve the run yourself, for example when its last reviewer approved it but listed findings."
                }
                onClick={() => void approveRunNow()}
              >
                {def.approveAtEnd ? "Approve round" : "Mark complete"}
              </button>
            </div>
          )}
        </section>
      )}

      <section className="pipeline-request" aria-label="Original request">
        <h3>Original request</h3>
        {originalRequest ? (
          <p className="pipeline-request-text">{originalRequest}</p>
        ) : (
          <p className="hint">Not filled in yet. It comes from the first stage's form.</p>
        )}
      </section>

      {(run.engine ?? 1) >= 2 && <TicketsSinceIntake runId={run.id} />}
      {(run.engine ?? 1) >= 2 && (
        <ClickUpUpdates
          runId={run.id}
          refreshKey={`${run.status ?? ""}|${run.verifications?.length ?? 0}|${run.updatedAt ?? ""}`}
        />
      )}
      {(run.engine ?? 1) >= 2 && <RoundSummary runId={run.id} refreshKey={run.updatedAt ?? ""} />}

      <div className="pipeline-lanes">
        {stages.map((stage) => {
          const stageDef = stageDefs.find((s) => s.id === stage.def.stageId);
          const gates = run.gates?.[stage.def.stageId];
          const hasGates = (stageDef?.gates?.length ?? 0) > 0;
          const haikuNote = haikuDefaultModeNote(stage.tab, modelSettings);
          return (
          <article
            key={stage.def.roleId}
            className={`pipeline-lane${stage.current ? " pipeline-lane-current" : ""}`}
            aria-label={stage.def.title}
          >
            <div className="pipeline-lane-head">
              <h3>{stage.def.title}</h3>
              <span className={`pipeline-lane-status pipeline-lane-status-${stage.status.tone}`}>
                {stage.status.label}
              </span>
            </div>
            <p className="hint pipeline-lane-tab">{stage.tab?.label ?? "—"}</p>
            {haikuNote && <p className="hint pipeline-haiku-mode">{haikuNote}</p>}
            {stage.verdict && (
              <p
                className={`pipeline-verdict pipeline-verdict-${verdictTone(stage.verdict)}`}
              >
                {stage.verdict}
              </p>
            )}
            {verdictHistory(run, stage.def.roleId).length > 0 && (
              <ol
                className="pipeline-verdict-history"
                aria-label={`${stage.def.title} verdicts by round`}
              >
                {verdictHistory(run, stage.def.roleId).map((entry, i) => (
                  <li key={`${entry.round}-${i}`}>
                    Round {entry.round}: {entry.verdict}
                  </li>
                ))}
              </ol>
            )}
            {(stageDef?.alsoReviewers ?? []).map((role) => {
              const other = tabs.find((t) => t.id === run.tabIds[role]);
              const said = other
                ? parseReviewVerdict(stageReply(other, runtimes[other.id], terminalReader, sessionLogs))
                : null;
              return (
                <p key={role} className="hint pipeline-also-reviewer">
                  Also reviewed by {roleDisplayName(role, null)}: {other ? (said ?? "no verdict yet") : "not started"}
                </p>
              );
            })}
            {stageDef?.loopBack && !(lanes.length > 0 && fanOutIndex >= 0 && stageDefs.indexOf(stageDef) >= fanOutIndex) && (
              <p className="hint pipeline-round-cap">
                {roundText(reviewRound(run, null, stageDef), stageDef)}
              </p>
            )}
            {gates && (
              <GateList
                results={gates.results}
                label={`${stage.def.title} checks, round ${gates.round}`}
              />
            )}
            {stage.handedIn && (
              <details className="pipeline-handed-in">
                <summary>Handed in ({stage.handedIn.length.toLocaleString()} chars)</summary>
                <pre className="plan-markdown">{stage.handedIn}</pre>
              </details>
            )}
            {stage.tabId && stage.tab && (
              <div className="button-row pipeline-lane-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onJump(stage.tabId!)}
                >
                  Jump
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onWatch(stage.tabId!)}
                >
                  Watch in split
                </button>
                {onStageControl && (run.engine ?? 1) >= 2 && stage.tab.bridge && (
                  (run.takenOver ?? []).includes(stage.tabId) ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      title="Let autopilot drive this stage again. A turn that already has a result is acted on at once."
                      onClick={() => void controlStage(stage.tabId!, "handBack")}
                    >
                      Hand back
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      title="Drive this stage yourself: autopilot stops checking and acting on its turns, and you can type in it."
                      onClick={() => void controlStage(stage.tabId!, "takeOver")}
                    >
                      Take over
                    </button>
                  )
                )}
                {hasGates && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!!checking[stage.def.stageId]}
                    onClick={() =>
                      void runChecks(
                        stage.def.stageId,
                        stage.tab,
                        stageReply(stage.tab, runtimes[stage.tabId!], terminalReader, sessionLogs),
                      )
                    }
                  >
                    {checking[stage.def.stageId] ? "Checking…" : "Run checks"}
                  </button>
                )}
              </div>
            )}
          </article>
          );
        })}
      </div>

      {plannedPrs.length >= 2 && onFanOut && !implementerStarted && (
        <section className="pipeline-fan-out" aria-label="Fan out">
          <h3>Fan out by pull request</h3>
          <p className="hint">
            The plan ships as {plannedPrs.length} pull requests. Fan out gives each one its own
            Implementer in its own git worktree, then its own PR Reviewer. Pull requests that build
            on another wait until that one is approved.
          </p>
          <ul>
            {plannedPrs.map((pr) => (
              <li key={pr.id}>
                {laneLabel(pr)}
                {pr.dependsOn.length > 0 && (
                  <span className="hint"> · after {pr.dependsOn.map((d) => d.toUpperCase()).join(", ")}</span>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void fanOut()}>
            Fan out into {plannedPrs.length} Implementers
          </button>
        </section>
      )}

      {laneStories(run, null).length > 0 && (
        <section className="pipeline-stories" aria-label="Stories">
          <h3>Stories · {storyProgress(run, null)}</h3>
          <StoryList run={run} lane={null} label="Stories of the pull request" />
          {autopilotOn && <StoryResendButton run={run} lane={null} onDone={reload} onNotice={onNotice} />}
        </section>
      )}

      {lanes.length > 0 && (
        <section className="pipeline-pr-lanes" aria-label="Pull requests">
          <h3>Pull requests</h3>
          <ul className="pipeline-pr-lane-list">
            {lanes.map((lane) => {
              const blocked = laneBlocked(lane.dependsOn);
              const lastVerdict = lane.verdicts?.[lane.verdicts.length - 1]?.verdict;
              const laneStage = stageDefs.find((s) => s.id === lane.stage);
              const tabsOfLane = Object.entries(lane.tabIds)
                .map(([roleId, id]) => ({ roleId, tab: laneTab(id) }))
                .filter((entry) => !!entry.tab);
              return (
                <li key={lane.id} className={`pipeline-pr-lane pipeline-pr-lane-${lane.status}`} aria-label={lane.title}>
                  <div className="pipeline-lane-head">
                    <strong>
                      {laneLabel(lane)}
                      {storyProgress(run, lane.id) ? ` · ${storyProgress(run, lane.id)}` : ""}
                    </strong>
                    <span className={`pipeline-lane-status pipeline-pr-lane-status`}>{lane.status}</span>
                  </div>
                  <p className="hint">
                    {stageTitle(run, lane.stage)} ·{" "}
                    {laneStage?.loopBack
                      ? roundText(reviewRound(run, lane.id, laneStage), laneStage).toLowerCase()
                      : `round ${Math.max(1, lane.round)}`}
                    {lastVerdict ? ` · last verdict ${lastVerdict}` : ""}
                    {lane.dependsOn?.length ? ` · after ${lane.dependsOn.map((d) => d.toUpperCase()).join(", ")}` : ""}
                  </p>
                  <StoryList run={run} lane={lane.id} label={`Stories of ${lane.title}`} />
                  {autopilotOn && <StoryResendButton run={run} lane={lane.id} onDone={reload} onNotice={onNotice} />}
                  <div className="button-row">
                    {tabsOfLane.map(({ roleId, tab }) => (
                      <button key={roleId} type="button" className="secondary-button" onClick={() => onJump(tab!.id)}>
                        {tab!.label}
                      </button>
                    ))}
                    {lane.status === "waiting" && onStartLane && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        title={
                          blocked.length
                            ? `Still waiting on ${blocked.map((d) => d.toUpperCase()).join(", ")}; start anyway if you know it is ready.`
                            : undefined
                        }
                        onClick={() => void startLaneNow(lane.id)}
                      >
                        {blocked.length ? "Start anyway" : "Start"}
                      </button>
                    )}
                    {lane.status === "active" && onApproveLane && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        title="Approve this pull request yourself, for example when its reviewer approved it but listed findings."
                        onClick={() => void approveLaneNow(lane.id)}
                      >
                        Mark approved
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {later.length > 0 && (
        <section className="pipeline-followups" aria-label="Follow-ups">
          <h3>Follow-ups</h3>
          <p className="hint">Findings below the round's threshold, kept for later instead of another round.</p>
          <ul>
            {later.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {kind === "full" && (
        <section className="pipeline-plan-panel">
          <h3>Plan for review</h3>
          <p className="hint">
            Paste or pull the Planner output, save as candidate plan, then run Plan Reviewer.
          </p>
          <details
            className="pipeline-plan-details"
            open={candidateOpen || candidateDraft.trim().length > 0}
            onToggle={(e) => setCandidateOpen(e.currentTarget.open)}
          >
            <summary>
              {candidateDraft.trim()
                ? `Plan text (${candidateDraft.length.toLocaleString()} chars)`
                : "Paste the plan text"}
            </summary>
            <textarea
              className="text-input prompt-area pipeline-plan-area"
              aria-label="Plan for review"
              rows={8}
              value={candidateDraft}
              onChange={(e) => setCandidateDraft(e.target.value)}
              disabled={busy}
            />
          </details>
          <div className="button-row">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void pullFromPlanner()}
            >
              Pull from Planner
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !candidateDraft.trim()}
              onClick={() => void saveCandidate()}
            >
              Save candidate plan
            </button>
            {!busy && !candidateDraft.trim() && (
              <DisabledReason className="disabled-reason-inline">
                Paste or pull the plan text to save it.
              </DisabledReason>
            )}
          </div>
        </section>
      )}

      <section className="pipeline-plan-panel">
        <h3>{kind === "execute" ? "Approved plan" : "Approve for implementation"}</h3>
        <p className="hint">
          {kind === "execute"
            ? "Paste your final plan here, then promote to the Implementer tab."
            : "After Plan Reviewer approves, pull or paste the final plan and promote."}
        </p>
        <details
          className="pipeline-plan-details"
          open={approvedOpen || approvedDraft.trim().length > 0}
          onToggle={(e) => setApprovedOpen(e.currentTarget.open)}
        >
          <summary>
            {approvedDraft.trim()
              ? `Plan text (${approvedDraft.length.toLocaleString()} chars)`
              : "Paste the plan text"}
          </summary>
          <textarea
            className="text-input prompt-area pipeline-plan-area"
            aria-label={kind === "execute" ? "Approved plan" : "Plan to approve"}
            rows={8}
            value={approvedDraft}
            onChange={(e) => setApprovedDraft(e.target.value)}
            disabled={busy}
          />
        </details>
        <div className="button-row">
          {kind === "full" && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={pullFromPlanReviewer}
            >
              Pull from Plan Reviewer
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            disabled={busy || !approvedDraft.trim() || !canPromote}
            title={
              canPromote
                ? undefined
                : `${promoteBlocked ?? ""} Promote only fills a draft Implementer form.`
            }
            onClick={() => void promote()}
          >
            {kind === "execute" ? "Send to Implementer" : "Approve for implementation"}
          </button>
          {!busy && (!approvedDraft.trim() || !canPromote) && (
            <DisabledReason className="disabled-reason-inline">
              {!canPromote ? promoteBlocked : "Paste or pull the plan text first."}
            </DisabledReason>
          )}
        </div>
      </section>

      <RunLanes run={run} tabs={tabs} />

      <section className="pipeline-ledger" aria-label="Timeline">
        <div className="pipeline-ledger-head">
          <h3>Timeline</h3>
          <button type="button" className="secondary-button" onClick={() => void exportReport()}>
            Export run report
          </button>
        </div>
        {events.length === 0 ? (
          <p className="hint">Hand-offs, checks and autopilot decisions show up here.</p>
        ) : (
          <ol className="pipeline-ledger-list">
            {events.map((event, i) => (
              <li key={`${event.at}-${i}`} className={`pipeline-event pipeline-event-${event.kind}`}>
                <span className="pipeline-event-when">{eventTime(event.at)}</span>{" "}
                <span className="pipeline-event-kind">{eventLabel(event.kind)}</span>
                {event.stageId && <span className="hint"> · {stageTitle(run, event.stageId)}</span>}
                <span className="hint"> · round {event.round}</span>
                {stopReasonText(event.outcome) && (
                  <div className="pipeline-event-reason">{stopReasonText(event.outcome)}</div>
                )}
                <div>{event.summary}</div>
                {event.detail?.trim() && (
                  <details>
                    <summary>Details</summary>
                    <pre className="plan-markdown">{event.detail}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
