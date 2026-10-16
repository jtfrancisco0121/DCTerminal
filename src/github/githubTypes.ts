/** Shapes the GitHub monitor commands return (see src-tauri/src/github). */

export type FeedKind =
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "pr_reopened"
  | "review_requested"
  | "review"
  | "comment"
  | "push"
  | "branch_created"
  | "branch_deleted"
  | "tag_created"
  | "tag_deleted"
  | "release"
  | "issue_opened"
  | "issue_closed"
  | "issue_reopened"
  | "other";

export type FeedSource = "koneksi-tech" | "personal";

export type FeedItem = {
  id: string;
  kind: FeedKind | string;
  source: FeedSource | string;
  /** `owner/repo` */
  repo: string;
  actor: string;
  actorIsBot: boolean;
  title: string;
  /** An https://github.com/ address, or empty. */
  url: string;
  /** RFC 3339, UTC */
  at: string;
  number?: number;
  ref?: string;
  prAuthor?: string;
  involvesMe: boolean;
  detail?: string;
  push?: { before: string; head: string };
};

export type RepoStatus = {
  repo: string;
  source: FeedSource | string;
  /** null until the repo has been polled once */
  reachable: boolean | null;
  error?: string;
  /** Oldest event GitHub still returns for this repo. */
  oldest?: string;
};

export type GithubSetup = {
  state: "missing" | "signed_out" | "scope" | "offline" | string;
  fix: string;
};

export type GithubFeed = {
  items: FeedItem[];
  needsYou: FeedItem[];
  needsYouReady: boolean;
  repos: RepoStatus[];
  /** Seconds GitHub asked us to wait between polls. */
  pollInterval: number;
  rateRemaining?: number;
  rateLimited: boolean;
  setup?: GithubSetup;
  /** Unix seconds */
  fetchedAt: number;
  errors: Record<string, string>;
};

export type GithubFilters = {
  chip: "all" | "koneksi-tech" | "mine" | string;
  /** `owner/repo`, or "" for every repo */
  repo: string;
  /** Event groups switched off. */
  hiddenTypes: string[];
  involvesMe: boolean;
  showBots: boolean;
};

export type GithubStatus = {
  state: "ready" | "missing" | "signed_out" | "scope" | "offline" | string;
  fix?: string | null;
  login?: string | null;
  scopes?: string[] | null;
  repos: RepoStatus[];
  filters: GithubFilters;
};

export type PushCommit = {
  sha: string;
  message: string;
  author: string;
  url: string;
  at: string;
};

export type PushCommits = {
  commits: PushCommit[];
  total: number;
};
