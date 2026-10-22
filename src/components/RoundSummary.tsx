import { useCallback, useEffect, useState } from "react";
import { pipelineRunRound, type RunRoundView } from "../bridge";
import { mergeOrderLines, roundCountText, roundRows } from "../pipeline/round";
import { ChatMarkdown } from "./ChatMarkdown";
import { errorText, InlineNotice } from "./InlineNotice";

type Props = {
  runId: string;
  /** Changes when the run does, so a new round from Triage is read again. */
  refreshKey: string;
};

/**
 * A QA round on the chain overview (R1): the plans Triage grouped the
 * tickets into, with their tickets, repos, wave and status (and why a plan
 * is deferred or parked), the waves, the merge order per repo, the tickets
 * left out, and the round document (`round.md`). Renders nothing for a run
 * with no `round.json`.
 */
export function RoundSummary({ runId, refreshKey }: Props) {
  const [view, setView] = useState<RunRoundView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await pipelineRunRound(runId));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (error) {
    return (
      <InlineNotice className="pipeline-round-summary" tone="warning">
        Could not read the round: {error}
      </InlineNotice>
    );
  }
  if (!view) return null;
  const { round } = view;
  const rows = roundRows(round);
  return (
    <section className="pipeline-round-summary" aria-label="Round">
      <h3>Round</h3>
      <p className="hint">{roundCountText(round)}</p>
      <table className="pipeline-round-table" aria-label="Round plans">
        <thead>
          <tr>
            <th scope="col">Plan</th>
            <th scope="col">Tickets</th>
            <th scope="col">Repos</th>
            <th scope="col">Wave</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={`pipeline-round-plan pipeline-round-plan-${row.status}`}>
              <td>
                <code>{row.id}</code> {row.title}
                <div className="hint">{row.summary}</div>
              </td>
              <td>{row.tickets.join(", ")}</td>
              <td>{row.repos.length ? row.repos.join(", ") : "this folder"}</td>
              <td>{row.wave}</td>
              <td>
                {row.status}
                {row.reason && <div className="hint">{row.reason}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {round.waves.length > 0 && (
        <ol className="pipeline-round-waves" aria-label="Waves">
          {round.waves.map((wave) => (
            <li key={wave.n}>
              <strong>Wave {wave.n}</strong>: {wave.why}
            </li>
          ))}
        </ol>
      )}
      {mergeOrderLines(round).length > 0 && (
        <ul className="pipeline-round-merge-order" aria-label="Merge order">
          {mergeOrderLines(round).map((line) => (
            <li key={line.repo}>
              <strong>{line.repo}</strong>: {line.order}
            </li>
          ))}
        </ul>
      )}
      {round.excluded.length > 0 && (
        <ul className="pipeline-round-excluded" aria-label="Excluded tickets">
          {round.excluded.map((entry) => (
            <li key={entry.ticket}>
              <code>{entry.ticket}</code> {entry.reason}
            </li>
          ))}
        </ul>
      )}
      {view.markdown.trim() && (
        <details className="pipeline-round-document">
          <summary>Round document (round.md)</summary>
          <p className="hint">
            <code>{view.markdownPath}</code>
          </p>
          <ChatMarkdown>{view.markdown}</ChatMarkdown>
        </details>
      )}
    </section>
  );
}
