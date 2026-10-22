import { describe, expect, it } from "vitest";
import type { PipelineRun, RunStory } from "../bridge";
import {
  currentStory,
  laneStories,
  parseAddedStories,
  pendingStoryCheckpoint,
  resendableStory,
  storyResendAction,
  storyContinueAction,
  storyContinueProblem,
  storyProgress,
  storyStatusText,
  storyWaitKey,
} from "./stories";

function stories(lane: string | null): RunStory[] {
  return [
    { lane, id: "s1", title: "R5 instrumentation", tickets: ["86c0r5"], checkpoint: "Rerun on Windows", status: "done", note: "Stalls 40 s." },
    { lane, id: "s2", title: "T14-4 log dedupe", status: "failed", attempt: 2 },
    { lane, id: "s3", title: "T14-2 lock-file filter", status: "pending" },
    { lane, id: "s4", title: "T14-1 folder name" },
  ];
}

function run(extra: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "ee_s",
    kind: "full",
    cwd: "/repo",
    stage: "implementer",
    overviewTabId: "",
    tabIds: {},
    createdAt: "2026-10-22T00:00:00Z",
    engine: 2,
    status: "running",
    ...extra,
  };
}

describe("stories (L3)", () => {
  it("reads each lane's stories, the current one and the progress line", () => {
    const view = run({ stories: [...stories("pr1"), { lane: "pr2", id: "s1", title: "Other", status: "done" }] });
    expect(laneStories(view, "pr1").map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(laneStories(view, null)).toEqual([]);
    expect(currentStory(view, "pr1")?.id).toBe("s2");
    expect(storyProgress(view, "pr1")).toBe("story 2/4");
    expect(storyProgress(view, "pr2")).toBe("stories done (1)");
    expect(storyProgress(view, null)).toBeNull();
    expect(storyProgress(run(), "pr1")).toBeNull();
  });

  it("offers Resend story only for a run stopped mid-loop", () => {
    const stopped = run({ status: "waiting", stopReason: "gate_failed", stories: stories(null), autopilot: { enabled: true } });
    expect(resendableStory(stopped, null)?.id).toBe("s2");
    expect(storyResendAction(null)).toEqual({ kind: "storyResend", lane: null });
    // Running again after a stop: a failed story can be resent; an active one is under way.
    expect(resendableStory({ ...stopped, status: "running" }, null)?.id).toBe("s2");
    const active = { ...stopped, status: "running" as const, stories: stories(null).map((s) => (s.id === "s2" ? { ...s, status: "active" as const } : s)) };
    expect(resendableStory(active, null)).toBeNull();
    expect(resendableStory({ ...stopped, autopilot: { enabled: false } }, null)).toBeNull();
    const verifying = { ...stopped, stories: stories(null).map((s) => (s.id === "s2" ? { ...s, status: "verifying" as const } : s)) };
    expect(resendableStory(verifying, null)).toBeNull();
    expect(storyStatusText({ id: "s4", title: "x", status: "verifying" })).toBe("waiting on your verification");
    expect(resendableStory({ ...stopped, autopilot: { enabled: true, verify: { stageId: "implementer", label: "verify", steps: "x", at: "now" } } }, null)).toBeNull();
    const skipped = { ...stopped, stories: stories(null).map((s) => ({ ...s, status: "skipped" as const })) };
    expect(resendableStory(skipped, null)).toBeNull();
    expect(storyProgress(skipped, null)).toBe("stories finished (4 skipped)");
    expect(storyStatusText({ id: "s5", title: "x", status: "skipped" })).toBe("skipped");
  });

  it("says where each story stands", () => {
    const [done, failed, pending, missing] = stories(null);
    expect([done, failed, pending, missing].map(storyStatusText)).toEqual([
      "done",
      "checks failed (attempt 2)",
      "pending",
      "pending",
    ]);
    expect(storyStatusText({ id: "s5", title: "x", status: "checking" })).toBe("checks running");
    expect(storyStatusText({ id: "s5", title: "x", status: "waiting" })).toBe("waiting on you");
  });

  it("shows a checkpoint story the run waits on, and builds your Continue", () => {
    const waitingRun = run({
      status: "waiting",
      stopReason: "checkpoint",
      lanes: [{ id: "pr1", title: "PR1 — Engine fixes", status: "active", stage: "implementer", round: 1, tabIds: {}, repo: "engine" }],
      stories: stories("pr1").map((s) => (s.id === "s1" ? { ...s, status: "waiting" as const } : { ...s, status: "pending" as const })),
      autopilot: {
        enabled: true,
        storyWait: { stageId: "implementer", lane: "pr1", story: "s1", checkpoint: "Rerun on Windows", turn: "tab|bridge|t1", at: "2026-10-22T10:00:00Z" },
      },
    });
    const pending = pendingStoryCheckpoint(waitingRun);
    expect(pending).toMatchObject({ lane: "pr1", laneTitle: "PR1 — Engine fixes", repo: "engine", number: 1, total: 4, checkpoint: "Rerun on Windows" });
    expect(pending?.next?.id).toBe("s2");
    expect(storyWaitKey(waitingRun)).toBe("pr1@s1@2026-10-22T10:00:00Z");
    // Continue needs the run's wait; a waiting record alone is not enough.
    const noWait = { ...waitingRun, status: "running" as const, stopReason: null, autopilot: { enabled: true } };
    expect(pendingStoryCheckpoint(noWait)).toBeNull();
    expect(storyWaitKey(noWait)).toBe("");
    // While autopilot is off the run is stopped: the panel waits until it is on again.
    expect(pendingStoryCheckpoint({ ...waitingRun, status: "stopped", stopReason: "paused_by_you" })).toBeNull();

    expect(parseAddedStories("- Fix the stall\n\n * Tidy the log \n1. Numbered\n2) Also\n-flag stays\n2024 plan")).toEqual([
      "Fix the stall",
      "Tidy the log",
      "Numbered",
      "Also",
      "-flag stays",
      "2024 plan",
    ]);
    expect(storyContinueAction(pending!, "  Stalls 40 s.  ", "- Fix the stall\n")).toEqual({
      kind: "storyContinue",
      lane: "pr1",
      story: "s1",
      note: "Stalls 40 s.",
      add: "Fix the stall",
    });
    expect(storyContinueAction(pending!, " ", "")).toEqual({ kind: "storyContinue", lane: "pr1", story: "s1", note: null, add: null });
    expect(storyContinueProblem(pending!, "ok", "")).toBeNull();
    expect(storyContinueProblem(pending!, "x".repeat(4001), "")).toContain("longer than 4000");
    expect(storyContinueProblem(pending!, "", Array.from({ length: 17 }, (_, i) => `Story ${i}`).join("\n"))).toContain("at most 20");
  });
});
