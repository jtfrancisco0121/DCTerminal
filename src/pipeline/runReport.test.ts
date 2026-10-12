import { describe, expect, it } from "vitest";
import type { PipelineRun } from "../bridge";
import { followUps, formatRunReport } from "./runReport";

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

  it("follow-ups come only from autopilot decisions", () => {
    expect(followUps(run({ events: [] }))).toEqual([]);
    expect(followUps(run())).toEqual(["[LOW] rename x", "[INFO] comment wording"]);
  });

  it("an empty ledger says so", () => {
    expect(formatRunReport(run({ events: [], gates: {} }))).toContain("Nothing recorded yet.");
  });
});
