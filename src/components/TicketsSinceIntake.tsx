import { useCallback, useEffect, useState } from "react";
import { clickupIntakeCheck, clickupIntakePull, type ClickUpIntakeCheck } from "../bridge";
import { errorText, InlineNotice } from "./InlineNotice";

/** How often an open overview asks again; the core checks ClickUp at most this often per run. */
export const INTAKE_CHECK_MS = 5 * 60 * 1000;

type Props = {
  runId: string;
};

/** "1 ticket changed" / "3 tickets changed". */
export function changedText(count: number): string {
  return `${count} ticket${count === 1 ? "" : "s"} changed since intake`;
}

/**
 * "Changed since intake" on the chain overview (C2). A run that started
 * from ClickUp tickets holds a snapshot (`tickets.json`, E3); this says
 * which tickets ClickUp edited since, and **Pull again** re-reads them into
 * the snapshot. Running stages are not prompted again: the next stage, or
 * a stage you send back, reads the new file. Renders nothing for a run
 * with no snapshot or no changes.
 */
export function TicketsSinceIntake({ runId }: Props) {
  const [check, setCheck] = useState<ClickUpIntakeCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);

  const load = useCallback(async () => {
    try {
      setCheck(await clickupIntakeCheck(runId));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [runId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), INTAKE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const pull = async () => {
    if (!check) return;
    setPulling(true);
    setError(null);
    try {
      // The Timeline note it adds reaches the overview as chain-run-updated.
      setCheck(await clickupIntakePull(runId, check.changed.map((t) => t.id)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPulling(false);
    }
  };

  if (error) {
    return (
      <InlineNotice className="pipeline-intake" tone="warning">
        Could not check the ClickUp tickets: {error}
      </InlineNotice>
    );
  }
  if (!check || check.changed.length === 0) return null;
  return (
    <section className="pipeline-intake" aria-label="Changed since intake">
      <p>
        <strong>{changedText(check.changed.length)}</strong>{" "}
        <span className="hint">(of {check.tickets} in this run's tickets.json)</span>
      </p>
      <ul>
        {check.changed.map((ticket) => (
          <li key={ticket.id}>
            <code>{ticket.id}</code> {ticket.title}
            {ticket.missing && <span className="hint"> (no longer in ClickUp, or this account cannot see it)</span>}
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button
          type="button"
          className="secondary-button"
          disabled={pulling}
          title="Re-read these tickets into tickets.json. Running stages are not prompted again."
          onClick={() => void pull()}
        >
          {pulling ? "Pulling…" : "Pull again"}
        </button>
      </div>
    </section>
  );
}
