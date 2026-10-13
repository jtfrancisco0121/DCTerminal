/**
 * Pipeline definitions (ADR-014). The built-ins are the same JSON files the
 * Rust core bundles (`docs/pipelines`), so both sides agree without a fetch;
 * the user's own pipelines arrive from `pipeline_defs_list` and join the
 * registry with `setPipelineDefs`. A chain's `kind` is its pipeline id.
 */
import eagle1 from "../../docs/pipelines/eagle1.json";
import eagle2 from "../../docs/pipelines/eagle2.json";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type LoopBackDef = {
  /** Stage id of an earlier stage. */
  to: string;
  maxRounds?: number;
  /** Findings below this go to follow-ups instead of another round. */
  minSeverity?: Severity;
};

export type GateDef =
  | { kind: "command"; run: string; timeoutSecs?: number }
  | { kind: "pullRequest" };

export type StageDef = {
  id: string;
  roleId: string;
  title: string;
  loopBack?: LoopBackDef | null;
  gates?: GateDef[];
  /** Autopilot stops before starting this stage. */
  checkpoint?: boolean;
  /** Specialist reviewers (role ids) reviewing the same work in parallel; findings merge. */
  alsoReviewers?: string[];
};

export type PipelineDef = {
  id: string;
  name: string;
  description?: string;
  /** Run kind stored on the chain's run; built-ins keep `full` / `execute`. */
  runKind?: string | null;
  stages: StageDef[];
  autopilot?: { pauseAtUsagePercent?: number };
  builtIn?: boolean;
};

export const DEFAULT_MAX_ROUNDS = 3;
export const DEFAULT_PAUSE_AT_USAGE_PERCENT = 90;

export const BUILT_IN_PIPELINES: readonly PipelineDef[] = [
  { ...(eagle1 as PipelineDef), builtIn: true },
  { ...(eagle2 as PipelineDef), builtIn: true },
];

let userPipelines: PipelineDef[] = [];

/** Your own pipelines from the backend (built-ins in the list are ignored). */
export function setPipelineDefs(defs: readonly PipelineDef[]): void {
  const builtIn = new Set(BUILT_IN_PIPELINES.map((def) => def.id));
  userPipelines = defs.filter((def) => !def.builtIn && !builtIn.has(def.id));
}

export function allPipelineDefs(): PipelineDef[] {
  return [...BUILT_IN_PIPELINES, ...userPipelines];
}

export function runKindOf(def: PipelineDef): string {
  return def.runKind ?? def.id;
}

/** The pipeline whose id (chain kind) or run kind is `key`. */
export function pipelineDef(key: string | null | undefined): PipelineDef | null {
  const wanted = (key ?? "").trim();
  if (!wanted) return null;
  return allPipelineDefs().find((def) => def.id === wanted || runKindOf(def) === wanted) ?? null;
}

/** Stages of a run kind or chain kind; unknown kinds read as Eagle-Eye 1. */
export function pipelineStages(key: string | null | undefined): StageDef[] {
  return (pipelineDef(key) ?? BUILT_IN_PIPELINES[0]).stages;
}

/** The stage's role, then its parallel reviewers. */
export function stageRoles(stage: StageDef): string[] {
  return [stage.roleId, ...(stage.alsoReviewers ?? [])];
}

/** The stage a role holds on a pipeline (its first one), parallel reviewers included. */
export function stageOfRole(def: PipelineDef, roleId: string): StageDef | null {
  return (
    def.stages.find((stage) => stage.roleId === roleId) ??
    def.stages.find((stage) => stage.alsoReviewers?.includes(roleId)) ??
    null
  );
}

/** Where a reviewer role on this pipeline sends its round back, as a role id. */
export function loopBackRole(def: PipelineDef, sourceRoleId: string): string | null {
  const stage = stageOfRole(def, sourceRoleId);
  const to = stage?.loopBack?.to;
  return to ? (def.stages.find((s) => s.id === to)?.roleId ?? null) : null;
}

export function maxRounds(stage: StageDef | null | undefined): number {
  return stage?.loopBack?.maxRounds ?? DEFAULT_MAX_ROUNDS;
}
