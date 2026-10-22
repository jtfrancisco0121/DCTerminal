import { useState } from "react";
import { pipelineActorMessage, type PipelineRun } from "../bridge";
import {
  parseAddedStories,
  pendingStoryCheckpoint,
  storyContinueAction,
  storyContinueProblem,
  storyWaitKey,
} from "../pipeline/stories";
import { errorText } from "./InlineNotice";

type Props = {
  run: PipelineRun;
  /** Reload the run after Continue (or a refused one). */
  onDone: () => Promise<unknown> | void;
  onNotice: (title: string, body: string) => void;
};

/**
 * The checkpoint story a run waits on (L3), on the chain overview: the
 * story, its checkpoint text, a note box and an optional box of stories to
 * add after it, then **Continue**. The run actor resumes the Implementer's
 * session with the next story and your note. Renders nothing when the run
 * waits on no checkpoint story.
 */
export function StoryCheckpointPanel({ run, onDone, onNotice }: Props) {
  const [note, setNote] = useState("");
  const [add, setAdd] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = pendingStoryCheckpoint(run);
  // A new wait starts with empty boxes.
  const waitId = storyWaitKey(run);
  const [shownFor, setShownFor] = useState(waitId);
  if (shownFor !== waitId) {
    setShownFor(waitId);
    setNote("");
    setAdd("");
  }
  if (!pending) return null;

  const problem = storyContinueProblem(pending, note, add);
  const where = [pending.laneTitle, pending.repo].filter(Boolean).join(" · ");
  const added = parseAddedStories(add);
  const next = added[0] ?? pending.next?.title ?? null;

  const send = async () => {
    if (problem) return;
    setBusy(true);
    try {
      await pipelineActorMessage(run.id, storyContinueAction(pending, note, add));
      setNote("");
      setAdd("");
    } catch (err: unknown) {
      onNotice("Next story not sent", errorText(err));
    } finally {
      setBusy(false);
      await onDone();
    }
  };

  return (
    <section className="pipeline-verify pipeline-story-checkpoint" aria-label="Story checkpoint">
      <h3>
        Checkpoint after story {pending.story.id} ({pending.number} of {pending.total}): {pending.story.title}
        {where && <span className="hint"> · {where}</span>}
      </h3>
      <p className="hint">Its checks passed. Do this, then continue with what you found:</p>
      <pre className="pipeline-verify-steps">{pending.checkpoint}</pre>
      <label className="field-label">
        Your note for the next story
        <textarea
          value={note}
          rows={4}
          disabled={busy}
          placeholder="What the rerun showed, for example the log lines that matter."
          onChange={(event) => setNote(event.currentTarget.value)}
        />
      </label>
      <label className="field-label">
        Add stories after this one (optional, one per line)
        <textarea
          value={add}
          rows={2}
          disabled={busy}
          placeholder="Fix the stall the log shows"
          onChange={(event) => setAdd(event.currentTarget.value)}
        />
      </label>
      {problem && <p className="error">{problem}</p>}
      <div className="button-row">
        <button
          type="button"
          className="primary-button"
          disabled={busy || !!problem}
          title={next ? `Send "${next}" to the Implementer, with your note.` : undefined}
          onClick={() => void send()}
        >
          Continue
        </button>
      </div>
    </section>
  );
}
