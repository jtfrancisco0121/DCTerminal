export type PipelineKind = "full" | "execute";

export type PipelineStageDef = {
  stageId: string;
  roleId: string;
  title: string;
};

export const FULL_PIPELINE_STAGES: PipelineStageDef[] = [
  { stageId: "planner", roleId: "role_planner", title: "Planner" },
  { stageId: "plan_reviewer", roleId: "role_plan_reviewer", title: "Plan Reviewer" },
  { stageId: "implementer", roleId: "role_implementer", title: "Implementer" },
  { stageId: "pr_reviewer", roleId: "role_pr_reviewer", title: "PR Reviewer" },
];

export const EXECUTE_PIPELINE_STAGES: PipelineStageDef[] = [
  { stageId: "implementer", roleId: "role_implementer", title: "Implementer" },
  { stageId: "pr_reviewer", roleId: "role_pr_reviewer", title: "PR Reviewer" },
];

export function stagesForKind(kind: PipelineKind): PipelineStageDef[] {
  return kind === "execute" ? EXECUTE_PIPELINE_STAGES : FULL_PIPELINE_STAGES;
}
