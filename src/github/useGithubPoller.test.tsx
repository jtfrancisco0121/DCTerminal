// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  githubFeed: vi.fn(),
  githubClaimNotifications: vi.fn(),
}));

import { getGithubState, requestGithubRefresh, resetGithubStateForTests } from "./feedCache";
import { HIDDEN_INTERVAL_S, VISIBLE_INTERVAL_S, pollDelaySeconds, resetPollerForTests, useGithubPoller } from "./useGithubPoller";
import { feed, item } from "./testFeed";
import type { GithubFeed } from "./githubTypes";

const settings = { enabled: true, system: true, toastWhenFocused: true };
const review = item({ id: "review_requested:o/r#1", kind: "review_requested", number: 1 });

function setup(over: Partial<Parameters<typeof useGithubPoller>[0]> = {}, initial: Partial<GithubFeed> = {}) {
  const fetchFeed = vi.fn(async () => feed({ needsYou: [review], ...initial }));
  const claim = vi.fn(async (ids: string[]) => ids);
  const toast = vi.fn();
  const showSystem = vi.fn(async () => true);
  const props = {
    tabId: "gh" as string | null,
    visible: true,
    visibleTabIds: () => ["other"],
    settings,
    toast,
    fetchFeed,
    claim,
    showSystem,
    windowFocused: () => false,
    ...over,
  };
  const hook = renderHook((p: typeof props) => useGithubPoller(p), { initialProps: props });
  return { fetchFeed, claim, toast, showSystem, hook, props };
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetGithubStateForTests();
  resetPollerForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("poll timing", () => {
  it("is a minute while visible and five minutes otherwise, longer if GitHub asks", () => {
    expect(pollDelaySeconds(true, 60)).toBe(VISIBLE_INTERVAL_S);
    expect(pollDelaySeconds(false, 60)).toBe(HIDDEN_INTERVAL_S);
    expect(pollDelaySeconds(true, 120)).toBe(120);
    expect(pollDelaySeconds(false, 60)).toBe(300);
    expect(pollDelaySeconds(true, undefined)).toBe(60);
  });
});

describe("useGithubPoller", () => {
  it("polls at once, then every 60 seconds while the tab is visible", async () => {
    const { fetchFeed } = setup();
    await tick(0);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    await tick(59_000);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
    await tick(60_000);
    expect(fetchFeed).toHaveBeenCalledTimes(3);
  });

  it("keeps polling every 5 minutes while the tab is hidden (nothing is mounted)", async () => {
    const { fetchFeed } = setup({ visible: false });
    await tick(0);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    await tick(240_000);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    await tick(60_000);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  });

  it("does not poll without a GitHub tab", async () => {
    const { fetchFeed } = setup({ tabId: null });
    await tick(600_000);
    expect(fetchFeed).not.toHaveBeenCalled();
  });

  it("stops when the tab goes away", async () => {
    const { fetchFeed, hook, props } = setup();
    await tick(0);
    hook.rerender({ ...props, tabId: null });
    await tick(600_000);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
  });

  it("honours a longer X-Poll-Interval", async () => {
    const { fetchFeed } = setup({}, { pollInterval: 180 });
    await tick(0);
    await tick(120_000);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    await tick(60_000);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  });

  it("never runs two cycles at once", async () => {
    let release: () => void = () => {};
    let running = 0;
    let peak = 0;
    const fetchFeed = vi.fn(
      () =>
        new Promise<GithubFeed>((resolve) => {
          running += 1;
          peak = Math.max(peak, running);
          release = () => {
            running -= 1;
            resolve(feed());
          };
        }),
    );
    const { hook, props } = setup({ fetchFeed });
    await tick(0);
    // Visibility changes re-run the effect while the first cycle is in flight.
    hook.rerender({ ...props, visible: false });
    hook.rerender({ ...props, visible: true });
    await tick(5_000);
    expect(peak).toBe(1);
    await act(async () => release());
    await tick(0);
    expect(getGithubState().feed).not.toBeNull();
  });

  it("keeps the last feed and reports the error when a cycle fails", async () => {
    const fetchFeed = vi.fn().mockResolvedValueOnce(feed({ fetchedAt: 5 })).mockRejectedValueOnce(new Error("gh timed out"));
    setup({ fetchFeed });
    await tick(0);
    await tick(60_000);
    expect(getGithubState().feed?.fetchedAt).toBe(5);
    expect(getGithubState().error).toBe("gh timed out");
  });

  it("polls right away when asked to check again", async () => {
    const { fetchFeed } = setup();
    await tick(0);
    act(() => requestGithubRefresh());
    await tick(0);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  });
});

describe("notifications from the poller", () => {
  it("the first sync claims (sets the baseline) and announces nothing", async () => {
    const { claim, toast, showSystem } = setup();
    claim.mockResolvedValueOnce([]);
    await tick(0);
    expect(claim).toHaveBeenCalledWith([review.id]);
    expect(toast).not.toHaveBeenCalled();
    expect(showSystem).not.toHaveBeenCalled();
  });

  it("announces claimed items with a toast and a system notification when unfocused", async () => {
    const { toast, showSystem } = setup();
    await tick(0);
    expect(toast).toHaveBeenCalledWith("gh", "GitHub · Review requested from you", "koneksi-web #1: Add upload retry");
    expect(showSystem).toHaveBeenCalledTimes(1);
  });

  it("only announces what the store hands back", async () => {
    const { claim, toast } = setup();
    claim.mockResolvedValue([]);
    await tick(0);
    expect(toast).not.toHaveBeenCalled();
  });

  it("sends nothing when notifications are off, but still claims", async () => {
    const { claim, toast, showSystem } = setup({ settings: { ...settings, enabled: false } });
    await tick(0);
    expect(claim).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(showSystem).not.toHaveBeenCalled();
  });

  it("never claims or announces for bots", async () => {
    const bot = item({ id: "review_requested:o/r#9", kind: "review_requested", actor: "dependabot[bot]", actorIsBot: true });
    const { claim, toast } = setup({}, { needsYou: [bot] });
    await tick(0);
    // Nothing to claim after the baseline, and nothing to say.
    expect(claim).toHaveBeenCalledWith([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not claim from a half-loaded or broken feed", async () => {
    const half = setup({}, { needsYouReady: false });
    await tick(0);
    expect(half.claim).not.toHaveBeenCalled();
    resetPollerForTests();
    const broken = setup({}, { setup: { state: "signed_out", fix: "gh auth login" } });
    await tick(0);
    expect(broken.claim).not.toHaveBeenCalled();
  });

  it("a denied system permission is not retried: the id stays claimed", async () => {
    const { claim, showSystem } = setup();
    const seen = new Set<string>();
    claim.mockImplementation(async (ids: string[]) => ids.filter((id) => !seen.has(id) && seen.add(id)));
    showSystem.mockResolvedValue(false);
    await tick(0);
    await tick(60_000);
    // The second cycle has nothing new to claim after the baseline flag.
    expect(showSystem).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(2);
  });
});
