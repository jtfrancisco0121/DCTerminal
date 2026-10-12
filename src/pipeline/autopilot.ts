/**
 * Autopilot glue on the frontend (ADR-014). The decision itself is the
 * Rust core's (`pipeline_decide`); this module turns a finished terminal
 * turn into the report it decides on, builds the hand-off source a decision
 * sends on, and works out which turns were already handled. Pure.
 */
import type { TabSummary, TerminalSessionLog, TurnReport, UsageSnapshot } from "../bridge";
import type { ChainRef } from "../handoff/chains";
import { contractFindings, contractResult, missingHandoffSections } from "../handoff/contract";
import { terminalLogFields, type HandoffField, type HandoffSource } from "../handoff/map";
import { roleDisplayName, type RoleName } from "../handoff/transitions";
import { parseReviewVerdict } from "../handoff/verdict";
import { pipelineDef, type PipelineDef, type StageDef } from "./defs";

/** The stage a chain tab holds on its pipeline, if its role matches that step. */
export function stageForTab(
  chain: ChainRef | null | undefined,
  roleId: string,
): { def: PipelineDef; stage: StageDef } | null {
  if (!chain) return null;
  const def = pipelineDef(chain.kind);
  const stage = def?.stages[chain.step - 1];
  return def && stage && stage.roleId === roleId ? { def, stage } : null;
}

/** The highest Claude usage window, in percent; null when none is known. */
export function usagePercent(usage: UsageSnapshot | null | undefined): number | null {
  const values = (usage?.windows ?? [])
    .map((window) => window.utilization)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.round(Math.max(...values)) : null;
}

/**
 * What a stage's reply says, for the decision: the verdict and findings of a
 * reviewer stage (a stage with a loop-back), and any missing HANDOFF section.
 */
export function turnReport(args: {
  stage: StageDef;
  reply: string;
  chat: boolean;
  usage: number | null;
  /** A Planner waiting on its plan dialog: its plan is the result, sections are not checked. */
  awaitingPlan?: boolean;
  /** The tab's lane, when the run fanned out. */
  lane?: string | null;
}): TurnReport {
  const { stage, reply, chat, usage, awaitingPlan = false, lane = null } = args;
  const result = contractResult(reply);
  const reviewer = !!stage.loopBack;
  return {
    stageId: stage.id,
    verdict: reviewer ? parseReviewVerdict(reply) : null,
    findings: reviewer
      ? (result?.findings ?? []).map((f) => ({ severity: f.severity, summary: f.summary }))
      : [],
    findingsKnown: reviewer && !!result,
    missingSections: awaitingPlan ? [] : missingHandoffSections(stage.roleId, reply),
    usagePercent: usage,
    chat,
    lane,
  };
}

/**
 * The findings a loop-back sends: the reviewer's findings section, else its
 * Result findings, else its whole reply.
 */
export function loopBackText(reply: string): string {
  const section = contractFindings(reply)?.trim();
  if (section) return section;
  const findings = contractResult(reply)?.findings ?? [];
  if (findings.length) {
    return findings
      .map((f, i) => `${i + 1}. [${f.severity || "?"}]${f.file ? ` ${f.file}:` : ""} ${f.summary}`)
      .join("\n");
  }
  return reply.trim();
}

/**
 * A terminal stage's hand-off source, read from its Claude session log
 * (the reply, and a Planner's ExitPlanMode plan). Nothing is selected.
 */
export function terminalStageSource(args: {
  tab: TabSummary;
  log: TerminalSessionLog | null;
  answers: Record<string, string>;
  tail: string;
  roles?: readonly RoleName[] | null;
  sourceFields?: HandoffField[];
  /** The turn is waiting on its ExitPlanMode plan (Planner). */
  awaitingPlan: boolean;
}): HandoffSource {
  const { tab, log, answers, tail, roles, sourceFields, awaitingPlan } = args;
  return {
    sourceRoleId: tab.roleId,
    sourceTabId: tab.id,
    sourceLabel: tab.label || roleDisplayName(tab.roleId, roles),
    cwd: tab.cwd,
    answers,
    sourceFields,
    ...terminalLogFields(log),
    plan: [],
    todos: [],
    selection: "",
    turnInFlight: awaitingPlan,
    terminalWorking: false,
    terminalWaiting: null,
    awaitingPlanApproval: awaitingPlan,
    fromTerminal: true,
    terminalTail: tail,
    branch: tab.worktreeBranch ?? null,
    transcriptText: tail,
  };
}

/**
 * The turn a log shows as finished, for autopilot: a turn that ended, or a
 * Planner turn waiting on its plan. Null while the turn is still working or
 * waits on anything else. The key changes once per turn, so each turn is
 * handled once.
 */
export function finishedTurn(
  roleId: string,
  log: TerminalSessionLog | null | undefined,
): { key: string; awaitingPlan: boolean } | null {
  if (!log) return null;
  const prompt = log.lastPromptAt ?? "";
  if (log.turnDone) return { key: `${log.sessionId}|${prompt}|done`, awaitingPlan: false };
  const open = log.openTool;
  if (roleId === "role_planner" && open?.name === "ExitPlanMode" && (log.plan ?? "").trim()) {
    return { key: `${log.sessionId}|${prompt}|plan|${open.id}`, awaitingPlan: true };
  }
  return null;
}
