/**
 * Eagle-Eye chains. EE1 is Planner → Plan Reviewer → Implementer → PR Reviewer.
 * EE2 is Implementer → PR Reviewer. A hand-off along the next edge advances
 * the step. Any other hand-off drops the chain label. Nothing starts by itself.
 */

export type ChainKind = "eagle1" | "eagle2";

export type ChainRef = {
  chainId: string;
  kind: ChainKind;
  step: number;
  total: number;
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
  return `${name} · step ${chain.step} of ${chain.total}`;
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
