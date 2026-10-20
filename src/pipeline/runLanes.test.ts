import { describe, expect, it } from "vitest";
import type { ChatEntry, PipelineRun, RunEvent } from "../bridge";
import { pipelineStages } from "./defs";
import { axisTicks, formatSpan, MAX_RUN_EVENTS, runLanes, subAgentBars, verdictTag, type TurnBar, type WaitBar } from "./runLanes";

const T0 = Date.parse("2026-10-16T10:00:00Z");
const MIN = 60_000;
const at = (min: number) => new Date(T0 + min * MIN).toISOString();
const stages = pipelineStages("eagle1");

function ev(min: number, kind: string, patch: Partial<RunEvent> = {}): RunEvent {
  return { at: at(min), kind, round: 1, summary: "", ...patch };
}

function run(events: RunEvent[], patch: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "ee_1",
    kind: "eagle1",
    cwd: "/repo",
    stage: "planner",
    overviewTabId: "",
    tabIds: {},
    createdAt: at(0),
    events,
    ...patch,
  };
}

const turnsOf = (model: ReturnType<typeof runLanes>, stageId: string) =>
  model.rows.find((r) => r.stageId === stageId)!.bars.filter((b): b is TurnBar => b.kind === "turn");
const waitsOf = (model: ReturnType<typeof runLanes>, stageId: string) =>
  model.rows.find((r) => r.stageId === stageId)!.bars.filter((b): b is WaitBar => b.kind === "wait");
const span = (bar: { start: number; end: number }) => [(bar.start - T0) / MIN, (bar.end - T0) / MIN];

describe("runLanes", () => {
  it("draws one row per stage and starts the first stage when the run was made", () => {
    const model = runLanes(run([]), stages, T0 + 10 * MIN);
    expect(model.rows.map((r) => r.title)).toEqual(["Planner", "Plan Reviewer", "Implementer", "PR Reviewer"]);
    const [planner] = turnsOf(model, "planner");
    expect(span(planner)).toEqual([0, 10]);
    expect(planner.open).toBe(true);
    expect(model.active).toBe(true);
    expect(planner.label).toBe("Planner round 1: working for 10m");
  });

  it("follows turns, a send-back and approval through rounds", () => {
    const model = runLanes(
      run(
        [
          ev(5, "turn", { stageId: "planner", roleId: "role_planner" }),
          ev(6, "handoff", { stageId: "plan_reviewer", roleId: "role_plan_reviewer" }),
          ev(9, "turn", { stageId: "plan_reviewer", outcome: "REQUIRES REVISION" }),
          ev(10, "loopBack", {
            stageId: "planner",
            roleId: "role_plan_reviewer",
            summary: "Round 1 sent back (REQUIRES REVISION)",
          }),
          ev(14, "turn", { stageId: "planner", round: 2 }),
          ev(15, "handoff", { stageId: "plan_reviewer", round: 2 }),
          ev(18, "turn", { stageId: "plan_reviewer", round: 2, outcome: "APPROVED" }),
          ev(20, "handoff", { stageId: "implementer", round: 2 }),
        ],
        { round: 2 },
      ),
      stages,
      T0 + 30 * MIN,
    );
    const planner = turnsOf(model, "planner");
    expect(planner.map(span)).toEqual([
      [0, 5],
      [10, 14],
    ]);
    expect(planner.map((b) => b.round)).toEqual([1, 2]);
    const reviewer = turnsOf(model, "plan_reviewer");
    expect(reviewer.map((b) => [b.round, b.verdict])).toEqual([
      [1, "CHANGES"],
      [2, "APPROVED"],
    ]);
    expect(reviewer[0].label).toBe("Plan Reviewer round 1: worked 3m, changes requested");
    const [impl] = turnsOf(model, "implementer");
    expect(span(impl)).toEqual([20, 30]);
    expect(impl.open).toBe(true);
  });

  it("without turn events (older runs) a stage ends when the next one starts, a reviewer passed over as approved", () => {
    const model = runLanes(
      run([
        ev(5, "handoff", { stageId: "plan_reviewer" }),
        ev(8, "handoff", { stageId: "implementer" }),
        ev(12, "complete", { summary: "done" }),
      ]),
      stages,
      T0 + 60 * MIN,
    );
    expect(span(turnsOf(model, "planner")[0])).toEqual([0, 5]);
    const [review] = turnsOf(model, "plan_reviewer");
    expect([...span(review), review.verdict]).toEqual([5, 8, "APPROVED"]);
    const [impl] = turnsOf(model, "implementer");
    expect(span(impl)).toEqual([8, 12]);
    expect(impl.open).toBe(false);
    expect(model.active).toBe(false);
    expect(model.end).toBe(T0 + 12 * MIN);
  });

  it("a turn after its bar closed extends that round's bar; autopilot re-asks start a new one", () => {
    const model = runLanes(
      run([
        ev(4, "turn", { stageId: "planner" }),
        ev(6, "turn", { stageId: "planner" }),
        ev(7, "autopilot", { stageId: "planner", outcome: "reask" }),
        ev(9, "turn", { stageId: "planner" }),
      ]),
      stages,
      T0 + 20 * MIN,
    );
    expect(turnsOf(model, "planner").map(span)).toEqual([
      [0, 6],
      [7, 9],
    ]);
  });

  it("a stop is a wait until the next step, or still open while autopilot waits", () => {
    const closed = runLanes(
      run([
        ev(5, "turn", { stageId: "planner" }),
        ev(5, "stop", { stageId: "implementer", summary: "Checkpoint before Implementer" }),
        ev(12, "handoff", { stageId: "implementer" }),
      ]),
      stages,
      T0 + 20 * MIN,
    );
    const [wait] = waitsOf(closed, "implementer");
    expect(span(wait)).toEqual([5, 12]);
    expect(wait.open).toBe(false);
    expect(wait.label).toContain("waited for you 7m. Checkpoint before Implementer");

    const waiting = runLanes(
      run([ev(5, "stop", { stageId: "plan_reviewer", summary: "No verdict" })], {
        autopilot: { enabled: true, waiting: "No verdict" },
      }),
      stages,
      T0 + 9 * MIN,
    );
    const [still] = waitsOf(waiting, "plan_reviewer");
    expect(span(still)).toEqual([5, 9]);
    expect(still.open).toBe(true);
  });

  it("gates are drawn over their run time with their outcome, falling back to the latest results", () => {
    const model = runLanes(
      run(
        [
          ev(10, "gate", { stageId: "implementer", summary: "npm test: 3 failed", outcome: "failed" }),
          ev(20, "gate", { stageId: "implementer", summary: "lint: clean" }),
          ev(21, "gate", { stageId: "implementer", summary: "old: something" }),
        ],
        {
          gates: {
            implementer: {
              round: 1,
              at: at(20),
              results: [{ kind: "command", label: "lint", status: "passed", summary: "clean", durationMs: 2 * MIN }],
            },
          },
        },
      ),
      stages,
      T0 + 30 * MIN,
    );
    const gates = model.rows.find((r) => r.stageId === "implementer")!.gates;
    expect(gates.map((g) => g.status)).toEqual(["failed", "passed", "unknown"]);
    expect(span(gates[1])).toEqual([18, 20]);
    expect(gates[0].label).toBe("Implementer check failed: npm test: 3 failed");
  });

  it("fanned-out pull requests stack on their own tracks with their own rounds", () => {
    const lanes = [
      { id: "pr1", title: "PR1 — API", status: "active", stage: "implementer", round: 2, tabIds: {} },
      { id: "pr2", title: "PR2 — UI", status: "active", stage: "implementer", round: 1, tabIds: {} },
    ];
    const model = runLanes(
      run(
        [
          ev(5, "handoff", { stageId: "implementer", summary: "PR1 — API: Handed to Implementer" }),
          ev(6, "handoff", { stageId: "implementer", summary: "PR2 — UI: Handed to Implementer" }),
          ev(10, "turn", { stageId: "implementer", summary: "PR1 — API: Implementer finished its turn" }),
          ev(11, "handoff", { stageId: "pr_reviewer", summary: "PR1 — API: Handed to PR Reviewer" }),
          ev(15, "loopBack", {
            stageId: "implementer",
            roleId: "role_pr_reviewer",
            summary: "PR1 — API: Round 1 sent back (REQUEST CHANGES)",
          }),
        ],
        { lanes },
      ),
      stages,
      T0 + 20 * MIN,
    );
    const impl = turnsOf(model, "implementer");
    expect(impl.map((b) => [b.lane, b.round, ...span(b)])).toEqual([
      ["pr1", 1, 5, 10],
      ["pr2", 1, 6, 20],
      ["pr1", 2, 15, 20],
    ]);
    expect(new Set(impl.slice(0, 2).map((b) => b.track)).size).toBe(2);
    expect(model.rows.find((r) => r.stageId === "implementer")!.tracks).toBe(2);
    expect(impl[0].label).toBe("Implementer (PR1 — API) round 1: worked 5m");
    const [review] = turnsOf(model, "pr_reviewer");
    expect([review.lane, review.verdict, ...span(review)]).toEqual(["pr1", "CHANGES", 11, 15]);
  });

  it("a round you dealt with yourself (V5, D28) ends that round like one sent back", () => {
    const lanes = [{ id: "pr1", title: "PR1 — API", status: "active", stage: "implementer", round: 2, tabIds: {} }];
    const model = runLanes(
      run(
        [
          ev(5, "handoff", { stageId: "implementer", summary: "PR1 — API: Handed to Implementer" }),
          ev(11, "handoff", { stageId: "pr_reviewer", summary: "PR1 — API: Handed to PR Reviewer" }),
          // The run's own round is not the lane's.
          ev(15, "loopBack", {
            stageId: "implementer",
            roleId: "role_pr_reviewer",
            round: 4,
            summary: "PR1 — API: Round 1 dealt with by you (REQUEST CHANGES)",
          }),
        ],
        { lanes },
      ),
      stages,
      T0 + 20 * MIN,
    );
    expect(turnsOf(model, "implementer").map((b) => [b.lane, b.round, ...span(b)])).toEqual([
      ["pr1", 1, 5, 11],
      ["pr1", 2, 15, 20],
    ]);
  });

  it("reads an event's lane from its laneId, not its summary text", () => {
    // "PR1: Auth" starts with "PR1: ", so the text alone names the wrong lane.
    const lanes = [
      { id: "pr1", title: "PR1", status: "active", stage: "implementer", round: 1, tabIds: {} },
      { id: "pr1b", title: "PR1: Auth", status: "active", stage: "implementer", round: 1, tabIds: {} },
    ];
    const model = runLanes(
      run(
        [
          ev(5, "handoff", { stageId: "implementer", laneId: "pr1b", summary: "PR1: Auth: Handed to Implementer" }),
          ev(8, "gate", { stageId: "implementer", laneId: "pr1b", summary: "PR1: Auth: lint: clean" }),
          // An old saved event, from before laneId: still read from its text.
          ev(9, "handoff", { stageId: "implementer", summary: "PR1: Handed to Implementer" }),
        ],
        {
          lanes,
          gates: {
            "implementer@pr1b": {
              round: 1,
              at: at(8),
              results: [{ kind: "command", label: "lint", status: "passed", summary: "clean", durationMs: MIN }],
            },
          },
        },
      ),
      stages,
      T0 + 10 * MIN,
    );
    const impl = turnsOf(model, "implementer");
    expect(impl.map((b) => [b.lane, ...span(b)])).toEqual([
      ["pr1b", 5, 10],
      ["pr1", 9, 10],
    ]);
    const [gate] = model.rows.find((r) => r.stageId === "implementer")!.gates;
    expect([gate.lane, gate.status, ...span(gate)]).toEqual(["pr1b", "passed", 7, 8]);
  });

  it("a coalesced turn (one event at the last reply) draws the same span as one event per reply", () => {
    const head = [ev(2, "handoff", { stageId: "plan_reviewer" })];
    const perReply = runLanes(
      run([
        ...head,
        ev(4, "turn", { stageId: "plan_reviewer", outcome: "REQUEST CHANGES" }),
        ev(6, "turn", { stageId: "plan_reviewer" }),
        ev(9, "turn", { stageId: "plan_reviewer" }),
      ]),
      stages,
      T0 + 20 * MIN,
    );
    const coalesced = runLanes(
      run([...head, ev(9, "turn", { stageId: "plan_reviewer", outcome: "REQUEST CHANGES" })]),
      stages,
      T0 + 20 * MIN,
    );
    for (const model of [perReply, coalesced]) {
      const [bar] = turnsOf(model, "plan_reviewer");
      expect([...span(bar), bar.verdict, bar.open]).toEqual([2, 9, "CHANGES", false]);
    }
  });

  it("a ledger at its cap starts at its first kept event, not when the run was made", () => {
    const events = Array.from({ length: MAX_RUN_EVENTS }, (_, i) =>
      ev(100 + i, "note", { summary: `note ${i}` }),
    );
    events[1] = ev(101, "handoff", { stageId: "implementer" });
    const model = runLanes(run(events, { stage: "implementer" }), stages, T0 + 500 * MIN);
    expect(model.start).toBe(T0 + 100 * MIN);
    expect(turnsOf(model, "planner")).toEqual([]);
    expect(span(turnsOf(model, "implementer")[0])[0]).toBe(101);
    // Below the cap the first stage still starts when the run was made.
    const whole = runLanes(run(events.slice(0, 10)), stages, T0 + 500 * MIN);
    expect(span(turnsOf(whole, "planner")[0])).toEqual([0, 101]);
  });

  it("ignores events on stages the pipeline does not have", () => {
    const model = runLanes(run([ev(3, "handoff", { stageId: "nowhere" }), ev(4, "gate", { stageId: "nowhere" })]), stages, T0 + 5 * MIN);
    expect(model.rows.flatMap((r) => [...r.bars, ...r.gates])).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("tags verdicts", () => {
    expect(verdictTag("REQUEST CHANGES")).toBe("CHANGES");
    expect(verdictTag("requires revision")).toBe("CHANGES");
    expect(verdictTag("APPROVED WITH CHANGES")).toBe("APPROVED");
    expect(verdictTag("maybe")).toBeNull();
    expect(verdictTag(null)).toBeNull();
  });

  it("formats spans", () => {
    expect(formatSpan(45_000)).toBe("45s");
    expect(formatSpan(5 * MIN)).toBe("5m");
    expect(formatSpan(90 * MIN)).toBe("1h 30m");
    expect(formatSpan(120 * MIN)).toBe("2h");
    expect(formatSpan(27 * 60 * MIN)).toBe("1d 3h");
  });

  it("puts at most about six round ticks on the axis", () => {
    const ticks = axisTicks(T0, T0 + 47 * MIN);
    expect(ticks.map((t) => t.label)).toEqual(["0s", "10m", "20m", "30m", "40m"]);
    expect(axisTicks(T0, T0 + 3 * 24 * 60 * MIN).length).toBeLessThanOrEqual(7);
  });

  it("turns a tab's sub-agents into bars inside the axis", () => {
    const sub = (patch: Partial<Extract<ChatEntry, { kind: "subAgent" }>>): ChatEntry => ({
      seq: 1,
      rev: 1,
      kind: "subAgent",
      toolId: "x",
      description: "Explore code",
      agentType: "Explore",
      background: false,
      status: "done",
      at: at(5),
      endedAt: at(8),
      ...patch,
    });
    const bars = subAgentBars(
      [
        sub({}),
        sub({ status: "running", endedAt: null, at: at(12) }),
        sub({ at: at(-20), endedAt: at(-10) }),
        { seq: 2, rev: 1, kind: "assistant", text: "hi", at: at(1) },
      ],
      { start: T0, end: T0 + 15 * MIN, now: T0 + 15 * MIN },
    );
    expect(bars.map((b) => [...span(b), b.open])).toEqual([
      [5, 8, false],
      [12, 15, true],
    ]);
    expect(bars[0].label).toBe("Sub-agent (Explore): Explore code, took 3m");
    expect(bars[1].label).toBe("Sub-agent (Explore): Explore code, running for 3m");
  });
});
