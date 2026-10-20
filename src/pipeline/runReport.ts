/**
 * The run report: one Markdown document from a run's ledger (ADR-014),
 * its stages, verdicts by round, latest gate results and follow-ups.
 * Pure; `exportRunReport` in the overview saves it.
 */
import type { GateResult, PipelineRun, RunEvent } from "../bridge";
import { pipelineDef, pipelineStages, stageRoles, type StageDef } from "./defs";
import { stopNotice } from "./stopReasons";

const EVENT_LABEL: Record<string, string> = {
  handoff: "Hand-off",
  loopBack: "Sent back",
  gate: "Check",
  autopilot: "Autopilot",
  stop: "Waiting for you",
  complete: "Complete",
  note: "Note",
  turn: "Turn finished",
};

export function eventLabel(kind: string): string {
  return EVENT_LABEL[kind] ?? kind;
}

/** "13 Oct 2026, 14:02" in the viewer's locale; the raw text when it does not parse. */
export function eventTime(at: string): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return at;
  return new Date(time).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function stageTitle(run: PipelineRun, stageId: string | null | undefined): string {
  if (!stageId) return "";
  return pipelineStages(run.kind).find((stage) => stage.id === stageId)?.title ?? stageId;
}

/**
 * The round a reviewer stage is on along its loop-back edge, as the round
 * cap counts it (Rust `review_round`): the recorded send-backs of any of the
 * stage's roles in the lane (or the run), plus one.
 */
export function reviewRound(run: PipelineRun, laneId: string | null | undefined, stage: StageDef): number {
  const lane = laneId ? run.lanes?.find((l) => l.id === laneId) : undefined;
  const roles = stageRoles(stage);
  return ((lane ?? run).verdicts ?? []).filter((v) => roles.includes(v.roleId)).length + 1;
}

/** Follow-ups autopilot kept instead of another round (from its decisions). */
export function followUps(run: PipelineRun): string[] {
  return (run.events ?? [])
    .filter((event) => (event.kind === "autopilot" || event.kind === "complete") && event.detail)
    .flatMap((event) => (event.detail ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => /^\[(LOW|INFO|\?)\]/.test(line));
}

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((ticks) => ticks.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text.trim()}\n${ticks}`;
}

function gateLine(result: GateResult): string {
  return `- **${result.status}** \`${result.label}\`: ${result.summary}`;
}

function stageSection(run: PipelineRun, stage: StageDef): string[] {
  const lines = [`### ${stage.title}`];
  const tab = run.tabIds[stage.roleId];
  lines.push(tab ? `Tab: \`${tab}\`` : "Not started.");
  const verdicts = (run.verdicts ?? []).filter((v) => v.roleId === stage.roleId);
  for (const v of verdicts) lines.push(`- Round ${v.round}: ${v.verdict?.trim() || "No verdict"}`);
  const gates = run.gates?.[stage.id];
  if (gates) {
    lines.push(`Checks (round ${gates.round}):`);
    for (const result of gates.results) lines.push(gateLine(result));
  }
  return lines;
}

function eventBlock(run: PipelineRun, event: RunEvent): string[] {
  const where = stageTitle(run, event.stageId);
  const head = `- ${eventTime(event.at)} · round ${event.round} · **${eventLabel(event.kind)}**${
    where ? ` (${where})` : ""
  }: ${event.kind === "stop" ? stopNotice(event.outcome, event.summary) : event.summary}`;
  if (!event.detail?.trim() || event.kind === "handoff") return [head];
  return [head, "", fence(event.detail), ""];
}

export function formatRunReport(run: PipelineRun, now = new Date()): string {
  const def = pipelineDef(run.kind);
  const name = def?.name ?? "Pipeline";
  // An engine-1 run is manual only (V6), as in the overview: its saved
  // autopilot flag and wait do nothing.
  const manualOnly = (run.engine ?? 1) < 2 || !!run.manualOnly;
  const lines: string[] = [
    `# ${name} run ${run.id}`,
    "",
    `- Folder: \`${run.cwd}\``,
    `- Started: ${eventTime(run.createdAt)}`,
    `- Stage: ${stageTitle(run, run.stage)} · round ${Math.max(1, run.round ?? 1)}`,
    `- Autopilot: ${manualOnly ? "off (this run is manual only)" : run.autopilot?.enabled ? "on" : "off"}`,
    `- Report made: ${eventTime(now.toISOString())}`,
  ];
  if (!manualOnly && run.autopilot?.waiting) lines.push(`- Waiting for you: ${stopNotice(run.stopReason, run.autopilot.waiting)}`);
  const request = run.originalRequest?.trim();
  if (request) lines.push("", "## Original request", "", request);
  lines.push("", "## Stages", "");
  for (const stage of pipelineStages(run.kind)) lines.push(...stageSection(run, stage), "");
  const later = followUps(run);
  if (later.length) lines.push("## Follow-ups", "", ...later.map((line) => `- ${line}`), "");
  lines.push("## Timeline", "");
  const events = run.events ?? [];
  if (!events.length) lines.push("Nothing recorded yet.");
  for (const event of events) lines.push(...eventBlock(run, event));
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
