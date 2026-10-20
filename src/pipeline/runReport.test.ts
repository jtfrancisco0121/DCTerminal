import { describe, expect, it } from "vitest";
import type { PipelineRun } from "../bridge";
import type { StageDef } from "./defs";
import { followUps, formatRunReport, reviewRound } from "./runReport";

function run(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "ee_1",
    kind: "full",
    cwd: "/repo",
    stage: "pr_reviewer",
    overviewTabId: "",
    tabIds: { role_planner: "tab-1", role_implementer: "tab-3" },
    createdAt: "2026-10-13T10:00:00Z",
    chainId: "ee_1",
    originalRequest: "Login 500\n\nExpired tokens return 500.",
    round: 2,
    verdicts: [{ roleId: "role_pr_reviewer", round: 1, verdict: "REQUEST CHANGES", at: "x" }],
    gates: {
      implementer: {
        round: 2,
        at: "x",
        results: [
          {
            kind: "command",
            label: "npm run check",
            status: "passed",
            summary: "Passed.",
            durationMs: 900,
          },
        ],
      },
    },
    events: [
      {
        at: "2026-10-13T10:05:00Z",
        kind: "gate",
        stageId: "implementer",
        round: 1,
        summary: "npm run check: Failed (exit code 1).",
        detail: "1 test failed\n```inner```",
      },
      {
        at: "2026-10-13T10:20:00Z",
        kind: "complete",
        stageId: "pr_reviewer",
        round: 2,
        summary: "REQUEST CHANGES with only findings below MEDIUM",
        detail: "[LOW] rename x\n[INFO] comment wording",
      },
    ],
    engine: 2,
    autopilot: { enabled: true },
    ...overrides,
  };
}

describe("run report", () => {
  it("lists stages, verdicts by round, checks, follow-ups and the timeline", () => {
    const report = formatRunReport(run(), new Date("2026-10-13T11:00:00Z"));
    expect(report).toContain("# Eagle-Eye 1 run ee_1");
    expect(report).toContain("- Autopilot: on");
    expect(report).toContain("## Original request\n\nLogin 500");
    expect(report).toContain("### PR Reviewer");
    expect(report).toContain("- Round 1: REQUEST CHANGES");
    expect(report).toContain("- **passed** `npm run check`: Passed.");
    expect(report).toContain("## Follow-ups\n\n- [LOW] rename x\n- [INFO] comment wording");
    expect(report).toContain("**Check** (Implementer): npm run check: Failed (exit code 1).");
    // Output with backticks gets a longer fence, so the report stays valid Markdown.
    expect(report).toContain("````\n1 test failed\n```inner```\n````");
    expect(report.endsWith("\n")).toBe(true);
  });

  it("an engine-1 run is manual only: no Autopilot on or Waiting for you, even when saved that way", () => {
    for (const overrides of [{ engine: 1 }, { engine: 2, manualOnly: true }] as Partial<PipelineRun>[]) {
      const report = formatRunReport(run({ ...overrides, autopilot: { enabled: true, waiting: "PR Reviewer needs you." } }));
      expect(report).toContain("- Autopilot: off (this run is manual only)");
      expect(report).not.toContain("- Autopilot: on");
      expect(report).not.toContain("- Waiting for you:");
    }
  });

  it("follow-ups come only from autopilot decisions", () => {
    expect(followUps(run({ events: [] }))).toEqual([]);
    expect(followUps(run())).toEqual(["[LOW] rename x", "[INFO] comment wording"]);
  });

  it("a stopped run and each stop line name the reason code's plain-English line", () => {
    const report = formatRunReport(
      run({
        status: "waiting",
        stopReason: "usage_limit",
        autopilot: { enabled: true, waiting: "Implementer hit a Claude usage limit: resets 3pm." },
        events: [
          {
            at: "2026-10-13T10:30:00Z",
            kind: "stop",
            stageId: "implementer",
            round: 2,
            summary: "Implementer hit a Claude usage limit: resets 3pm.",
            outcome: "usage_limit",
          },
        ],
      }),
    );
    expect(report).toContain(
      "- Waiting for you: Claude's usage limit was reached. Implementer hit a Claude usage limit: resets 3pm.",
    );
    expect(report).toContain(
      "**Waiting for you** (Implementer): Claude's usage limit was reached. Implementer hit a Claude usage limit: resets 3pm.",
    );
  });

  it("an empty ledger says so", () => {
    expect(formatRunReport(run({ events: [], gates: {} }))).toContain("Nothing recorded yet.");
  });
});

describe("reviewRound", () => {
  const prReviewer = {
    id: "pr_reviewer",
    title: "PR Reviewer",
    roleId: "role_pr_reviewer",
    alsoReviewers: ["role_security"],
  } as StageDef;

  it("counts send-backs of every role of the stage, in the lane or the run, plus one", () => {
    const sent = (roleId: string) => ({ roleId, round: 1, verdict: "REQUEST CHANGES", at: "x" });
    const view = run({
      round: 4,
      // A specialist's manual send-back counts; another stage's does not.
      verdicts: [sent("role_pr_reviewer"), sent("role_security"), sent("role_plan_reviewer")],
      lanes: [
        { id: "pr1", title: "PR1", status: "active", stage: "pr_reviewer", round: 2, tabIds: {}, verdicts: [sent("role_security")] },
      ],
    });
    expect(reviewRound(view, null, prReviewer)).toBe(3);
    expect(reviewRound(view, "pr1", prReviewer)).toBe(2);
    // An unknown lane falls back to the run, as in the engine.
    expect(reviewRound(view, "gone", prReviewer)).toBe(3);
  });
});
