import { useEffect, useMemo, useState } from "react";
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

function StageRow({
  row,
  model,
  tab,
  onSubAgents,
}: {
  row: LaneRow;
  model: RunLanesModel;
  tab: TabSummary | undefined;
  onSubAgents: (stageId: string, bars: SubAgentBar[]) => void;
}) {
  const place = placeOf(model);
  const claude = !!tab && isClaudeTerminal(tab);
  const { entries } = useChatEntries(claude ? tab!.id : null, claude);
  const subAgents = useMemo(
    () => (claude ? subAgentBars(entries, model) : []),
    [claude, entries, model],
  );
  const placedSubs = useMemo(() => assignTracks(subAgents), [subAgents]);
  useEffect(() => onSubAgents(row.stageId, subAgents), [onSubAgents, row.stageId, subAgents]);

  return (
    <>
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
                title={bar.label}
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
function sameBars(a: SubAgentBar[] | undefined, b: SubAgentBar[]): boolean {
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
  const [subs, setSubs] = useState<Record<string, SubAgentBar[]>>({});
  const onSubAgents = useMemo(
    () => (stageId: string, bars: SubAgentBar[]) =>
      setSubs((prev) => (sameBars(prev[stageId], bars) ? prev : { ...prev, [stageId]: bars })),
    [],
  );
  const span = Math.max(1, model.end - model.start);
  const tabOf = (roleId: string) => tabs.find((t) => t.id === run.tabIds[roleId]);

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
            tab={tabOf(stages.find((s) => s.id === row.stageId)?.roleId ?? "")}
            onSubAgents={onSubAgents}
          />
        ))}
        <div />
        <div className="run-lanes-axis">
          {model.ticks.map((tick) => (
            <span key={tick.at} className="run-lanes-tick" style={{ left: `${((tick.at - model.start) / span) * 100}%` }}>
              {tick.label}
            </span>
          ))}
          {model.active && <span className="run-lanes-now-label" style={{ left: `${Math.min(100, ((model.now - model.start) / span) * 100)}%` }}>now</span>}
        </div>
      </div>
      <ul className="sr-only" aria-label="Run lanes as a list">
        {model.rows.flatMap((row) => [
          ...row.bars.map((bar, i) => <li key={`${row.stageId}-b${i}`}>{bar.label}</li>),
          ...row.gates.map((gate, i) => <li key={`${row.stageId}-g${i}`}>{gate.label}</li>),
          ...(subs[row.stageId] ?? []).map((bar, i) => (
            <li key={`${row.stageId}-s${i}`}>
              {row.title}: {bar.label}
            </li>
          )),
        ])}
      </ul>
    </section>
  );
}
