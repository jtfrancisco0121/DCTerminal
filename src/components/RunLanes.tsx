import { useCallback, useEffect, useMemo, useState } from "react";
import type { PipelineRun, TabSummary } from "../bridge";
import { pipelineStages } from "../pipeline/defs";
import {
  assignTracks,
  runLanes,
  subAgentBars,
  type GateBar,
  type LaneRow,
  type RunLanesModel,
  type SubAgentBar,
  type TurnBar,
  type WaitBar,
} from "../pipeline/runLanes";
import { useChatEntries } from "../terminal/chatEntriesStore";
import { isClaudeTerminal } from "../views/tabHelpers";

/** Height of one bar track, px (bar plus gap). */
const TRACK = 18;
/** The strip under a stage's bars where its checks draw. */
const GATE_STRIP = 6;
const TICK_MS = 5_000;

/** The clock, ticking while the run is active so its open bars grow. */
function useNow(active: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined || !active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active, fixed]);
  return fixed ?? now;
}

function placeOf(model: RunLanesModel) {
  const span = Math.max(1, model.end - model.start);
  const pct = (at: number) => Math.min(100, Math.max(0, ((at - model.start) / span) * 100));
  return (bar: { start: number; end: number }) => ({
    left: `${pct(bar.start)}%`,
    width: `max(${pct(bar.end) - pct(bar.start)}%, 3px)`,
  });
}

function NowLine({ model }: { model: RunLanesModel }) {
  if (!model.active) return null;
  const span = Math.max(1, model.end - model.start);
  const left = Math.min(100, ((model.now - model.start) / span) * 100);
  return <div className="run-lanes-now" style={{ left: `${left}%` }} />;
}

function barClass(bar: TurnBar | WaitBar): string {
  if (bar.kind === "wait") return "run-lane-bar run-lane-bar-wait";
  return `run-lane-bar ${bar.open ? "run-lane-bar-working" : "run-lane-bar-done"}`;
}

/** A Claude terminal of a stage: the run's own, or a fanned-out lane's. */
type StageTab = { tab: TabSummary; lane: string | null };
/** A sub-agent bar and the lane title of the tab that ran it. */
type LaneSubAgentBar = SubAgentBar & { lane: string | null };

/** Reads one tab's sub-agents and reports them; draws nothing. */
function TabSubAgents({
  tabId,
  model,
  onBars,
}: {
  tabId: string;
  model: RunLanesModel;
  onBars: (tabId: string, bars: SubAgentBar[]) => void;
}) {
  const { entries } = useChatEntries(tabId, true);
  const bars = useMemo(() => subAgentBars(entries, model), [entries, model]);
  useEffect(() => onBars(tabId, bars), [onBars, tabId, bars]);
  return null;
}

function StageRow({
  row,
  model,
  tabs,
  onSubAgents,
}: {
  row: LaneRow;
  model: RunLanesModel;
  tabs: StageTab[];
  onSubAgents: (stageId: string, bars: LaneSubAgentBar[]) => void;
}) {
  const place = placeOf(model);
  const sources = tabs.filter((s) => isClaudeTerminal(s.tab));
  const [byTab, setByTab] = useState<Record<string, SubAgentBar[]>>({});
  const onBars = useCallback(
    (tabId: string, bars: SubAgentBar[]) =>
      setByTab((prev) => (sameBars(prev[tabId], bars) ? prev : { ...prev, [tabId]: bars })),
    [],
  );
  // Each tab (the run's own, then each lane's) on its own tracks. Keyed by
  // value: the tab list is rebuilt on every render.
  const sourceKey = JSON.stringify(sources.map((s) => [s.tab.id, s.lane]));
  const placedSubs = useMemo(() => {
    const bars: (LaneSubAgentBar & { track: number })[] = [];
    let tracks = 0;
    for (const [tabId, lane] of JSON.parse(sourceKey) as [string, string | null][]) {
      const own = byTab[tabId] ?? [];
      if (!own.length) continue;
      const placed = assignTracks(own.map((bar) => ({ ...bar, lane })));
      for (const bar of placed.bars) bars.push({ ...bar, track: bar.track + tracks });
      tracks += placed.tracks;
    }
    return { bars, tracks };
  }, [sourceKey, byTab]);
  const subAgents = useMemo(() => placedSubs.bars.map(({ track: _track, ...bar }) => bar), [placedSubs]);
  useEffect(() => onSubAgents(row.stageId, subAgents), [onSubAgents, row.stageId, subAgents]);

  return (
    <>
      {sources.map((source) => (
        <TabSubAgents key={source.tab.id} tabId={source.tab.id} model={model} onBars={onBars} />
      ))}
      <div className="run-lanes-label" title={row.title}>
        {row.title}
      </div>
      <div className="run-lanes-track" style={{ height: row.tracks * TRACK + GATE_STRIP }}>
        {row.bars.map((bar, i) => (
          <div
            key={`b${i}`}
            className={barClass(bar)}
            style={{ ...place(bar), top: bar.track * TRACK }}
            title={bar.label}
          >
            {bar.kind === "turn" && bar.verdict && (
              <span
                className={`run-lane-verdict run-lane-verdict-${bar.verdict === "CHANGES" ? "changes" : "approved"}`}
              >
                {bar.verdict}
              </span>
            )}
          </div>
        ))}
        {row.gates.map((gate: GateBar, i) => (
          <div
            key={`g${i}`}
            className={`run-lane-gate run-lane-gate-${gate.status}`}
            style={{ ...place(gate), top: row.tracks * TRACK }}
            title={gate.label}
          />
        ))}
        <NowLine model={model} />
      </div>
      {placedSubs.bars.length > 0 && (
        <>
          <div className="run-lanes-label run-lanes-label-sub" title={`${row.title} sub-agents`}>
            Sub-agents
          </div>
          <div className="run-lanes-track run-lanes-track-sub" style={{ height: placedSubs.tracks * TRACK }}>
            {placedSubs.bars.map((bar, i) => (
              <div
                key={`s${i}`}
                className={`run-lane-bar run-lane-bar-sub${bar.open ? " run-lane-bar-sub-open" : ""}`}
                style={{ ...place(bar), top: bar.track * TRACK }}
                title={bar.lane ? `${bar.lane}: ${bar.label}` : bar.label}
              />
            ))}
            <NowLine model={model} />
          </div>
        </>
      )}
    </>
  );
}

/** Same text list: no state update (and no render loop) for an equal list. */
function sameBars<T extends SubAgentBar>(a: T[] | undefined, b: T[]): boolean {
  const left = a ?? [];
  return left.length === b.length && left.every((bar, i) => bar.label === b[i].label);
}

const LEGEND:{ cls: string; text: string }[] = [
  { cls: "run-lane-bar-done", text: "Turn" },
  { cls: "run-lane-bar-working", text: "Working" },
  { cls: "run-lane-bar-wait", text: "Waiting for you" },
  { cls: "run-lane-gate-passed", text: "Check passed" },
  { cls: "run-lane-gate-failed", text: "Check failed" },
  { cls: "run-lane-bar-sub", text: "Sub-agent" },
];

/**
 * When each stage of a run worked, waited for you and ran its checks, on one
 * time axis, with the sub-agents of Claude terminal stages under their stage.
 */
export function RunLanes({ run, tabs, now: fixedNow }: { run: PipelineRun; tabs: TabSummary[]; now?: number }) {
  const stages = pipelineStages(run.kind);
  const complete = (run.events ?? []).some((e) => e.kind === "complete");
  const now = useNow(!complete, fixedNow);
  const model = useMemo(() => runLanes(run, stages, now), [run, stages, now]);
  const [subs, setSubs] = useState<Record<string, LaneSubAgentBar[]>>({});
  const onSubAgents = useMemo(
    () => (stageId: string, bars: LaneSubAgentBar[]) =>
      setSubs((prev) => (sameBars(prev[stageId], bars) ? prev : { ...prev, [stageId]: bars })),
    [],
  );
  const span = Math.max(1, model.end - model.start);
  // A stage's tabs: the run's own, then each fanned-out lane's (by its title).
  const tabsOf = (roleId: string): StageTab[] => {
    const out: StageTab[] = [];
    const own = tabs.find((t) => t.id === run.tabIds[roleId]);
    if (own) out.push({ tab: own, lane: null });
    for (const lane of run.lanes ?? []) {
      const tab = tabs.find((t) => t.id === lane.tabIds?.[roleId]);
      if (tab && !out.some((s) => s.tab.id === tab.id)) out.push({ tab, lane: lane.title || lane.id });
    }
    return out;
  };

  return (
    <section className="run-lanes" aria-label="Run lanes">
      <div className="run-lanes-head">
        <h3>Run lanes</h3>
        <ul className="run-lanes-legend" aria-label="Legend">
          {LEGEND.map((item) => (
            <li key={item.text}>
              <span className={`run-lanes-swatch ${item.cls}`} aria-hidden="true" />
              {item.text}
            </li>
          ))}
        </ul>
      </div>
      <div className="run-lanes-chart" aria-hidden="true">
        {model.rows.map((row) => (
          <StageRow
            key={row.stageId}
            row={row}
            model={model}
            tabs={tabsOf(stages.find((s) => s.id === row.stageId)?.roleId ?? "")}
            onSubAgents={onSubAgents}
          />
        ))}
        <div />
        <div className="run-lanes-axis">
          {model.ticks.map((tick) => {
            // Shift each label by its own position: left-aligned at 0, centred
            // mid-axis, right-anchored at 100%, so none hangs past the chart.
            const left = ((tick.at - model.start) / span) * 100;
            return (
              <span key={tick.at} className="run-lanes-tick" style={{ left: `${left}%`, transform: `translateX(-${left}%)` }}>
                {tick.label}
              </span>
            );
          })}
          {model.active && <span className="run-lanes-now-label" style={{ left: `${Math.min(100, ((model.now - model.start) / span) * 100)}%` }}>now</span>}
        </div>
      </div>
      <ul className="sr-only" aria-label="Run lanes as a list">
        {model.rows.flatMap((row) => [
          ...row.bars.map((bar, i) => <li key={`${row.stageId}-b${i}`}>{bar.label}</li>),
          ...row.gates.map((gate, i) => <li key={`${row.stageId}-g${i}`}>{gate.label}</li>),
          ...(subs[row.stageId] ?? []).map((bar, i) => (
            <li key={`${row.stageId}-s${i}`}>
              {row.title}
              {bar.lane ? ` (${bar.lane})` : ""}: {bar.label}
            </li>
          )),
        ])}
      </ul>
    </section>
  );
}
