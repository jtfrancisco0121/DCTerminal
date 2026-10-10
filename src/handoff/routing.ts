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
const PLANNER_ASK =
  "Revise the plan to address these findings, then reply with the full revised plan, ending with the `## HANDOFF: Plan` and `## HANDOFF: Open questions` sections.";
const IMPLEMENTER_ASK =
  "Address these findings, then push to the same branch so the existing pull request updates (do not open a new one). End your reply with the HANDOFF sections: Implementation summary, Files changed, Tests run, Deviations from the plan, and Pull request (the same URL).";

export function loopBackMessage(
  sourceRoleId: string,
  findings: string,
  round: number,
  roles?: readonly RoleName[] | null,
): string {
  const ask = sourceRoleId === "role_plan_reviewer" ? PLANNER_ASK : IMPLEMENTER_ASK;
  const from = roleDisplayName(sourceRoleId, roles);
  return `Review findings from the ${from} (round ${round}):\n\n${findings.trim()}\n\n${ask}`;
}

/** The findings and round inside a loopBackMessage, or null for any other text. */
export function loopBackFindings(text: string): { from: string; round: number; findings: string } | null {
  const head = /^Review findings from the (.+?) \(round (\d+)\):\n\n/.exec(text.trimStart());
  if (!head) return null;
  let findings = text.trimStart().slice(head[0].length);
  for (const ask of [PLANNER_ASK, IMPLEMENTER_ASK]) {
    if (findings.trimEnd().endsWith(ask)) findings = findings.trimEnd().slice(0, -ask.length);
  }
  // Messages from before the HANDOFF asks end with a short plain ask.
  findings = findings.replace(/\n\n(?:Address these findings, then summarize what changed\.|Revise the plan to address these findings, then reply with the full revised plan\.)\s*$/, "");
  return { from: head[1], round: Number(head[2]), findings: findings.trim() };
}
