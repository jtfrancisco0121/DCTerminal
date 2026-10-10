import { useCallback, useEffect, useState } from "react";
import type { PipelineRun, TabSummary } from "../bridge";
import {
  getPipelineRun,
  listenChainRunUpdated,
  pipelinePromotePlan,
  pipelineSetCandidatePlan,
} from "../bridge";
import {
  coalescedReload,
  isForRun,
  OVERVIEW_FALLBACK_POLL_MS,
} from "../pipeline/overviewRefresh";
import type { TabRuntime } from "../liveTabs";
import type { PipelineKind } from "../pipeline/stages";
import {
  overviewStages,
  pullPlannerText,
  pullPlanReviewText,
  verdictHistory,
} from "../pipeline/overviewModel";
import { liveTerminalReader, type TerminalReader } from "../pipeline/terminalText";
import { verdictTone } from "../handoff/verdict";

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
};

function overviewTitle(run: PipelineRun, kind: PipelineKind): string {
  if (!run.chainId) return "Pipeline overview";
  return kind === "execute" ? "Eagle-Eye 2 overview" : "Eagle-Eye 1 overview";
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
}: Props) {
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [candidateDraft, setCandidateDraft] = useState("");
  const [approvedDraft, setApprovedDraft] = useState("");
  const [busy, setBusy] = useState(false);

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

  const pullFromPlanner = async () => {
    if (!run) return;
    const pulled = await pullPlannerText(run, tabs, runtimes, terminalReader);
    if (pulled.text) setCandidateDraft(pulled.text);
    else onNotice("Nothing to pull", pulled.reason ?? "No Planner reply yet.");
  };

  const pullFromPlanReviewer = () => {
    if (!run) return;
    const pulled = pullPlanReviewText(run, tabs, runtimes, terminalReader);
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

  const stages = overviewStages(run, tabs, runtimes, terminalReader);
  const implementerTab = tabs.find((t) => t.id === run.tabIds.role_implementer);
  // A chain's Implementer may already be running; promote only fills a draft form.
  const canPromote = !run.chainId || implementerTab?.phase === "draft";
  const originalRequest = run.originalRequest?.trim() ?? "";
  const round = Math.max(1, run.round ?? 1);

  return (
    <section className="pipeline-overview" aria-label="Pipeline overview">
      <header className="pipeline-overview-header">
        <div>
          <h2 className="pipeline-overview-title">{overviewTitle(run, kind)}</h2>
          <p className="hint pipeline-overview-meta">
            {kind === "execute" ? "Implement → PR review" : "Plan → review → implement → PR"} ·{" "}
            <span className="pipeline-overview-cwd">{cwd || run.cwd}</span>
          </p>
        </div>
        <p className="hint">
          Stage: <strong>{run.stage}</strong>
          {round > 1 && <span className="pipeline-round"> · round {round}</span>}
        </p>
      </header>

      <section className="pipeline-request" aria-label="Original request">
        <h3>Original request</h3>
        {originalRequest ? (
          <p className="pipeline-request-text">{originalRequest}</p>
        ) : (
          <p className="hint">Not filled in yet. It comes from the first stage's form.</p>
        )}
      </section>

      <div className="pipeline-lanes">
        {stages.map((stage) => (
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
              </div>
            )}
          </article>
        ))}
      </div>

      {kind === "full" && (
        <section className="pipeline-plan-panel">
          <h3>Plan for review</h3>
          <p className="hint">
            Paste or pull the Planner output, save as candidate plan, then run Plan Reviewer.
          </p>
          <textarea
            className="text-input prompt-area pipeline-plan-area"
            rows={8}
            value={candidateDraft}
            onChange={(e) => setCandidateDraft(e.target.value)}
            disabled={busy}
          />
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
        <textarea
          className="text-input prompt-area pipeline-plan-area"
          rows={8}
          value={approvedDraft}
          onChange={(e) => setApprovedDraft(e.target.value)}
          disabled={busy}
        />
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
        </div>
      </section>
    </section>
  );
}
