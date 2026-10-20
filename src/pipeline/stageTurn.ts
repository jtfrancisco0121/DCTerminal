/**
 * A chain terminal's finished turn, read from its Claude session log: the
 * stage the tab holds, whether its turn finished (`useRunTurns` notes it in
 * the run's ledger), and the hand-off source a manual hand-off from it
 * carries. Nothing here decides: autopilot is the Rust run actor's (V3), and
 * the v1 frontend autopilot is gone (V6). Pure.
 */
import type { TabSummary, TerminalSessionLog } from "../bridge";
import type { ChainRef } from "../handoff/chains";
import { terminalLogFields, type HandoffField, type HandoffSource } from "../handoff/map";
import { roleDisplayName, type RoleName } from "../handoff/transitions";
import { pipelineDef, roleBehaviour, stageRoles, type PipelineDef, type StageDef } from "./defs";

/** The stage a chain tab holds on its pipeline, if its role matches that step. */
export function stageForTab(
  chain: ChainRef | null | undefined,
  roleId: string,
): { def: PipelineDef; stage: StageDef } | null {
  if (!chain) return null;
  const def = pipelineDef(chain.kind);
  const stage = def?.stages[chain.step - 1];
  return def && stage && stageRoles(stage).includes(roleId) ? { def, stage } : null;
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
    sourceChainKind: tab.chain?.kind ?? null,
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
 * The turn a log shows as finished: a turn that ended, or a
 * Planner turn waiting on its plan. Null while the turn is still working or
 * waits on anything else. A turn you interrupted is not finished work, so
 * it is null too. The key changes once per turn, so each turn is handled once.
 * `chainKind`: the tab's pipeline, where its stage's kind says it plans (H4).
 */
export function finishedTurn(
  roleId: string,
  log: TerminalSessionLog | null | undefined,
  chainKind?: string | null,
): { key: string; awaitingPlan: boolean } | null {
  if (!log) return null;
  const prompt = log.lastPromptAt ?? "";
  if (log.turnDone) {
    return log.interrupted ? null : { key: `${log.sessionId}|${prompt}|done`, awaitingPlan: false };
  }
  const open = log.openTool;
  if (roleBehaviour(roleId, chainKind) === "planner" && open?.name === "ExitPlanMode" && (log.plan ?? "").trim()) {
    return { key: `${log.sessionId}|${prompt}|plan|${open.id}`, awaitingPlan: true };
  }
  return null;
}
