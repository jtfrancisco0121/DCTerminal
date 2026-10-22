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

/** The lanes (null: the run's own) of `run` that have stories, in order. */
function storyLanes(run: PipelineRun): (string | null)[] {
  const lanes: (string | null)[] = [];
  for (const story of run.stories ?? []) {
    const lane = story.lane ?? null;
    if (!lanes.includes(lane)) lanes.push(lane);
  }
  return lanes;
}

/**
 * The checkpoint story `run` waits on, or null when it waits on none: the
 * run's wait, or a current story still waiting on you after the run's wait
 * ended another way (autopilot turned off and on), so Continue stays.
 */
export function pendingStoryCheckpoint(run: PipelineRun): PendingStoryCheckpoint | null {
  if (run.status === "complete") return null;
  const wait = run.autopilot?.storyWait;
  const lane =
    wait && run.status === "waiting" && run.stopReason === "checkpoint"
      ? (wait.lane ?? null)
      : storyLanes(run).find((id) => currentStory(run, id)?.status === "waiting");
  if (lane === undefined) return null;
  const stories = laneStories(run, lane);
  const now = currentStory(run, lane);
  if (!now || now.status !== "waiting") return null;
  const at = stories.indexOf(now);
  const laneRecord = lane ? run.lanes?.find((l) => l.id === lane) : undefined;
  return {
    lane,
    laneTitle: laneRecord?.title ?? null,
    repo: laneRecord?.repo ?? null,
    story: stories[at],
    number: at + 1,
    total: stories.length,
    checkpoint: wait && (wait.lane ?? null) === lane && wait.story === now.id ? wait.checkpoint : (now.checkpoint ?? ""),
    next: stories[at + 1] ?? null,
  };
}

/** One wait from another; "" when the run waits on no checkpoint story. */
export function storyWaitKey(run: PipelineRun): string {
  const pending = pendingStoryCheckpoint(run);
  if (!pending) return "";
  return `${pending.lane ?? ""}@${pending.story.id}@${pending.story.at ?? ""}`;
}

/**
 * The lane whose current story can be sent again (**Resend story**): the
 * run stopped mid-loop (not running, not complete, not waiting on your
 * answer) and the story is not waiting on its checkpoint. Null otherwise.
 */
export function resendableStory(run: PipelineRun, lane: string | null): RunStory | null {
  if (run.status === "running" || run.status === "complete" || !run.status) return null;
  if (run.autopilot?.verify || run.autopilot?.storyWait) return null;
  const now = currentStory(run, lane);
  return now && now.status !== "waiting" ? now : null;
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
