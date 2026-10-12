import { describe, expect, it } from "vitest";
import type { TerminalSessionLog } from "../bridge";
import {
  finishedTurn,
  loopBackText,
  stageForTab,
  turnReport,
  usagePercent,
} from "./autopilot";
import { pipelineDef } from "./defs";

function log(patch: Partial<TerminalSessionLog> = {}): TerminalSessionLog {
  return {
    sessionId: "s1",
    path: "/x.jsonl",
    turnDone: true,
    lastReply: "done",
    plan: null,
    planAt: null,
    lastPromptAt: "2026-10-13T10:00:00Z",
    toolCalls: [],
    openTool: null,
    ...patch,
  };
}

const REVIEW = [
  "Looks risky.",
  "",
  "## HANDOFF: Verdict",
  "REQUEST CHANGES",
  "",
  "## HANDOFF: Findings for the Implementer",
  "1. src/a.ts:4 guard the null token.",
  "",
  "## HANDOFF: Result",
  '```json\n{"verdict": "REQUEST CHANGES", "findings": [{"severity": "MEDIUM", "file": "src/a.ts:4", "summary": "Null token."}, {"severity": "LOW", "summary": "Typo."}]}\n```',
].join("\n");

describe("autopilot helpers", () => {
  it("places a chain tab on its pipeline stage only when the role matches", () => {
    const chain = { chainId: "ee_1", kind: "eagle1", step: 2, total: 4 };
    expect(stageForTab(chain, "role_plan_reviewer")?.stage.id).toBe("plan_reviewer");
    expect(stageForTab(chain, "role_planner")).toBeNull();
    expect(stageForTab(null, "role_planner")).toBeNull();
  });

  it("a turn counts once it is done, or when a Planner waits on its plan", () => {
    expect(finishedTurn("role_implementer", log())?.awaitingPlan).toBe(false);
    expect(finishedTurn("role_implementer", log({ turnDone: false }))).toBeNull();
    const planning = log({
      turnDone: false,
      plan: "# Plan",
      openTool: { id: "t1", name: "ExitPlanMode", title: "Plan" },
    });
    expect(finishedTurn("role_planner", planning)).toEqual({
      key: "s1|2026-10-13T10:00:00Z|plan|t1",
      awaitingPlan: true,
    });
    // Only a Planner hands on from its plan dialog.
    expect(finishedTurn("role_implementer", planning)).toBeNull();
    // A new prompt is a new turn.
    expect(finishedTurn("role_implementer", log({ lastPromptAt: "later" }))?.key).not.toBe(
      finishedTurn("role_implementer", log())?.key,
    );
  });

  it("reports a reviewer's verdict and findings, and what sections are missing", () => {
    const stage = pipelineDef("eagle1")!.stages[3];
    const report = turnReport({ stage, reply: REVIEW, chat: false, usage: 42 });
    expect(report).toEqual({
      stageId: "pr_reviewer",
      verdict: "REQUEST CHANGES",
      findings: [
        { severity: "MEDIUM", summary: "Null token." },
        { severity: "LOW", summary: "Typo." },
      ],
      findingsKnown: true,
      missingSections: [],
      usagePercent: 42,
      chat: false,
      lane: null,
    });
    const bare = turnReport({ stage, reply: "## HANDOFF: Verdict\nAPPROVED", chat: false, usage: null });
    expect(bare.findingsKnown).toBe(false);
    expect(bare.missingSections).toEqual(["Findings for the Implementer"]);
    const implementer = pipelineDef("eagle1")!.stages[2];
    const work = turnReport({ stage: implementer, reply: REVIEW, chat: false, usage: null });
    expect(work.verdict).toBeNull();
    expect(work.findings).toEqual([]);
    const planner = pipelineDef("eagle1")!.stages[0];
    expect(
      turnReport({ stage: planner, reply: "# Plan", chat: false, usage: null, awaitingPlan: true })
        .missingSections,
    ).toEqual([]);
  });

  it("sends back the findings section, else the Result findings, else the reply", () => {
    expect(loopBackText(REVIEW)).toBe("1. src/a.ts:4 guard the null token.");
    const onlyResult =
      '## HANDOFF: Result\n{"verdict": "REQUEST CHANGES", "findings": [{"severity": "HIGH", "file": "a.ts", "summary": "Boom."}]}';
    expect(loopBackText(onlyResult)).toBe("1. [HIGH] a.ts: Boom.");
    expect(loopBackText("  plain words  ")).toBe("plain words");
  });

  it("usage is the highest known window", () => {
    expect(usagePercent(null)).toBeNull();
    expect(
      usagePercent({
        configDir: "",
        contextByTab: {},
        windows: [
          { rateLimitType: "a", label: "5h", utilization: 40.4, resetsAt: null, status: "", seenAtMs: 0 },
          { rateLimitType: "b", label: "7d", utilization: null, resetsAt: null, status: "", seenAtMs: 0 },
          { rateLimitType: "c", label: "7d", utilization: 91.6, resetsAt: null, status: "", seenAtMs: 0 },
        ],
      }),
    ).toBe(92);
  });
});
