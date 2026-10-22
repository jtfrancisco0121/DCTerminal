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

/**
 * Characters as Rust's `chars().count()` counts them (code points), so a
 * limit here matches the one Rust checks: an emoji is one, not two (L2).
 */
export function charCount(text: string): number {
  return [...text].length;
}

/** As `MAX_REPO_NAME_CHARS` in Rust. */
export const MAX_REPO_NAME_CHARS = 40;

/**
 * What is wrong with `name` for a repo next to `others` (the other repos'
 * names), in the words the form shows; null when it is fine.
 */
export function repoNameProblem(name: string, others: readonly string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the repo a name, such as backend.";
  if (charCount(trimmed) > MAX_REPO_NAME_CHARS) return `The name is longer than ${MAX_REPO_NAME_CHARS} characters.`;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return "The name may use only letters, digits, - and _.";
  if (others.some((other) => other.toLowerCase() === trimmed.toLowerCase())) {
    return `There is already a repo named ${trimmed}.`;
  }
  return null;
}

/** As `MAX_REPO_CHECK_CHARS` and `MAX_REPO_VERIFY_CHARS` in Rust (L2). */
export const MAX_REPO_CHECK_CHARS = 2000;
export const MAX_REPO_VERIFY_CHARS = 2000;

/**
 * What is wrong with a repo's check command (L2), as for a pipeline's
 * command gate: one line, at most 2000 characters. Blank is no check.
 */
export function repoCheckProblem(check: string): string | null {
  const trimmed = check.trim();
  if (/[\r\n]/.test(trimmed)) return "The check is one line: no line breaks.";
  if (charCount(trimmed) > MAX_REPO_CHECK_CHARS) return `The check is longer than ${MAX_REPO_CHECK_CHARS} characters.`;
  return null;
}

/** What is wrong with a repo's verify steps (L2): at most 2000 characters. Blank is nothing to verify. */
export function repoVerifyProblem(verify: string): string | null {
  return charCount(verify.trim()) > MAX_REPO_VERIFY_CHARS
    ? `The verify steps are longer than ${MAX_REPO_VERIFY_CHARS} characters.`
    : null;
}

/**
 * A repo as saved: trimmed, with `check` and `verify` only when they hold
 * text, so a repo without them is saved as before L2.
 */
export function repoEntry(name: string, folder: string, check: string, verify: string): RepoEntry {
  const entry: RepoEntry = { name: name.trim(), folder: folder.trim() };
  if (check.trim()) entry.check = check.trim();
  if (verify.trim()) entry.verify = verify.trim();
  return entry;
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
  /** W1: `home` is a workspace of repos, not a repo: every lane names its repo. */
  workspace = false,
): { folders: LaneFolder[] } | { error: string } {
  const folders: LaneFolder[] = [];
  for (const lane of lanes) {
    const name = lane.repo?.trim();
    if (!name) {
      if (workspace) {
        return {
          error: `${lane.title} names no repo, and ${home} is a folder of repos, not a git repo. Send the plan back so the Planner sets its repo.`,
        };
      }
      folders.push({ laneId: lane.id, repo: null, folder: home });
      continue;
    }
    const repo = findRepo(repos, name);
    if (!repo) {
      return {
        error: workspace
          ? `${lane.title} is in the repo "${name}", which is not in ${home} or Settings › Repos.`
          : `${lane.title} is in the repo "${name}", which is not in Settings › Repos. Add it there, or ask the Planner to leave its repo out.`,
      };
    }
    folders.push({ laneId: lane.id, repo: repo.name, folder: repo.folder });
  }
  return { folders };
}
