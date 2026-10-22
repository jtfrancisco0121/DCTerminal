import type { RoundPlan, RunRound } from "../bridge";

/** Test data for the QA round views (R1): one plan of a round. */
export function plan(id: string, wave: number | null, status: RoundPlan["status"] = "active", extra: Partial<RoundPlan> = {}): RoundPlan {
  return { id, title: `Title ${id}`, tickets: [`QA-${id}`], repos: ["backend"], status, wave, summary: `Fix ${id}.`, ...extra };
}

/** A round shaped like a real one: 8 plans, 4 waves, one parked, one deferred (invented tickets). */
export function exampleRound(): RunRound {
  return {
    schema: 1,
    runId: "ee_round",
    stageKey: "triage",
    turn: "t1",
    at: "2026-10-22T10:00:00Z",
    plans: [
      plan("plan1", 1),
      plan("plan2", 2, "active", { repos: ["backend", "engine"] }),
      plan("plan3", 3, "parked", { reason: "Waits on the timestamp UI decision.", tickets: ["QA-1", "QA-2"], repos: ["backend", "engine"] }),
      plan("plan4", 2, "active", { repos: ["backend", "desktop", "web"] }),
      plan("plan5", 1, "active", { repos: ["engine"] }),
      plan("plan6", 3, "active", { repos: ["desktop"] }),
      plan("plan7", 4, "active", { repos: ["desktop", "web"] }),
      plan("plan8", null, "deferred", { reason: "The fix is in the gateway, not our repos.", repos: ["gateway"] }),
    ],
    waves: [1, 2, 3, 4].map((n) => ({ n, why: `Why wave ${n}` })),
    mergeOrder: {
      web: ["plan4", "plan7"],
      backend: ["plan1", "plan2", "plan4", "plan3"],
      engine: ["plan5", "plan2", "plan3"],
      desktop: ["plan4", "plan6", "plan7"],
    },
    excluded: [{ ticket: "QA-99", reason: "Already fixed." }],
  };
}
