/**
 * Eagle-Eye chains. EE1 is Planner → Plan Reviewer → Implementer → PR Reviewer.
 * EE2 is Implementer → PR Reviewer. A hand-off along the next edge advances
 * the step. A reviewer sending its round back (Plan Reviewer → Planner,
 * PR Reviewer → Implementer) is a loop-back: it stays on the chain and starts
 * the next round. Any other hand-off drops the chain label. Nothing starts by
 * itself.
 */

export type ChainKind = "eagle1" | "eagle2";

export type ChainRef = {
  chainId: string;
  kind: ChainKind;
  step: number;
  total: number;
  /** Review round; missing means 1. Each loop-back adds one. */
  round?: number;
};

const EAGLE1 = [
  "role_planner",
  "role_plan_reviewer",
  "role_implementer",
  "role_pr_reviewer",
] as const;

const EAGLE2 = ["role_implementer", "role_pr_reviewer"] as const;

export function chainSteps(kind: string): readonly string[] | null {
  if (kind === "eagle1") return EAGLE1;
  if (kind === "eagle2") return EAGLE2;
  return null;
}

export function chainLabel(chain: ChainRef): string {
  const name = chain.kind === "eagle2" ? "Eagle-Eye 2" : "Eagle-Eye 1";
  const round = chainRound(chain);
  return `${name} · step ${chain.step} of ${chain.total}${round > 1 ? ` · round ${round}` : ""}`;
}

export function chainRound(chain: Pick<ChainRef, "round">): number {
  return Math.max(1, chain.round ?? 1);
}

/** Reviewer → earlier stage edges that send a round back. */
const LOOP_BACKS: Readonly<Record<string, string>> = {
  role_plan_reviewer: "role_planner",
  role_pr_reviewer: "role_implementer",
};

export function isLoopBackEdge(sourceRoleId: string, targetRoleId: string): boolean {
  return LOOP_BACKS[sourceRoleId] === targetRoleId;
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
  if (!isLoopBackEdge(sourceRoleId, targetRoleId)) return null;
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
    total: kind === "eagle1" ? 4 : 2,
  };
}
