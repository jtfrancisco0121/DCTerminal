/**
 * W1: workspace folders. A start folder that is not a git repo but holds
 * repos as child folders (`~/Documents/Koneksi`) is a workspace: its repos
 * are found by the Rust side (`workspace_repos.rs`) and merged with
 * Settings › Repos. Pure: the start screen line, and what fan-out allows.
 */
import type { RepoEntry, WorkspaceRepos } from "../bridge";

/** How many repo names the start screen line spells out before "…". */
export const WORKSPACE_LINE_NAMES = 3;

/** `repo`'s folder is `folder` or inside it (either slash). */
function inside(repo: RepoEntry, folder: string): boolean {
  const base = folder.trim().replace(/[\\/]+$/, "");
  const path = repo.folder.trim();
  return !!base && (path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`));
}

/** The repos found in `folder` (not the Settings entries kept from elsewhere). */
export function reposFoundIn(info: WorkspaceRepos, folder: string): RepoEntry[] {
  return info.repos.filter((repo) => inside(repo, folder));
}

/**
 * "Workspace: 3 repos found (koneksi-backend, koneksi-engine, …)" for a
 * workspace folder; null for anything else.
 */
export function workspaceLine(info: WorkspaceRepos | null, folder: string): string | null {
  if (!info?.workspace) return null;
  const found = reposFoundIn(info, folder);
  if (!found.length) return null;
  const names = found.slice(0, WORKSPACE_LINE_NAMES).map((repo) => repo.name);
  const more = found.length > WORKSPACE_LINE_NAMES ? ", …" : "";
  return `Workspace: ${found.length} repo${found.length === 1 ? "" : "s"} found (${names.join(", ")}${more})`;
}

/**
 * The fewest pull requests fan-out takes: two, or one in a workspace (a
 * one-task plan still gets a worktree in its repo).
 */
export function minFanOutLanes(workspace: boolean): number {
  return workspace ? 1 : 2;
}
