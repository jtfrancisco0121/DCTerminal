/**
 * Run lanes: when each stage of a run worked, waited and ran its checks,
 * on one time axis. Pure; `RunLanes` draws it.
 *
 * Spans come from the run's ledger (ADR-014):
 * - a turn starts on a hand-off into the stage, a round sent back into it,
 *   or an autopilot decision that sets it working (advance, re-ask, retry);
 *   the first stage starts when the run was made;
 * - it ends on the stage's `turn` event (its verdict, if any, tags the end),
 *   on a send-back from it (CHANGES), or when a later stage takes over
 *   (a reviewer passed over that way counts as APPROVED);
 * - `stop` events are waits for you, until the next thing happens;
 * - `gate` events are checks, drawn over their run time.
 * Runs recorded before `turn` events existed still draw: their turns just
 * end when the next stage starts.
 */
import type { ChatEntry, GateResult, PipelineRun, RunEvent } from "../bridge";
import type { StageDef } from "./defs";

export type Verdict = "CHANGES" | "APPROVED";
export type GateStatus = "passed" | "failed" | "skipped" | "unknown";

type BarBase = {
  stageId: string;
  /** Lane id of a fanned-out pull request, or null. */
  lane: string | null;
  start: number;
  end: number;
  /** Still going: drawn up to now. */
  open: boolean;
  /** Text alternative. */
  label: string;
};

export type TurnBar = BarBase & { kind: "turn"; round: number; verdict: Verdict | null; track: number };
export type WaitBar = BarBase & { kind: "wait"; reason: string; track: number };
export type GateBar = BarBase & { kind: "gate"; status: GateStatus };
export type SubAgentBar = {
  start: number;
  end: number;
  open: boolean;
  label: string;
};

export type LaneRow = {
  stageId: string;
  title: string;
  /** Turns and waits, each on a track (parallel pull requests stack). */
  bars: (TurnBar | WaitBar)[];
  gates: GateBar[];
  tracks: number;
};

export type Tick = { at: number; label: string };

export type RunLanesModel = {
  start: number;
  end: number;
  /** No `complete` event yet: the now line shows. */
  active: boolean;
  now: number;
  rows: LaneRow[];
  ticks: Tick[];
};

const CHANGES = new Set(["REQUIRES REVISION", "REQUEST CHANGES", "REJECTED", "CHANGES"]);

/** A recorded verdict as its lane tag; null for none or unknown text. */
export function verdictTag(verdict: string | null | undefined): Verdict | null {
  const text = verdict?.trim().toUpperCase() ?? "";
  if (!text) return null;
  if (CHANGES.has(text)) return "CHANGES";
  if (text.startsWith("APPROVED")) return "APPROVED";
  return null;
}

function time(at: string | null | undefined): number | null {
  const ms = Date.parse(at ?? "");
  return Number.isFinite(ms) ? ms : null;
}

/** The lane an event names by its "PR1 — Title: " prefix. */
function laneOf(run: PipelineRun, summary: string): string | null {
  for (const lane of run.lanes ?? []) {
    if (lane.title && summary.startsWith(`${lane.title}: `)) return lane.id;
  }
  return null;
}

function stageOfRoleIn(stages: readonly StageDef[], roleId: string | null | undefined): StageDef | null {
  if (!roleId) return null;
  return stages.find((s) => s.roleId === roleId) ?? stages.find((s) => s.alsoReviewers?.includes(roleId)) ?? null;
}

const STARTS = new Set(["advance", "reask", "retry"]);
const ROUND_SENT_BACK = /Round (\d+) sent back/;

function gateStatusOf(
  run: PipelineRun,
  event: RunEvent,
  stageId: string,
  lane: string | null,
): { status: GateStatus; durationMs: number } {
  const key = lane ? `${stageId}@${lane}` : stageId;
  const latest = run.gates?.[key];
  const label = event.summary.slice(lane ? event.summary.indexOf(": ") + 2 : 0);
  const match: GateResult | undefined = latest?.results.find((r) => label.startsWith(`${r.label}: `));
  const outcome = event.outcome?.trim() ?? "";
  const status: GateStatus =
    outcome === "passed" || outcome === "failed" || outcome === "skipped"
      ? outcome
      : match && Math.abs((time(latest?.at) ?? 0) - (time(event.at) ?? 0)) < 5_000
        ? (match.status as GateStatus)
        : "unknown";
  return { status, durationMs: match?.durationMs ?? 0 };
}

/** Bars per stage from the ledger. `now` is the clock (tests pass one). */
export function runLanes(run: PipelineRun, stages: readonly StageDef[], now: number): RunLanesModel {
  const created = time(run.createdAt);
  const events = (run.events ?? []).filter((e) => time(e.at) !== null);
  const first = time(events[0]?.at);
  const start = Math.min(created ?? first ?? now, first ?? created ?? now);
  const index = new Map(stages.map((s, i) => [s.id, i]));

  const turns: Omit<TurnBar, "track">[] = [];
  const waits: Omit<WaitBar, "track">[] = [];
  const gates: GateBar[] = [];
  const open = new Map<string, Omit<TurnBar, "track">>();
  let wait: Omit<WaitBar, "track"> | null = null;
  const laneRound = new Map<string, number>();
  const key = (stageId: string, lane: string | null) => `${stageId}@${lane ?? ""}`;
  const title = (stageId: string) => stages.find((s) => s.id === stageId)?.title ?? stageId;
  const isReviewer = (stageId: string) => !!stages.find((s) => s.id === stageId)?.loopBack;
  let complete = false;
  let lastAt = start;

  const roundFor = (event: RunEvent, lane: string | null) =>
    lane ? (laneRound.get(lane) ?? 1) : Math.max(1, event.round);

  const close = (bar: Omit<TurnBar, "track">, at: number, verdict: Verdict | null) => {
    bar.end = Math.max(bar.start, at);
    bar.open = false;
    if (verdict) bar.verdict = verdict;
    open.delete(key(bar.stageId, bar.lane));
  };

  const begin = (stageId: string, lane: string | null, round: number, at: number) => {
    if (!index.has(stageId)) return;
    const current = open.get(key(stageId, lane));
    if (current && current.round === round) return;
    if (current) close(current, at, null);
    // A later stage taking over ends the earlier ones of the same lane (and
    // the shared stages before a fan-out). A reviewer passed over approved.
    const at_ = index.get(stageId)!;
    for (const bar of [...open.values()]) {
      if ((bar.lane === lane || bar.lane === null) && (index.get(bar.stageId) ?? -1) < at_) {
        close(bar, at, isReviewer(bar.stageId) ? "APPROVED" : null);
      }
    }
    const bar: Omit<TurnBar, "track"> = {
      kind: "turn",
      stageId,
      lane,
      round,
      start: at,
      end: at,
      open: true,
      verdict: null,
      label: "",
    };
    open.set(key(stageId, lane), bar);
    turns.push(bar);
  };

  /**
   * A turn ends: the open bar, else the stage's last bar of that round
   * (`extend`: it worked again until now; else only its verdict is set).
   */
  const finish = (
    stageId: string,
    lane: string | null,
    round: number,
    at: number,
    verdict: Verdict | null,
    extend = true,
  ) => {
    const bar = open.get(key(stageId, lane));
    if (bar) {
      close(bar, at, verdict);
      return;
    }
    const last = [...turns].reverse().find((t) => t.stageId === stageId && t.lane === lane);
    if (last && last.round === round && at >= last.end) {
      if (extend) last.end = at;
      if (verdict) last.verdict = verdict;
    }
  };

  const endWait = (at: number) => {
    if (!wait) return;
    wait.end = Math.max(wait.start, at);
    wait.open = false;
    wait = null;
  };

  if (stages[0]) begin(stages[0].id, null, 1, start);

  for (const event of events) {
    const at = time(event.at)!;
    lastAt = Math.max(lastAt, at);
    const lane = laneOf(run, event.summary);
    const stageId = event.stageId ?? "";
    if (event.kind !== "stop" && event.kind !== "gate") endWait(at);
    switch (event.kind) {
      case "handoff":
        begin(stageId, lane, roundFor(event, lane), at);
        break;
      case "loopBack": {
        const ending = Number(ROUND_SENT_BACK.exec(event.summary)?.[1] ?? event.round) || 1;
        const reviewer = stageOfRoleIn(stages, event.roleId);
        if (reviewer) finish(reviewer.id, lane, ending, at, "CHANGES", false);
        if (lane) laneRound.set(lane, ending + 1);
        begin(stageId, lane, ending + 1, at);
        break;
      }
      case "autopilot":
        if (STARTS.has(event.outcome ?? "")) {
          const round = roundFor(event, lane);
          const current = open.get(key(stageId, lane));
          // A re-ask or retry sets a finished stage working again.
          if (!current) begin(stageId, lane, round, at);
        }
        break;
      case "turn":
        finish(stageId, lane, roundFor(event, lane), at, verdictTag(event.outcome));
        break;
      case "stop": {
        endWait(at);
        const waitStage = index.has(stageId) ? stageId : run.stage;
        if (!index.has(waitStage)) break;
        wait = {
          kind: "wait",
          stageId: waitStage,
          lane,
          start: at,
          end: at,
          open: true,
          reason: event.summary,
          label: "",
        };
        waits.push(wait);
        break;
      }
      case "gate": {
        if (!index.has(stageId)) break;
        const { status, durationMs } = gateStatusOf(run, event, stageId, lane);
        gates.push({
          kind: "gate",
          stageId,
          lane,
          start: at - durationMs,
          end: at,
          open: false,
          status,
          label: `${title(stageId)} check ${status === "unknown" ? "ran" : status}: ${event.summary}`,
        });
        break;
      }
      case "complete":
        complete = true;
        for (const bar of [...open.values()]) {
          close(bar, at, isReviewer(bar.stageId) ? "APPROVED" : null);
        }
        break;
    }
  }

  const active = !complete;
  const end = active ? Math.max(now, lastAt) : lastAt;
  for (const bar of open.values()) {
    bar.end = end;
    bar.open = active;
  }
  if (wait) {
    const still = active && !!run.autopilot?.waiting;
    (wait as Omit<WaitBar, "track">).end = still ? end : lastAt;
    (wait as Omit<WaitBar, "track">).open = still;
  }

  for (const bar of turns) {
    const lanePart = bar.lane ? ` (${laneTitle(run, bar.lane)})` : "";
    const verdict = bar.verdict ? `, ${bar.verdict === "CHANGES" ? "changes requested" : "approved"}` : "";
    bar.label = `${title(bar.stageId)}${lanePart} round ${bar.round}: ${
      bar.open ? "working for" : "worked"
    } ${formatSpan(bar.end - bar.start)}${verdict}`;
  }
  for (const bar of waits) {
    bar.label = `${title(bar.stageId)}: waited for you${bar.open ? " (still waiting)" : ""} ${formatSpan(
      bar.end - bar.start,
    )}. ${bar.reason}`;
  }

  const rows: LaneRow[] = stages.map((stage) => {
    const barsOf = [...turns, ...waits]
      .filter((b) => b.stageId === stage.id)
      .sort((a, b) => a.start - b.start || (a.kind === "turn" ? -1 : 1));
    const placed = assignTracks(barsOf);
    return {
      stageId: stage.id,
      title: stage.title,
      bars: placed.bars,
      gates: gates.filter((g) => g.stageId === stage.id),
      tracks: placed.tracks,
    };
  });

  return { start, end: Math.max(end, start + 1000), active, now, rows, ticks: axisTicks(start, Math.max(end, start + 1000)) };
}

function laneTitle(run: PipelineRun, lane: string): string {
  return run.lanes?.find((l) => l.id === lane)?.title ?? lane;
}

/** First track whose last bar ended by this bar's start. */
export function assignTracks<T extends { start: number; end: number }>(bars: T[]): { bars: (T & { track: number })[]; tracks: number } {
  const ends: number[] = [];
  const out = bars.map((bar) => {
    let track = ends.findIndex((end) => end <= bar.start);
    if (track < 0) {
      track = ends.length;
      ends.push(bar.end);
    } else ends[track] = bar.end;
    return { ...bar, track };
  });
  return { bars: out, tracks: Math.max(1, ends.length) };
}

const STEPS = [
  1, 5, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400,
].map((s) => s * 1000);

/** Up to about six ticks at a round step, labelled as time since the start. */
export function axisTicks(start: number, end: number): Tick[] {
  const span = Math.max(1, end - start);
  const step = STEPS.find((s) => span / s <= 6) ?? Math.ceil(span / 6 / 86_400_000) * 86_400_000;
  const ticks: Tick[] = [];
  for (let at = start; at <= end; at += step) ticks.push({ at, label: formatSpan(at - start) });
  return ticks;
}

/** "45s", "5m", "1h 30m", "2d 3h". */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** A stage tab's sub-agents as bars inside the axis; running ones reach now. */
export function subAgentBars(
  entries: readonly ChatEntry[],
  range: { start: number; end: number; now: number },
): SubAgentBar[] {
  const out: SubAgentBar[] = [];
  for (const entry of entries) {
    if (entry.kind !== "subAgent") continue;
    const from = time(entry.at);
    if (from === null) continue;
    const running = entry.status === "running";
    const to = time(entry.endedAt) ?? (running ? range.now : from);
    if (to < range.start || from > range.end) continue;
    const start = Math.max(range.start, from);
    const end = Math.min(range.end, Math.max(start, to));
    const type = entry.agentType ? ` (${entry.agentType})` : "";
    const took = running
      ? `running for ${formatSpan(end - start)}`
      : entry.background
        ? "started in the background"
        : `took ${formatSpan(end - start)}`;
    out.push({
      start,
      end,
      open: running,
      label: `Sub-agent${type}: ${entry.description || "untitled"}, ${took}`,
    });
  }
  return out;
}
