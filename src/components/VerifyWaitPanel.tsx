import { useState } from "react";
import { pipelineActorMessage, type PipelineRun } from "../bridge";
import { pendingVerify, verifyAction, verifyNoteProblem } from "../pipeline/verify";
import { errorText } from "./InlineNotice";

type Props = {
  run: PipelineRun;
  /** Reload the run after an answer (or a refused one). */
  onDone: () => Promise<unknown> | void;
  onNotice: (title: string, body: string) => void;
};

/**
 * The verify gate a run waits on (L2), on the chain overview: its steps,
 * the lane and the pull requests that lane reported, then **Mark verified**
 * or **Failed** with a note. Both go to the run actor; a failure's note
 * goes back to the stage as a round. Renders nothing when the run waits on
 * no verify gate.
 */
export function VerifyWaitPanel({ run, onDone, onNotice }: Props) {
  const [failing, setFailing] = useState(false);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const wait = pendingVerify(run);
  if (!wait) return null;

  const problem = touched ? verifyNoteProblem(note) : null;
  const where = [wait.laneTitle, wait.repo].filter(Boolean).join(" · ");

  const send = async (verified: boolean) => {
    if (!verified) {
      setTouched(true);
      if (verifyNoteProblem(note)) return;
    }
    setBusy(true);
    try {
      await pipelineActorMessage(run.id, verifyAction(wait, verified, verified ? undefined : note));
      setFailing(false);
      setNote("");
      setTouched(false);
    } catch (err: unknown) {
      onNotice(verified ? "Not marked verified" : "Not sent back", errorText(err));
    } finally {
      setBusy(false);
      await onDone();
    }
  };

  return (
    <section className="pipeline-verify" aria-label="Verification">
      <h3>
        Verify: <code>{wait.label}</code>
        {where && <span className="hint"> · {where}</span>}
      </h3>
      <p className="hint">The checks passed. Carry out these steps yourself, then mark the result.</p>
      <pre className="pipeline-verify-steps">{wait.steps}</pre>
      {wait.prs.length > 0 && (
        <ul className="pipeline-verify-prs" aria-label="Pull requests to verify">
          {wait.prs.map((url) => (
            <li key={url}>
              <code>{url}</code>
            </li>
          ))}
        </ul>
      )}
      {failing ? (
        <div className="settings-subsection">
          <label className="field-label">
            What failed
            <textarea
              value={note}
              rows={4}
              disabled={busy}
              placeholder="The session list stays empty after sign-in."
              aria-invalid={problem ? true : undefined}
              onChange={(event) => {
                setNote(event.currentTarget.value);
                setTouched(true);
              }}
            />
          </label>
          {problem && <p className="error">{problem}</p>}
          <div className="button-row">
            <button type="button" className="primary-button" disabled={busy} onClick={() => void send(false)}>
              Send back
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setFailing(false);
                setTouched(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="button-row">
          <button type="button" className="primary-button" disabled={busy} onClick={() => void send(true)}>
            Mark verified
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            title="Send a note on what failed back to the stage, as a failed check's output goes back."
            onClick={() => setFailing(true)}
          >
            Failed
          </button>
        </div>
      )}
    </section>
  );
}
