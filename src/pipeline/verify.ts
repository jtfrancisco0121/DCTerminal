/**
 * Verify gates (L2): checks the app cannot run itself, such as a Playwright
 * run on a Windows staging build. Once a stage's other gates pass, the run
 * waits with `checkpoint` and `autopilot.verify` holds the steps; you mark
 * them verified, or failed with a note that goes back to the stage. Pure:
 * `VerifyWaitPanel` renders it and sends the answer to the run actor.
 */
import type { ActorAction, PipelineRun, VerifyRecord } from "../bridge";

/** As `MAX_VERIFY_NOTE_CHARS` in Rust (`pipelines/verify.rs`). */
export const MAX_VERIFY_NOTE_CHARS = 4000;

/** What the overview shows while the run waits on a verify gate. */
export type PendingVerify = {
  stageId: string;
  lane: string | null;
  /** "PR1 — API", when the run fanned out. */
  laneTitle: string | null;
  /** The lane's Settings › Repos name, if it has one. */
  repo: string | null;
  label: string;
  steps: string;
  prs: string[];
};

/** The verify gate `run` waits on, or null when it waits on nothing of the kind. */
export function pendingVerify(run: PipelineRun): PendingVerify | null {
  const wait = run.autopilot?.verify;
  if (!wait || run.status !== "waiting" || run.stopReason !== "checkpoint") return null;
  const lane = wait.lane ? run.lanes?.find((l) => l.id === wait.lane) : undefined;
  return {
    stageId: wait.stageId,
    lane: wait.lane ?? null,
    laneTitle: lane?.title ?? null,
    repo: lane?.repo ?? null,
    label: wait.label,
    steps: wait.steps,
    prs: wait.prs ?? [],
  };
}

/** What is wrong with the note sent with Failed; null when it can be sent. */
export function verifyNoteProblem(note: string): string | null {
  const trimmed = note.trim();
  if (!trimmed) return "Say what failed: the note goes back to the stage.";
  if (trimmed.length > MAX_VERIFY_NOTE_CHARS) return `The note is longer than ${MAX_VERIFY_NOTE_CHARS} characters.`;
  return null;
}

/** The run actor message for your answer. */
export function verifyAction(wait: PendingVerify, verified: boolean, note?: string): ActorAction {
  const text = note?.trim();
  return { kind: "verify", stageId: wait.stageId, lane: wait.lane, verified, note: text ? text : null };
}

/** The latest answer for `lane` (null: the run's own stages), as C3 reads it. */
export function latestVerification(run: PipelineRun, lane: string | null): VerifyRecord | null {
  const records = run.verifications ?? [];
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if ((records[i].lane ?? null) === lane) return records[i];
  }
  return null;
}
