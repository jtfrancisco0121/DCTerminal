/**
 * The one hand-off transition table. Every "Send to …" button, dialog
 * target list, terminal menu item, and palette command reads from here.
 * A role's own `handoffTargets` (Settings > Roles) replaces its row.
 *
 * Eagle-Eye 1: Planner → Plan Reviewer → Implementer → PR Reviewer
 * Eagle-Eye 2: Implementer → PR Reviewer
 *
 * Recommendation and Codebase Audit feed the chain: one selected feature
 * card or finding becomes a Planner request (or a Developer fix).
 */

import { loopBackTarget, nextChainRoles, type ChainRef } from "./chains";

export type HandoffTargetId = string;

export const HANDOFF_TRANSITIONS: Readonly<Record<string, readonly HandoffTargetId[]>> = {
  role_planner: ["role_plan_reviewer", "role_implementer", "role_developer"],
  // Plan Reviewer can also send the plan back to the Planner for revision.
  role_plan_reviewer: ["role_implementer", "role_developer", "role_planner"],
  role_implementer: ["role_pr_reviewer"],
  role_developer: ["role_pr_reviewer"],
  // Fix-ups after review.
  role_pr_reviewer: ["role_implementer"],
  // Reports: plan one feature card or finding, or fix a small one directly.
  role_recommendation: ["role_planner", "role_developer"],
  role_codebase_audit: ["role_planner", "role_developer"],
};

/** Sources whose output is a plan (scope picker, plan files, terminal capture). */
export const PLAN_SOURCE_ROLES: readonly string[] = ["role_planner", "role_plan_reviewer"];

/** Sources whose output is a report of feature cards or findings. */
export const REPORT_SOURCE_ROLES: readonly string[] = ["role_recommendation", "role_codebase_audit"];

/** Fallback names when the loaded role list is not available. */
export const BUILT_IN_ROLE_NAMES: Readonly<Record<string, string>> = {
  role_planner: "Planner",
  role_plan_reviewer: "Plan Reviewer",
  role_implementer: "Implementer",
  role_developer: "Developer",
  role_pr_reviewer: "PR Reviewer",
  role_general: "General",
  role_recommendation: "Recommendation",
  role_codebase_audit: "Codebase Audit",
};

/**
 * A loaded role. `handoffTargets` is set when the role's targets are data
 * (edited in Settings > Roles, or a custom role); missing means the table above.
 */
export type RoleName = { id: string; name: string; handoffTargets?: readonly string[] | null };

/**
 * Where a role may hand off: the loaded role's own `handoffTargets` when it
 * has them, else the built-in table. Unknown roles have no targets. On a
 * chain, the chain's next role and the role's loop-back target are added,
 * so a pipeline of your own can use edges the table does not list.
 */
export function handoffTargets(
  sourceRoleId: string,
  roles?: readonly RoleName[] | null,
  chain?: ChainRef | null,
): HandoffTargetId[] {
  const own = roles?.find((role) => role.id === sourceRoleId)?.handoffTargets;
  const targets = own
    ? own.filter((id) => id !== sourceRoleId)
    : [...(HANDOFF_TRANSITIONS[sourceRoleId] ?? [])];
  if (chain) {
    for (const id of [...nextChainRoles(chain, sourceRoleId), loopBackTarget(sourceRoleId, chain.kind)]) {
      if (id && id !== sourceRoleId && !targets.includes(id)) targets.push(id);
    }
  }
  return targets;
}

export function isHandoffSource(
  sourceRoleId: string,
  roles?: readonly RoleName[] | null,
  chain?: ChainRef | null,
): boolean {
  return handoffTargets(sourceRoleId, roles, chain).length > 0;
}

export function isPlanSource(roleId: string): boolean {
  return PLAN_SOURCE_ROLES.includes(roleId);
}

export function isReportSource(roleId: string): boolean {
  return REPORT_SOURCE_ROLES.includes(roleId);
}

/** Roles whose hand-off text is captured from the chat or terminal (scope picker). */
export function isCaptureSource(roleId: string): boolean {
  return isPlanSource(roleId) || isReportSource(roleId);
}

export function isValidTransition(
  sourceRoleId: string,
  targetRoleId: string,
  roles?: readonly RoleName[] | null,
): boolean {
  return handoffTargets(sourceRoleId, roles).includes(targetRoleId);
}

/** Role name from the loaded roles, then the built-in names, then "role". */
export function roleDisplayName(roleId: string, roles?: readonly RoleName[] | null): string {
  const loaded = roles?.find((role) => role.id === roleId)?.name?.trim();
  if (loaded) return loaded;
  return BUILT_IN_ROLE_NAMES[roleId] ?? "role";
}

/** "Send to …" items for a source role (chat buttons, terminal right-click menu). */
export function handoffMenuItems(
  sourceRoleId: string,
  roles?: readonly RoleName[] | null,
  chain?: ChainRef | null,
): { target: HandoffTargetId; label: string }[] {
  return handoffTargets(sourceRoleId, roles, chain).map((target) => ({
    target,
    label: `Send to ${roleDisplayName(target, roles)}`,
  }));
}
