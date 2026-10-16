import { useCallback, useEffect, useMemo, useState } from "react";
import { getPipelineRun, listenChainRunUpdated, type PipelineRun } from "../bridge";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { MarkdownViewSwitch, type MarkdownView } from "../components/MarkdownViewSwitch";
import { PanelHeader } from "../components/PanelHeader";
import { highlightCode } from "../files/highlight";
import { coalescedReload, isForRun, OVERVIEW_FALLBACK_POLL_MS } from "../pipeline/overviewRefresh";
import { planHeading, planOfRun } from "../pipeline/planPane";
import { eventTime } from "../pipeline/runReport";
import { planPaneOpen, setPlanPaneOpen, usePlanPaneOpen } from "./planPaneState";

/**
 * The docked plan pane of a pipeline tab: the run's approved plan (or its
 * candidate while none is approved), refetched whenever the run changes.
 */
export function PlanPane({ tabId, runId }: { tabId: string; runId: string }) {
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [view, setView] = useState<MarkdownView>("rendered");

  const reload = useCallback(async () => {
    try {
      const fresh = await getPipelineRun(runId);
      setRun(fresh.run);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
        else {
          unlisten = stop;
          setLive(true);
        }
      })
      // intentionally silent: without the live event the pane still polls on a timer.
      .catch(() => {});
    refresh.request();
    const timer = window.setInterval(() => refresh.request(), OVERVIEW_FALLBACK_POLL_MS);
    return () => {
      disposed = true;
      refresh.stop();
      unlisten?.();
      setLive(false);
      window.clearInterval(timer);
    };
  }, [reload, runId]);

  const plan = run ? planOfRun(run) : null;
  const source = useMemo(() => (plan ? highlightCode(plan.text, "plan.md") : null), [plan?.text]);

  return (
    <aside className="plan-pane" aria-label="Plan">
      <PanelHeader
        title={planHeading(plan)}
        closeLabel="Close plan pane"
        onClose={() => setPlanPaneOpen(tabId, false)}
        actions={
          live ? (
            <span className="plan-pane-live" title="Updates as the run changes">
              LIVE
            </span>
          ) : null
        }
      >
        {plan && <MarkdownViewSwitch name={`plan-view-${tabId}`} view={view} onChange={setView} />}
      </PanelHeader>
      {plan?.updatedAt && <p className="hint plan-pane-updated">Updated {eventTime(plan.updatedAt)}</p>}
      <div className="plan-pane-body">
        {error ? (
          <p className="error">{error}</p>
        ) : !run ? (
          <p className="hint">Loading the plan…</p>
        ) : !plan ? (
          <p className="hint">
            No plan yet. It shows here once the Planner’s plan is saved, approved or handed to the Implementer.
          </p>
        ) : view === "rendered" ? (
          <div className="session-stream-agent">
            <ChatMarkdown>{plan.text}</ChatMarkdown>
          </div>
        ) : (
          <pre className="file-code hljs plan-pane-source">
            <code
              className={source?.language ? `language-${source.language}` : undefined}
              dangerouslySetInnerHTML={{ __html: source?.html ?? "" }}
            />
          </pre>
        )}
      </div>
    </aside>
  );
}

/** "Plan" in a pipeline tab's header: opens or closes the docked plan pane. */
export function PlanPaneToggle({ tabId }: { tabId: string }) {
  const open = usePlanPaneOpen(tabId);
  return (
    <button
      type="button"
      className="secondary-button plan-pane-toggle"
      aria-pressed={open}
      title={open ? "Hide the run's plan" : "Show the run's plan beside the terminal"}
      onClick={() => setPlanPaneOpen(tabId, !planPaneOpen(tabId))}
    >
      Plan
    </button>
  );
}
