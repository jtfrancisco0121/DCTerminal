import { useCallback, useEffect, useMemo, useState } from "react";
import type { PipelineRun, TabSummary } from "../bridge";
import {
  getPipelineRun,
  pipelinePromotePlan,
  pipelineSetCandidatePlan,
} from "../bridge";
import type { TabRuntime } from "../liveTabs";
import { stagesForKind, type PipelineKind } from "../pipeline/stages";
import { latestAgentMessage } from "../handoff/map";
import { segmentsToPlainText } from "../transcript";

type Props = {
  runId: string;
  cwd: string;
  tabs: TabSummary[];
  runtimes: Record<string, TabRuntime>;
  onJump: (tabId: string) => void;
  onWatch: (tabId: string) => void;
  onRefreshTabs: () => Promise<unknown>;
  onNotice: (title: string, body: string) => void;
};

function laneStatus(
  tab: TabSummary | undefined,
  rt: TabRuntime | undefined,
): { label: string; tone: "idle" | "live" | "done" } {
  if (!tab) return { label: "Missing tab", tone: "idle" };
  if (rt?.promptInFlight) return { label: "Working…", tone: "live" };
  if (tab.phase === "running" || rt?.session) return { label: "Session open", tone: "live" };
  if (tab.hasTranscript || tab.startupPromptSent) return { label: "Stopped", tone: "done" };
  if (tab.phase === "draft") return { label: "Ready", tone: "idle" };
  return { label: tab.phase, tone: "idle" };
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
    void reload();
    const timer = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const kind = (run?.kind ?? "full") as PipelineKind;
  const stageDefs = stagesForKind(kind);

  const tabById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);

  const pullPlannerText = useCallback(() => {
    const plannerTabId = run?.tabIds.role_planner;
    if (!plannerTabId) return "";
    const rt = runtimes[plannerTabId];
    const fromStream = latestAgentMessage(
      rt?.segments.map((s) => ({ kind: s.kind, text: s.text })) ?? [],
    );
    if (fromStream.trim()) return fromStream.trim();
    const tab = tabById.get(plannerTabId);
    if (tab?.hasTranscript) {
      return segmentsToPlainText(rt?.segments ?? []).trim();
    }
    return "";
  }, [run?.tabIds.role_planner, runtimes, tabById]);

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

  return (
    <section className="pipeline-overview" aria-label="Pipeline overview">
      <header className="pipeline-overview-header">
        <div>
          <h2 className="pipeline-overview-title">Pipeline overview</h2>
          <p className="hint pipeline-overview-meta">
            {kind === "execute" ? "Execute" : "Plan → review → implement → PR"} ·{" "}
            <span className="pipeline-overview-cwd">{cwd}</span>
          </p>
        </div>
        <p className="hint">
          Stage: <strong>{run.stage}</strong>
        </p>
      </header>

      <div className="pipeline-lanes">
        {stageDefs.map((def) => {
          const tabId = run.tabIds[def.roleId];
          const tab = tabId ? tabById.get(tabId) : undefined;
          const rt = tabId ? runtimes[tabId] : undefined;
          const status = laneStatus(tab, rt);
          const isCurrent = run.stage === def.stageId;
          return (
            <article
              key={def.roleId}
              className={`pipeline-lane${isCurrent ? " pipeline-lane-current" : ""}`}
            >
              <div className="pipeline-lane-head">
                <h3>{def.title}</h3>
                <span className={`pipeline-lane-status pipeline-lane-status-${status.tone}`}>
                  {status.label}
                </span>
              </div>
              <p className="hint pipeline-lane-tab">{tab?.label ?? "—"}</p>
              {tabId && (
                <div className="button-row pipeline-lane-actions">
                  <button type="button" className="secondary-button" onClick={() => onJump(tabId)}>
                    Jump
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onWatch(tabId)}
                  >
                    Watch in split
                  </button>
                </div>
              )}
            </article>
          );
        })}
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
              onClick={() => {
                const text = pullPlannerText();
                if (text) setCandidateDraft(text);
                else onNotice("Nothing to pull", "Start the Planner tab or wait for a reply.");
              }}
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
            : "After Plan Reviewer approves, paste the final plan and promote."}
        </p>
        <textarea
          className="text-input prompt-area pipeline-plan-area"
          rows={8}
          value={approvedDraft}
          onChange={(e) => setApprovedDraft(e.target.value)}
          disabled={busy}
        />
        <div className="button-row">
          <button
            type="button"
            className="primary-button"
            disabled={busy || !approvedDraft.trim()}
            onClick={() => void promote()}
          >
            {kind === "execute" ? "Send to Implementer" : "Approve for implementation"}
          </button>
        </div>
      </section>
    </section>
  );
}
