/**
 * The round view's rules (R2), pure: which pipelines a round can run its
 * plans with, and the one-line progress of a running round.
 */
import type { PlanRunState, RoundView } from "../bridge";
import { stageKind, type PipelineDef } from "./defs";

/** The pipeline a plan runs when you pick none (the core's default too). */
export const DEFAULT_PLAN_PIPELINE = "eagle1";
export const MAX_RUNS_AT_ONCE = 8;

/**
 * Pipelines a round can run each plan with: enabled, on engine 2 (every
 * stage a planner, a reviewer with no parallel reviewers, an implementer,
 * or an artifact stage, F1), and not a round's own pipeline.
 */
export function planPipelines(defs: readonly PipelineDef[]): PipelineDef[] {
  return defs.filter(
    (def) =>
      !def.disabled &&
      def.stages.length > 0 &&
      !def.stages.some((stage) => stage.round) &&
      def.stages.every((stage) => {
        const kind = stageKind(stage);
        return (
          kind === "planner" ||
          kind === "implementer" ||
          kind === "artifact" ||
          (kind === "reviewer" && !(stage.alsoReviewers ?? []).length)
        );
      }),
  );
}

const ORDER: readonly PlanRunState[] = ["done", "running", "stopped", "ready", "parked", "deferred"];

/** "1 of 3 plans done · 1 running · 1 stopped · 1 parked". Counts the plans in the round (not deferred) as the total. */
export function roundProgress(view: RoundView): string {
  const count = (state: PlanRunState) => view.plans.filter((p) => p.state === state).length;
  const inRound = view.plans.filter((p) => p.state !== "deferred").length;
  const parts = [`${count("done")} of ${inRound} plan${inRound === 1 ? "" : "s"} done`];
  for (const state of ORDER.slice(1)) {
    const n = count(state);
    if (n) parts.push(`${n} ${state}`);
  }
  return parts.join(" · ");
}

/** The waves a plan can be unparked into: 1 … N. */
export function waveChoices(waves: number): number[] {
  return Array.from({ length: Math.max(0, waves) }, (_, i) => i + 1);
}
