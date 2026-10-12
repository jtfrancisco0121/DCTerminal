/**
 * Fan-out (ADR-014 phase 3): a plan that ships as several pull requests
 * gets one lane per pull request, each with its own Implementer in its own
 * git worktree. Lanes with no dependency start at once; the others wait
 * until the lanes they depend on are approved (autopilot starts them, or
 * Start in the overview).
 */
import {
  gitRepoInfo,
  getPipelineRun,
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
import { laneBranch, laneNote, lanesFromReply } from "./prPlan";

export { laneBranch, laneNote, lanesFromReply, parsePullRequestPlan, type PlannedPr } from "./prPlan";

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
 * reply: makes one worktree tab per lane and saves each hand-off (the plan
 * plus its lane note), then records the lanes, attaches the hand-offs, and
 * starts the lanes with no dependency. Everything that can fail before the
 * lanes are recorded runs first, so a failure leaves no half-recorded run.
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
  const scope = defaultScope(source);
  const ready: {
    lane: (typeof lanes)[number];
    tabId: string;
    values: Record<string, string>;
    plan: string | null;
    record: Awaited<ReturnType<typeof saveHandoff>>;
    value: PreparedHandoff;
  }[] = [];
  const made: { branch: string; cwd: string }[] = [];
  try {
    for (const lane of lanes) {
      const branch = laneBranch(run.id, lane.id);
      const { tab } = await worktreeTabNew({
        roleId: stage.roleId,
        repoPath: run.cwd,
        branch,
        createBranch: true,
        base: null,
      });
      made.push({ branch, cwd: tab.cwd });
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
        laneNote(lane, lanes, run.id),
      );
      const record = await saveHandoff(value, scope);
      const terminal = terminalHandoffInput(value.mapped);
      const values = { ...terminal.values, cwd: tab.cwd };
      if (lane.dependsOn.length > 0) await deps.syncForm(tab.id, stage.roleId, tab.cwd, values);
      ready.push({ lane, tabId: tab.id, values, plan: terminal.handoffPlan || null, record, value });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!made.length) throw err;
    // Nothing is recorded yet; the worktrees made so far are left for you to remove.
    // intentionally silent: the error below matters more than a stale tab list.
    await deps.refreshTabs().catch(() => {});
    throw new Error(
      `${message} Fan-out stopped before recording the lanes. Remove the worktrees it already made: ` +
        made.map((m) => `${m.cwd} (branch \`${m.branch}\`)`).join(", ") +
        ".",
    );
  }
  await pipelineFanOut(
    run.id,
    stage.id,
    lanes.map((lane) => ({ id: lane.id, title: lane.title, dependsOn: lane.dependsOn })),
  );
  for (const item of ready) {
    await attachHandoff({ record: item.record, tabId: item.tabId, prepared: item.value, loopBack: null, verdict: null });
  }
  const started: string[] = [];
  const waiting: string[] = [];
  const failed: string[] = [];
  for (const item of ready) {
    if (item.lane.dependsOn.length > 0) {
      waiting.push(item.lane.id);
      continue;
    }
    let why = "the terminal did not start";
    try {
      if (await deps.startTerminal(item.tabId, stage.roleId, item.values, item.plan)) {
        started.push(item.lane.id);
        continue;
      }
    } catch (err: unknown) {
      why = err instanceof Error ? err.message : String(err);
    }
    // Back to waiting, so Start in the overview can try again.
    // intentionally silent: the error below still names the lane.
    await pipelineLaneStatus(run.id, item.lane.id, "waiting").catch(() => {});
    failed.push(`${item.lane.title} (${why})`);
  }
  await deps.refreshTabs();
  if (failed.length) {
    throw new Error(`${failed.join("; ")} did not start. Start ${failed.length === 1 ? "it" : "them"} from the overview.`);
  }
  return { started, waiting };
}

/** Lanes being claimed now, so two starts of one lane cannot race. */
const claiming = new Set<string>();

/**
 * Starts a waiting lane's Implementer from its prefilled draft tab. Claims
 * the lane first (re-read, still `waiting`, marked `active`), so a lane is
 * started once; false when it was no longer waiting. A failed start puts
 * the lane back to `waiting`.
 */
export async function startLane(
  run: PipelineRun,
  lane: RunLane,
  roleId: string,
  deps: Pick<FanOutDeps, "startTerminal" | "refreshTabs">,
): Promise<boolean> {
  const tabId = lane.tabIds[roleId];
  if (!tabId) throw new Error(`${lane.title} has no ${roleId} tab.`);
  const key = `${run.id}|${lane.id}`;
  if (claiming.has(key)) return false;
  claiming.add(key);
  try {
    const { run: fresh } = await getPipelineRun(run.id);
    if (fresh.lanes?.find((l) => l.id === lane.id)?.status !== "waiting") return false;
    await pipelineLaneStatus(run.id, lane.id, "active");
    try {
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
    } catch (err: unknown) {
      // intentionally silent: the start error below is the one to show.
      await pipelineLaneStatus(run.id, lane.id, "waiting").catch(() => {});
      throw err;
    }
    await deps.refreshTabs();
    return true;
  } finally {
    claiming.delete(key);
  }
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
