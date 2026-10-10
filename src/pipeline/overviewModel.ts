/**
 * What the pipeline / Eagle-Eye chain overview shows per stage. Pure reads
 * of tabs, runtimes, and open terminals; nothing here starts or sends.
 */
import type { PipelineRun, TabSummary } from "../bridge";
import { latestAgentMessage, splitPlanReview } from "../handoff/map";
import { isReviewerRole, parseReviewVerdict, type ReviewVerdict } from "../handoff/verdict";
import type { TabRuntime } from "../liveTabs";
import { segmentsToPlainText } from "../transcript";
import { stagesForKind, type PipelineKind, type PipelineStageDef } from "./stages";
import type { TerminalReader } from "./terminalText";

export type LaneTone = "idle" | "live" | "done";

export function laneStatus(
  tab: TabSummary | undefined,
  rt: TabRuntime | undefined,
): { label: string; tone: LaneTone } {
  if (!tab) return { label: "Missing tab", tone: "idle" };
  if (rt?.promptInFlight) return { label: "Working…", tone: "live" };
  if (tab.phase === "running" || rt?.session) return { label: "Session open", tone: "live" };
  if (tab.hasTranscript || tab.startupPromptSent) return { label: "Stopped", tone: "done" };
  if (tab.phase === "draft") return { label: "Ready", tone: "idle" };
  return { label: tab.phase, tone: "idle" };
}

function isTerminal(tab: TabSummary | undefined): boolean {
  return tab?.kind === "terminal";
}

/** The stage's latest reply: chat's last agent message, or a terminal's tail. */
export function stageReply(
  tab: TabSummary | undefined,
  rt: TabRuntime | undefined,
  reader: TerminalReader,
): string {
  if (!tab) return "";
  if (isTerminal(tab)) return reader.tail(tab.id).trim();
  return latestAgentMessage(rt?.segments.map((s) => ({ kind: s.kind, text: s.text })) ?? []);
}

export type StageView = {
  def: PipelineStageDef;
  tabId: string | null;
  tab: TabSummary | undefined;
  status: { label: string; tone: LaneTone };
  /** Text a hand-off along the chain sent into this stage. */
  handedIn: string | null;
  verdict: ReviewVerdict | null;
  current: boolean;
};

export function overviewStages(
  run: PipelineRun,
  tabs: TabSummary[],
  runtimes: Record<string, TabRuntime>,
  reader: TerminalReader,
): StageView[] {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  return stagesForKind((run.kind ?? "full") as PipelineKind).map((def) => {
    const tabId = run.tabIds[def.roleId] ?? null;
    const tab = tabId ? byId.get(tabId) : undefined;
    const rt = tabId ? runtimes[tabId] : undefined;
    const verdict = isReviewerRole(def.roleId)
      ? parseReviewVerdict(stageReply(tab, rt, reader))
      : null;
    return {
      def,
      tabId,
      tab,
      status: tabId ? laneStatus(tab, rt) : { label: "Not started", tone: "idle" },
      handedIn: run.handoffs?.[def.roleId]?.text?.trim() || null,
      verdict,
      current: run.stage === def.stageId,
    };
  });
}

/** A reviewer's verdict for each round it sent back, oldest first. */
export function verdictHistory(
  run: PipelineRun,
  roleId: string,
): { round: number; verdict: string }[] {
  return (run.verdicts ?? [])
    .filter((entry) => entry.roleId === roleId)
    .map((entry) => ({ round: entry.round, verdict: entry.verdict?.trim() || "No verdict" }));
}

export type Pulled = { text: string; reason: string | null };

const NOT_OPEN_TERMINAL = (role: string) =>
  `The ${role} runs in a terminal that is not open in this window. Jump to it, select the text, and pull again.`;

function stageTab(run: PipelineRun, tabs: TabSummary[], roleId: string): TabSummary | undefined {
  const id = run.tabIds[roleId];
  return id ? tabs.find((t) => t.id === id) : undefined;
}

/** The Planner's plan: chat reply, or a terminal's selection, plan file, then tail. */
export async function pullPlannerText(
  run: PipelineRun,
  tabs: TabSummary[],
  runtimes: Record<string, TabRuntime>,
  reader: TerminalReader,
): Promise<Pulled> {
  const tab = stageTab(run, tabs, "role_planner");
  if (!tab) return { text: "", reason: "This run has no open Planner tab." };
  if (isTerminal(tab)) {
    const text =
      reader.selection(tab.id) || (await reader.planFile(tab.id)) || reader.tail(tab.id);
    return text.trim()
      ? { text: text.trim(), reason: null }
      : { text: "", reason: NOT_OPEN_TERMINAL("Planner") };
  }
  const rt = runtimes[tab.id];
  const reply = stageReply(tab, rt, reader);
  if (reply) return { text: reply, reason: null };
  if (tab.hasTranscript) {
    const text = segmentsToPlainText(rt?.segments ?? []).trim();
    if (text) return { text, reason: null };
  }
  return { text: "", reason: "Start the Planner tab or wait for a reply." };
}

/** The reviewed plan from the Plan Reviewer's reply (its "Reviewed plan" section). */
export function pullPlanReviewText(
  run: PipelineRun,
  tabs: TabSummary[],
  runtimes: Record<string, TabRuntime>,
  reader: TerminalReader,
): Pulled {
  const tab = stageTab(run, tabs, "role_plan_reviewer");
  if (!tab) return { text: "", reason: "This run has no open Plan Reviewer tab." };
  const reply = isTerminal(tab)
    ? reader.selection(tab.id) || reader.tail(tab.id)
    : stageReply(tab, runtimes[tab.id], reader);
  if (!reply.trim()) {
    return {
      text: "",
      reason: isTerminal(tab)
        ? NOT_OPEN_TERMINAL("Plan Reviewer")
        : "Start the Plan Reviewer tab or wait for a reply.",
    };
  }
  return { text: splitPlanReview(reply).plan, reason: null };
}
