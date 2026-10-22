import type { PipelineRun } from "../bridge";
import { laneStories, storyStatusText } from "../pipeline/stories";

/**
 * A pull request's stories (L3), compact: one line each with its id,
 * title, tickets and where it stands. Renders nothing when `lane` (null:
 * the run's own Implementer) is not built in stories.
 */
export function StoryList({ run, lane, label }: { run: PipelineRun; lane: string | null; label: string }) {
  const stories = laneStories(run, lane);
  if (stories.length === 0) return null;
  return (
    <ol className="pipeline-story-list" aria-label={label}>
      {stories.map((story) => (
        <li key={story.id} className={`pipeline-story pipeline-story-${story.status ?? "pending"}`}>
          <code>{story.id}</code> {story.title}
          {story.tickets?.length ? <span className="hint"> · {story.tickets.join(", ")}</span> : null}
          <span className="pipeline-story-status"> · {storyStatusText(story)}</span>
          {story.added && <span className="hint"> · added by you</span>}
        </li>
      ))}
    </ol>
  );
}
