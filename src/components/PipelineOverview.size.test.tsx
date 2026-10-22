// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  getPipelineRun: vi.fn(),
  clickupIntakeCheck: vi.fn(async () => null),
  clickupWritebackLoad: vi.fn(async () => null),
  listenChainRunUpdated: vi.fn(async () => () => {}),
  pipelinePromotePlan: vi.fn(async () => {}),
  pipelineSetCandidatePlan: vi.fn(async () => {}),
}));
vi.mock("../pipeline/terminalText", () => ({ liveTerminalReader: null }));

import type { PipelineRun } from "../bridge";
import { getPipelineRun } from "../bridge";
import { PipelineOverview } from "./PipelineOverview";

function run(size: PipelineRun["size"]): PipelineRun {
  return {
    id: "ee_f3",
    kind: "eagle-eye-l",
    cwd: "/p",
    stage: "analyst",
    overviewTabId: "",
    tabIds: {},
    createdAt: "2026-10-22T00:00:00Z",
    engine: 2,
    status: "stopped",
    size,
  };
}

async function meta(size: PipelineRun["size"]) {
  vi.mocked(getPipelineRun).mockResolvedValue({ run: run(size) });
  const view = render(
    <PipelineOverview
      runId="ee_f3"
      cwd="/p"
      tabs={[]}
      runtimes={{}}
      onJump={vi.fn()}
      onWatch={vi.fn()}
      onRefreshTabs={async () => {}}
      onNotice={vi.fn()}
      terminalReader={{ selection: () => "", tail: () => "", planFile: async () => "" }}
    />,
  );
  const line = await screen.findByText((_, el) => !!el?.classList.contains("pipeline-overview-meta"));
  const text = line.textContent ?? "";
  view.unmount();
  return text;
}

describe("PipelineOverview size (F3)", () => {
  it("shows the size the run started with, and nothing for a run with none", async () => {
    expect(await meta("L")).toContain("Size L: Brief, PRD and architecture first, then M");
    expect(await meta(null)).not.toContain("Size");
  });
});
