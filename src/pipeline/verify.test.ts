import { describe, expect, it } from "vitest";
import type { PipelineRun } from "../bridge";
import {
  latestVerification,
  MAX_VERIFY_NOTE_CHARS,
  pendingVerify,
  verifyAction,
  verifyNoteProblem,
  verifyWaitKey,
} from "./verify";

const STEPS = "Run the qa128-ml Playwright project on the Windows staging build.";

function run(extra: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "ee_v",
    kind: "full",
    cwd: "/repo",
    stage: "implementer",
    overviewTabId: "",
    tabIds: {},
    createdAt: "2026-10-22T00:00:00Z",
    engine: 2,
    status: "waiting",
    stopReason: "checkpoint",
    lanes: [
      { id: "pr1", title: "PR1 — API", status: "active", stage: "implementer", round: 1, tabIds: {}, repo: "backend" },
      { id: "pr2", title: "PR2 — Client", status: "waiting", stage: "implementer", round: 1, tabIds: {} },
    ],
    autopilot: {
      enabled: true,
      waiting: "PR1 — API: Implementer passed its checks, and backend verify waits for you.",
      verify: {
        stageId: "implementer",
        lane: "pr1",
        label: "backend verify",
        steps: STEPS,
        turn: "tab|bridge|t1",
        prs: ["https://github.com/acme/backend/pull/1"],
        at: "2026-10-22T10:00:00Z",
      },
    },
    ...extra,
  };
}

describe("verify gates (L2)", () => {
  it("shows the wait while the run waits with checkpoint on it, with its lane, repo and pull requests", () => {
    expect(pendingVerify(run())).toEqual({
      stageId: "implementer",
      lane: "pr1",
      laneTitle: "PR1 — API",
      repo: "backend",
      label: "backend verify",
      steps: STEPS,
      prs: ["https://github.com/acme/backend/pull/1"],
    });
    // Any other wait, or a run that moved on, shows nothing.
    expect(pendingVerify(run({ stopReason: "stalled" }))).toBeNull();
    expect(pendingVerify(run({ status: "running", stopReason: null }))).toBeNull();
    expect(pendingVerify(run({ autopilot: { enabled: true, waiting: "Checkpoint before Implementer." } }))).toBeNull();
    // A run that did not fan out has no lane.
    const plain = run({ lanes: [] });
    plain.autopilot!.verify = { ...plain.autopilot!.verify!, lane: null, label: "verify", prs: undefined };
    expect(pendingVerify(plain)).toMatchObject({ lane: null, laneTitle: null, repo: null, prs: [] });
  });

  it("keys a wait by its stage, lane and start, and none when the run waits on nothing", () => {
    expect(verifyWaitKey(run())).toBe("implementer@pr1@2026-10-22T10:00:00Z");
    expect(verifyWaitKey(run({ status: "running", stopReason: null }))).toBe("");
  });

  it("needs a note to fail, of at most 4000 characters", () => {
    expect(verifyNoteProblem("  ")).toBe("Say what failed: the note goes back to the stage.");
    expect(verifyNoteProblem("x".repeat(MAX_VERIFY_NOTE_CHARS + 1))).toContain("longer than 4000");
    expect(verifyNoteProblem("The session list is empty.")).toBeNull();
    // Counted as Rust counts them: code points.
    expect(verifyNoteProblem("😀".repeat(MAX_VERIFY_NOTE_CHARS))).toBeNull();
    expect(verifyNoteProblem("😀".repeat(MAX_VERIFY_NOTE_CHARS + 1))).toContain("longer than 4000");
  });

  it("builds the run actor's verify message", () => {
    const wait = pendingVerify(run())!;
    expect(verifyAction(wait, true)).toEqual({ kind: "verify", stageId: "implementer", lane: "pr1", verified: true, note: null });
    expect(verifyAction(wait, false, "  Empty list.  ")).toEqual({
      kind: "verify",
      stageId: "implementer",
      lane: "pr1",
      verified: false,
      note: "Empty list.",
    });
  });

  it("reads a lane's latest answer", () => {
    const record = (lane: string | null, result: "verified" | "failed", attempt: number) => ({
      stageId: "implementer",
      lane,
      round: 1,
      attempt,
      label: "verify",
      steps: STEPS,
      result,
      by: "you",
      at: "now",
    });
    const answered = run({ verifications: [record("pr1", "failed", 1), record(null, "failed", 1), record("pr1", "verified", 2)] });
    expect(latestVerification(answered, "pr1")?.result).toBe("verified");
    expect(latestVerification(answered, null)?.result).toBe("failed");
    expect(latestVerification(answered, "pr2")).toBeNull();
    expect(latestVerification(run(), "pr1")).toBeNull();
  });
});
