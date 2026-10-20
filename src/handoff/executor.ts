/**
 * The hand-off executor: everything between "the user picked a target and a
 * scope" and "the next tab exists". It enriches the source, maps it onto the
 * target role's form, works out the chain step, checks a terminal start,
 * saves the hand-off, and records the new tab's chain step.
 *
 * UI state (busy flags, dialog errors, drafts, tab selection) stays with the
 * caller; this module only talks to the backend through `HandoffIo`, so
 * tests can fake IO. Autopilot never comes through here: the Rust run actor
 * builds an engine-2 run's hand-offs itself, and the v1 frontend autopilot
 * that used these steps is gone (V6).
 */
import {
  changesList,
  getPipelineRun,
  getRole,
  gitRepoInfo,
  handoffAttach,
  handoffSave,
  pipelineActorMessage,
  terminalPlanFile,
  validateAndPreview,
  type HandoffRecord,
  type Role,
} from "../bridge";
import { roleBehaviour } from "../pipeline/defs";
import { advanceChain, type ChainRef } from "./chains";
import {
  carryChainTaskType,
  handoffFillSummary,
  handoffStartProblem,
  mapHandoff,
  needsChainTaskType,
  terminalHandoffInput,
  terminalStartMessage,
  type HandoffField,
  type HandoffScope,
  type HandoffSource,
  type HandoffSurface,
  type HandoffTarget,
  type MappedHandoff,
} from "./map";
import { loopBackFindings } from "./routing";
import { roleDisplayName, type RoleName } from "./transitions";

/** The backend calls the executor makes. Defaults to the real bridge. */
export type HandoffIo = {
  getRole: typeof getRole;
  changesList: typeof changesList;
  gitRepoInfo: typeof gitRepoInfo;
  getPipelineRun: typeof getPipelineRun;
  terminalPlanFile: typeof terminalPlanFile;
  validateAndPreview: typeof validateAndPreview;
  handoffSave: typeof handoffSave;
  handoffAttach: typeof handoffAttach;
  /** Engine 2: the next stage's form as the run folder's files fill it (null when the actor has none). */
  runFilesPrefill: (runId: string, sourceTabId: string, targetRoleId: string) => Promise<RunFilesPrefill | null>;
};

/** The next stage's form values from the run folder (no `cwd`), and the text recorded as the hand-off. */
export type RunFilesPrefill = { values: Record<string, string>; handoffText: string };

export const bridgeHandoffIo: HandoffIo = {
  getRole,
  changesList,
  gitRepoInfo,
  getPipelineRun,
  terminalPlanFile,
  validateAndPreview,
  handoffSave,
  handoffAttach,
  runFilesPrefill: async (runId, sourceTabId, targetRoleId) =>
    (await pipelineActorMessage(runId, { kind: "prefill", sourceTabId, targetRoleId })).prefill ?? null,
};

export function handoffFieldsOf(role: Role): HandoffField[] {
  return role.fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options,
    required: field.required,
    showWhen: field.showWhen ?? null,
  }));
}

/** A reviewer's round going back to an earlier stage's (new) tab. */
export type LoopBackStep = {
  chainId: string;
  /** The target tab's chain tag for the next round. */
  next: ChainRef;
};

export type PrepareRequest = {
  source: HandoffSource;
  scope: HandoffScope;
  surface: HandoffSurface;
  targetRoleId: string;
  /** The source tab's chain, if it is on one. */
  sourceChain: ChainRef | null | undefined;
  /** Set when this hand-off sends a reviewer's round back. */
  loopBack: LoopBackStep | null;
  /** The source terminal's plan file when the scope is `plan_file`. */
  planFile?: { name: string; path: string } | null;
  /**
   * Engine 2 (V4, D20): the source's run id when it is a bridged stage. The
   * next stage's form is then filled from the run folder's files (plan.md,
   * tasks.json, prs.json), not mapped from the reply; it stays editable.
   */
  runFilesFrom?: string | null;
  /** Fields and template loaded with the dialog, used if the role cannot be re-read. */
  fallbackFields?: HandoffField[] | null;
  fallbackTemplate?: string | null;
  roles?: readonly RoleName[] | null;
};

export type PreparedHandoff = {
  source: HandoffSource;
  target: HandoffTarget;
  mapped: MappedHandoff;
  /** The chain tag the new tab takes, if any. */
  nextChain: ChainRef | null;
};

export type Prepared = { ok: true; value: PreparedHandoff } | { ok: false; error: string };

/** A terminal plan file may have been edited since the dialog opened. */
async function freshPlanFile(io: HandoffIo, req: PrepareRequest): Promise<HandoffSource> {
  const { source, scope, planFile } = req;
  if (!source.fromTerminal || scope !== "plan_file" || !planFile) return source;
  // intentionally silent: falls back to the plan text captured earlier.
  const fresh = await io
    .terminalPlanFile(0, source.sourceTabId, { mentioned: [planFile.name], claimed: [] })
    .catch(() => null);
  return fresh?.path === planFile.path && fresh.text.trim()
    ? { ...source, planFileText: fresh.text }
    : source;
}

/** An Implementer's hand-off carries its changed files, branch, and the findings it fixed. */
async function implementerContext(
  io: HandoffIo,
  source: HandoffSource,
  chainId: string | null,
): Promise<HandoffSource> {
  if (roleBehaviour(source.sourceRoleId, source.sourceChainKind) !== "implementer") return source;
  // intentionally silent: each lookup only enriches the hand-off; it works without them.
  const [changes, repo, run] = await Promise.all([
    io.changesList(source.sourceTabId, "tab").catch(() => null),
    io.gitRepoInfo(source.cwd).catch(() => null),
    chainId ? io.getPipelineRun(chainId).catch(() => null) : Promise.resolve(null),
  ]);
  // A send-back from the PR Reviewer: the next review checks those findings.
  // Hand-offs into a run are kept by the role they went to: this implementer's own.
  const sentBack = loopBackFindings(run?.run.handoffs?.[source.sourceRoleId]?.text ?? "");
  return {
    ...source,
    changes:
      changes?.state === "ok"
        ? changes.files.map((file) => ({
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
          }))
        : source.changes,
    branch: repo?.currentBranch ?? source.branch ?? null,
    previousReview: sentBack ? { round: sentBack.round, findings: sentBack.findings } : null,
  };
}

/**
 * The mapped form with the run folder's values over it (engine 2, D20). The
 * plan field then holds the whole plan from `plan.md`, so nothing is cut.
 */
export function withRunFiles(mapped: MappedHandoff, prefill: RunFilesPrefill): MappedHandoff {
  const answers: Record<string, string> = { ...mapped.answers, ...prefill.values, cwd: mapped.answers.cwd ?? "" };
  const planFilled = !!mapped.planField && !!prefill.values[mapped.planField]?.trim();
  return {
    ...mapped,
    answers,
    planText: prefill.handoffText.trim() ? prefill.handoffText : mapped.planText,
    inlinePlan: planFilled && mapped.planField ? answers[mapped.planField] : mapped.inlinePlan,
    truncated: planFilled ? false : mapped.truncated,
  };
}

/**
 * Everything before anything is written: the mapped form, the chain step,
 * and (for a terminal, which starts the CLI at once) a complete prompt.
 */
export async function prepareHandoff(
  req: PrepareRequest,
  io: HandoffIo = bridgeHandoffIo,
): Promise<Prepared> {
  let source = await freshPlanFile(io, req);
  source = await implementerContext(io, source, req.sourceChain?.chainId ?? null);
  // Settings can stay open over the dialog: map onto the role as saved now.
  // intentionally silent: falls back to the role fields loaded with the dialog.
  const role = await io.getRole(req.targetRoleId).catch(() => null);
  const fields = role ? handoffFieldsOf(role) : (req.fallbackFields ?? []);
  const templateText = role ? role.templateText : (req.fallbackTemplate ?? "");
  const target: HandoffTarget = { roleId: req.targetRoleId, fields };
  let mapped = mapHandoff(source, req.scope, target);
  if (!mapped.planText) {
    return { ok: false, error: mapped.warning ?? "That choice has no content." };
  }
  // A loop-back whose tab is gone or not live opens a new tab on the chain.
  const nextChain =
    req.loopBack?.next ??
    (req.sourceChain ? advanceChain(req.sourceChain, source.sourceRoleId, req.targetRoleId) : null);
  if (nextChain && needsChainTaskType(mapped, target)) {
    // Plan Reviewer has no task type; the chain's Planner form does.
    // intentionally silent: without it the task type is simply not carried over.
    const view = await io.getPipelineRun(nextChain.chainId).catch(() => null);
    mapped = carryChainTaskType(mapped, target, view?.taskType);
  }
  if (req.runFilesFrom && nextChain && !req.loopBack) {
    // intentionally silent: without it the form keeps the values mapped from the reply.
    const prefill = await io
      .runFilesPrefill(req.runFilesFrom, source.sourceTabId, req.targetRoleId)
      .catch(() => null);
    if (prefill) mapped = withRunFiles(mapped, prefill);
  }
  if (req.surface === "terminal") {
    // The form summary names what the hand-off left empty, then the backend
    // validates exactly what will be sent.
    const targetName = roleDisplayName(req.targetRoleId, req.roles);
    let problem = handoffStartProblem(
      handoffFillSummary(mapped, { ...target, templateText }),
      targetName,
    );
    if (!problem) {
      // intentionally silent: the backend validates again when the terminal starts.
      const check = await io
        .validateAndPreview(req.targetRoleId, {
          ...terminalHandoffInput(mapped).values,
          cwd: source.cwd,
        })
        .catch(() => null);
      problem = terminalStartMessage(
        targetName,
        (check?.errors ?? []).filter((err) => err.key !== "cwd").map((err) => err.message),
      );
    }
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, value: { source, target, mapped, nextChain } };
}

/** Saves the hand-off record (before the target tab exists). */
export function saveHandoff(
  prepared: PreparedHandoff,
  scope: HandoffScope,
  io: HandoffIo = bridgeHandoffIo,
): Promise<HandoffRecord> {
  const { source, target, mapped, nextChain } = prepared;
  return io.handoffSave({
    sourceTabId: source.sourceTabId,
    sourceRoleId: source.sourceRoleId,
    sourceLabel: source.sourceLabel,
    targetRoleId: target.roleId,
    title: mapped.title,
    cwd: source.cwd,
    scope,
    planText: mapped.planText,
    truncated: mapped.truncated,
    warning: mapped.warning,
    planField: mapped.planField,
    chain: nextChain,
  });
}

/**
 * Binds the saved hand-off to the tab it opened and records that tab's
 * chain step, or the reviewer's loop-back round, in one backend call.
 */
export async function attachHandoff(
  args: {
    record: HandoffRecord;
    tabId: string;
    prepared: PreparedHandoff;
    loopBack: LoopBackStep | null;
    /** The reviewer's verdict for the round a loop-back ends. */
    verdict: string | null;
  },
  io: HandoffIo = bridgeHandoffIo,
): Promise<HandoffRecord> {
  const { record, tabId, prepared, loopBack, verdict } = args;
  const { mapped, nextChain, source } = prepared;
  const attached = await io.handoffAttach({
    id: record.id,
    tabId,
    chain: loopBack ? null : nextChain,
    loopBack: loopBack
      ? {
          chainId: loopBack.chainId,
          reviewerRoleId: source.sourceRoleId,
          verdict,
          lane: loopBack.next.lane ?? null,
        }
      : null,
    handoffText: loopBack || nextChain ? mapped.planText : null,
  });
  return attached.record;
}
