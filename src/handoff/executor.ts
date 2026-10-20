/**
 * The hand-off executor: everything between "the user (or autopilot) picked
 * a target and a scope" and "the next tab exists". It enriches the source,
 * maps it onto the target role's form, works out the chain step, checks a
 * terminal start, saves the hand-off, and records the new tab's chain step.
 *
 * UI state (busy flags, dialog errors, drafts, tab selection) stays with the
 * caller; this module only talks to the backend through `HandoffIo`, so the
 * dialog and the pipeline autopilot run the same steps and tests can fake IO.
 */
import {
  changesList,
  getPipelineRun,
  getRole,
  gitRepoInfo,
  handoffAttach,
  handoffSave,
  pipelineClaimHandoff,
  pipelineReleaseHandoff,
  terminalPlanFile,
  validateAndPreview,
  type ClaimOutcome,
  type HandoffRecord,
  type Role,
} from "../bridge";
import { roleBehaviour } from "../pipeline/defs";
import { eventTime } from "../pipeline/runReport";
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
};

export const bridgeHandoffIo: HandoffIo = {
  getRole,
  changesList,
  gitRepoInfo,
  getPipelineRun,
  terminalPlanFile,
  validateAndPreview,
  handoffSave,
  handoffAttach,
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

/** The backend calls a hand-off claim makes. Defaults to the real bridge. */
export type ClaimIo = {
  claim: typeof pipelineClaimHandoff;
  release: typeof pipelineReleaseHandoff;
};

// Async wrappers: a call that throws at once still lands in the callers' catch.
export const bridgeClaimIo: ClaimIo = {
  claim: async (args) => pipelineClaimHandoff(args),
  release: async (runId, key) => pipelineReleaseHandoff(runId, key),
};

export type ClaimCheck =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; key: string; warning: string };

/**
 * Before you hand a chain tab's turn on, or send its round back: claims the
 * hand-off, so autopilot does not make it a second time. When autopilot made
 * it already, it warns instead, once: pressing Send again with the same
 * claim (`confirmedKey`) makes it anyway. A hand-off you made before goes
 * ahead (you chose to send it again). `release` gives the claim back when
 * the hand-off does not happen. Without a run (or when the backend cannot
 * be asked) nothing is claimed and the hand-off goes ahead as before.
 */
export async function claimManualHandoff(
  args: {
    sourceTabId: string;
    kind: "advance" | "back";
    /** The source tab's turn (`turnId`), when it is a terminal with a session log. */
    turn: string | null;
    /** The claim you were warned about and pressed Send again for. */
    confirmedKey: string | null;
  },
  io: ClaimIo = bridgeClaimIo,
): Promise<ClaimCheck> {
  const ask = (force: boolean) =>
    // intentionally silent: without a claim the hand-off goes ahead as it always did.
    io.claim({ sourceTabId: args.sourceTabId, kind: args.kind, turn: args.turn, force }).catch(() => null);
  const held = (outcome: ClaimOutcome | null): ClaimCheck => ({
    ok: true,
    release: async () => {
      // intentionally silent: a claim left behind only adds a warning to a later hand-off.
      if (outcome?.claimed) await io.release(outcome.runId, outcome.key).catch(() => {});
    },
  });
  const outcome = await ask(false);
  if (!outcome || outcome.claimed || outcome.existing?.by !== "autopilot") return held(outcome);
  if (args.confirmedKey === outcome.key) return held(await ask(true));
  const what = args.kind === "back" ? "sent this round back" : "handed this turn on";
  const again = args.kind === "back" ? "send it back" : "hand it on";
  return {
    ok: false,
    key: outcome.key,
    warning: `Autopilot already ${what} (${eventTime(outcome.existing.at)}): see the run's timeline. Press Send again to ${again} anyway.`,
  };
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
