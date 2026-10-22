import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { roundMergeQueue, type MergeQueueView } from "../bridge";
import { entryName, repoLine, stateLabel } from "../pipeline/mergeQueue";
import { errorText, InlineNotice } from "./InlineNotice";

type Props = {
  /** The round's id, its Triage run or one of its plan runs. */
  roundKey: string;
};

/**
 * The merge queue (R3): each repo's pull requests of the round in merge
 * order, with GitHub's state of each, the next one to merge highlighted,
 * and warnings when one needs a rebase on its base or a retarget. Read-only:
 * you merge, as always; it can only open a pull request in the browser.
 * GitHub is read through your `gh` when the view opens and on Refresh.
 */
export function MergeQueue({ roundKey }: Props) {
  const [view, setView] = useState<MergeQueueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setView(await roundMergeQueue(roundKey));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [roundKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (url: string) => {
    void openUrl(url).catch((err: unknown) => setError(`Could not open the pull request: ${errorText(err)}`));
  };

  return (
    <section className="pipeline-merge-queue" aria-label="Merge queue">
      <div className="pipeline-ledger-head">
        <h4>Merge queue</h4>
        <button type="button" className="secondary-button" disabled={loading} onClick={() => void load()}>
          {loading ? "Reading GitHub…" : "Refresh"}
        </button>
      </div>
      <p className="hint">
        Each repo's pull requests in merge order. You merge them yourself: nothing here merges, rebases or pushes. Merge one at a
        time per repo; the next is suggested once the one before it merged.
      </p>
      {error && (
        <InlineNotice tone="warning" className="pipeline-merge-queue-error">
          {error}
        </InlineNotice>
      )}
      {view && view.repos.length === 0 && <p className="hint">No plan has a pull request yet.</p>}
      {view?.repos.map((queue) => (
        <section key={queue.repo} className="pipeline-merge-queue-repo" aria-label={`Merge queue for ${queue.repo}`}>
          <h5>
            {queue.repo} <span className="hint">· {repoLine(queue)}</span>
          </h5>
          <ol>
            {queue.entries.map((entry, i) => (
              <li
                key={`${entry.planId}-${entry.url ?? i}`}
                className={`pipeline-merge-queue-entry pipeline-merge-queue-${entry.state}${entry.next ? " pipeline-merge-queue-next" : ""}`}
                aria-current={entry.next ? "step" : undefined}
              >
                <strong>{entryName(entry)}</strong> {entry.title}{" "}
                <span className="pipeline-lane-status">{stateLabel(entry.state)}</span>
                {entry.next && <span className="pipeline-merge-queue-badge"> Next to merge</span>}
                {entry.base && <span className="hint"> · into {entry.base}</span>}
                {entry.url && (
                  <button type="button" className="secondary-button" onClick={() => open(entry.url!)}>
                    Open on GitHub
                  </button>
                )}
                {entry.waitsFor && <div className="hint">After {entry.waitsFor}.</div>}
                {entry.warnings.length > 0 && (
                  <ul className="pipeline-merge-queue-warnings">
                    {entry.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </section>
  );
}
