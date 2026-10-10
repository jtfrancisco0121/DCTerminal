/**
 * Which hand-off button is primary, and what it says, from the reviewer's
 * verdict. Only labels and emphasis: every hand-off still waits for the user.
 */
import { nextChainRole, type ChainRef } from "./chains";
import { roleDisplayName, type HandoffTargetId, type RoleName } from "./transitions";
import { needsRevision, type ReviewVerdict } from "./verdict";

export type HandoffRoute = {
  primaryTarget: HandoffTargetId | null;
  /** Label of the primary button ("Next: Send to Implementer", "Send back to Planner"). */
  primaryLabel: string | null;
  /** PR Reviewer approved: nothing left to hand on. */
  complete: boolean;
};

const REVISE_TARGET: Readonly<Record<string, string>> = {
  role_plan_reviewer: "role_planner",
  role_pr_reviewer: "role_implementer",
};

export function handoffRoute(options: {
  sourceRoleId: string;
  targets: readonly HandoffTargetId[];
  verdict: ReviewVerdict | null;
  chain?: ChainRef | null;
  roles?: readonly RoleName[] | null;
}): HandoffRoute {
  const { sourceRoleId, targets, verdict, chain, roles } = options;
  const offer = (id: string | null, label: (name: string) => string): HandoffRoute =>
    id && targets.includes(id)
      ? { primaryTarget: id, primaryLabel: label(roleDisplayName(id, roles)), complete: false }
      : { primaryTarget: null, primaryLabel: null, complete: false };
  const next = (id: string | null) => offer(id, (name) => `Next: Send to ${name}`);
  const chainNext = chain ? nextChainRole(chain, sourceRoleId) : null;

  const revise = REVISE_TARGET[sourceRoleId];
  if (revise && needsRevision(verdict)) {
    return offer(revise, (name) => `Send back to ${name}`);
  }
  if (sourceRoleId === "role_plan_reviewer" && verdict) {
    // APPROVED / APPROVED WITH CHANGES: on to the Implementer, chain or not.
    return next(chainNext ?? "role_implementer");
  }
  if (sourceRoleId === "role_pr_reviewer" && verdict === "APPROVED") {
    return { primaryTarget: null, primaryLabel: null, complete: true };
  }
  return next(chainNext);
}

/** The follow-up a loop-back sends into the chain's existing tab. */
export function loopBackMessage(
  sourceRoleId: string,
  findings: string,
  round: number,
  roles?: readonly RoleName[] | null,
): string {
  const ask =
    sourceRoleId === "role_plan_reviewer"
      ? "Revise the plan to address these findings, then reply with the full revised plan."
      : "Address these findings, then summarize what changed.";
  const from = roleDisplayName(sourceRoleId, roles);
  return `Review findings from the ${from} (round ${round}):\n\n${findings.trim()}\n\n${ask}`;
}
