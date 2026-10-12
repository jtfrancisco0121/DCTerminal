/**
 * Chains along a pipeline (`src/pipeline/defs.ts`). EE1 is Planner → Plan
 * Reviewer → Implementer → PR Reviewer; EE2 is Implementer → PR Reviewer;
 * your own pipelines work the same way. A hand-off along the next edge
 * advances the step. A reviewer sending its round back along its stage's
 * `loopBack` (Plan Reviewer → Planner, PR Reviewer → Implementer) stays on
 * the chain and starts the next round. Any other hand-off drops the chain
 * label. Only an opt-in autopilot starts anything by itself.
 */
import { loopBackRole, pipelineDef } from "../pipeline/defs";

/** A pipeline id: `eagle1`, `eagle2`, or one of your own. */
export type ChainKind = string;

export type ChainRef = {
  chainId: string;
  kind: ChainKind;
  step: number;
  total: number;
  /** Review round; missing means 1. Each loop-back adds one. */
  round?: number;
};

/** Role id per step of a pipeline, or null for an unknown pipeline. */
export function chainSteps(kind: string): readonly string[] | null {
  return pipelineDef(kind)?.stages.map((stage) => stage.roleId) ?? null;
}

export function chainLabel(chain: ChainRef): string {
  const name = pipelineDef(chain.kind)?.name ?? "Pipeline";
  const round = chainRound(chain);
  return `${name} · step ${chain.step} of ${chain.total}${round > 1 ? ` · round ${round}` : ""}`;
}

export function chainRound(chain: Pick<ChainRef, "round">): number {
  return Math.max(1, chain.round ?? 1);
}

/** Reviewer → earlier stage edges of the built-in chains, for tabs off any chain. */
const LOOP_BACKS: Readonly<Record<string, string>> = {
  role_plan_reviewer: "role_planner",
  role_pr_reviewer: "role_implementer",
};

/** The role `sourceRoleId` sends its round back to: on `kind`'s pipeline, else the built-in edge. */
export function loopBackTarget(sourceRoleId: string, kind?: string | null): string | null {
  const def = kind ? pipelineDef(kind) : null;
  if (def) return loopBackRole(def, sourceRoleId);
  return LOOP_BACKS[sourceRoleId] ?? null;
}

export function isLoopBackEdge(
  sourceRoleId: string,
  targetRoleId: string,
  kind?: string | null,
): boolean {
  return loopBackTarget(sourceRoleId, kind) === targetRoleId;
}

/**
 * The step a loop-back lands on, when this tab is the chain's reviewer and
 * the target is that reviewer's loop-back role. Null otherwise.
 */
export function loopBackStep(
  chain: ChainRef,
  sourceRoleId: string,
  targetRoleId: string,
): number | null {
  if (!isLoopBackEdge(sourceRoleId, targetRoleId, chain.kind)) return null;
  const steps = chainSteps(chain.kind);
  if (!steps || steps[chain.step - 1] !== sourceRoleId) return null;
  const index = steps.indexOf(targetRoleId);
  return index >= 0 && index < chain.step - 1 ? index + 1 : null;
}

/** The chain tag a loop-back target gets: its own step, next round. */
export function loopBackChain(
  chain: ChainRef,
  sourceRoleId: string,
  targetRoleId: string,
): ChainRef | null {
  const step = loopBackStep(chain, sourceRoleId, targetRoleId);
  return step ? { ...chain, step, round: chainRound(chain) + 1 } : null;
}

/**
 * The chain's open tab for `step`: the newest tagged tab that `prefer`
 * accepts (a live session), else the newest tagged tab.
 */
export function chainTabFor<T extends { id: string; chain?: ChainRef | null }>(
  tabs: readonly T[],
  chain: ChainRef,
  step: number,
  prefer?: (tab: T) => boolean,
): T | null {
  const tagged = tabs.filter(
    (tab) => tab.chain?.chainId === chain.chainId && tab.chain.step === step,
  );
  const preferred = prefer ? tagged.filter(prefer) : [];
  return preferred[preferred.length - 1] ?? tagged[tagged.length - 1] ?? null;
}

/** Role id of the next step, when this tab is still on the chain's edge. */
export function nextChainRole(chain: ChainRef, sourceRoleId: string): string | null {
  const steps = chainSteps(chain.kind);
  if (!steps) return null;
  if (steps[chain.step - 1] !== sourceRoleId) return null;
  return steps[chain.step] ?? null;
}

/**
 * The chain record for the tab a hand-off opens. Null when the target is
 * not the next step (the chain label ends).
 */
export function advanceChain(
  chain: ChainRef,
  sourceRoleId: string,
  targetRoleId: string,
): ChainRef | null {
  const next = nextChainRole(chain, sourceRoleId);
  if (!next || next !== targetRoleId || chain.step >= chain.total) return null;
  return { ...chain, step: chain.step + 1 };
}

/** Step 1 of a new chain, tagged onto a draft the user is about to start. */
export function newChain(kind: ChainKind, now = Date.now()): ChainRef {
  return {
    chainId: `ee_${now}`,
    kind,
    step: 1,
    total: chainSteps(kind)?.length ?? 1,
  };
}
