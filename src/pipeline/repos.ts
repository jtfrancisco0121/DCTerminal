/**
 * Settings › Repos (Eagle-Eye v3, L1): named git repos a plan can span.
 * A Planner task names one (`"repo": "engine"`) and fan-out makes that
 * lane's worktree in the repo's folder; a lane with none uses the run's own
 * folder, as before. Pure: `ReposSettings` and `fanOut.ts` act on it. The
 * Rust side (`store/repos_settings.rs`) checks again when it saves, and
 * also that each folder is a git repo.
 */
import type { RepoEntry } from "../bridge";
import type { PlannedPr } from "./prPlan";

/** As `MAX_REPO_NAME_CHARS` in Rust. */
export const MAX_REPO_NAME_CHARS = 40;

/**
 * What is wrong with `name` for a repo next to `others` (the other repos'
 * names), in the words the form shows; null when it is fine.
 */
export function repoNameProblem(name: string, others: readonly string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the repo a name, such as backend.";
  if (trimmed.length > MAX_REPO_NAME_CHARS) return `The name is longer than ${MAX_REPO_NAME_CHARS} characters.`;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return "The name may use only letters, digits, - and _.";
  if (others.some((other) => other.toLowerCase() === trimmed.toLowerCase())) {
    return `There is already a repo named ${trimmed}.`;
  }
  return null;
}

/** The repo named `name` (any case, as the bridge matches it). */
export function findRepo(repos: readonly RepoEntry[], name: string): RepoEntry | null {
  const wanted = name.trim().toLowerCase();
  return repos.find((repo) => repo.name.toLowerCase() === wanted) ?? null;
}

/** Where one lane's worktree is made: its repo's folder, or the run's own. */
export type LaneFolder = { laneId: string; repo: string | null; folder: string };

/**
 * Each lane's folder for fan-out. A lane without a repo uses `home` (the
 * run's folder). A repo that is not in Settings › Repos (removed after the
 * plan was accepted) is an error naming it; no folder is guessed.
 */
export function laneFolders(
  lanes: readonly PlannedPr[],
  repos: readonly RepoEntry[],
  home: string,
): { folders: LaneFolder[] } | { error: string } {
  const folders: LaneFolder[] = [];
  for (const lane of lanes) {
    const name = lane.repo?.trim();
    if (!name) {
      folders.push({ laneId: lane.id, repo: null, folder: home });
      continue;
    }
    const repo = findRepo(repos, name);
    if (!repo) {
      return {
        error: `${lane.title} is in the repo "${name}", which is not in Settings › Repos. Add it there, or ask the Planner to leave its repo out.`,
      };
    }
    folders.push({ laneId: lane.id, repo: repo.name, folder: repo.folder });
  }
  return { folders };
}
