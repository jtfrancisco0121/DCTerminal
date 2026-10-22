import { useState } from "react";
import { pipelineActorMessage, type PipelineRun } from "../bridge";
import { resendableStory, storyResendAction } from "../pipeline/stories";
import { errorText } from "./InlineNotice";

type Props = {
  run: PipelineRun;
  lane: string | null;
  onDone: () => Promise<unknown> | void;
  onNotice: (title: string, body: string) => void;
};

/**
 * **Resend story** (L3): the run stopped mid-loop (its check retries used
 * up, a usage pause, a turn that named no story). The run actor sends the
 * current story to the Implementer's session again and the run runs.
 * Renders nothing when there is no such story.
 */
export function StoryResendButton({ run, lane, onDone, onNotice }: Props) {
  const [busy, setBusy] = useState(false);
  const story = resendableStory(run, lane);
  if (!story) return null;
  const send = async () => {
    setBusy(true);
    try {
      await pipelineActorMessage(run.id, storyResendAction(lane));
    } catch (err: unknown) {
      onNotice("Story not sent again", errorText(err));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  return (
    <div className="button-row">
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        title={`Send story ${story.id} (${story.title}) to the Implementer's session again, and let autopilot carry on.`}
        onClick={() => void send()}
      >
        Resend story {story.id}
      </button>
    </div>
  );
}
