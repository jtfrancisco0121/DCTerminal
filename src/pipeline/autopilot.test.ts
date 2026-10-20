import { describe, expect, it } from "vitest";
import type { BridgeTurn, TerminalSessionLog } from "../bridge";
import { parseReviewVerdict as parseReviewVerdictOf } from "../handoff/verdict";
import {
  bridgeFindingsText,
  bridgePrUrls,
  bridgeReview,
  bridgeBlocked,
  bridgeTurnReport,
  bridgeVerdict,
  finishedTurn,
  reviseVerdict,
  loopBackText,
  mergeReviews,
  worstVerdict,
  stageForTab,
  turnReport,
  usagePercent,
} from "./autopilot";
import { pipelineDef, type PipelineDef } from "./defs";

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
      rateLimit: null,
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

  it("merged parallel reviews: sections are checked on the stage reviewer's own reply", () => {
    const stage = pipelineDef("eagle1")!.stages[3];
    const merged = mergeReviews(
      [
        { name: "PR Reviewer", reply: "## HANDOFF: Verdict\nAPPROVED" },
        { name: "Security", reply: "## HANDOFF: Verdict\nAPPROVED" },
      ],
      "REQUEST CHANGES",
    );
    const report = turnReport({
      stage,
      reply: merged,
      ownReply: "## HANDOFF: Verdict\nAPPROVED",
      chat: false,
      usage: null,
    });
    expect(report.verdict).toBe("APPROVED");
    expect(report.missingSections).toEqual(["Findings for the Implementer"]);
    expect(turnReport({ stage, reply: merged, chat: false, usage: null }).missingSections).toEqual([]);
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
    // A window that reset since its reading is unknown, not its old percent.
    const now = Date.UTC(2026, 9, 10, 12, 0);
    expect(
      usagePercent(
        {
          configDir: "",
          contextByTab: {},
          windows: [
            { rateLimitType: "five_hour", label: "5h", utilization: 97, resetsAt: now / 1000 - 60, status: "", seenAtMs: 0 },
          ],
        },
        now,
      ),
    ).toBeNull();
  });

  it("a rate-limit error in the turn goes into the report", () => {
    const planner = pipelineDef("eagle1")!.stages[0];
    const limited = turnReport({
      stage: planner,
      reply: "",
      chat: false,
      usage: null,
      rateLimit: "You've hit your limit · resets 3pm",
    });
    expect(limited.rateLimit).toBe("You've hit your limit · resets 3pm");
    expect(limited.usagePercent).toBeNull();
    expect(turnReport({ stage: planner, reply: "# Plan", chat: false, usage: null }).rateLimit).toBeNull();
  });
});

describe("parallel reviews", () => {
  const pr = (verdict: string, findings: string, result?: string) =>
    `## HANDOFF: Verdict\n${verdict}\n\n## HANDOFF: Findings for the Implementer\n${findings}${
      result ? `\n\n## HANDOFF: Result\n${result}` : ""
    }`;

  it("the worst verdict wins; a reviewer with none counts as changes", () => {
    expect(worstVerdict(["APPROVED", "APPROVED WITH CHANGES"], "REQUEST CHANGES")).toBe("APPROVED WITH CHANGES");
    expect(worstVerdict(["APPROVED", "REQUEST CHANGES"], "REQUEST CHANGES")).toBe("REQUEST CHANGES");
    expect(worstVerdict(["APPROVED", null], "REQUEST CHANGES")).toBe("REQUEST CHANGES");
    expect(worstVerdict(["APPROVED", "APPROVED"], "REQUEST CHANGES")).toBe("APPROVED");
  });

  it("merges findings by reviewer and keeps a Result only when every reviewer gave one", () => {
    const merged = mergeReviews(
      [
        { name: "PR Reviewer", reply: pr("APPROVED", "None.", '{"verdict":"APPROVED","findings":[]}') },
        {
          name: "Security Reviewer",
          reply: pr(
            "REQUEST CHANGES",
            "1. Escape the token in logs.",
            '{"verdict":"REQUEST CHANGES","findings":[{"severity":"HIGH","summary":"Token in logs."}]}',
          ),
        },
      ],
      "REQUEST CHANGES",
    );
    expect(parseReviewVerdictOf(merged)).toBe("REQUEST CHANGES");
    expect(loopBackText(merged)).toBe("From the Security Reviewer:\n1. Escape the token in logs.");
    const stage = { id: "review", roleId: "role_pr_reviewer", title: "PR Reviewer", loopBack: { to: "build" } };
    const report = turnReport({ stage, reply: merged, chat: false, usage: null });
    expect(report.findingsKnown).toBe(true);
    expect(report.findings).toEqual([{ severity: "HIGH", summary: "Security Reviewer: Token in logs." }]);
    const partial = mergeReviews(
      [
        { name: "PR Reviewer", reply: pr("APPROVED", "None.") },
        { name: "Security Reviewer", reply: pr("APPROVED", "None.", '{"verdict":"APPROVED","findings":[]}') },
      ],
      "REQUEST CHANGES",
    );
    expect(partial).not.toContain("HANDOFF: Result");
    expect(parseReviewVerdictOf(partial)).toBe("APPROVED");
  });
});

function bridgeTurn(patch: Partial<BridgeTurn> = {}): BridgeTurn {
  return {
    schema: 1,
    runId: "ee_1",
    stageKey: "pr_reviewer",
    stageId: "pr_reviewer",
    roleId: "role_pr_reviewer",
    tabId: "t4",
    turn: "p-1",
    outcome: "result",
    endedAt: "2026-10-19T10:00:00Z",
    lastAssistantMessage: "## HANDOFF: Verdict\nREQUEST CHANGES",
    blocked: false,
    result: {
      schema: 1,
      verdict: "CHANGES_REQUIRED",
      findings: [
        { severity: "HIGH", file: "src/a.ts:4", summary: "Null token." },
        { severity: "LOW", summary: "Typo." },
      ],
    },
    ...patch,
  };
}

describe("bridge turns (engine 2)", () => {
  const def = pipelineDef("eagle1")!;
  const prStage = def.stages.find((s) => s.id === "pr_reviewer")!;

  it("reads the bridge's verdict words as the words the rest of the pipeline uses", () => {
    expect(bridgeVerdict("APPROVED", "REQUEST CHANGES")).toBe("APPROVED");
    expect(bridgeVerdict("APPROVED_WITH_CHANGES", "REQUEST CHANGES")).toBe("APPROVED WITH CHANGES");
    expect(bridgeVerdict("CHANGES_REQUIRED", "REQUIRES REVISION")).toBe("REQUIRES REVISION");
    expect(bridgeVerdict(undefined, "REQUEST CHANGES")).toBeNull();
    // A plan reviewer asks for revision; every other reviewer for changes.
    const full = pipelineDef("eagle1")!;
    const stage = (d: PipelineDef, id: string) => d.stages.find((s) => s.id === id)!;
    expect(reviseVerdict(full, stage(full, "plan_reviewer"))).toBe("REQUIRES REVISION");
    expect(reviseVerdict(full, stage(full, "pr_reviewer"))).toBe("REQUEST CHANGES");
  });

  it("a copied Plan Reviewer revises like the built-in one: its stage kind decides, not its role id", () => {
    const copied: PipelineDef = {
      id: "my_plan",
      name: "My plan",
      stages: [
        { id: "planner", roleId: "role_planner", title: "Planner" },
        { id: "plan_check", roleId: "role_custom_9", title: "Plan check", loopBack: { to: "planner", minSeverity: "MEDIUM" } },
        { id: "implementer", roleId: "role_implementer", title: "Implementer" },
        { id: "pr_check", roleId: "role_custom_10", title: "PR check", loopBack: { to: "implementer", minSeverity: "MEDIUM" } },
      ],
    };
    expect(reviseVerdict(copied, copied.stages[1])).toBe("REQUIRES REVISION");
    expect(reviseVerdict(copied, copied.stages[3])).toBe("REQUEST CHANGES");
  });

  it("decides on the submitted result, not on the reply's text", () => {
    const turn = bridgeTurn({ lastAssistantMessage: "## HANDOFF: Verdict\nAPPROVED" });
    const report = bridgeTurnReport({ stage: prStage, turn, usage: 12, lane: "pr1", revise: "REQUEST CHANGES" });
    expect(report).toEqual({
      stageId: "pr_reviewer",
      verdict: "REQUEST CHANGES",
      findings: [
        { severity: "HIGH", summary: "Null token." },
        { severity: "LOW", summary: "Typo." },
      ],
      findingsKnown: true,
      missingSections: [],
      usagePercent: 12,
      chat: false,
      lane: "pr1",
      rateLimit: null,
      noResult: false,
      blocked: null,
    });
  });

  it("reports a turn without a result as no_result", () => {
    const report = bridgeTurnReport({
      stage: prStage,
      turn: bridgeTurn({ outcome: "no_result", result: null, blocked: true }),
      usage: null,
      lane: null,
      revise: "REQUEST CHANGES",
    });
    expect(report.noResult).toBe(true);
    expect(report.verdict).toBeNull();
    expect(report.findingsKnown).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it("a blocked Implementer's result carries why, so the run waits instead of stopping with no_result", () => {
    const blocked = bridgeTurn({
      result: { schema: 1, prs: [], summary: "Nothing built.", blocked: "The plan's API does not exist." },
    });
    const report = bridgeTurnReport({ stage: prStage, turn: blocked, usage: null, lane: null, revise: "REQUEST CHANGES" });
    expect(report).toMatchObject({ noResult: false, blocked: "The plan's API does not exist.", verdict: null });
    expect(bridgeBlocked(blocked)).toBe("The plan's API does not exist.");
    const done = bridgeTurn({ result: { schema: 1, prs: [{ url: "https://x/pull/1", branch: "b", title: "t" }], summary: "s" } });
    expect(bridgeBlocked(done)).toBeNull();
    expect(bridgeTurnReport({ stage: prStage, turn: done, usage: null, lane: null, revise: "x" }).blocked).toBeNull();
    expect(bridgeBlocked(bridgeTurn({ outcome: "no_result", result: null }))).toBeNull();
  });

  it("lists the findings a loop-back sends the way the v1 path does", () => {
    expect(bridgeFindingsText(bridgeReview(bridgeTurn())!.findings)).toBe(
      "1. [HIGH] src/a.ts:4: Null token.\n2. [LOW] Typo.",
    );
    expect(bridgeFindingsText([])).toBe("");
  });

  it("a Planner's or an Implementer's result is no review: no verdict, no findings, pull requests for the checks", () => {
    const implementer = bridgeTurn({
      result: { schema: 1, prs: [{ url: "https://x/pull/1", branch: "b", title: "t" }], summary: "s" },
    });
    expect(bridgeReview(implementer)).toBeNull();
    expect(bridgePrUrls(implementer)).toEqual(["https://x/pull/1"]);
    const report = bridgeTurnReport({ stage: prStage, turn: implementer, usage: null, lane: null, revise: "REQUEST CHANGES" });
    expect(report).toMatchObject({ verdict: null, findings: [], noResult: false });
    const planner = bridgeTurn({ result: { schema: 1, tasks: [] } });
    expect(bridgePrUrls(planner)).toBeNull();
    expect(bridgePrUrls(bridgeTurn({ outcome: "no_result", result: null }))).toBeNull();
    expect(bridgeReview(bridgeTurn())?.verdict).toBe("CHANGES_REQUIRED");
  });
});
