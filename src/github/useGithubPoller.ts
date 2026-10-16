/**
 * Polls GitHub for the window while it has a GitHub tab, whether or not that
 * tab is on screen: every minute while visible, every five minutes otherwise
 * (longer when GitHub's X-Poll-Interval asks). It owns notifications too, so
 * they keep coming while the tab is hidden. Without a GitHub tab it is idle.
 */
import { useEffect, useRef, useState } from "react";
import { githubClaimNotifications, githubFeed } from "../bridge";
import type { NotificationSettings } from "../notify/agentNotify";
import { showSystemNotification } from "../notify/systemNotify";
import { isWindowFocused } from "../notify/windowFocus";
import {
  getGithubState,
  setGithubError,
  setGithubFeed,
  setGithubLoading,
  useGithubState,
} from "./feedCache";
import type { GithubFeed } from "./githubTypes";
import { deliveryFor, notifyCandidates, noticesFor } from "./notifyDecisions";

export const VISIBLE_INTERVAL_S = 60;
export const HIDDEN_INTERVAL_S = 300;

/** Seconds until the next poll. */
export function pollDelaySeconds(visible: boolean, pollInterval: number | undefined): number {
  const base = visible ? VISIBLE_INTERVAL_S : HIDDEN_INTERVAL_S;
  return Math.max(base, pollInterval ?? 0);
}

type Options = {
  /** The window's GitHub tab, or null when it has none (no polling). */
  tabId: string | null;
  /** The tab is on screen: active, the second pane or a grid cell. */
  visible: boolean;
  /** Tabs on screen right now, for the notification rules. */
  visibleTabIds: () => (string | null | undefined)[];
  settings: NotificationSettings | null;
  /** In-app toast for a notice. */
  toast: (tabId: string, title: string, body: string) => void;
  fetchFeed?: () => Promise<GithubFeed>;
  claim?: (ids: string[]) => Promise<string[]>;
  showSystem?: (title: string, body: string) => Promise<boolean>;
  windowFocused?: () => boolean;
};

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export function useGithubPoller(options: Options): void {
  const latest = useRef(options);
  latest.current = options;
  const inFlight = useRef(false);
  const [docVisible, setDocVisible] = useState(documentVisible);
  const nonce = useGithubState().refreshNonce;
  const { tabId, visible } = options;

  useEffect(() => {
    const onChange = () => setDocVisible(documentVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    if (!tabId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScreen = visible && docVisible;

    const cycle = async () => {
      // A cycle from before a re-render is still running: do not overlap.
      if (inFlight.current) {
        if (!cancelled) timer = setTimeout(() => void cycle(), 2000);
        return;
      }
      inFlight.current = true;
      setGithubLoading(true);
      try {
        const opts = latest.current;
        const feed = await (opts.fetchFeed ?? githubFeed)();
        // Kept even when this effect was replaced mid-flight: it is still news.
        setGithubFeed(feed);
        await announce(feed, tabId);
      } catch (err: unknown) {
        setGithubError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight.current = false;
        if (!cancelled) schedule();
      }
    };

    const announce = async (feed: GithubFeed, github: string) => {
      const opts = latest.current;
      const candidates = notifyCandidates(feed);
      // The first claim sets the baseline even with nothing to claim.
      if (!feed.needsYouReady || feed.setup) return;
      if (candidates.length === 0 && baselined) return;
      const claimed = await (opts.claim ?? githubClaimNotifications)(candidates);
      baselined = true;
      if (claimed.length === 0) return;
      const decision = deliveryFor({
        settings: opts.settings,
        windowFocused: (opts.windowFocused ?? isWindowFocused)(),
        tabId: github,
        visibleTabIds: opts.visibleTabIds(),
      });
      if (!decision.toast && !decision.system) return;
      for (const notice of noticesFor(feed, claimed)) {
        if (decision.toast) opts.toast(github, notice.title, notice.body);
        if (decision.system) {
          // A denied permission is not retried: the id stays claimed.
          void (opts.showSystem ?? showSystemNotification)(notice.title, notice.body);
        }
      }
    };

    const schedule = () => {
      if (cancelled) return;
      const seconds = pollDelaySeconds(onScreen, getGithubState().feed?.pollInterval);
      timer = setTimeout(() => void cycle(), seconds * 1000);
    };

    void cycle();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tabId, visible, docVisible, nonce]);
}

/** Set after this window's first successful claim. */
let baselined = false;

export function resetPollerForTests(): void {
  baselined = false;
}
