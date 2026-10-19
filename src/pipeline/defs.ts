/**
 * Pipeline definitions (ADR-014). The built-ins are the same JSON files the
 * Rust core bundles (`docs/pipelines`), so both sides agree without a fetch;
 * the user's own pipelines arrive from `pipeline_defs_list` and join the
 * registry with `setPipelineDefs`. A chain's `kind` is its pipeline id.
 *
 * Track H4: each stage has a `kind`, so a copied role behaves like its
 * original. Every rule that used to compare a role id with `role_planner`
 * and friends asks `roleBehaviour` instead. A pipeline the core found
 * invalid arrives with `disabled` (the reason) and cannot start.
 */
import eagle1 from "../../docs/pipelines/eagle1.json";
import eagle2 from "../../docs/pipelines/eagle2.json";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type LoopBackDef = {
  /** Stage id of an earlier stage. */
  to: string;
  /** Round cap; left out (or null): no limit, rounds go back until the reviewer approves. */
  maxRounds?: number | null;
  /** Findings below this go to follow-ups instead of another round. */
  minSeverity?: Severity;
};

export type GateDef =
  /** `optional`: an `auto` check with nothing to run is skipped instead of stopping the run. */
  | { kind: "command"; run: string; timeoutSecs?: number; optional?: boolean }
  | { kind: "pullRequest" };

/** What a stage does, whatever its role is called. */
export type StageKind = "planner" | "reviewer" | "implementer" | "generic";

/**
 * What a role does on its stage, the reviewer split by what it reviews: a
 * plan (its round goes back to a planner) or the work.
 */
export type RoleBehaviour = "planner" | "plan_reviewer" | "implementer" | "pr_reviewer" | "generic";

export type StageDef = {
  id: string;
  roleId: string;
  title: string;
  /** Left out: from the built-in role id, else `reviewer` with a loop-back, else `generic`. */
  kind?: StageKind | null;
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
  /** Why this pipeline of yours cannot run (set by the core when it does not validate). */
  disabled?: string | null;
  /** The entry as `pipelines.json` has it, when it could not be read as a pipeline. */
  raw?: unknown;
};

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

/** Stages of a run kind or chain kind; none for an unknown kind (never Eagle-Eye 1). */
export function pipelineStages(key: string | null | undefined): StageDef[] {
  return pipelineDef(key)?.stages ?? [];
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

/** Built-in roles and what they do; any other role id does nothing special off a pipeline. */
const BUILT_IN_BEHAVIOUR: Readonly<Record<string, RoleBehaviour>> = {
  role_planner: "planner",
  role_plan_reviewer: "plan_reviewer",
  role_implementer: "implementer",
  role_pr_reviewer: "pr_reviewer",
};

const BUILT_IN_ROLE: Readonly<Record<Exclude<RoleBehaviour, "generic">, string>> = {
  planner: "role_planner",
  plan_reviewer: "role_plan_reviewer",
  implementer: "role_implementer",
  pr_reviewer: "role_pr_reviewer",
};

function kindOfBehaviour(behaviour: RoleBehaviour): StageKind {
  return behaviour === "plan_reviewer" || behaviour === "pr_reviewer" ? "reviewer" : behaviour;
}

/** The stage's kind: as set, else from its built-in role, else a stage that loops back reviews. */
export function stageKind(stage: StageDef): StageKind {
  if (stage.kind) return stage.kind;
  const builtIn = BUILT_IN_BEHAVIOUR[stage.roleId];
  if (builtIn) return kindOfBehaviour(builtIn);
  return stage.loopBack ? "reviewer" : "generic";
}

/** What the stage's roles do: a reviewer reviews a plan when its round goes back to (or follows) a planner. */
export function stageBehaviour(def: PipelineDef, stage: StageDef): RoleBehaviour {
  const kind = stageKind(stage);
  if (kind !== "reviewer") return kind;
  const index = def.stages.indexOf(stage);
  const reviewed = stage.loopBack?.to
    ? def.stages.find((s) => s.id === stage.loopBack?.to)
    : index > 0
      ? def.stages[index - 1]
      : undefined;
  return reviewed && stageKind(reviewed) === "planner" ? "plan_reviewer" : "pr_reviewer";
}

/**
 * What `roleId` does: on `chainKind`'s pipeline, its stage's kind (so a
 * copied role behaves like its original); off a pipeline, or for a role
 * that is not on it, the built-in role's, else nothing special.
 */
export function roleBehaviour(roleId: string, chainKind?: string | null): RoleBehaviour {
  const def = chainKind ? pipelineDef(chainKind) : null;
  const stage = def ? stageOfRole(def, roleId) : null;
  if (def && stage) return stageBehaviour(def, stage);
  return BUILT_IN_BEHAVIOUR[roleId] ?? "generic";
}

/** The role that does `behaviour` on `kind`'s pipeline (its first such stage), else the built-in role. */
export function behaviourRole(kind: string | null | undefined, behaviour: Exclude<RoleBehaviour, "generic">): string {
  const def = pipelineDef(kind);
  const stage = def?.stages.find((s) => stageBehaviour(def, s) === behaviour);
  return stage?.roleId ?? BUILT_IN_ROLE[behaviour];
}

/** A loop-back's round cap, or null for none (rounds go back until the reviewer approves). */
export function maxRounds(stage: StageDef | null | undefined): number | null {
  return stage?.loopBack?.maxRounds ?? null;
}

/** "no round limit", or "at most 3 rounds". */
export function roundLimitText(max: number | null): string {
  return max == null ? "no round limit" : `at most ${max} rounds`;
}
