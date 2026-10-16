import type { FeedItem, GithubFeed } from "./githubTypes";

export function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "1",
    kind: "pr_opened",
    source: "koneksi-tech",
    repo: "koneksi-tech/koneksi-web",
    actor: "alvin-reyes",
    actorIsBot: false,
    title: "Add upload retry",
    url: "https://github.com/koneksi-tech/koneksi-web/pull/41",
    at: "2026-10-15T06:18:06Z",
    number: 41,
    involvesMe: false,
    ...over,
  };
}

export function feed(over: Partial<GithubFeed> = {}): GithubFeed {
  return {
    items: [],
    needsYou: [],
    needsYouReady: true,
    repos: [],
    pollInterval: 60,
    rateLimited: false,
    fetchedAt: 1_792_000_000,
    errors: {},
    ...over,
  };
}
