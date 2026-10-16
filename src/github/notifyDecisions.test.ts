import { describe, expect, it } from "vitest";
import { MAX_NOTICES_PER_SYNC, deliveryFor, noticeFor, noticesFor, notifyCandidates } from "./notifyDecisions";
import { feed, item } from "./testFeed";

const review = item({ id: "review_requested:o/r#1", kind: "review_requested", title: "Presign", number: 1, repo: "koneksi-tech/koneksi-backend" });
const merged = item({ id: "pr_merged:o/r#2", kind: "pr_merged", number: 2 });
const bot = item({ id: "review_requested:o/r#3", kind: "review_requested", actor: "dependabot[bot]", actorIsBot: true });

describe("notification candidates", () => {
  it("are the human needs-you items", () => {
    expect(notifyCandidates(feed({ needsYou: [review, bot, merged] }))).toEqual([review.id, merged.id]);
  });

  it("are empty until every source has answered, or while gh needs a fix", () => {
    expect(notifyCandidates(feed({ needsYou: [review], needsYouReady: false }))).toEqual([]);
    expect(notifyCandidates(feed({ needsYou: [review], setup: { state: "signed_out", fix: "x" } }))).toEqual([]);
  });
});

describe("delivery", () => {
  const base = { tabId: "gh", visibleTabIds: ["other"] as string[] };
  const on = { enabled: true, system: true, toastWhenFocused: true };

  it("sends nothing when notifications are off", () => {
    expect(deliveryFor({ ...base, settings: { ...on, enabled: false }, windowFocused: false })).toEqual({ toast: false, system: false });
  });

  it("an unfocused window gets a system notification and a toast", () => {
    expect(deliveryFor({ ...base, settings: on, windowFocused: false })).toEqual({ toast: true, system: true });
    expect(deliveryFor({ ...base, settings: { ...on, system: false }, windowFocused: false })).toEqual({ toast: true, system: false });
  });

  it("a focused window gets a toast only if the setting allows it", () => {
    expect(deliveryFor({ ...base, settings: on, windowFocused: true })).toEqual({ toast: true, system: false });
    expect(deliveryFor({ ...base, settings: { ...on, toastWhenFocused: false }, windowFocused: true })).toEqual({ toast: false, system: false });
  });

  it("a GitHub tab already on screen in a focused window stays quiet", () => {
    expect(deliveryFor({ ...base, visibleTabIds: ["gh"], settings: on, windowFocused: true })).toEqual({ toast: false, system: false });
  });

  it("uses the defaults before settings load", () => {
    expect(deliveryFor({ ...base, settings: null, windowFocused: false })).toEqual({ toast: true, system: true });
  });
});

describe("notices", () => {
  it("describe the item", () => {
    expect(noticeFor(review)).toEqual({
      title: "GitHub · Review requested from you",
      body: "koneksi-backend #1: Presign",
    });
  });

  it("only cover claimed ids, never bots", () => {
    const f = feed({ needsYou: [review, merged, bot] });
    expect(noticesFor(f, [merged.id, bot.id]).map((n) => n.title)).toEqual(["GitHub · Your PR was merged"]);
    expect(noticesFor(f, [])).toEqual([]);
  });

  it("fold a burst into one summary", () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ id: `pr_merged:o/r#${i}`, kind: "pr_merged", number: i }));
    const out = noticesFor(feed({ needsYou: many }), many.map((m) => m.id));
    expect(out).toHaveLength(MAX_NOTICES_PER_SYNC);
    expect(out[out.length - 1].body).toContain("6 more");
  });
});
