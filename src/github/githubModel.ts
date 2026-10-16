/** Pure view logic for the GitHub tab: filtering, grouping and labels. */
import type { FeedItem, GithubFilters, RepoStatus } from "./githubTypes";

export type TypeGroup =
  | "pr"
  | "merge"
  | "review"
  | "comment"
  | "push"
  | "branch"
  | "release"
  | "other";

export const TYPE_GROUPS: { id: TypeGroup; label: string }[] = [
  { id: "pr", label: "PRs" },
  { id: "merge", label: "Merges" },
  { id: "review", label: "Reviews" },
  { id: "comment", label: "Comments" },
  { id: "push", label: "Pushes" },
  { id: "branch", label: "Branches" },
  { id: "release", label: "Releases" },
  { id: "other", label: "Other" },
];

export const DEFAULT_FILTERS: GithubFilters = {
  chip: "all",
  repo: "",
  hiddenTypes: [],
  involvesMe: false,
  showBots: false,
};

/** The toggle an event belongs to. */
export function groupOf(kind: string): TypeGroup {
  switch (kind) {
    case "pr_opened":
    case "pr_closed":
    case "pr_reopened":
      return "pr";
    case "pr_merged":
      return "merge";
    case "review":
    case "review_requested":
      return "review";
    case "comment":
      return "comment";
    case "push":
      return "push";
    case "branch_created":
    case "branch_deleted":
    case "tag_created":
    case "tag_deleted":
      return "branch";
    case "release":
      return "release";
    default:
      return "other";
  }
}

export type Filtered = {
  shown: FeedItem[];
  /** Events the Show bots toggle is hiding (after the other filters). */
  hiddenBots: number;
};

/** Applies the chips, repo, type toggles, "involves me" and Show bots. */
export function applyFilters(items: FeedItem[], filters: GithubFilters): Filtered {
  const hidden = new Set(filters.hiddenTypes);
  const shown: FeedItem[] = [];
  let hiddenBots = 0;
  for (const item of items) {
    if (filters.chip === "koneksi-tech" && item.source !== "koneksi-tech") continue;
    if (filters.chip === "mine" && item.source !== "personal") continue;
    if (filters.repo && item.repo !== filters.repo) continue;
    if (hidden.has(groupOf(item.kind))) continue;
    if (filters.involvesMe && !item.involvesMe) continue;
    if (item.actorIsBot && !filters.showBots) {
      hiddenBots += 1;
      continue;
    }
    shown.push(item);
  }
  return { shown, hiddenBots };
}

export function chipCounts(repos: RepoStatus[]): { all: number; org: number; mine: number } {
  const org = repos.filter((r) => r.source === "koneksi-tech").length;
  const mine = repos.filter((r) => r.source === "personal").length;
  return { all: org + mine, org, mine };
}

/** Repos the repo filter offers for the selected chip. */
export function reposForChip(repos: RepoStatus[], chip: string): RepoStatus[] {
  return repos.filter((r) =>
    chip === "koneksi-tech" ? r.source === "koneksi-tech" : chip === "mine" ? r.source === "personal" : true,
  );
}

export function shortRepo(full: string): string {
  return full.split("/")[1] ?? full;
}

/** `#41`, or the branch, tag or release name. */
export function refLabel(item: FeedItem): string {
  const repo = shortRepo(item.repo);
  if (item.number != null) return `${repo} #${item.number}`;
  if (item.ref) return `${repo} ${item.ref}`;
  return repo;
}

const KIND_LABEL: Record<string, string> = {
  pr_opened: "PR opened",
  pr_merged: "Merged",
  pr_closed: "PR closed",
  pr_reopened: "PR reopened",
  review_requested: "Review requested",
  review: "Review",
  comment: "Comment",
  push: "Pushed",
  branch_created: "Branch created",
  branch_deleted: "Branch deleted",
  tag_created: "Tag created",
  tag_deleted: "Tag deleted",
  release: "Release",
  issue_opened: "Issue opened",
  issue_closed: "Issue closed",
  issue_reopened: "Issue reopened",
  other: "Activity",
};

export function kindLabel(item: FeedItem): string {
  if (item.kind === "review" && item.detail) {
    return item.detail === "requested changes" ? "Changes requested" : `Review ${item.detail}`;
  }
  return KIND_LABEL[item.kind] ?? "Activity";
}

/** CSS tone class suffix for an event. */
export function kindTone(item: FeedItem): string {
  switch (item.kind) {
    case "pr_merged":
      return "merged";
    case "pr_opened":
    case "pr_reopened":
    case "issue_opened":
      return "opened";
    case "pr_closed":
    case "issue_closed":
    case "branch_deleted":
    case "tag_deleted":
      return "closed";
    case "review":
    case "review_requested":
      return "review";
    case "push":
      return "push";
    default:
      return "muted";
  }
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dayLabel(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const diff = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export type DayGroup = { label: string; items: FeedItem[] };

/** Consecutive items of the same day, in the order given. */
export function groupByDay(items: FeedItem[], now: number = Date.now()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const label = dayLabel(item.at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function monthDay(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * How far back the feed reaches: the newest of the per-repo "oldest event"
 * dates is as far as every repo in view is covered. A repo that reaches less
 * far back than the rest is named.
 */
export function reachNote(repos: RepoStatus[], filters: GithubFilters): string {
  const inView = reposForChip(repos, filters.chip).filter(
    (r) => (!filters.repo || r.repo === filters.repo) && r.oldest && r.reachable !== false,
  );
  if (inView.length === 0) return "";
  const times = inView.map((r) => Date.parse(r.oldest as string)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return "";
  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  const base = `Reaches back to ${monthDay(new Date(newest).toISOString())} in every repo shown`;
  if (newest - oldest < 3 * 86_400_000) return `${base}. GitHub keeps the last 300 events per repo.`;
  const shortest = inView
    .filter((r) => Date.parse(r.oldest as string) > oldest + 3 * 86_400_000)
    .sort((a, b) => Date.parse(b.oldest as string) - Date.parse(a.oldest as string))
    .slice(0, 3)
    .map((r) => `${shortRepo(r.repo)} (${monthDay(r.oldest as string)})`);
  return `${base}; ${shortest.join(", ")} reach${shortest.length === 1 ? "es" : ""} less far back. GitHub keeps the last 300 events per repo.`;
}

/** Repos that cannot be reached, for the notice on the filter. */
export function unreachable(repos: RepoStatus[]): RepoStatus[] {
  return repos.filter((r) => r.reachable === false);
}

/** Only https://github.com/ addresses are ever opened. */
export function isGithubUrl(url: string): boolean {
  return url.startsWith("https://github.com/") && !/\s/.test(url);
}
