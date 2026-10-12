/**
 * Fan-out (ADR-014 phase 3): a plan that ships as several pull requests
 * gets one lane per pull request, each with its own Implementer in its own
 * git worktree. Lanes with no dependency start at once; the others wait
 * until the lanes they depend on are approved (autopilot starts them, or
 * Start in the overview).
 */
import {
  gitRepoInfo,
  getTab,
  handoffGet,
  handoffList,
  pipelineFanOut,
  pipelineLaneStatus,
  worktreeTabNew,
  type PipelineRun,
  type RunLane,
  type TabSummary,
} from "../bridge";
import type { ChainRef } from "../handoff/chains";
import {
  attachHandoff,
  prepareHandoff,
  saveHandoff,
  type PreparedHandoff,
} from "../handoff/executor";
import { defaultScope, terminalHandoffInput, type HandoffSource } from "../handoff/map";
import type { RoleName } from "../handoff/transitions";
import type { PipelineDef, StageDef } from "./defs";
import { laneNote, lanesFromReply } from "./prPlan";

export { laneNote, lanesFromReply, parsePullRequestPlan, type PlannedPr } from "./prPlan";

/** `mapped` with the lane note added to Additional Context (else in front of the plan). */
export function withLaneNote(prepared: PreparedHandoff, note: string): PreparedHandoff {
  const mapped = { ...prepared.mapped, answers: { ...prepared.mapped.answers } };
  if ("additionalContext" in mapped.answers || prepared.target.fields.some((f) => f.key === "additionalContext")) {
    const before = (mapped.answers.additionalContext ?? "").trim();
    mapped.answers.additionalContext = before ? `${note}\n\n${before}` : note;
  } else {
    mapped.planText = `${note}\n\n${mapped.planText}`;
    if (mapped.planField) {
      mapped.answers[mapped.planField] = `${note}\n\n${mapped.answers[mapped.planField] ?? ""}`;
    }
  }
  return { ...prepared, mapped };
}

/** A git branch name for a lane's worktree: `ee-1760…-pr1`. */
export function laneBranch(runId: string, laneId: string): string {
  return `${runId}-${laneId}`.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^-+/, "");
}

export type FanOutDeps = {
  /** Starts the role terminal in an existing draft tab, quietly; the tab id or null. */
  startTerminal: (tabId: string, roleId: string, values: Record<string, string>, plan: string | null) => Promise<string | null>;
  /** Keeps a waiting lane's draft form filled in. */
  syncForm: (tabId: string, roleId: string, cwd: string, values: Record<string, string>) => Promise<void>;
  refreshTabs: () => Promise<unknown>;
  roles: readonly RoleName[] | null;
};

/**
 * Splits `run` at `stage` (the Implementer's) using the plan in `source`'s
 * reply: records the lanes, makes one worktree tab per lane, hands each
 * the plan plus its lane note, and starts the lanes with no dependency.
 */
export async function fanOutRun(
  args: {
    run: PipelineRun;
    stage: StageDef;
    source: HandoffSource;
    sourceChain: ChainRef;
  },
  deps: FanOutDeps,
): Promise<{ started: string[]; waiting: string[] }> {
  const { run, stage, source, sourceChain } = args;
  const lanes = lanesFromReply(source.latestMessage);
  if (lanes.length < 2) {
    throw new Error("The plan lists fewer than two pull requests (manual steps do not count).");
  }
  const repo = await gitRepoInfo(run.cwd).catch(() => null);
  if (!repo) throw new Error(`${run.cwd} is not a git repository, so there is nowhere to make worktrees.`);
  await pipelineFanOut(
    run.id,
    stage.id,
    lanes.map((lane) => ({ id: lane.id, title: lane.title, dependsOn: lane.dependsOn })),
  );
  const scope = defaultScope(source);
  const started: string[] = [];
  const waiting: string[] = [];
  for (const lane of lanes) {
    const branch = laneBranch(run.id, lane.id);
    const { tab } = await worktreeTabNew({
      roleId: stage.roleId,
      repoPath: run.cwd,
      branch,
      createBranch: true,
      base: null,
    });
    const prepared = await prepareHandoff({
      source,
      scope,
      surface: "terminal",
      targetRoleId: stage.roleId,
      sourceChain,
      loopBack: null,
      roles: deps.roles,
    });
    if (!prepared.ok) throw new Error(`${lane.title}: ${prepared.error}`);
    const next = prepared.value.nextChain;
    const value = withLaneNote(
      { ...prepared.value, nextChain: next ? { ...next, lane: lane.id } : null },
      laneNote(lane, lanes, branch),
    );
    const record = await saveHandoff(value, scope);
    const terminal = terminalHandoffInput(value.mapped);
    const values = { ...terminal.values, cwd: tab.cwd };
    if (lane.dependsOn.length === 0) {
      const id = await deps.startTerminal(tab.id, stage.roleId, values, terminal.handoffPlan || null);
      if (!id) throw new Error(`${lane.title}: the terminal did not start.`);
      started.push(lane.id);
    } else {
      await deps.syncForm(tab.id, stage.roleId, tab.cwd, values);
      waiting.push(lane.id);
    }
    await attachHandoff({ record, tabId: tab.id, prepared: value, loopBack: null, verdict: null });
  }
  await deps.refreshTabs();
  return { started, waiting };
}

/** Starts a waiting lane's Implementer from its prefilled draft tab. */
export async function startLane(
  run: PipelineRun,
  lane: RunLane,
  roleId: string,
  deps: Pick<FanOutDeps, "startTerminal" | "refreshTabs">,
): Promise<void> {
  const tabId = lane.tabIds[roleId];
  if (!tabId) throw new Error(`${lane.title} has no ${roleId} tab.`);
  const { tab } = await getTab(tabId);
  const values = { ...tab.answers, cwd: tab.cwd };
  // A plan too long for the form waits in the saved hand-off (terminalHandoffInput).
  const cut = Object.values(values).some((value) => /^The full text \([\d,.\s]+characters\) follows/.test(value));
  let plan: string | null = null;
  if (cut) {
    const record = (await handoffList()).find((item) => item.targetTabId === tabId);
    plan = record ? (await handoffGet(record.id)).planText : null;
  }
  const id = await deps.startTerminal(tabId, roleId, values, plan);
  if (!id) throw new Error(`${lane.title}: the terminal did not start.`);
  await pipelineLaneStatus(run.id, lane.id, "active");
  await deps.refreshTabs();
}

/** The stage before the fan-out stage, whose reply holds the plan. */
export function planStageFor(
  def: PipelineDef,
  fanStage: StageDef,
): StageDef | null {
  const at = def.stages.findIndex((s) => s.id === fanStage.id);
  return at > 0 ? def.stages[at - 1] : null;
}

/** The tab of `stage` on the run, if open. */
export function stageTab(run: PipelineRun, stage: StageDef, tabs: readonly TabSummary[]): TabSummary | null {
  const id = run.tabIds[stage.roleId];
  return (id && tabs.find((t) => t.id === id)) || null;
}
