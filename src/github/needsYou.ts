/** "Needs you": what is waiting on the user, from notifications and search. */
import type { FeedItem, GithubFeed } from "./githubTypes";
import { refLabel } from "./githubModel";

/** Bots are left out whatever Show bots says. */
export function needsYouItems(feed: GithubFeed | null): FeedItem[] {
  return (feed?.needsYou ?? []).filter((item) => !item.actorIsBot);
}

export function needsYouLabel(item: FeedItem): string {
  switch (item.kind) {
    case "review_requested":
      return "Review requested from you";
    case "pr_merged":
      return "Your PR was merged";
    case "pr_closed":
      return "Your PR was closed";
    case "comment":
      return "New comment on your PR";
    default:
      return "Needs you";
  }
}

/** Who, in a few words. */
export function needsYouMeta(item: FeedItem): string {
  if (item.kind === "comment") return item.actor;
  if (item.kind === "review_requested") return item.actor ? `from ${item.actor}` : "";
  return "";
}

export function needsYouRef(item: FeedItem): string {
  return refLabel(item);
}
