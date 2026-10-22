/**
 * F1: artifact stages (the Analyst, PM and Architect) write documents into
 * the run folder. One that reports `partial` makes the run wait with
 * `checkpoint` (`autopilot.artifactWait`) and shows its open questions; your
 * **Answer** resumes the stage's session with your answers. One that reports
 * `blocked` waits with its reason, and **Continue** resumes it with your
 * note (or none). Pure: `ArtifactWaitPanel` renders it.
 */
import type { ActorAction, ArtifactWait, PipelineRun } from "../bridge";
import { charCount } from "./repos";

/** As `MAX_ANSWER_CHARS` in Rust (`pipelines/artifacts.rs`). */
export const MAX_ARTIFACT_ANSWER_CHARS = 8000;

/** The artifact stage `run` waits on, or null. The wait survives turning autopilot off and on. */
export function pendingArtifactWait(run: PipelineRun): ArtifactWait | null {
  const wait = run.autopilot?.artifactWait;
  if (!wait || run.status !== "waiting" || run.stopReason !== "checkpoint") return null;
  return wait;
}

/** One wait from another; "" when the run waits on no artifact stage. */
export function artifactWaitKey(run: PipelineRun): string {
  const wait = pendingArtifactWait(run);
  return wait ? `${wait.stageId}@${wait.at}` : "";
}

/** What is wrong with your answer; null when it can be sent. Open questions need an answer; a blocked stage may go on with no note. */
export function artifactAnswerProblem(wait: ArtifactWait, answer: string): string | null {
  const text = answer.trim();
  if (charCount(text) > MAX_ARTIFACT_ANSWER_CHARS) return `The answer is longer than ${MAX_ARTIFACT_ANSWER_CHARS} characters.`;
  if (wait.status === "partial" && !text) return `Write your answers to ${wait.stageTitle}'s questions first.`;
  return null;
}

/** The run actor message for Answer (or Continue after a block). */
export function artifactAnswerAction(wait: ArtifactWait, answer: string): ActorAction {
  const text = answer.trim();
  return { kind: "artifactAnswer", stageId: wait.stageId, answer: text ? text : null };
}
