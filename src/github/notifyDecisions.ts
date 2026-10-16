/**
 * Which "Needs you" items are announced, and how. Claiming (marking seen,
 * once across all windows) happens in the Rust store; this only picks the
 * candidates and the delivery.
 */
import {
  decideNotification,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type NotifyDecision,
} from "../notify/agentNotify";
import type { FeedItem, GithubFeed } from "./githubTypes";
import { needsYouItems, needsYouLabel, needsYouRef } from "./needsYou";

/** At most this many separate notices per sync; the rest are summarized. */
export const MAX_NOTICES_PER_SYNC = 4;

/**
 * Ids worth claiming: human items from a feed whose "Needs you" sources have
 * all answered. Before that nothing is claimed, so a half-loaded list cannot
 * set the first-sync baseline.
 */
export function notifyCandidates(feed: GithubFeed): string[] {
  if (feed.setup || !feed.needsYouReady) return [];
  return needsYouItems(feed).map((item) => item.id);
}

/** Delivery for a GitHub tab: the same rules as any other background tab. */
export function deliveryFor(input: {
  settings: NotificationSettings | null;
  windowFocused: boolean;
  tabId: string;
  visibleTabIds: readonly (string | null | undefined)[];
}): NotifyDecision {
  return decideNotification({
    tabId: input.tabId,
    visibleTabIds: input.visibleTabIds,
    windowFocused: input.windowFocused,
    settings: input.settings ?? DEFAULT_NOTIFICATION_SETTINGS,
  });
}

export function noticeFor(item: FeedItem): { title: string; body: string } {
  const body = [needsYouRef(item), item.title].filter(Boolean).join(": ");
  return { title: `GitHub · ${needsYouLabel(item)}`, body };
}

/** The notices for claimed ids, newest first; extras fold into one. */
export function noticesFor(
  feed: GithubFeed,
  claimed: readonly string[],
): { title: string; body: string }[] {
  const wanted = new Set(claimed);
  const items = needsYouItems(feed).filter((item) => wanted.has(item.id));
  if (items.length <= MAX_NOTICES_PER_SYNC) return items.map(noticeFor);
  const head = items.slice(0, MAX_NOTICES_PER_SYNC - 1).map(noticeFor);
  const more = items.length - head.length;
  return [...head, { title: "GitHub · More needs you", body: `${more} more items are waiting in the GitHub tab.` }];
}
