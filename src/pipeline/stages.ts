import { pipelineDef, pipelineStages } from "./defs";

/** A run kind (`full`, `execute`) or a pipeline id of your own. */
export type PipelineKind = string;

export type PipelineStageDef = {
  stageId: string;
  roleId: string;
  title: string;
};

/** Stages of a run from its pipeline definition (`src/pipeline/defs.ts`). */
export function stagesForKind(kind: PipelineKind): PipelineStageDef[] {
  return pipelineStages(kind).map((stage) => ({
    stageId: stage.id,
    roleId: stage.roleId,
    title: stage.title,
  }));
}

/** The pipeline's name for a run kind ("Eagle-Eye 1" for `full`). */
export function pipelineName(kind: PipelineKind): string {
  return pipelineDef(kind)?.name ?? "Pipeline";
}
