import { useState } from "react";
import { pipelineActorMessage, type PipelineRun } from "../bridge";
import { artifactAnswerAction, artifactAnswerProblem, artifactWaitKey, pendingArtifactWait } from "../pipeline/artifacts";
import { errorText } from "./InlineNotice";

type Props = {
  run: PipelineRun;
  /** Reload the run after Answer (or a refused one). */
  onDone: () => Promise<unknown> | void;
  onNotice: (title: string, body: string) => void;
};

/**
 * F1: the artifact stage a run waits on, on the chain overview: its open
 * questions and an answer box (**Answer**), or, when it reported blocked,
 * its reason and a note box (**Continue**). The run actor resumes the
 * stage's session with what you wrote. Renders nothing otherwise.
 */
export function ArtifactWaitPanel({ run, onDone, onNotice }: Props) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const wait = pendingArtifactWait(run);
  // A new wait starts with an empty box.
  const waitId = artifactWaitKey(run);
  const [shownFor, setShownFor] = useState(waitId);
  if (shownFor !== waitId) {
    setShownFor(waitId);
    setAnswer("");
  }
  if (!wait) return null;

  const partial = wait.status === "partial";
  const problem = artifactAnswerProblem(wait, answer);

  const send = async () => {
    if (problem) return;
    setBusy(true);
    try {
      await pipelineActorMessage(run.id, artifactAnswerAction(wait, answer));
      setAnswer("");
    } catch (err: unknown) {
      onNotice(partial ? "Answer not sent" : "Not continued", errorText(err));
    } finally {
      setBusy(false);
      await onDone();
    }
  };

  return (
    <section className="pipeline-verify pipeline-artifact-wait" aria-label="Document questions">
      <h3>
        {partial ? `${wait.stageTitle} has questions` : `${wait.stageTitle} is blocked`}
        {(wait.artifacts?.length ?? 0) > 0 && <span className="hint"> · {wait.artifacts?.join(", ")}</span>}
      </h3>
      {partial ? (
        <ol className="pipeline-artifact-questions">
          {(wait.questions ?? []).map((question, index) => (
            <li key={index}>{question}</li>
          ))}
        </ol>
      ) : (
        <pre className="pipeline-verify-steps">{wait.reason ?? ""}</pre>
      )}
      <label className="field-label">
        {partial ? "Your answers" : "Your note (optional)"}
        <textarea
          value={answer}
          rows={4}
          disabled={busy}
          placeholder={partial ? "1. Offline is out of scope. 2. JT signs off." : "What to do instead, or leave empty to let it try again."}
          onChange={(event) => setAnswer(event.currentTarget.value)}
        />
      </label>
      {problem && answer.trim() && <p className="error">{problem}</p>}
      <div className="button-row">
        <button
          type="button"
          className="primary-button"
          disabled={busy || !!problem}
          title={`Send this to ${wait.stageTitle} in its session; it updates the document and reports again.`}
          onClick={() => void send()}
        >
          {partial ? "Answer" : "Continue"}
        </button>
      </div>
    </section>
  );
}
