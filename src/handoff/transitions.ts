/**
 * The one hand-off transition table. Every "Send to …" button, dialog
 * target list, terminal menu item, and palette command reads from here.
 *
 * Eagle-Eye 1: Planner → Plan Reviewer → Implementer → PR Reviewer
 * Eagle-Eye 2: Implementer → PR Reviewer
 */

export type HandoffTargetId = string;

export const HANDOFF_TRANSITIONS: Readonly<Record<string, readonly HandoffTargetId[]>> = {
  role_planner: ["role_plan_reviewer", "role_implementer", "role_developer"],
  // Plan Reviewer can also send the plan back to the Planner for revision.
  role_plan_reviewer: ["role_implementer", "role_developer", "role_planner"],
  role_implementer: ["role_pr_reviewer"],
  role_developer: ["role_pr_reviewer"],
  // Fix-ups after review.
  role_pr_reviewer: ["role_implementer"],
};

/** Sources whose output is a plan (scope picker, plan files, terminal capture). */
export const PLAN_SOURCE_ROLES: readonly string[] = ["role_planner", "role_plan_reviewer"];

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

export type RoleName = { id: string; name: string };

export function handoffTargets(sourceRoleId: string): HandoffTargetId[] {
  return [...(HANDOFF_TRANSITIONS[sourceRoleId] ?? [])];
}

export function isHandoffSource(sourceRoleId: string): boolean {
  return handoffTargets(sourceRoleId).length > 0;
}

export function isPlanSource(roleId: string): boolean {
  return PLAN_SOURCE_ROLES.includes(roleId);
}

export function isValidTransition(sourceRoleId: string, targetRoleId: string): boolean {
  return handoffTargets(sourceRoleId).includes(targetRoleId);
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
): { target: HandoffTargetId; label: string }[] {
  return handoffTargets(sourceRoleId).map((target) => ({
    target,
    label: `Send to ${roleDisplayName(target, roles)}`,
  }));
}
