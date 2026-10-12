import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { DisabledReason } from "./DisabledReason";
import type { GateResult, PipelineRun, TabSummary } from "../bridge";
import {
  exportTextFile,
  getPipelineRun,
  listenChainRunUpdated,
  pipelinePromotePlan,
  pipelineRunGates,
  pipelineSetAutopilot,
  pipelineSetCandidatePlan,
} from "../bridge";
import { maxRounds, pipelineDef, pipelineStages } from "../pipeline/defs";
import { eventLabel, eventTime, followUps, formatRunReport, stageTitle } from "../pipeline/runReport";
import { githubPrUrls } from "../handoff/map";
import { errorText } from "./InlineNotice";
import {
  coalescedReload,
  isForRun,
  OVERVIEW_FALLBACK_POLL_MS,
} from "../pipeline/overviewRefresh";
import type { TabRuntime } from "../liveTabs";
import { pipelineName, type PipelineKind } from "../pipeline/stages";
import {
  overviewStages,
  pullPlannerText,
  pullPlanReviewText,
  stageReply,
  verdictHistory,
  type SessionLogs,
} from "../pipeline/overviewModel";
import { liveTerminalReader, type TerminalReader } from "../pipeline/terminalText";
import { verdictTone } from "../handoff/verdict";
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
};

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

  const reload = useCallback(async () => {
    try {
      const view = await getPipelineRun(runId);
      setRun(view.run);
      setLoadError(null);
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
      const implId = run?.tabIds.role_implementer;
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
  const implementerTab = tabs.find((t) => t.id === run.tabIds.role_implementer);
  // A chain's Implementer may already be running; promote only fills a draft form.
  const canPromote = !run.chainId || implementerTab?.phase === "draft";
  const originalRequest = run.originalRequest?.trim() ?? "";
  const round = Math.max(1, run.round ?? 1);
  const def = pipelineDef(run.kind);
  const stageDefs = pipelineStages(run.kind);
  const autopilotOn = !!run.autopilot?.enabled;
  const later = followUps(run);
  const events = [...(run.events ?? [])].reverse();

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
              onChange={(e) => void setAutopilot(e.currentTarget.checked)}
            />{" "}
            <strong>Autopilot</strong>
          </label>
          <p className="hint">
            {autopilotOn
              ? "After each terminal stage's turn, the checks run and the run moves on, sends a round back, or stops for you. It stops before a checkpoint, at the round cap, when Claude needs you, and near your usage limit. It never merges."
              : "Off: every hand-off waits for you. Turn it on to let terminal stages hand on by themselves."}
          </p>
          {autopilotOn && run.autopilot?.waiting && (
            <p className="pipeline-autopilot-waiting" role="status">
              Waiting for you: {run.autopilot.waiting}
            </p>
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

      <div className="pipeline-lanes">
        {stages.map((stage) => {
          const stageDef = stageDefs.find((s) => s.id === stage.def.stageId);
          const gates = run.gates?.[stage.def.stageId];
          const hasGates = (stageDef?.gates?.length ?? 0) > 0;
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
            {stageDef?.loopBack && (
              <p className="hint pipeline-round-cap">
                Round {round} of at most {maxRounds(stageDef)}
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
                : "Use Hand off on the Plan Reviewer tab. Promote only fills a draft Implementer form."
            }
            onClick={() => void promote()}
          >
            {kind === "execute" ? "Send to Implementer" : "Approve for implementation"}
          </button>
          {!busy && (!approvedDraft.trim() || !canPromote) && (
            <DisabledReason className="disabled-reason-inline">
              {!canPromote
                ? "The Implementer tab already started. Use Hand off on the Plan Reviewer tab."
                : "Paste or pull the plan text first."}
            </DisabledReason>
          )}
        </div>
      </section>

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
