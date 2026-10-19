import { readFileSync } from "node:fs";
import type { Role, TabSummary } from "../../../src/bridge";
import type { FeedItem, GithubFilters, RepoStatus } from "../../../src/github/githubTypes";
import type { GithubMock } from "./types";

export const CWD = "/Users/e2e/Projects/demo";

/** Built-in roles from the seed the app ships (`seed/roles.seed.json`). */
export function builtInRoles(): Role[] {
  const seed = JSON.parse(
    readFileSync(new URL("../../../seed/roles.seed.json", import.meta.url), "utf8"),
  ) as { roles: Role[] };
  return seed.roles;
}

export function roleTab(id: string, roleId: string, label: string, extra: Partial<TabSummary> = {}): TabSummary {
  return {
    id,
    label,
    roleId,
    cwd: CWD,
    phase: "draft",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: false,
    folderStatus: "ok",
    color: "",
    kind: "role",
    terminalLaunch: "",
    acpSessionId: null,
    model: null,
    provider: "claude",
    chain: null,
    ...extra,
  };
}

/**
 * The GitHub monitor's answers (src-tauri/src/commands/github.rs): gh signed
 * in as `e2e-dev`, two repos, one review request and three events. Push
 * commits are keyed `repo@head`.
 */
export function sampleGithub(): GithubMock {
  const repos: RepoStatus[] = [
    { repo: "koneksi-tech/koneksi-web", source: "koneksi-tech", reachable: true, oldest: "2026-10-01T00:00:00Z" },
    { repo: "e2e-dev/dotfiles", source: "personal", reachable: true, oldest: "2026-10-01T00:00:00Z" },
  ];
  const reviewRequest: FeedItem = {
    id: "n-1",
    kind: "review_requested",
    source: "koneksi-tech",
    repo: "koneksi-tech/koneksi-web",
    actor: "alvin-reyes",
    actorIsBot: false,
    title: "Add upload retry",
    url: "https://github.com/koneksi-tech/koneksi-web/pull/41",
    at: "2026-10-15T06:20:00Z",
    number: 41,
    involvesMe: true,
  };
  const items: FeedItem[] = [
    { ...reviewRequest, id: "e-3", kind: "pr_opened", involvesMe: false },
    {
      id: "e-2",
      kind: "push",
      source: "personal",
      repo: "e2e-dev/dotfiles",
      actor: "e2e-dev",
      actorIsBot: false,
      title: "2 commits to main",
      url: "https://github.com/e2e-dev/dotfiles/compare/aaa1111...bbb2222",
      at: "2026-10-15T05:00:00Z",
      ref: "main",
      involvesMe: true,
      push: { before: "aaa1111", head: "bbb2222" },
    },
    {
      id: "e-1",
      kind: "push",
      source: "koneksi-tech",
      repo: "koneksi-tech/koneksi-web",
      actor: "renovate[bot]",
      actorIsBot: true,
      title: "1 commit to deps",
      url: "https://github.com/koneksi-tech/koneksi-web/compare/ccc3333...ddd4444",
      at: "2026-10-14T05:00:00Z",
      ref: "deps",
      involvesMe: false,
      push: { before: "ccc3333", head: "ddd4444" },
    },
  ];
  const filters: GithubFilters = { chip: "all", repo: "", hiddenTypes: [], involvesMe: false, showBots: false };
  return {
    status: { state: "ready", fix: null, login: "e2e-dev", scopes: ["repo", "read:org"], repos, filters },
    feed: {
      items,
      needsYou: [reviewRequest],
      needsYouReady: true,
      repos,
      pollInterval: 60,
      rateRemaining: 4900,
      rateLimited: false,
      fetchedAt: Math.floor(Date.now() / 1000),
      errors: {},
    },
    commits: {
      "e2e-dev/dotfiles@bbb2222": {
        total: 2,
        commits: [
          {
            sha: "bbb2222aaaaaaa",
            message: "Use zsh completions",
            author: "e2e-dev",
            url: "https://github.com/e2e-dev/dotfiles/commit/bbb2222aaaaaaa",
            at: "2026-10-15T04:59:00Z",
          },
          {
            sha: "abc1234bbbbbbb",
            message: "Add git aliases",
            author: "e2e-dev",
            url: "https://github.com/e2e-dev/dotfiles/commit/abc1234bbbbbbb",
            at: "2026-10-15T04:58:00Z",
          },
        ],
      },
    },
  };
}
