// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  getPipelineRun: vi.fn(),
  clickupIntakeCheck: vi.fn(async () => null),
  listenChainRunUpdated: vi.fn(async () => () => {}),
  pipelineActorMessage: vi.fn(async () => ({})),
  pipelinePromotePlan: vi.fn(async () => {}),
  pipelineSetCandidatePlan: vi.fn(async () => {}),
  pipelineSetAutopilot: vi.fn(async () => {}),
  pipelineRunGates: vi.fn(async () => []),
  pipelineRunTasks: vi.fn(async () => null),
  exportTextFile: vi.fn(async () => {}),
}));
vi.mock("../pipeline/terminalText", () => ({ liveTerminalReader: null }));

import type { PipelineRun, RunStory } from "../bridge";
import { getPipelineRun } from "../bridge";
import type { TerminalReader } from "../pipeline/terminalText";
import { PipelineOverview } from "./PipelineOverview";

const noTerminal: TerminalReader = { selection: () => "", tail: () => "", planFile: async () => "" };

function stories(lane: string | null): RunStory[] {
  return [
    { lane, id: "s1", title: "R5 instrumentation", status: "done" },
    { lane, id: "s2", title: "T14-4 log dedupe", status: "checking" },
    { lane, id: "s3", title: "T14-2 lock-file filter", status: "pending" },
    { lane, id: "s4", title: "T14-1 folder name", status: "pending" },
  ];
}

function run(extra: Partial<PipelineRun>): PipelineRun {
  return {
    id: "ee_1",
    kind: "full",
    cwd: "/p",
    stage: "implementer",
    overviewTabId: "ov",
    tabIds: {},
    createdAt: "2026-10-22T00:00:00Z",
    chainId: "ee_1",
    engine: 2,
    status: "running",
    autopilot: { enabled: true },
    ...extra,
  };
}

function show(view: PipelineRun) {
  vi.mocked(getPipelineRun).mockResolvedValue({ run: view });
  render(
    <PipelineOverview
      runId={view.id}
      cwd="/p"
      tabs={[]}
      runtimes={{}}
      onJump={() => {}}
      onWatch={() => {}}
      onRefreshTabs={async () => {}}
      onNotice={() => {}}
      terminalReader={noTerminal}
    />,
  );
}

describe("PipelineOverview stories (L3)", () => {
  it("labels a lane with its story progress and lists its stories", async () => {
    show(
      run({
        fanOutStage: "implementer",
        lanes: [
          { id: "pr1", title: "PR1 — Engine fixes", status: "active", stage: "implementer", round: 1, tabIds: {}, repo: "engine" },
          { id: "pr2", title: "PR2 — Docs", status: "waiting", stage: "implementer", round: 1, tabIds: {} },
        ],
        stories: stories("pr1"),
      }),
    );
    const lanes = await screen.findByRole("region", { name: "Pull requests" });
    const pr1 = within(lanes).getByRole("listitem", { name: "PR1 — Engine fixes" });
    expect(pr1.textContent).toContain("PR1 — Engine fixes · engine · story 2/4");
    const list = within(pr1).getByRole("list", { name: "Stories of PR1 — Engine fixes" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "s1 R5 instrumentation · done",
      "s2 T14-4 log dedupe · checks running",
      "s3 T14-2 lock-file filter · pending",
      "s4 T14-1 folder name · pending",
    ]);
    const pr2 = within(lanes).getByRole("listitem", { name: "PR2 — Docs" });
    expect(pr2.textContent).not.toContain("story");
    expect(screen.queryByRole("region", { name: "Stories" })).toBeNull();
  });

  it("shows the run's own pull request's stories and the checkpoint it waits on", async () => {
    show(
      run({
        status: "waiting",
        stopReason: "checkpoint",
        stories: stories(null).map((s) => (s.id === "s2" ? { ...s, status: "waiting" as const, checkpoint: "Rerun on Windows" } : s)),
        autopilot: {
          enabled: true,
          waiting: "Story s2 (2 of 4) passed its checks, and its checkpoint waits for you: Rerun on Windows.",
          storyWait: { stageId: "implementer", lane: null, story: "s2", checkpoint: "Rerun on Windows", turn: "impl|bridge|t2", at: "now" },
        },
      }),
    );
    const section = await screen.findByRole("region", { name: "Stories" });
    expect(section.textContent).toContain("Stories · story 2/4");
    expect(within(section).getByRole("list", { name: "Stories of the pull request" })).toBeTruthy();
    const panel = screen.getByRole("region", { name: "Story checkpoint" });
    expect(panel.textContent).toContain("Checkpoint after story s2 (2 of 4): T14-4 log dedupe");
    expect(within(panel).getByRole("button", { name: "Continue" })).toBeTruthy();
  });
});
