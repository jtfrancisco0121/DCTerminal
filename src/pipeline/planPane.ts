/**
 * What the docked plan pane shows for a run: the approved plan, else the
 * candidate the Planner produced, else the plan a chain handed to its
 * Implementer (chain runs carry their plan in that hand-off). Pure.
 */
import type { PipelineRun, TabSummary } from "../bridge";
import { behaviourRole } from "./defs";

export type PlanSource = "approved" | "candidate" | "handoff";

export type RunPlan = {
  text: string;
  source: PlanSource;
  /** The round it was approved (or handed on) in; null when not recorded. */
  round: number | null;
  /** ISO time it last changed; null when not known. */
  updatedAt: string | null;
};

/** The run a tab belongs to: its chain's run, else its preset pipeline run. */
export function runIdOfTab(tab: Pick<TabSummary, "chain" | "pipelineRunId"> | null | undefined): string | null {
  const id = tab?.chain?.chainId?.trim() || tab?.pipelineRunId?.trim() || "";
  return id || null;
}

function lastEvent(run: PipelineRun, match: (kind: string, outcome: string, roleId: string) => boolean) {
  const events = run.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (match(e.kind, e.outcome ?? "", e.roleId ?? "")) return e;
  }
  return null;
}

/**
 * `lane`: the fanned-out pull request the tab works on, if any; its own
 * Implementer hand-off comes before the run's.
 */
export function planOfRun(run: PipelineRun, lane: string | null = null): RunPlan | null {
  const approved = run.approvedPlan?.trim();
  if (approved) {
    const event = lastEvent(run, (kind, outcome) => kind === "note" && outcome === "planApproved");
    return {
      text: approved,
      source: "approved",
      round: event?.round ?? null,
      updatedAt: event?.at ?? run.updatedAt ?? null,
    };
  }
  const candidate = run.candidatePlan?.trim();
  if (candidate) {
    return { text: candidate, source: "candidate", round: null, updatedAt: run.updatedAt ?? null };
  }
  // The implementer stage's role on this run's pipeline (a copy keeps its own id).
  const implementer = behaviourRole(run.kind, "implementer");
  const own = lane ? run.lanes?.find((l) => l.id === lane) : undefined;
  const laneHandoff = own?.handoffs?.[implementer];
  if (own && laneHandoff?.text.trim()) {
    // A lane's latest Implementer hand-off opens its current round.
    return {
      text: laneHandoff.text.trim(),
      source: "handoff",
      round: own.round || null,
      updatedAt: laneHandoff.at || null,
    };
  }
  const handoff = run.handoffs?.[implementer];
  if (handoff?.text.trim()) {
    const event = lastEvent(run, (kind, _o, roleId) => kind === "handoff" && roleId === implementer);
    return {
      text: handoff.text.trim(),
      source: "handoff",
      round: event?.round ?? null,
      updatedAt: handoff.at || null,
    };
  }
  return null;
}

/** "Plan · approved in round 2", "Plan · candidate", … */
export function planHeading(plan: RunPlan | null): string {
  if (!plan) return "Plan";
  const round = plan.round ? ` in round ${plan.round}` : "";
  switch (plan.source) {
    case "approved":
      return `Plan · approved${round}`;
    case "candidate":
      return "Plan · candidate";
    case "handoff":
      return `Plan · handed to the Implementer${round}`;
  }
}
