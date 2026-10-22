import { useCallback, useEffect, useState } from "react";
import {
  listenChainRunUpdated,
  pipelineActorMessage,
  roundAction,
  roundGet,
  type PlanCheckpoint,
  type RoundAction,
  type RoundPlanView,
  type RoundView,
} from "../bridge";
import { allPipelineDefs } from "../pipeline/defs";
import { isForRun, OVERVIEW_FALLBACK_POLL_MS } from "../pipeline/overviewRefresh";
import { DEFAULT_PLAN_PIPELINE, MAX_RUNS_AT_ONCE, planPipelines, roundProgress, waveChoices } from "../pipeline/roundRunner";
import { errorText, InlineNotice } from "./InlineNotice";

type Props = {
  /** The Triage run whose round this is. */
  triageRunId: string;
  /** The Triage run is complete (its round approved), so the round can start. */
  runComplete: boolean;
  /** The round's waves (from round.json), for Start round's Commit up to wave. */
  waves: number;
  /** Open a plan run's overview. */
  onOpenRun?: (runId: string) => void;
};

/**
 * The round runner on a Triage run's overview (R2). Before the round
 * starts: **Start round** with the pipeline each plan runs, the cap on runs
 * at once and **Commit up to wave N**. Once it runs: each plan with its
 * state, why a ready plan waits, its run, **Unpark** and **Retry**; the cap
 * and Commit up to wave; and **Approve all checkpoints**, every plan run
 * waiting at its plan checkpoint with Approve (your Send to its actor).
 */
export function RoundRunner({ triageRunId, runComplete, waves, onOpenRun }: Props) {
  const [view, setView] = useState<RoundView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pipeline, setPipeline] = useState(DEFAULT_PLAN_PIPELINE);
  const [cap, setCap] = useState(2);
  const [commit, setCommit] = useState(1);
  const [unparkWave, setUnparkWave] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    try {
      const next = await roundGet(triageRunId);
      setView(next);
      if (next) {
        setCap(next.round.runsAtOnce);
        setCommit(next.round.commitUpToWave);
      }
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [triageRunId]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void load();
    // The round runner tells the Triage run's overview whenever a plan changes.
    listenChainRunUpdated((event) => {
      if (isForRun(event, triageRunId)) void load();
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      // intentionally silent: without the live event the view still polls.
      .catch(() => {});
    const timer = window.setInterval(() => void load(), OVERVIEW_FALLBACK_POLL_MS);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [load, triageRunId]);

  const act = async (action: RoundAction) => {
    setBusy(true);
    try {
      setView(await roundAction(action));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const approve = async (wait: PlanCheckpoint) => {
    setBusy(true);
    try {
      await pipelineActorMessage(wait.runId, { kind: "send", sourceTabId: wait.sourceTabId, targetRoleId: wait.targetRoleId });
      await load();
    } catch (err) {
      setError(`${wait.planId}: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const notice = error && (
    <InlineNotice className="pipeline-round-runner-error" tone="warning">
      {error}
    </InlineNotice>
  );

  if (!view) {
    if (!runComplete) {
      return (
        <section className="pipeline-round-runner" aria-label="Round runner">
          {notice}
          <p className="hint">Approve the round (scope and wave order) to start it: each active plan then gets a run of its own.</p>
        </section>
      );
    }
    const pipelines = planPipelines(allPipelineDefs());
    return (
      <section className="pipeline-round-runner" aria-label="Round runner">
        <h4>Start the round</h4>
        {notice}
        <div className="pipeline-round-start">
          <label>
            Each plan runs{" "}
            <select aria-label="Pipeline for each plan" value={pipeline} disabled={busy} onChange={(e) => setPipeline(e.currentTarget.value)}>
              {pipelines.map((def) => (
                <option key={def.id} value={def.id}>
                  {def.name}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            Runs at once{" "}
            <input
              type="number"
              aria-label="Runs at once"
              min={1}
              max={MAX_RUNS_AT_ONCE}
              value={cap}
              disabled={busy}
              onChange={(e) => setCap(Number(e.currentTarget.value))}
            />
          </label>{" "}
          <label>
            Commit up to wave{" "}
            <select aria-label="Commit up to wave" value={commit} disabled={busy} onChange={(e) => setCommit(Number(e.currentTarget.value))}>
              {waveChoices(waves).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="primary-button"
            disabled={busy || waves < 1}
            onClick={() => void act({ kind: "start", triageRunId, pipeline, runsAtOnce: cap, commitUpToWave: commit })}
          >
            Start round
          </button>
        </div>
      </section>
    );
  }

  const { round } = view;
  const plansByWave = [...view.plans].sort((a, b) => (a.wave ?? 99) - (b.wave ?? 99));
  return (
    <section className="pipeline-round-runner" aria-label="Round runner">
      <h4>Round runs</h4>
      <p className="hint">{roundProgress(view)}</p>
      {notice}
      <div className="pipeline-round-settings">
        <label>
          Runs at once{" "}
          <input
            type="number"
            aria-label="Runs at once"
            min={1}
            max={MAX_RUNS_AT_ONCE}
            value={cap}
            disabled={busy}
            onChange={(e) => setCap(Number(e.currentTarget.value))}
          />
        </label>{" "}
        <label>
          Commit up to wave{" "}
          <select aria-label="Commit up to wave" value={commit} disabled={busy} onChange={(e) => setCommit(Number(e.currentTarget.value))}>
            {waveChoices(round.waves).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>{" "}
        <button
          type="button"
          className="secondary-button"
          disabled={busy || (cap === round.runsAtOnce && commit === round.commitUpToWave)}
          onClick={() => void act({ kind: "settings", roundId: round.id, runsAtOnce: cap, commitUpToWave: commit })}
        >
          Save
        </button>
      </div>
      <table className="pipeline-round-table" aria-label="Plan runs">
        <thead>
          <tr>
            <th scope="col">Plan</th>
            <th scope="col">Wave</th>
            <th scope="col">State</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {plansByWave.map((plan) => (
            <PlanRow
              key={plan.planId}
              plan={plan}
              waves={round.waves}
              busy={busy}
              unparkWave={unparkWave[plan.planId] ?? plan.wave ?? round.waves}
              onUnparkWave={(n) => setUnparkWave((prev) => ({ ...prev, [plan.planId]: n }))}
              onUnpark={(wave) => void act({ kind: "unpark", roundId: round.id, planId: plan.planId, wave })}
              onRetry={() => void act({ kind: "retry", roundId: round.id, planId: plan.planId })}
              onOpenRun={onOpenRun}
            />
          ))}
        </tbody>
      </table>
      <section className="pipeline-round-checkpoints" aria-label="Approve all checkpoints">
        <h4>Approve all checkpoints</h4>
        {view.checkpoints.length === 0 ? (
          <p className="hint">No plan run is waiting at its plan checkpoint.</p>
        ) : (
          <ul>
            {view.checkpoints.map((wait) => (
              <li key={wait.runId}>
                <strong>{wait.planId}</strong> waits before {wait.stageTitle}.{" "}
                {wait.waiting && <span className="hint">{wait.waiting} </span>}
                <button type="button" className="primary-button" disabled={busy} onClick={() => void approve(wait)}>
                  Approve
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function PlanRow({
  plan,
  waves,
  busy,
  unparkWave,
  onUnparkWave,
  onUnpark,
  onRetry,
  onOpenRun,
}: {
  plan: RoundPlanView;
  waves: number;
  busy: boolean;
  unparkWave: number;
  onUnparkWave: (wave: number) => void;
  onUnpark: (wave: number) => void;
  onRetry: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  const runId = plan.runId ?? null;
  return (
    <tr className={`pipeline-round-plan pipeline-round-plan-${plan.state}`}>
      <td>
        <code>{plan.planId}</code> {plan.title}
        {plan.repos.length > 0 && <div className="hint">{plan.repos.join(", ")}</div>}
      </td>
      <td>{plan.wave ? `Wave ${plan.wave}` : "—"}</td>
      <td>
        {plan.state}
        {(plan.waiting || plan.note) && <div className="hint">{plan.waiting || plan.note}</div>}
      </td>
      <td className="button-row">
        {runId && onOpenRun && (
          <button type="button" className="secondary-button" onClick={() => onOpenRun(runId)}>
            Open run
          </button>
        )}
        {plan.state === "parked" && (
          <>
            <select
              aria-label={`Wave for ${plan.planId}`}
              value={unparkWave}
              disabled={busy}
              onChange={(e) => onUnparkWave(Number(e.currentTarget.value))}
            >
              {waveChoices(waves).map((n) => (
                <option key={n} value={n}>
                  Wave {n}
                </option>
              ))}
            </select>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => onUnpark(unparkWave)}>
              Unpark
            </button>
          </>
        )}
        {plan.state === "stopped" && !runId && (
          <button type="button" className="secondary-button" disabled={busy} onClick={onRetry}>
            Retry
          </button>
        )}
      </td>
    </tr>
  );
}
