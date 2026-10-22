/**
 * The story loop (L3): a pull request built in stories, one Implementer
 * session and one branch, with the checks after each story. The run keeps
 * one record per story (`run.stories`); a checkpoint story makes the run
 * wait with `checkpoint` (`autopilot.storyWait`) until your **Continue**,
 * which passes your note on to the next story and can add stories after
 * it. Pure: `StoryCheckpointPanel` and the chain overview render it.
 */
import type { ActorAction, PipelineRun, RunStory, StoryStatus } from "../bridge";
import { charCount } from "./repos";

/** As `MAX_STORY_NOTE_CHARS` in Rust (`pipelines/stories.rs`). */
export const MAX_STORY_NOTE_CHARS = 4000;
/** As `MAX_STORIES` (counting the ones you add). */
export const MAX_STORIES = 20;
/** As `MAX_ADDED_TITLE_CHARS`. */
export const MAX_ADDED_TITLE_CHARS = 300;

/** The stories of `lane` (null: the run's own Implementer), in order. */
export function laneStories(run: PipelineRun, lane: string | null): RunStory[] {
  return (run.stories ?? []).filter((story) => (story.lane ?? null) === lane);
}

function statusOf(story: RunStory): StoryStatus {
  return story.status ?? "pending";
}

function finished(story: RunStory): boolean {
  const status = statusOf(story);
  return status === "done" || status === "skipped";
}

/** The story `lane` is on: the first one not done (or skipped); null when all are finished or it has none. */
export function currentStory(run: PipelineRun, lane: string | null): RunStory | null {
  return laneStories(run, lane).find((story) => !finished(story)) ?? null;
}

/** "story 2/4", "stories done (4)", or null for a pull request not built in stories. */
export function storyProgress(run: PipelineRun, lane: string | null): string | null {
  const stories = laneStories(run, lane);
  if (stories.length === 0) return null;
  const now = currentStory(run, lane);
  if (!now) {
    const skipped = stories.filter((story) => statusOf(story) === "skipped").length;
    return skipped ? `stories finished (${skipped} skipped)` : `stories done (${stories.length})`;
  }
  return `story ${stories.indexOf(now) + 1}/${stories.length}`;
}

/** What a story's status reads as in the overview. */
export function storyStatusText(story: RunStory): string {
  switch (statusOf(story)) {
    case "pending":
      return "pending";
    case "active":
      return "active";
    case "checking":
      return "checks running";
    case "failed":
      return `checks failed (attempt ${story.attempt ?? 1})`;
    case "waiting":
      return "waiting on you";
    case "verifying":
      return "waiting on your verification";
    case "done":
      return "done";
    case "skipped":
      return "skipped";
  }
}

/** What the overview shows while the run waits on a checkpoint story. */
export type PendingStoryCheckpoint = {
  lane: string | null;
  /** "PR1 — Engine fixes", when the run fanned out. */
  laneTitle: string | null;
  repo: string | null;
  story: RunStory;
  /** 1-based place of the story, and how many there are. */
  number: number;
  total: number;
  checkpoint: string;
  /** The story that goes next with your note. */
  next: RunStory | null;
};

/**
 * The checkpoint story `run` waits on, or null when it waits on none. The
 * wait survives turning autopilot off and on (the run waits again).
 */
export function pendingStoryCheckpoint(run: PipelineRun): PendingStoryCheckpoint | null {
  const wait = run.autopilot?.storyWait;
  if (!wait || run.status !== "waiting" || run.stopReason !== "checkpoint") return null;
  const lane = wait.lane ?? null;
  const stories = laneStories(run, lane);
  const at = stories.findIndex((story) => story.id === wait.story);
  if (at < 0) return null;
  const laneRecord = lane ? run.lanes?.find((l) => l.id === lane) : undefined;
  return {
    lane,
    laneTitle: laneRecord?.title ?? null,
    repo: laneRecord?.repo ?? null,
    story: stories[at],
    number: at + 1,
    total: stories.length,
    checkpoint: wait.checkpoint,
    next: stories[at + 1] ?? null,
  };
}

/** One wait from another; "" when the run waits on no checkpoint story. */
export function storyWaitKey(run: PipelineRun): string {
  const wait = run.autopilot?.storyWait;
  if (!wait || !pendingStoryCheckpoint(run)) return "";
  return `${wait.lane ?? ""}@${wait.story}@${wait.at}`;
}

/**
 * The current story of `lane` that can be sent again (**Resend story**),
 * or null. Autopilot must be on and the run not waiting on your answer.
 * A stopped run offers any story not at a checkpoint or verification; a
 * running run (turned on again after a stop) offers a story whose checks
 * failed, since nothing else will send it. The run actor checks the rest.
 */
export function resendableStory(run: PipelineRun, lane: string | null): RunStory | null {
  if (!run.autopilot?.enabled || run.status === "complete" || !run.status) return null;
  if (run.autopilot.verify || run.autopilot.storyWait) return null;
  const now = currentStory(run, lane);
  if (!now) return null;
  if (run.status !== "running") return now;
  // Running (autopilot turned on again after a stop, or a wait that ended
  // another way): only when nothing is under way for the story, as the run
  // actor checks it: the story is not being checked, and the lane's newest
  // step was a stop, not a retry, a next story or a turn being decided.
  if (now.status !== "active" && now.status !== "failed") return null;
  return lastLaneStep(run, lane)?.kind === "stop" ? now : null;
}

/** The newest ledger line of `lane` (null: the run's own), leaving out checks and autopilot on/off. */
function lastLaneStep(run: PipelineRun, lane: string | null) {
  const events = run.events ?? [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === "gate") continue;
    if (event.kind === "autopilot" && (event.summary === "Autopilot on" || event.summary === "Autopilot off")) continue;
    if ((event.laneId ?? null) !== lane) continue;
    return event;
  }
  return null;
}

/** The run actor message for Resend story. */
export function storyResendAction(lane: string | null): ActorAction {
  return { kind: "storyResend", lane };
}

/** The stories you typed to add, one per line (as the Rust side reads them). */
export function parseAddedStories(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*•] |\d+[.)] )/, "").trim())
    .filter((line) => line.length > 0);
}

/** What is wrong with the note or the stories to add; null when Continue can be sent. */
export function storyContinueProblem(pending: PendingStoryCheckpoint, note: string, add: string): string | null {
  if (charCount(note.trim()) > MAX_STORY_NOTE_CHARS) return `The note is longer than ${MAX_STORY_NOTE_CHARS} characters.`;
  const added = parseAddedStories(add);
  const long = added.find((title) => charCount(title) > MAX_ADDED_TITLE_CHARS);
  if (long) return `A story to add is longer than ${MAX_ADDED_TITLE_CHARS} characters.`;
  if (pending.total + added.length > MAX_STORIES) {
    return `This pull request has ${pending.total} stories; at most ${MAX_STORIES} with the ones you add.`;
  }
  return null;
}

/** The run actor message for your Continue. */
export function storyContinueAction(pending: PendingStoryCheckpoint, note: string, add: string): ActorAction {
  const text = note.trim();
  const added = parseAddedStories(add);
  return {
    kind: "storyContinue",
    lane: pending.lane,
    story: pending.story.id,
    note: text ? text : null,
    add: added.length ? added.join("\n") : null,
  };
}
