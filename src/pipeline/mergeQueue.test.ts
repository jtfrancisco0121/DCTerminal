import { describe, expect, it } from "vitest";
import type { QueueEntry } from "../bridge";
import { entryName, repoLine, stateLabel } from "./mergeQueue";

const entry = (planId: string, state: QueueEntry["state"], extra: Partial<QueueEntry> = {}): QueueEntry => ({
  planId,
  title: planId,
  state,
  next: false,
  warnings: [],
  ...extra,
});

describe("merge queue words (R3)", () => {
  it("names a place by its plan and pull request number", () => {
    expect(entryName(entry("plan2", "open", { number: 12 }))).toBe("plan2 #12");
    expect(entryName(entry("plan3", "missing"))).toBe("plan3");
    expect(stateLabel("closed")).toBe("closed (not merged)");
    expect(stateLabel("missing")).toBe("no pull request yet");
  });

  it("says what is next in a repo, or why nothing is", () => {
    expect(repoLine({ repo: "web", entries: [entry("plan4", "merged"), entry("plan7", "open", { number: 47, next: true })] })).toBe(
      "Next to merge: plan7 #47",
    );
    expect(repoLine({ repo: "web", entries: [entry("plan4", "merged"), entry("plan3", "parked")] })).toBe("Everything merged");
    expect(repoLine({ repo: "web", entries: [entry("plan4", "missing"), entry("plan7", "open")] })).toBe(
      "Nothing to merge yet: plan4 has no pull request here.",
    );
    expect(repoLine({ repo: "web", entries: [entry("plan4", "unknown", { number: 41 })] })).toBe(
      "Nothing suggested: plan4 #41's state could not be read.",
    );
  });
});
