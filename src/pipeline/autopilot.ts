/**
 * Autopilot glue on the frontend (ADR-014). The decision itself is the
 * Rust core's (`pipeline_decide`); this module turns a finished terminal
 * turn into the report it decides on, builds the hand-off source a decision
 * sends on, and works out which turns were already handled. Engine-1 runs
 * only: the Rust run actor decides an engine-2 run's bridged turns from
 * their `submit_result` (V3). Pure.
 */
import type { TabSummary, TerminalSessionLog, TurnReport, UsageSnapshot } from "../bridge";
import type { ChainRef } from "../handoff/chains";
import { contractFindings, contractResult, missingHandoffSections } from "../handoff/contract";
import { terminalLogFields, type HandoffField, type HandoffSource } from "../handoff/map";
import { roleDisplayName, type RoleName } from "../handoff/transitions";
import { parseReviewVerdict } from "../handoff/verdict";
import { pipelineDef, roleBehaviour, stageRoles, type PipelineDef, type StageDef } from "./defs";
import { knownUsagePercent } from "../usage/limits";

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
 * The highest current Claude usage window, in percent; null when unknown
 * (none read, or each reset since its reading). Autopilot carries on then.
 */
export function usagePercent(usage: UsageSnapshot | null | undefined, now = Date.now()): number | null {
  return knownUsagePercent(usage?.windows ?? [], now);
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
  /** The rate-limit error in the stage's session log this turn, if any. */
  rateLimit?: string | null;
  /** A Planner waiting on its plan dialog: its plan is the result, sections are not checked. */
  awaitingPlan?: boolean;
  /** The tab's lane, when the run fanned out. */
  lane?: string | null;
  /** The run's pipeline (chain kind): the stage's kind picks the sections its reply owes. */
  chainKind?: string | null;
  /**
   * The stage reviewer's own reply, when `reply` merges parallel reviews:
   * its HANDOFF sections are checked, not the merged ones.
   */
  ownReply?: string;
}): TurnReport {
  const {
    stage,
    reply,
    chat,
    usage,
    rateLimit = null,
    awaitingPlan = false,
    lane = null,
    ownReply = reply,
    chainKind = null,
  } = args;
  const result = contractResult(reply);
  const reviewer = !!stage.loopBack;
  return {
    stageId: stage.id,
    verdict: reviewer ? parseReviewVerdict(reply) : null,
    findings: reviewer
      ? (result?.findings ?? []).map((f) => ({ severity: f.severity, summary: f.summary }))
      : [],
    findingsKnown: reviewer && !!result,
    missingSections: awaitingPlan ? [] : missingHandoffSections(stage.roleId, ownReply, chainKind),
    usagePercent: usage,
    rateLimit: rateLimit?.trim() || null,
    chat,
    lane,
  };
}

/**
 * The findings a loop-back sends: the reviewer's findings section, else its
 * Result findings, else its whole reply.
 */
export function loopBackText(reply: string): string {
  const declared = contractFindings(reply);
  // "None." reads as "" here: the reviewer said there is nothing to fix.
  if (declared !== null) {
    if (declared.trim()) return declared.trim();
    const listed = contractResult(reply)?.findings ?? [];
    if (!listed.length) return "";
  }
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
 * The turn a log shows as finished, for autopilot: a turn that ended, or a
 * Planner turn waiting on its plan. Null while the turn is still working or
 * waits on anything else. A turn you interrupted is not finished work, so
 * it is null too. The key changes once per turn, so each turn is handled once.
 * `chainKind`: the tab's pipeline, where its stage's kind says it plans.
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

/**
 * A terminal tab's current turn, `tab|session|prompt`: the prompt that
 * started it names it, so a reply read again (or the next turn's log read
 * before its prompt lands) is the same turn. Hand-off claims and autopilot
 * decisions are keyed on it. Null without a session log.
 */
export function turnId(tabId: string, log: TerminalSessionLog | null | undefined): string | null {
  if (!log?.sessionId) return null;
  return `${tabId}|${log.sessionId}|${log.lastPromptAt ?? ""}`;
}

const VERDICT_ORDER = ["REJECTED", "REQUIRES REVISION", "REQUEST CHANGES", "APPROVED WITH CHANGES", "APPROVED"];

/** The least favourable of several verdicts; a reviewer without one counts as needing changes. */
export function worstVerdict(verdicts: readonly (string | null)[], revise: string): string {
  if (verdicts.some((v) => !v)) return revise;
  const ranked = verdicts.map((v) => VERDICT_ORDER.indexOf(v ?? ""));
  const worst = Math.min(...ranked.map((rank) => (rank < 0 ? 0 : rank)));
  const verdict = VERDICT_ORDER[worst];
  // A plan reviewer's "changes" verdict and a PR reviewer's differ in name only.
  return verdict === "REQUEST CHANGES" || verdict === "REQUIRES REVISION" || verdict === "REJECTED"
    ? revise
    : verdict;
}

/**
 * Parallel reviews of one stage as a single reply in the HANDOFF contract:
 * the worst verdict, each reviewer's findings under its name, and every
 * Result finding. Autopilot decides and sends back on this one reply.
 */
export function mergeReviews(
  reviews: readonly { name: string; reply: string }[],
  revise: string,
): string {
  const verdicts = reviews.map((r) => parseReviewVerdict(r.reply));
  const verdict = worstVerdict(verdicts, revise);
  const findings = reviews
    .map((r, i) => {
      const text = loopBackText(r.reply);
      if (!text) return verdicts[i]?.startsWith("APPROVED") ? "" : `From the ${r.name}:\nNo findings given.`;
      return `From the ${r.name}:\n${text}`;
    })
    .filter(Boolean);
  const results = reviews.map((r) => contractResult(r.reply));
  const known = results.every(Boolean);
  const merged = results.flatMap((result, i) =>
    (result?.findings ?? []).map((f) => ({ ...f, summary: `${reviews[i].name}: ${f.summary}` })),
  );
  const sections = [
    `## HANDOFF: Verdict\n${verdict}`,
    `## HANDOFF: Findings for the Implementer\n${findings.length ? findings.join("\n\n") : "None."}`,
  ];
  if (known) {
    sections.push(`## HANDOFF: Result\n\`\`\`json\n${JSON.stringify({ verdict, findings: merged })}\n\`\`\``);
  }
  return sections.join("\n\n");
}
